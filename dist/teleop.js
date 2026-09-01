// NORI: Additive file. Remote-mode operator client (M1 §e: the laptop app is the
// single control client). Framework-agnostic: this class owns the WebRTC + Supabase
// signaling + control-data-channel logic; the React page (pages/remote.tsx) only wires
// it to the DOM (video element, form, keyboard) and renders status.
//
// It is the TypeScript port of rpi5/media/webrtc_operator.html in NoriTeleop — same
// wire protocol, so it talks to the same `webrtc_robot.py` on the Pi:
//   * Supabase Realtime broadcast channel (room = NORI_ROOM) for SDP/ICE exchange
//   * the browser is the ANSWERER; a FRESH RTCPeerConnection per offer (robot restarts)
//   * control rides an UNRELIABLE data channel the robot opens ('control'), bridged on
//     the Pi to the daemon's NDJSON :7777
//   * auth: the robot gates private rooms itself (Supabase RLS); the operator no longer
//     sends a room-token HMAC proof — it simply joins and handshakes
//   * TURN is additive (STUN-direct preferred); forceRelay validates the relay path
import { AudioLatencyProbe, audioLatencyEnabled } from "./audioLatency";
import { VideoQualityLoop } from "./videoQuality";
import { NORI_PROTOCOL_VERSION } from "./version";
import { liftJogKey, liftAxes } from "./rail";
// ── current units ───────────────────────────────────────────────────────────────────────
// The daemon sends Present_Current as RAW Feetech LSBs (sign-magnitude, STS3215 addr 69) —
// telemetry.json documents the field as "Signed raw Present_Current per motor". The STS3215
// reports 6.5 mA per count.
//
// The WIRE deliberately stays in LSBs: every tuning knob the robot is configured with is in
// the same unit (NORI_STALL_CURRENT, the NORI_STALL_CURRENT_BREAKIN ceiling, config_check's
// 10..500 range). Converting daemon-side would silently desync telemetry from the numbers an
// operator sets in lift.env. So convert at the DISPLAY EDGE only, here.
//
// Reference points for anyone reading a grip-force bar: the default stall trigger of 90 LSB
// is ~585 mA, the break-in ceiling of 160 LSB is ~1.04 A, and CURRENT_FULL_LSB (600) is ~3.9 A.
export const CURRENT_MA_PER_LSB = 6.5;
// Raw Present_Current LSBs -> milliamps. Sign is preserved; callers that want magnitude
// should Math.abs() the raw value first (direction is meaningful for haptics, not for force).
export function currentMa(rawLsb) {
    return rawLsb * CURRENT_MA_PER_LSB;
}
// Raw LSB value mapped to a full grip-force bar, shared by the 2D readout (TeleopStatus) and
// the VR HUD so the two can't drift apart. This is a DISPLAY normalization, not a limit: it
// mirrors Torque_Limit's 0..600 span, which is a duty scale rather than a current scale.
export const CURRENT_FULL_LSB = 600;
// The states that end an action's lifecycle (awaitAction resolves on these).
const TERMINAL_ACTION_STATES = new Set(["done", "clamped", "blocked", "timeout"]);
// How long to sit in "waiting" before calling it a failure. The client keeps re-announcing
// 'ready' underneath (a robot that boots late still connects on its own) — this deadline only
// decides when we STOP staying silent and tell the operator something is wrong.
const WAIT_FOR_ROBOT_MS = 12000;
// Render a CameraLayout as a one-line description for the LLM vision prompt (e.g. "top-left =
// left_wrist; …"). Pure + exported so it can be unit-tested without a live peer.
export function formatCameraLayout(layout) {
    const { cols, rows, tiles } = layout;
    const posLabel = (i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const v = rows === 1 ? "" : rows === 2 ? (r === 0 ? "top" : "bottom") : `row ${r + 1}`;
        const h = cols === 1 ? "" : cols === 2 ? (c === 0 ? "left" : "right") : `col ${c + 1}`;
        if (!v)
            return h || "single";
        if (!h)
            return v;
        return v.includes(" ") || h.includes(" ") ? `${v} ${h}` : `${v}-${h}`;
    };
    const parts = tiles.map((name, i) => `${posLabel(i)} = ${name}`).join("; ");
    return `Composite camera view — ${cols}x${rows} grid, tiles left-to-right then top-to-bottom: ${parts}. ` +
        `Acting on it: a "<side>_wrist" tile is the camera ON that arm — drive that arm with side:"<side>" ` +
        `(e.g. left_wrist → side:"left"). A wrist view is egocentric: its own image left/right is NOT the ` +
        `robot's. Use the "overhead"/"front" scene tiles to judge the robot's left vs right and which side ` +
        `of the robot an object is on.`;
}
// The source crop rect of one named camera tile inside a composite frame of vw x vh pixels,
// or null if the role isn't in the layout (or the inputs are degenerate). Pure + exported so
// the tile mapping is unit-testable without a live peer; shared by cameraView() (live crop),
// captureFrame(role) (one-shot crop), and anything app-side that needs the same math.
export function cameraTileRect(layout, role, vw, vh) {
    const idx = layout.tiles.indexOf(role);
    if (idx < 0 || layout.cols < 1 || layout.rows < 1 || vw <= 0 || vh <= 0)
        return null;
    const sw = vw / layout.cols;
    const sh = vh / layout.rows;
    return { sx: (idx % layout.cols) * sw, sy: Math.floor(idx / layout.cols) * sh, sw, sh };
}
// Three-valued capability check (mirrors nori-sdk-py RobotInfo.supports): true/false when
// the robot declared its capabilities, undefined when the ack predates the field — callers
// must treat undefined as "unknown, probe or assume legacy", never as false.
export function supportsCapability(info, capability) {
    const caps = info?.capabilities;
    if (caps === undefined)
        return undefined;
    return caps.includes(capability);
}
// Fleet-serial model code: "NORI-L3-0007" -> "L3", "NORI-A3-0000" -> "A3"; non-fleet /
// unrecognized serials (dev rooms, legacy formats) -> null. Case-insensitive, same parse as
// the backend's _FLEET_SERIAL and the app's robotModels.ts. Lives in the SDK because the
// wire itself is model-dependent in exactly one place (the L2 legacy base-angular sign) and
// the SDK must resolve that without the app's help.
export function serialModelCode(serial) {
    const m = /^NORI-([A-Z]\d+)/i.exec(serial.trim());
    return m ? m[1].toUpperCase() : null;
}
// True for addresses that mean a VPN/overlay carried the candidate even though its ICE
// type is "host". A "lan" verdict over a tunnel hands the robot the tight watchdog
// profile on a path with tunnel latency and a 1280-byte MTU — the exact pairing that
// silently ate every fragmented frame on the 2026-08-26 bench (Tailscale: its CGNAT
// IPv4 range and IPv6 ULA prefix; the multi-KB ack died deterministically and an ordered
// channel head-of-line blocked behind it). Not a general tunnel detector — it names the
// overlay networks we have actually been bitten by. Mirrors nori-sdk-py _tunnel_address.
export function tunnelAddress(host) {
    // RFC 6598 CGNAT 100.64.0.0/10 (Tailscale's IPv4 range): 100.64.x.x .. 100.127.x.x.
    const v4 = /^100\.(\d{1,3})\./.exec(host);
    if (v4) {
        const octet = Number(v4[1]);
        return octet >= 64 && octet <= 127;
    }
    // Tailscale's IPv6 ULA fd7a:115c:a1e0::/48. The first three hextets have no leading
    // zeros, so every textual form — compressed or not — starts with this prefix; only
    // case varies.
    return host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
// Coerce a wire `ack` frame into a RobotInfo. Tolerant of old daemons that send a bare
// {type:"ack"} (absent `accepted` counts as accepted; everything else optional). Pure +
// exported so the handshake parse is unit-testable without a live peer.
export function parseAck(m, sdkProtocolVersion = NORI_PROTOCOL_VERSION) {
    const wd = m.watchdog_profile;
    const protocolVersion = typeof m.protocol_version === "number" ? m.protocol_version : undefined;
    return {
        accepted: m.accepted !== false,
        protocolVersion,
        normMode: typeof m.norm_mode === "string" ? m.norm_mode : undefined,
        watchdogProfile: wd && typeof wd.t_warn_ms === "number" && typeof wd.t_stop_ms === "number"
            ? { t_warn_ms: wd.t_warn_ms, t_stop_ms: wd.t_stop_ms }
            : undefined,
        descriptor: m.descriptor && typeof m.descriptor === "object"
            ? m.descriptor
            : undefined,
        initialState: m.initial_state && typeof m.initial_state === "object"
            ? m.initial_state
            : undefined,
        error: typeof m.error === "string" ? m.error : undefined,
        versionMismatch: protocolVersion !== undefined && protocolVersion !== sdkProtocolVersion,
        model: typeof m.model === "string" && m.model ? m.model : undefined,
        capabilities: Array.isArray(m.capabilities) && m.capabilities.every((c) => typeof c === "string")
            ? m.capabilities
            : undefined,
    };
}
const TERMINAL_NAVIGATION_STATES = new Set([
    "succeeded", "canceled", "aborted", "failed", "unavailable",
]);
// Two schemes; 'm' toggles. Default = CYLINDRICAL (the rpi4 feel).
//  cylindrical: shoulder_pan + x/y reach (IK) + pitch + wrist_roll + gripper
//  joint (per-motor): each motor direct, top row +, bottom row -
// Exported so the on-screen control legend (pages/remote.tsx) derives from the SAME maps
// the jog stream uses — no hand-maintained second copy to drift out of sync (C3).
export const TASK_KEYS = {
    q: ["shoulder_pan", 1], e: ["shoulder_pan", -1],
    w: ["x", 1], s: ["x", -1], a: ["y", 1], d: ["y", -1],
    z: ["pitch", 1], x: ["pitch", -1], r: ["wrist_roll", 1], f: ["wrist_roll", -1],
    t: ["gripper", 1], g: ["gripper", -1],
};
export const JOINT_KEYS = {
    q: ["shoulder_pan", 1], a: ["shoulder_pan", -1],
    w: ["shoulder_lift", 1], s: ["shoulder_lift", -1],
    e: ["elbow_flex", 1], d: ["elbow_flex", -1],
    r: ["wrist_flex", 1], f: ["wrist_flex", -1],
    t: ["wrist_roll", 1], g: ["wrist_roll", -1],
    y: ["gripper", 1], h: ["gripper", -1],
};
// ---- A3: descriptor-gated cartesian task jog (additive; L2 byte-identical) ----
// The A3 gateway advertises descriptor.jog_scale.task = {x,y,z,pitch,yaw,shoulder_pan};
// L2 daemons never send jog_scale.task. PRESENCE of that field — never a model string —
// gates the cartesian keymap/label below. `yaw` is the canonical angular-z verb
// (shoulder_pan is a deprecated alias the gateway still accepts); new clients send yaw.
// Key choices deliberately avoid i/k/j/l (base), u/o (lift), m (mode toggle) and
// space/p/c (commands); y/h are free in task mode (they only carry gripper in JOINT_KEYS).
export const CARTESIAN_TASK_KEYS = {
    q: ["yaw", 1], e: ["yaw", -1],
    w: ["x", 1], s: ["x", -1], a: ["y", 1], d: ["y", -1],
    y: ["z", 1], h: ["z", -1],
    z: ["pitch", 1], x: ["pitch", -1], r: ["wrist_roll", 1], f: ["wrist_roll", -1],
    t: ["gripper", 1], g: ["gripper", -1],
};
// The task-mode keymap for a given descriptor. No descriptor jog_scale.task (every L2,
// and any pre-ack session) returns the EXACT legacy TASK_KEYS object — same reference,
// same bytes on the wire — so deployed L2 units behave byte-identically.
export function taskKeymapFor(descriptor) {
    return descriptor?.jog_scale?.task ? CARTESIAN_TASK_KEYS : TASK_KEYS;
}
// Display label for the non-joint control mode. The ControlMode VALUE stays
// "cylindrical" everywhere (public type, persisted state — never on the wire); only
// what the operator READS changes: "cartesian" when the descriptor advertises a task
// jog vocabulary (A3), "cylindrical" otherwise (L2 / unknown).
export function taskModeLabel(descriptor) {
    return descriptor?.jog_scale?.task ? "cartesian" : "cylindrical";
}
// ---- L3: descriptor-driven per-motor jog (additive; L2 byte-identical) ----
// L2 daemons advertise (or predate) the classic 6-DOF vocabulary in
// JOINT_KEYS; the L3 gateway's ack descriptor advertises its real arm joints
// ("right_arm_shoulder_pitch.pos", ...). Only when a descriptor names arm
// joints OUTSIDE the L2 set does per-motor mode derive its keymap from the
// descriptor. No descriptor, or the L2 vocabulary, keeps the exact legacy
// map — every deployed L2 behaves identically.
const L2_JOINT_SHORTS = new Set([
    "shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper",
]);
// Anatomical display/keyboard order for known L3 joints; unknown joints sort last.
const L3_PREFERRED_ORDER = [
    "shoulder_pitch", "shoulder_roll", "bicep_yaw", "elbow_pitch",
    "forearm_yaw", "wrist_pitch", "wrist_roll",
];
// Key pairs for dynamically-mapped joints, row order. Deliberately avoids
// i/k/j/l (base), u/o (lift), m (mode toggle) and space/p/c (commands).
const DYNAMIC_KEY_PAIRS = [
    ["q", "a"], ["w", "s"], ["e", "d"], ["r", "f"],
    ["t", "g"], ["y", "h"], ["z", "x"], ["b", "n"],
];
// The descriptor's arm-joint short names for one arm, or null when the robot
// speaks the L2 vocabulary (=> use the legacy JOINT_KEYS untouched).
export function l3JointShorts(descriptor, arm) {
    const joints = descriptor?.joints;
    if (!joints)
        return null;
    const prefix = `${arm}_arm_`;
    const shorts = [];
    for (const key of joints) {
        if (!key.startsWith(prefix) || !key.endsWith(".pos"))
            continue;
        const short = key.slice(prefix.length, -".pos".length);
        if (short !== "gripper")
            shorts.push(short);
    }
    if (!shorts.length || shorts.every((s) => L2_JOINT_SHORTS.has(s)))
        return null;
    const rank = (s) => {
        const i = L3_PREFERRED_ORDER.indexOf(s);
        return i < 0 ? L3_PREFERRED_ORDER.length : i;
    };
    shorts.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return shorts;
}
// The legacy 6-DOF joint vocabulary, derived from JOINT_KEYS so there is exactly one copy.
export const L2_JOINT_DOFS = [
    ...new Set(Object.values(JOINT_KEYS).map(([dof]) => dof)),
];
// The per-joint DOF vocabulary ONE ARM actually accepts — what scripted/agent surfaces
// (ScriptDriver `joint`/`moveTo`, the LLM `move_to` tool schema) validate against and
// advertise. Derived from the descriptor when the robot sent one (spec MODELS.md: branch on
// descriptor, never on model); the compiled-in L2 set survives ONLY as the no-descriptor
// legacy fallback — the one place a hardcoded joint list is legitimate. A descriptor that
// names no joints for `side` yields [] (that arm does not exist; the gateway would refuse
// every key as unknown_joint), never the L2 fallback: substituting a vocabulary the robot
// didn't advertise is how an agent gets taught joints that aren't there.
export function jointDofsFor(descriptor, side) {
    const joints = descriptor?.joints;
    if (!joints)
        return [...L2_JOINT_DOFS];
    const prefix = `${side}_arm_`;
    return joints
        .filter((k) => k.startsWith(prefix) && k.endsWith(".pos"))
        .map((k) => k.slice(prefix.length, -".pos".length));
}
// Build a per-motor keymap for descriptor-advertised joints. The gripper
// always keeps the last pair, so it can never fall off the keyboard.
export function jointKeymapForShorts(shorts) {
    const dofs = [...shorts.slice(0, DYNAMIC_KEY_PAIRS.length - 1), "gripper"];
    const map = {};
    dofs.forEach((short, i) => {
        const [pos, neg] = DYNAMIC_KEY_PAIRS[i];
        map[pos] = [short, 1];
        map[neg] = [short, -1];
    });
    return map;
}
export const BASE_KEYS = {
    i: ["linear", 1], k: ["linear", -1], j: ["angular", 1], l: ["angular", -1],
    // WASD alias for the same base DOFs. jogTick gives the ARM keymap first claim on a
    // key, so these only take effect while a leader source owns the arms (arm keys are
    // ignored then) — plain keyboard driving keeps WASD on the arm exactly as before.
    w: ["linear", 1], s: ["linear", -1], a: ["angular", 1], d: ["angular", -1],
};
export const ZLIFT_KEYS = { u: 1, o: -1 };
export const CMD_KEYS = { " ": "estop", p: "reset_latch", c: "reset" };
// Collapse a `key -> [dof, ±1]` map into per-DOF +/- rows, preserving first-seen order so
// the legend reads in the same order as the physical key layout.
function rowsFromAxisMap(map) {
    const byDof = new Map();
    for (const [key, [dof, sign]] of Object.entries(map)) {
        const row = byDof.get(dof) ?? { dof, posKey: "", negKey: "" };
        // First key wins per (dof, sign) so alias keys (WASD on the base) don't displace
        // the primary binding in the legend.
        if (sign > 0)
            row.posKey || (row.posKey = key);
        else
            row.negKey || (row.negKey = key);
        byDof.set(dof, row);
    }
    return [...byDof.values()];
}
// Split BASE_KEYS (in declaration order) into complete inverted-T clusters for keypad-style
// legends — primary IJKL first, then the WASD alias. Derived from the live map so the
// legend can never drift from what the keys actually send (C3).
export function baseKeyClusters() {
    const clusters = [];
    let cur = {};
    for (const [key, [dof, sign]] of Object.entries(BASE_KEYS)) {
        const slot = dof === "linear" ? (sign > 0 ? "forward" : "back") : sign > 0 ? "left" : "right";
        if (cur[slot] !== undefined) {
            clusters.push(cur);
            cur = {};
        }
        cur[slot] = key;
    }
    if (Object.keys(cur).length)
        clusters.push(cur);
    return clusters;
}
// Structured control legend for a given mode — derived from the exported maps above so it
// can never drift from what the keys actually send.
export function keybindLegend(mode, jointShorts, 
// Descriptor threads the task vocabulary the same way jointShorts threads the L3
// per-motor one: with jog_scale.task advertised (A3) the legend shows yaw/z;
// omitted/null (every L2) renders the exact legacy legend.
descriptor) {
    const [u, o] = Object.entries(ZLIFT_KEYS).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    // "(selected arm)" is an L-series fact: one rail per arm, u/o drive whichever
    // arm is selected. An A-series robot has ONE central column (descriptor aux
    // "lift"), where the qualifier is wrong — both arms ride the same lift.
    const axes = liftAxes(descriptor ?? undefined);
    const liftDof = axes.length > 0 && axes.every((a) => a.side === null)
        ? "lift" : "lift (selected arm)";
    return {
        arm: rowsFromAxisMap(mode === "joint"
            ? (jointShorts ? jointKeymapForShorts(jointShorts) : JOINT_KEYS)
            : taskKeymapFor(descriptor)),
        base: rowsFromAxisMap(BASE_KEYS),
        lift: { dof: liftDof, posKey: u, negKey: o },
        commands: [
            { key: "SPACE", label: "E-STOP" },
            { key: "P", label: "reset latch" },
            { key: "C", label: "reset" },
            { key: "M", label: "toggle mode" },
        ],
    };
}
const JOG_HZ_MS = 20; // 50 Hz level-jog
const BUFFER_LIMIT = 16384; // skip a jog frame if the channel is congested
export class RemoteTeleop {
    constructor(opts) {
        this.pc = null;
        this.remoteSet = false;
        this.pendingIce = [];
        this.connected = false;
        this.retryTimer = null;
        this.latencyProbe = null; // R-X.2 audio-latency harness (per peer)
        this.videoLoop = null; // ABR loop (videoQuality.ts, per peer)
        this.jogTimer = null;
        this.controlCh = null;
        this.linkMode = null; // measured ICE path -> daemon watchdog
        // Connect-phase machine (see ConnectStatus). `waitTimer` is the "robot never answered" deadline.
        this.connStatus = { phase: "idle" };
        this.waitTimer = null;
        this.mode = "cylindrical";
        // When non-null, the jog tick sends this payload instead of the keyboard-derived one
        // (set by the VR session each frame; null = keyboard owns the stream). An all-zeros
        // payload is a deliberate "hold" (e.g. clutch released) — distinct from null.
        this.externalJog = null;
        // When non-null, the jog tick attaches these ABSOLUTE leader targets to the control
        // frame (arms follow the physical leader arms); base + lift still come from the keyboard.
        // Set by the leader driver each poll; null = no leader source (arms owned by keyboard/VR).
        this.externalLeader = null;
        // Keyboard jog speed in (0..1] — scales every held-key rate (arm, base, lift) before it
        // goes on the wire. 1 (default) = the daemon's full per-tick step, i.e. legacy behavior.
        // Keyboard-only: VR carries its own tuning (VrJogMapper.setTuning) and passes through
        // externalJog untouched; leader targets are absolute and unaffected.
        this.keyboardSpeed = 1;
        // When true, an autonomous policy owns the control stream via sendAction(): the 50 Hz
        // jog tick yields entirely so its ever-present "hold" frame (idle zero-jog, or a
        // leader's absolute targets) can't out-vote the policy's ~10 Hz absolute actions and
        // pin the arm. Set by PolicyRunner around a rollout. See jogTick + setPolicyDriving.
        this.policyDriving = false;
        // Last inbound robot media streams, remembered so setVideoEl/setAudioEl can re-point a fresh
        // DOM element at the live stream after a page swap (the session can outlive the page that
        // rendered the original <video>/<audio>). See setVideoEl below.
        this.inboundVideo = null;
        this.inboundAudio = null;
        // Desired robot-video state. Remembered so a pause/resume issued before the control channel is
        // open (e.g. pause-on-connect for power saving) is applied the moment it opens, not lost.
        this.videoPaused = false;
        this.seq = 0; // monotonic control-frame counter (nori-protocol control.seq)
        this.pressed = new Set();
        this.cmdDown = new Set();
        // loop_hz / temp / status only ride the periodic telemetry block, not every per-tick
        // frame — keep last values so the readout doesn't flicker to 0.
        this.tel = {
            loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false, linkMode: null, currents: {},
            state: {}, videoNet: null, batteryPercent: null, motorFaults: {}, servoTemps: {}, latchReason: null,
        };
        this.stopped = false;
        // Latest world-state from the daemon perception process (Phase F). null until a frame arrives
        // (or forever, if the on-Pi detector isn't running — perceive() then returns null and scripts
        // fall back to blind/telemetry-only behavior). Fed on the control channel like telemetry.
        this.perception = null;
        // ---- action completion (Phase E / G1) ------------------------------------
        this.actionSeq = 0; // mints unique action_ids
        // Pending awaitAction() promises, keyed by action_id; resolved on the terminal action_status.
        this.actionWaiters = new Map();
        // Latest status seen per action_id (any state), so the executor can tell whether the daemon is
        // participating (Phase-E-capable) vs. silent (fall back to client-side detection). Pruned on
        // terminal + size-capped so it can't grow unbounded.
        this.latestActionStatus = new Map();
        // Composite camera layout from the bridge (Phase F vision), null until it arrives / single-cam.
        this.cameraLayoutRaw = null;
        this.daemonStat = null; // latest daemon_status (bridge health frame)
        this.recStat = null; // latest record_status (W2.11 recorder reply)
        this.psStat = null; // latest policy_stream_status
        this.psWaiters = []; // FIFO, one per in-flight policyStream()
        this.navigationStat = null;
        this.navigationWaiters = new Map();
        this.navigationGoalWaiters = new Map();
        this.sensorStat = null;
        this.lidarStat = null;
        this.imuStat = null;
        this.sensorWaiters = new Map();
        // The parsed handshake ack (P4.1). null until the daemon's ack arrives; refreshed on every
        // daemon (re)connect (a fresh offer means a fresh session, and the daemon re-acks).
        this.ackInfo = null;
        // ---- two-way call (Phase 7 §B) -------------------------------------------
        this.micStream = null;
        this.micTrack = null;
        this.camStream = null;
        this.camTrack = null;
        // Outbound CLIP audio (laptop file/TTS/Web-Audio -> robot speaker). Shares the ONE audio
        // uplink transceiver with the mic, so while a clip plays it owns the uplink; sending null
        // hands the uplink back to the mic (if a call is live) or detaches. The track itself is
        // owned by the CALLER (built from an <audio>/AudioContext) — the SDK only references it.
        this.clipTrack = null;
        this.call = {
            active: false, micMuted: true, micSending: false,
            robotAudio: false, robotMicLive: false, robotMicMuted: false, cameraOn: false,
        };
        this.log = (...a) => this.o.onLog(a.join(" "));
        // estopConfirmed(): resolvers waiting for the NEXT wire-reported "latched" safety state.
        this.estopWaiters = [];
        // NOTE: the handshake lives in `ackInfo` (declared above) and is read through the public
        // robotInfo() accessor. There used to be a SECOND private field named `robotInfo` here
        // holding the same value — which shadowed that method on every instance, so
        // `teleop.robotInfo()` threw "is not a function" for the whole life of the session.
        this.dynamicKeymap = null;
        this.o = opts;
        if (opts.mode)
            this.mode = opts.mode;
    }
    setArm(arm) {
        this.o.arm = arm;
    }
    // Re-point the robot's inbound VIDEO at a (new) element, or detach with null. This lets one
    // persistent session render on whichever page is currently mounted: a page sets its <video> on
    // mount and passes null on unmount, without tearing down the peer connection. Immediately
    // attaches the live stream if one has already arrived.
    setVideoEl(el) {
        this.o.videoEl = el ?? undefined; // usages are null-guarded (ontrack + here)
        if (el && this.inboundVideo && el.srcObject !== this.inboundVideo) {
            el.srcObject = this.inboundVideo;
        }
    }
    // Re-point the robot's inbound AUDIO sink (mirrors setVideoEl). Preserves the call-mute policy.
    setAudioEl(el) {
        this.o.audioEl = el ?? undefined;
        if (el) {
            if (this.inboundAudio && el.srcObject !== this.inboundAudio)
                el.srcObject = this.inboundAudio;
            el.muted = !this.call.active;
        }
    }
    // The robot's inbound video as a raw MediaStream (null until the track arrives). For
    // consumers that don't want a DOM <video> at all — canvas pipelines, ML/CV frame
    // grabbing, MediaRecorder. The stream is the live composite (or single-camera) feed;
    // don't stop() its tracks — they belong to the peer connection. (P4.6)
    videoStream() {
        return this.inboundVideo;
    }
    // A cropped per-camera view of the composite feed (P4.6). The robot sends ONE composite
    // H.264 track (tiled grid, see cameraLayoutInfo()); this crops the named tile into its
    // own MediaStream via canvas.captureStream, so `cameraView("left_wrist")` replaces
    // hand-rolled quadrant math. Returns null until BOTH the video track and the bridge's
    // camera_layout frame have arrived (poll or use onCameraLayout), or if `role` isn't in
    // the layout (single-camera mode has no layout — use videoStream() there).
    // The crop rect is recomputed every frame from the video's live dimensions, so it
    // survives a mid-session encode-resolution change. Call handle.stop() when done — the
    // draw loop costs CPU per view. The source track is never touched.
    cameraView(role, opts) {
        const layout = this.cameraLayoutRaw;
        const src = this.inboundVideo;
        if (!layout || !src)
            return null;
        const idx = layout.tiles.indexOf(role);
        if (idx < 0)
            return null;
        const fps = opts?.fps && opts.fps > 0 ? opts.fps : 15;
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = src;
        // The draw loop below is driven by requestVideoFrameCallback, which only fires
        // when a frame is PRESENTED to the compositor. A detached <video> (never in the
        // DOM) is never presented, so rvfc never fires, drawImage never runs, and the
        // captured crop stream stays empty (0x0) — the "policy drives but nothing moves"
        // failure. Keep the element in the render tree but visually gone so it decodes.
        video.style.cssText =
            "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
        void video.play().catch(() => { });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return null;
        let stopped = false;
        // Prefer requestVideoFrameCallback (fires per decoded frame — no wasted draws);
        // fall back to a plain timer at the requested fps.
        const rvfc = video.requestVideoFrameCallback?.bind(video);
        const schedule = () => {
            if (stopped)
                return;
            if (rvfc)
                rvfc(draw);
            else
                setTimeout(draw, 1000 / fps);
        };
        const draw = () => {
            if (stopped)
                return;
            const r = cameraTileRect(layout, role, video.videoWidth, video.videoHeight);
            if (r) {
                const cw = Math.max(2, Math.round(r.sw));
                const ch = Math.max(2, Math.round(r.sh));
                if (canvas.width !== cw || canvas.height !== ch) {
                    canvas.width = cw;
                    canvas.height = ch;
                }
                ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, cw, ch);
            }
            schedule();
        };
        schedule();
        const stream = canvas.captureStream(fps);
        return {
            stream,
            role,
            stop() {
                stopped = true;
                video.srcObject = null;
                video.remove();
                for (const t of stream.getTracks())
                    t.stop();
            },
        };
    }
    // The follower arm the keyboard / selected-arm inputs currently target (the
    // on-screen arm switch). The leader driver reads this to route a SINGLE
    // connected leader to whichever arm is selected.
    getArm() {
        return this.o.arm;
    }
    // VR (or any external input mapper) hands the jog tick a ready jog payload. Pass null
    // to release the stream back to the keyboard. The next jogTick uses it as-is.
    setExternalJog(jog) {
        this.externalJog = jog;
    }
    // Keyboard jog speed (user setting). Takes effect on the next 50 Hz tick; clamped to
    // (0..1] so it can only slow keys down, never exceed the daemon's full rate.
    setKeyboardSpeed(s) {
        this.keyboardSpeed = Math.max(0.05, Math.min(1, s));
    }
    // Physical leader arms hand the jog tick their measured absolute targets (degrees /
    // gripper [0,100]) keyed "<side>_arm_<joint>.pos". Pass null to release the arms back to
    // the keyboard/VR. Coexists with jog: the leader owns the arms, base + lift stay on the
    // keyboard, so the operator can drive the base while the arms mirror the leaders.
    setLeaderAction(leader) {
        this.externalLeader = leader;
    }
    // Send ONE absolute-target control frame: {type:"control", action:{"<motor>.pos": value}}. Keys
    // are normalized "<side>_arm_<joint>.pos" ([-100,100]; grippers [0,100]) — identical to the
    // telemetry `state` namespace. The daemon LATCHES and holds the target, and a zero-jog does NOT
    // cancel it, so this coexists with the jog heartbeat. WARNING: the daemon applies `action` with
    // NO server-side slew — a far-from-current target lurches. Callers must ramp large moves
    // themselves (see ScriptDriver.moveTo). Base is not positionable this way (jog/velocity only).
    // Optional `actionId` (Phase E): the daemon echoes it in action_status transitions for this move,
    // so awaitAction(id) can resolve on the authoritative done/clamped/blocked/timeout. Untagged
    // frames (no id) are unchanged — the daemon just doesn't track them.
    sendAction(action, actionId) {
        const frame = { type: "control", seq: this.seq++, action };
        if (actionId)
            frame.action_id = actionId;
        this.dcSend(frame);
    }
    // Mint a fresh, unique action_id for a move (Phase E). Human-readable for logs.
    nextActionId() {
        return `a${++this.actionSeq}`;
    }
    // Send an absolute Cartesian pose target for ONE arm's gripper TCP (nori-protocol
    // control.pose; capability "pose_targets"). The robot solves IK ON-BOARD — the wire never
    // carries joint solutions — then latches and tracks the result exactly like sendAction:
    // a zero jog does not cancel it, the watchdog's t_stop drops it. Lifecycle rides the
    // action_id through action_status (awaitAction resolves on the terminal state; the
    // intermediate "active" means solved-and-tracking). Failure is a modelled `blocked`
    // reason, not an exception: "no_ik_solution" (full pose: not retriable at this lift
    // height; position-only: wrist-dependent, retry with an orientation), "ik_timeout"
    // (retry), "limit:<joint>", "singularity", "collision", "lift_moved" (re-send to
    // re-solve), "config_jump" (split the move into waypoints), "frame:<name>".
    //
    // Conventions (NORMATIVE, nori-protocol control.json): metres in base_footprint, REP-103
    // (+x forward, +y left, +z up), quaternion [x, y, z, w]. OMIT the orientation for "get
    // the gripper to this point, any wrist angle" — the robot solves at its current wrist.
    //
    // THROWS if the robot's ack EXPLICITLY lacks "pose_targets" (the frame would be silently
    // ignored — a hung move with no error is worse than a throw). An ack that predates
    // capabilities entirely passes through: probe-or-assume-legacy is the ack contract.
    // Malformed vectors also throw here rather than costing a round trip to a "bad_pose".
    sendPose(side, positionM, orientationXyzw, actionId) {
        if (supportsCapability(this.ackInfo, "pose_targets") === false) {
            throw new Error("this robot does not advertise the pose_targets capability — a pose frame would " +
                "be silently ignored");
        }
        if (side !== "left" && side !== "right") {
            throw new Error(`sendPose: side must be "left" or "right", got ${String(side)}`);
        }
        if (positionM.length !== 3) {
            throw new Error(`sendPose: positionM needs [x, y, z] metres, got ${positionM.length}`);
        }
        if (orientationXyzw !== undefined && orientationXyzw.length !== 4) {
            throw new Error(`sendPose: orientationXyzw needs [x, y, z, w], got ${orientationXyzw.length}`);
        }
        const target = {
            frame: "base_footprint",
            position_m: [...positionM],
        };
        if (orientationXyzw !== undefined)
            target.orientation_xyzw = [...orientationXyzw];
        const frame = {
            type: "control", seq: this.seq++, pose: { [`${side}_arm`]: target },
        };
        if (actionId)
            frame.action_id = actionId;
        this.dcSend(frame);
    }
    requestUuid() {
        const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
        if (randomUUID)
            return randomUUID();
        // RFC 4122 v4 fallback for older WebViews; correlation, not a secret.
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = Math.floor(Math.random() * 16);
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    }
    // A status the CLIENT invents when the robot's reply never arrives. It carries the
    // robot's own last words forward instead of asserting the robot stopped: synthesizing
    // `active: false` here would let a caller read a lost reply as a halted robot. See
    // NavigationStatus.unreachable.
    unreachableNavigation(error, fields = {}) {
        // Only carry the cache forward when it describes the goal being asked about — a
        // snapshot of a DIFFERENT goal says nothing about this one.
        const last = this.navigationStat;
        const carry = last && (fields.goalId === undefined || last.goalId === fields.goalId)
            ? last : null;
        const status = {
            ok: false,
            state: carry?.state ?? "unavailable",
            active: carry?.active ?? false,
            unreachable: true,
            error,
        };
        if (fields.requestId !== undefined)
            status.requestId = fields.requestId;
        if (fields.goalId !== undefined)
            status.goalId = fields.goalId;
        if (fields.name !== undefined)
            status.name = fields.name;
        return status;
    }
    unreachableSensorStream(requestId, error) {
        const last = this.sensorStat;
        return {
            ok: false,
            requestId,
            lidarHz: last?.lidarHz ?? 0,
            imuHz: last?.imuHz ?? 0,
            lidarMaxPoints: last?.lidarMaxPoints ?? 360,
            lidarAvailable: last?.lidarAvailable ?? false,
            imuAvailable: last?.imuAvailable ?? false,
            unreachable: true,
            error,
        };
    }
    navigationRequest(action, fields = {}, timeoutMs = 5000) {
        if (supportsCapability(this.ackInfo, "named_navigation") === false) {
            return Promise.reject(new Error("this robot does not advertise the named_navigation capability"));
        }
        const requestId = this.requestUuid();
        return new Promise((resolve) => {
            const frame = {
                type: "navigation",
                request_id: requestId,
                action,
                ...fields,
            };
            const timer = setTimeout(() => {
                const waiter = this.navigationWaiters.get(requestId);
                if (waiter)
                    clearInterval(waiter.retry);
                this.navigationWaiters.delete(requestId);
                resolve(this.unreachableNavigation(`navigation ${action}: no reply in ${timeoutMs}ms`, { requestId, goalId: fields.goal_id, name: fields.name }));
            }, timeoutMs);
            // Retrying the SAME request_id is safe by contract and recovers a lost
            // one-shot command or reply without ever starting a duplicate goal.
            const retry = setInterval(() => { this.dcSend(frame); }, 750);
            this.navigationWaiters.set(requestId, { resolve, timer, retry });
            const sent = this.dcSend(frame);
            if (!sent) {
                clearTimeout(timer);
                clearInterval(retry);
                this.navigationWaiters.delete(requestId);
                resolve(this.unreachableNavigation("navigation control channel is not open", { requestId, goalId: fields.goal_id, name: fields.name }));
            }
        });
    }
    listWaypoints(opts) {
        return this.navigationRequest("list_waypoints", {}, opts?.timeoutMs);
    }
    rememberWaypoint(name, opts) {
        return this.navigationRequest("remember_waypoint", { name }, opts?.timeoutMs);
    }
    deleteWaypoint(name, opts) {
        return this.navigationRequest("delete_waypoint", { name }, opts?.timeoutMs);
    }
    navigateToWaypoint(name, opts) {
        return this.navigationRequest("start", { name, goal_id: this.requestUuid() }, opts?.timeoutMs);
    }
    cancelNavigation(goalId, opts) {
        return this.navigationRequest("cancel", goalId ? { goal_id: goalId } : {}, opts?.timeoutMs);
    }
    getNavigationStatus(opts) {
        return this.navigationRequest("status", {}, opts?.timeoutMs);
    }
    latestNavigationStatus() {
        return this.navigationStat;
    }
    awaitNavigation(goalId, opts) {
        const current = this.navigationStat;
        if (current?.goalId === goalId && TERMINAL_NAVIGATION_STATES.has(current.state)) {
            return Promise.resolve(current);
        }
        const timeoutMs = opts?.timeoutMs ?? 120000;
        return new Promise((resolve) => {
            const previous = this.navigationGoalWaiters.get(goalId);
            if (previous) {
                clearTimeout(previous.timer);
                previous.resolve(this.unreachableNavigation("awaitNavigation replaced by a newer waiter for this goal", { goalId }));
            }
            const timer = setTimeout(() => {
                this.navigationGoalWaiters.delete(goalId);
                resolve(this.unreachableNavigation(`navigation goal did not finish in ${timeoutMs}ms`, { goalId }));
            }, timeoutMs);
            this.navigationGoalWaiters.set(goalId, { resolve, timer });
        });
    }
    sensorRequest(action, config = {}, timeoutMs = 5000) {
        if (supportsCapability(this.ackInfo, "sensor_streams") === false) {
            return Promise.reject(new Error("this robot does not advertise the sensor_streams capability"));
        }
        const fields = {};
        const invalid = (value, min, max) => value !== undefined && (!Number.isFinite(value) || value < min || value > max);
        if (invalid(config.lidarHz, 0, 10)) {
            return Promise.reject(new Error("lidarHz must be between 0 and 10"));
        }
        if (invalid(config.imuHz, 0, 50)) {
            return Promise.reject(new Error("imuHz must be between 0 and 50"));
        }
        if (config.lidarMaxPoints !== undefined &&
            (!Number.isInteger(config.lidarMaxPoints) ||
                config.lidarMaxPoints < 16 || config.lidarMaxPoints > 1440)) {
            return Promise.reject(new Error("lidarMaxPoints must be an integer between 16 and 1440"));
        }
        if (config.lidarHz !== undefined)
            fields.lidar_hz = config.lidarHz;
        if (config.imuHz !== undefined)
            fields.imu_hz = config.imuHz;
        if (config.lidarMaxPoints !== undefined)
            fields.lidar_max_points = config.lidarMaxPoints;
        if (action === "configure" && Object.keys(fields).length === 0) {
            return Promise.reject(new Error("configureSensorStreams requires at least one setting"));
        }
        const requestId = this.requestUuid();
        const frame = {
            type: "sensor_stream", request_id: requestId, action, ...fields,
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const waiter = this.sensorWaiters.get(requestId);
                if (waiter)
                    clearInterval(waiter.retry);
                this.sensorWaiters.delete(requestId);
                resolve(this.unreachableSensorStream(requestId, `sensor_stream ${action}: no reply in ${timeoutMs}ms`));
            }, timeoutMs);
            const retry = setInterval(() => { this.dcSend(frame); }, 750);
            this.sensorWaiters.set(requestId, { resolve, timer, retry });
            if (!this.dcSend(frame)) {
                clearTimeout(timer);
                clearInterval(retry);
                this.sensorWaiters.delete(requestId);
                resolve(this.unreachableSensorStream(requestId, "sensor stream control channel is not open"));
            }
        });
    }
    /** Configure either stream. Omitted settings retain their current robot-side value. */
    configureSensorStreams(config, opts) {
        return this.sensorRequest("configure", config, opts?.timeoutMs);
    }
    getSensorStreamStatus(opts) {
        return this.sensorRequest("status", {}, opts?.timeoutMs);
    }
    latestSensorStreamStatus() { return this.sensorStat; }
    latestLidarScan() { return this.lidarStat; }
    latestImuSample() { return this.imuStat; }
    // Drive the robot's policy streamer (STREAM_INTEGRATION_PLAN §3): the observation
    // leg of remote inference. `start` makes the ROBOT dial out to `target` (the
    // lelab receiver from /nori/rollout/stream/open) and push full-quality frames.
    // Resolves with the robot's reply, or a synthetic timeout error after `timeoutMs`
    // — never rejects (the awaitAction contract). Default 12 s because the robot-side
    // relay legitimately blocks up to ~8 s on `start` (sink connect + preamble); a
    // shorter wait reports "timeout" while the stream then actually starts.
    policyStream(action, opts) {
        const frame = { type: "policy_stream", action };
        if (opts?.dest)
            frame.dest = opts.dest;
        if (opts?.target)
            frame.target = opts.target;
        // Pentest V10 sink auth: the robot must echo this token in its stream preamble.
        // Travels over the authenticated datachannel, so an off-channel attacker never sees it.
        if (opts?.token)
            frame.token = opts.token;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const i = this.psWaiters.indexOf(entry);
                if (i >= 0)
                    this.psWaiters.splice(i, 1);
                resolve({ ok: false, streaming: false, dest: null,
                    error: `policy_stream ${action}: no reply in ${opts?.timeoutMs ?? 12000}ms` });
            }, opts?.timeoutMs ?? 12000);
            const entry = (s) => { clearTimeout(timer); resolve(s); };
            this.psWaiters.push(entry);
            this.dcSend(frame);
        });
    }
    // Latest policy_stream_status seen (any), or null. The mid-run death statuses
    // ("sink timeout", "camera silence") land here even with no command in flight.
    policyStreamStatus() {
        return this.psStat;
    }
    // Hand the arms to an autonomous policy (or take them back). While on, the 50 Hz
    // jog tick drops the leader's absolute targets and held keys so only sendAction()
    // drives the arms — otherwise the ever-present jog frame out-votes the policy and
    // the arm never reaches the commanded pose. Call setPolicyDriving(false) to restore
    // normal keyboard/leader control. See jogTick.
    setPolicyDriving(on) {
        this.policyDriving = on;
    }
    // Latest action_status seen for `id` (any state), or null. The executor uses this to detect
    // whether the daemon is Phase-E-capable (any status seen) vs. silent (old daemon → fall back to
    // client-side arrival detection).
    actionStatus(id) {
        return this.latestActionStatus.get(id) ?? null;
    }
    // Resolve when the daemon reports a TERMINAL action_status for `id` (done/clamped/blocked/timeout).
    // Falls back to a synthetic { state:"timeout", reason:"client-fallback" } after timeoutMs so a
    // caller never hangs if the daemon predates Phase E or the transport drops. Never rejects.
    awaitAction(id, opts) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.actionWaiters.delete(id);
                resolve({ action_id: id, state: "timeout", reason: "client-fallback" });
            }, opts?.timeoutMs ?? 10000);
            this.actionWaiters.set(id, { resolve, timer });
        });
    }
    // Public command surface for non-keyboard inputs (VR E-STOP / reset). Mirrors sendCmd.
    // NOTE: command("estop") THROWS when the control channel is known-dead — see sendCmd.
    command(cmd) {
        this.sendCmd(cmd);
    }
    // Ask the robot to arm/disarm its motor buses (arbiter ownership on the robot side).
    // Fire-and-forget like ordinary verbs; the truthful armed state comes BACK on
    // daemon_status.armed — render that, never this call. Robots without arming support
    // ignore the verb and never report `armed`.
    setArmed(on) {
        this.dcSend({ type: "command", [on ? "arm" : "disarm"]: true });
        this.log(on ? "arm requested" : "disarm requested — support the arms; they de-torque");
    }
    // command("estop"), then await the robot REPORTING the latch in telemetry. Delivery is
    // not execution: the channel is unreliable by design (a sent frame can vanish in flight)
    // and the robot drops command frames with no reply while its motion stack is down.
    // Confirmation is OBSERVED STATE — a status block parsed off the wire AFTER the send;
    // the cached telemetry view is deliberately not consulted, because a stale "latched"
    // from minutes ago would confirm an estop that went nowhere. Rejects on a dead channel
    // (via command) and on timeout; the only safe reading of either is "the robot is NOT
    // stopped". Mirrors nori-sdk-py's estop_confirmed(). Default is 5 s, not 2: the latch
    // report crosses gateway -> safety node -> telemetry, and 2 s proved tight on a busy
    // stack (2026-08-26 bench).
    async estopConfirmed(timeoutMs = 5000) {
        let onLatched;
        const latched = new Promise((res) => { onLatched = res; });
        // Subscribed BEFORE the send, so a fast robot cannot report into the gap.
        this.estopWaiters.push(onLatched);
        try {
            this.command("estop"); // throws on a known-dead channel
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`estop sent but the robot never reported the latch within ${timeoutMs} ms — ` +
                    "assume it is NOT stopped (motion stack down, or the frame was lost)")), timeoutMs);
                latched.then(() => { clearTimeout(timer); resolve(); });
            });
        }
        finally {
            const i = this.estopWaiters.indexOf(onLatched);
            if (i >= 0)
                this.estopWaiters.splice(i, 1);
        }
    }
    // Ask the robot to drop / restore its camera-encoder bitrate to free CPU+bandwidth while
    // the laptop adds load (e.g. streaming a clip to the speaker). "low" cuts the x264 bitrate
    // on the robot; "normal" restores the default; a NUMBER requests that exact kbps (clamped
    // robot-side to its --bitrate ceiling — this is what the ABR loop streams). Intercepted by
    // webrtc_robot.py (never reaches the daemon), exactly like {type:"call"} — no nori-protocol
    // change, no version bump. NOTE: while connected, the ABR loop re-asserts its own target
    // every second, so a manual value only sticks if the loop is stopped first.
    setVideoQuality(quality) {
        this.dcSend(typeof quality === "number"
            ? { type: "video", bitrate: quality }
            : { type: "video", quality });
    }
    // W2.11 on-robot episode recording: drive the robot's always-on recorder (the Pi
    // spools full-quality frames + telemetry + actions for policy training — NOT the
    // degraded live stream you're watching). Bridge-intercepted like {type:"video"}/
    // {type:"call"} — never reaches the daemon, no nori-protocol change. The reply
    // arrives as onRecord / recordState(); a robot with recording disabled answers
    // {ok:false, error:"recorder unreachable"} within ~1 s rather than staying silent.
    //
    // Two-tier protocol (W2.11 one-bundle-per-session — a session ships as ONE
    // raw_bundle holding N episodes):
    //   session_start {task} -> episode_start -> episode_stop [-> episode_discard]
    //     (repeat episodes) -> session_end (keep+ship) | session_discard (drop all)
    //   - episode_discard: Reject the just-recorded episode (deletes its robot copy;
    //     other kept episodes stay). Safe because Reject is while still connected, so
    //     the idle-gated shipper hasn't uploaded the session yet.
    //   - session_end: close the session; it uploads when the robot next idles.
    // Legacy one-episode aliases (kept for the bench page / auto mode): start {task}
    // = session_start+episode_start; stop = episode_stop+session_end; discard /
    // discard_last = session_discard.
    record(action, task, opts) {
        const msg = { type: "record", action };
        // Task rides episode_start too: if session_start dropped on the unreliable
        // control channel, the robot auto-opens a session on episode_start and needs
        // the task from here so it isn't lost.
        if (action === "start" || action === "session_start" || action === "episode_start") {
            if (task)
                msg.task = task;
            if (opts?.stereo)
                msg.stereo = true;
        }
        this.dcSend(msg);
    }
    // Pause/resume the robot's video ENCODER (not just the DOM sink). "pause" gates frames before
    // the software x264 encoder so it goes idle — the real Pi CPU/power saving; "resume" re-opens it
    // and the robot forces a fresh keyframe. Use this to keep video off unless a page is showing it.
    // Safe to call before the control channel is open — the desired state is flushed on open.
    pauseVideo() { this.setVideoPaused(true); }
    resumeVideo() { this.setVideoPaused(false); }
    /** Current encoder gate state, so a transient consumer (e.g. a policy rollout that
     *  force-resumes to grab frames) can RESTORE what it found instead of blindly
     *  pausing on exit — blindly pausing freezes the preview of a page still on screen. */
    isVideoPaused() { return this.videoPaused; }
    setVideoPaused(paused) {
        this.videoPaused = paused;
        this.dcSend({ type: "video", state: paused ? "pause" : "resume" });
    }
    // Grab a still frame from the robot's inbound video WITHOUT needing a <video> on screen — reads
    // the live track directly. Returns null if no video is arriving (not connected, or paused with no
    // frames). Prefer snapshot() if the encoder may be paused; this one assumes frames are flowing.
    // `role` (optional) crops the named tile out of the composite (per-camera `look`): the crop rect
    // comes from cameraTileRect + the bridge's camera_layout. When role is given but the layout hasn't
    // arrived / doesn't contain it, this returns NULL — never the full composite. A silent fallback
    // would hand a caller (e.g. an LLM told "this is left_wrist") a mislabeled frame, which is worse
    // than no frame; the caller should report the unknown role instead.
    async captureFrame(mime = "image/jpeg", quality = 0.7, role) {
        const track = this.inboundVideo?.getVideoTracks?.()[0];
        if (!track || track.readyState !== "live")
            return null;
        try {
            // ImageCapture.grabFrame is experimental and missing from some TS lib.dom versions; add it
            // locally rather than depend on the ambient type.
            const capture = new ImageCapture(track);
            const bmp = await capture.grabFrame();
            let rect = { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height };
            if (role !== undefined) {
                const r = this.cameraLayoutRaw && cameraTileRect(this.cameraLayoutRaw, role, bmp.width, bmp.height);
                if (!r) {
                    bmp.close?.();
                    return null; // unknown role / no layout (single-camera mode): see contract above
                }
                rect = r;
            }
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(2, Math.round(rect.sw));
            canvas.height = Math.max(2, Math.round(rect.sh));
            const ctx = canvas.getContext("2d");
            if (!ctx)
                return null;
            ctx.drawImage(bmp, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
            bmp.close?.();
            return await new Promise((res) => canvas.toBlob((b) => res(b), mime, quality));
        }
        catch {
            return null; // ImageCapture unsupported or grab failed
        }
    }
    // Snapshot that handles a paused encoder: if video is paused, resume (which forces a keyframe on
    // the robot), wait briefly for a frame to arrive, grab it, then re-pause — so a still can be taken
    // for LLM vision etc. without leaving the encoder running. settleMs is the resume→frame wait.
    // `role` crops one camera tile (see captureFrame): the agent-loop `look {camera}` tool maps to
    // `snapshot(500, camera)`. Null on unknown role — report it, don't substitute the composite.
    async snapshot(settleMs = 500, role) {
        const wasPaused = this.videoPaused;
        if (wasPaused) {
            this.resumeVideo();
            await new Promise((res) => setTimeout(res, settleMs));
        }
        const blob = await this.captureFrame("image/jpeg", 0.7, role);
        if (wasPaused)
            this.pauseVideo();
        return blob;
    }
    // Flip cylindrical <-> per-motor from the UI (same effect as the 'm' key). onMode fires.
    toggleMode() {
        this.setMode(this.mode === "joint" ? "cylindrical" : "joint");
    }
    // ---- two-way call (Phase 7 §B) -------------------------------------------
    // All of the following are renegotiation-free (R-X.1): the operator's mic/camera are
    // attached to transceivers the robot offered up front via replaceTrack. If the robot has
    // not (yet) offered an audio/video uplink m-line, capture still succeeds locally but
    // micSending/cameraOn reflect that nothing is transmitted (Pi M3/M6 pending).
    callState() {
        return { ...this.call };
    }
    // Join the call: capture the mic (browser AEC/NS/AGC on as cheap insurance; the real fix
    // is robot-side hardware AEC, M3-D), wire it to the uplink if present, announce over the
    // control channel. Starts MUTED — the operator explicitly unmutes.
    async joinCall() {
        if (!this.micStream) {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            this.micTrack = this.micStream.getAudioTracks()[0] ?? null;
        }
        if (this.micTrack)
            this.micTrack.enabled = !this.call.micMuted;
        this.call.active = true;
        this.applyAudioSink(); // now in the call -> unmute the robot audio sink
        const wired = this.attachTrack("audio", this.micTrack);
        this.call.micSending = wired && !this.call.micMuted;
        if (!wired)
            this.log("mic captured, but robot offered no audio uplink — not transmitting (Pi M3 pending)");
        this.dcSend({ type: "call", state: "join", mic_muted: this.call.micMuted });
        this.emitCall();
        return this.callState();
    }
    // Leave the call: stop capture, detach from the uplink, announce.
    leaveCall() {
        this.detachTrack("audio");
        this.stopStream(this.micStream);
        this.micStream = null;
        this.micTrack = null;
        this.disableCamera();
        this.call.active = false;
        this.call.micSending = false;
        this.applyAudioSink(); // left the call -> mute the robot audio sink again
        this.dcSend({ type: "call", state: "leave" });
        this.emitCall();
    }
    // Mute/unmute the operator mic. A track.enabled flip — never a renegotiation.
    setMicMuted(muted) {
        this.call.micMuted = muted;
        if (this.micTrack)
            this.micTrack.enabled = !muted;
        this.call.micSending = this.call.active && !muted && !!this.audioSender();
        this.dcSend({ type: "call", mic_muted: muted });
        this.emitCall();
    }
    // M6 (gated): capture the operator camera and wire it to the reserved video uplink. Built
    // now, shipped dark — the page only calls this behind isM6VideoEnabled(). Returns the local
    // stream so the caller can show a self-view.
    async enableCamera() {
        if (!this.camStream) {
            this.camStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 }, // ≤480p (R-X.7: a 7" DSI needs no more)
            });
            this.camTrack = this.camStream.getVideoTracks()[0] ?? null;
        }
        const wired = this.attachTrack("video", this.camTrack);
        this.call.cameraOn = true;
        if (!wired)
            this.log("camera captured, but robot offered no video uplink — not transmitting (Pi M6 pending)");
        this.emitCall();
        return this.camStream;
    }
    disableCamera() {
        this.detachTrack("video");
        this.stopStream(this.camStream);
        this.camStream = null;
        this.camTrack = null;
        this.call.cameraOn = false;
        this.emitCall();
    }
    // Stream an arbitrary audio track (a decoded file, TTS, or Web-Audio graph) to the robot's
    // speaker over the SAME reserved audio uplink the two-way call uses — renegotiation-free
    // (replaceTrack onto the sendrecv transceiver the robot offered; R-X.1). This is the
    // laptop->robot M3b downlink with a NON-mic source; the robot's `_on_incoming_audio` links
    // whatever arrives on the audio m-line to its ALSA speaker.
    //
    //   const track = mediaStreamDestination.stream.getAudioTracks()[0]; // Web Audio, or
    //   const track = audioEl.captureStream().getAudioTracks()[0];       // <audio> element
    //   await teleop.sendClipAudio(track);   // ... on 'ended':  await teleop.sendClipAudio(null)
    //
    // Requirements & caveats:
    //  - The robot must run its voice downlink (webrtc_robot.py --voice / NORI_VOICE + a
    //    speaker). Only then is the audio m-line sendrecv and does the robot play what we send;
    //    otherwise capture succeeds locally but nothing transmits (returns false, logs).
    //  - ONE audio m-line: a clip and the mic can't transmit at once. Starting a clip takes the
    //    uplink; sendClipAudio(null) restores the mic if a call is active, else detaches.
    //  - Real-time Opus, not a file transfer: audio plays as it streams; a network drop drops
    //    the audio. The caller owns the track's lifetime (stop it when the source ends).
    //  - Consent-gated robots (§2.1-F accept-before-unmute): the clip:true announce below means
    //    a clip alone never rings the robot's accept prompt and never opens its room mic — the
    //    gate applies only when the operator joinCall()s to actually hear the room.
    // Returns whether the track was actually wired to a robot uplink.
    async sendClipAudio(track) {
        this.clipTrack = track;
        if (track) {
            const wired = this.attachTrack("audio", track);
            // Announce over the control channel like a call-join so the robot links its speaker
            // branch + shows "on air" (it intercepts {type:"call"} frames). clip:true marks it
            // speaker-only: consent-gated robots (§2.1-F) must NOT ring their accept prompt —
            // nobody is asking to hear the room — and must keep the room mic shut. Older robots
            // ignore the extra key (they ring; harmless). Skip if a call is already joined —
            // the uplink is already announced; we're just swapping the source.
            if (!this.call.active)
                this.dcSend({ type: "call", state: "join", mic_muted: true, clip: true });
            this.log(wired
                ? "clip audio -> robot speaker"
                : "clip audio: robot offered no audio uplink — enable --voice on the robot (not transmitting)");
            return wired;
        }
        // Stopping the clip: hand the uplink back to the mic if we're in a call, else detach and
        // announce leave (parity with leaveCall so the robot drops "on air").
        if (this.call.active && this.micTrack) {
            this.attachTrack("audio", this.micTrack);
            this.call.micSending = !this.call.micMuted && !!this.audioSender();
            this.emitCall();
        }
        else {
            this.detachTrack("audio");
            this.dcSend({ type: "call", state: "leave" });
        }
        return false;
    }
    emitCall() {
        this.o.onCall?.({ ...this.call });
    }
    // Robot audio only plays while the operator is in the call (mute the sink otherwise), so
    // merely connecting the session never leaks room audio.
    applyAudioSink() {
        if (this.o.audioEl)
            this.o.audioEl.muted = !this.call.active;
    }
    // Re-attach whatever the operator already captured onto the current peer (used after a
    // fresh peer is built mid-call). No-op if nothing captured.
    attachLocalMedia() {
        // Drop a stale clip ref (the app already stopped the track) so a dead track is never
        // re-piled onto a reconnecting session — every restart would otherwise accrete one.
        if (this.clipTrack && this.clipTrack.readyState !== "live")
            this.clipTrack = null;
        // A live clip owns the single audio uplink; otherwise the mic does. Re-assert that on the
        // fresh peer so clip playback survives a robot restart / reconnect mid-stream.
        if (this.clipTrack) {
            this.attachTrack("audio", this.clipTrack);
        }
        else if (this.micTrack) {
            const wired = this.attachTrack("audio", this.micTrack);
            this.call.micSending = wired && this.call.active && !this.call.micMuted;
        }
        if (this.camTrack)
            this.attachTrack("video", this.camTrack);
        this.emitCall();
    }
    // Find a transceiver of the given kind we can SEND on (the robot offered to receive from
    // us), and replaceTrack. Returns whether an uplink existed.
    attachTrack(kind, track) {
        if (!this.pc || !track)
            return false;
        const tr = this.sendTransceiver(kind);
        if (!tr)
            return false;
        try {
            tr.sender.replaceTrack(track);
            return true;
        }
        catch {
            return false;
        }
    }
    detachTrack(kind) {
        const tr = this.pc ? this.sendTransceiver(kind) : null;
        try {
            tr?.sender.replaceTrack(null);
        }
        catch { /* peer already gone */ }
    }
    audioSender() {
        return !!this.sendTransceiver("audio");
    }
    // The first transceiver of `kind` whose negotiated direction lets us send. Uses the
    // inbound receiver track's kind to identify the m-line's media type (reliable post-SRD).
    sendTransceiver(kind) {
        if (!this.pc)
            return null;
        const canSend = (d) => d === "sendrecv" || d === "sendonly";
        for (const t of this.pc.getTransceivers()) {
            if (t.receiver.track?.kind !== kind)
                continue;
            if (canSend(t.currentDirection) || canSend(t.direction))
                return t;
        }
        return null;
    }
    // True if the robot's offer invites our voice (audio m-line is sendrecv → the robot will
    // RECEIVE). We reserve the uplink only then; an M3a sendonly offer stays recvonly (no uplink).
    offerWantsAudioUplink(sdp) {
        let inAudio = false;
        for (const line of sdp.split(/\r?\n/)) {
            if (line.startsWith("m="))
                inAudio = line.startsWith("m=audio");
            else if (inAudio && line.startsWith("a=sendrecv"))
                return true;
        }
        return false;
    }
    stopStream(s) {
        s?.getTracks().forEach((t) => t.stop());
    }
    iceServers() {
        // An empty `stun` means "no STUN server", not "a server whose URL is the empty string":
        // RTCPeerConnection REJECTS `{urls: ""}` with a SyntaxError at construction, which would
        // take down the whole session. Omitting it is the valid configuration for the two cases
        // that legitimately need no STUN — same-LAN sessions (host candidates suffice) and the
        // in-page mock robot (@nori/sdk/mock), whose dev loop must not touch the network at all.
        const servers = this.o.stun ? [{ urls: this.o.stun }] : [];
        if (this.o.turnUrls.length) {
            servers.push({ urls: this.o.turnUrls, username: this.o.turnUser, credential: this.o.turnCred });
        }
        return servers;
    }
    // ---- connect phase machine -----------------------------------------------
    // Single writer for ConnectStatus. Deduped so a repeated transition (e.g. Supabase flapping
    // CHANNEL_ERROR) doesn't spam the UI or the log.
    setPhase(phase, reason, detail) {
        const prev = this.connStatus;
        if (prev.phase === phase && prev.reason === reason && prev.detail === detail)
            return;
        this.connStatus = { phase, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
        this.o.onConnectStatus?.(this.connStatus);
    }
    // Latest connect phase, for consumers that poll rather than subscribe.
    connectStatus() {
        return this.connStatus;
    }
    // Arm the "the robot never answered" deadline. Called when we enter `waiting`. NOTE this does
    // NOT stop the 2 s 'ready' retry loop — a robot that powers on two minutes late still connects
    // by itself. The deadline only governs when we admit to the operator that nothing is answering.
    armWaitDeadline() {
        if (this.waitTimer)
            clearTimeout(this.waitTimer);
        this.waitTimer = setTimeout(() => {
            this.waitTimer = null;
            if (this.stopped || this.connected)
                return;
            if (this.connStatus.phase !== "waiting")
                return; // an offer already moved us on
            this.log("no answer from the robot after " + Math.round(WAIT_FOR_ROBOT_MS / 1000) + "s");
            this.setPhase("failed", "robot_not_responding");
        }, WAIT_FOR_ROBOT_MS);
    }
    clearWaitDeadline() {
        if (this.waitTimer) {
            clearTimeout(this.waitTimer);
            this.waitTimer = null;
        }
    }
    // ---- lifecycle -----------------------------------------------------------
    async start() {
        this.stopped = false;
        this.setPhase("joining");
        if (this.o.forceRelay && !this.o.turnUrls.length) {
            this.log("force relay is on but no TURN URL set — connect will fail");
        }
        this.log(`ICE: STUN${this.o.turnUrls.length ? ` + TURN(${this.o.turnUrls.length})` : ""}` +
            (this.o.forceRelay ? "  [FORCE RELAY]" : ""));
        // All SDP/ICE + the room handshake ride the injected SignalingTransport (Supabase in the
        // fork, BYO for external SDK consumers). The WebRTC/auth/jog logic below is transport-agnostic.
        await this.o.signaling.connect({
            // a fresh offer => a fresh peer connection (handles robot restarts / reconnects)
            onSdp: async (payload) => {
                if (!payload || payload.type !== "offer")
                    return;
                // The robot answered — whatever else goes wrong from here, it is NOT absent, so the
                // "nobody is home" deadline is void.
                this.clearWaitDeadline();
                this.setPhase("negotiating");
                try {
                    this.log("offer received; building fresh peer + answering...");
                    const pc = this.freshPeer();
                    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
                    this.remoteSet = true;
                    for (const c of this.pendingIce) {
                        try {
                            await pc.addIceCandidate(c);
                        }
                        catch (e) {
                            this.log("ice warn", e.message);
                        }
                    }
                    this.pendingIce = [];
                    // Reserve the audio UPLINK before answering: the robot offers audio sendrecv (M3b), but a
                    // browser answers RECVONLY by default (it only agreed to receive the robot mic). Flip our
                    // audio transceiver to sendrecv now so the ANSWER advertises send — then joining the call
                    // is a pure replaceTrack, never a renegotiation (R-X.1). Only when the robot actually
                    // invites our voice, so the M3a sendonly path stays recvonly.
                    if (this.offerWantsAudioUplink(payload.sdp)) {
                        const at = pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");
                        if (at && at.direction !== "sendrecv") {
                            try {
                                at.direction = "sendrecv";
                                this.log("reserved audio uplink (sendrecv) for the call");
                            }
                            catch (e) {
                                this.log("could not reserve audio uplink:", e.message);
                            }
                        }
                    }
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.o.signaling.sendSdp({ type: "answer", sdp: answer.sdp ?? "" });
                    this.log("answer sent");
                    // If a call was already joined before (re)connect, re-wire mic/cam onto this fresh
                    // peer's transceivers. Pure replaceTrack — no renegotiation (R-X.1).
                    this.attachLocalMedia();
                }
                catch (e) {
                    // This whole body runs inside a signaling event callback, so a throw here used to
                    // become an unhandled rejection: the operator saw the session simply stop, with no
                    // error anywhere. Surface it instead.
                    const msg = e.message;
                    this.log("negotiation failed: " + msg);
                    this.setPhase("failed", "negotiation_failed", msg);
                }
            },
            onIce: async (payload) => {
                const cand = { candidate: payload.candidate, sdpMLineIndex: payload.sdpMLineIndex };
                if (this.pc && this.remoteSet) {
                    try {
                        await this.pc.addIceCandidate(cand);
                    }
                    catch (e) {
                        this.log("ice warn", e.message);
                    }
                }
                else {
                    this.pendingIce.push(cand);
                }
            },
            // robot (re)joined the room -> re-announce 'ready' so it (re)offers. The room token is
            // retired: the robot gates private-room access itself (Supabase RLS), so there's no HMAC
            // proof to compute here anymore — we just handshake.
            //
            // Do NOT clear `connected` here. The gateway broadcasts robot_here on EVERY room join —
            // including its own signaling auto-reconnect mid-session — and the only thing that ever
            // sets the flag back is pc.onconnectionstatechange, which never re-fires on a healthy
            // peer. Clearing it re-armed the 2 s ready-resend forever and disabled the live-session
            // guards on onNack/onState, so a stray nack or a routine CHANNEL_ERROR flap painted
            // `failed` over a session that was actively driving. The ready IS still sent: a gateway
            // that already has us dedupes re-readys, and a RESTARTED one (no session) needs it to
            // offer — its robot_here usually beats us noticing the dead peer. Same fix as the
            // Python SDK's _on_robot_here.
            onRobotHere: async () => {
                this.log("robot announced — sending 'ready'");
                this.sendReady();
            },
            // The robot refused our 'ready'. Report a concrete refusal immediately — no point waiting out
            // the deadline, the answer won't change. Advisory (a nack is forgeable by anyone in the room),
            // so it only picks the error copy; it never grants or denies anything.
            onNack: (payload) => {
                if (this.connected)
                    return; // a live session ignores late/stray nacks
                if (payload?.reason && payload.reason !== "unauthorized") {
                    this.log("robot refused the session: " + payload.reason);
                    this.clearWaitDeadline();
                    this.setPhase("failed", "session_rejected", payload.reason);
                    return;
                }
                // Room-token auth is retired (the robot gates access via Supabase RLS), so an
                // "unauthorized"/reasonless nack is now a stray or forged artifact rather than a wrong
                // access code. Ignore it and keep retrying 'ready' — an authorized operator that's in the
                // room will get an offer regardless.
                this.log("ignoring unauthorized nack (room-token auth retired — the robot gates access itself)");
            },
            onOpen: () => {
                // No `connected = false` here either (see onRobotHere): onOpen fires on every
                // signaling reconnect, and the connection-state callback owns that flag. The
                // retry loop below already no-ops while connected, so a live session never
                // chatters — and if the peer later drops, the same loop resumes announcing.
                this.sendReady();
                this.log("announced 'ready' — waiting for robot offer");
                // Only (re)enter `waiting` from a pre-connection phase. onOpen also fires on a mid-session
                // signaling reconnect, and that must not knock a live session back to "waiting".
                if (this.connStatus.phase === "joining" || this.connStatus.phase === "failed") {
                    this.setPhase("waiting");
                    this.armWaitDeadline();
                }
                if (this.retryTimer)
                    clearInterval(this.retryTimer);
                this.retryTimer = setInterval(() => { if (!this.connected)
                    this.sendReady(); }, 2000);
            },
            // Transport health. Distinct from robot health: this is "can we reach the room at all".
            // supabase-js retries underneath, so we report the outage but never tear the session down —
            // if it recovers, onOpen fires again and we go back to waiting for the robot.
            onState: (state) => {
                if (state === "error" || state === "timeout") {
                    if (this.connected)
                        return; // a live session rides out a signaling blip; media is P2P
                    this.setPhase("failed", "signaling_unreachable", state);
                }
            },
        });
        if (!this.jogTimer)
            this.jogTimer = setInterval(() => this.jogTick(), JOG_HZ_MS);
    }
    async stop() {
        this.stopped = true;
        this.pressed.clear();
        // release mic/camera capture (safe if never joined)
        this.stopStream(this.micStream);
        this.micStream = null;
        this.micTrack = null;
        this.stopStream(this.camStream);
        this.camStream = null;
        this.camTrack = null;
        this.clipTrack = null; // caller owns the clip track's lifetime; just drop our reference
        this.call = {
            active: false, micMuted: true, micSending: false,
            robotAudio: false, robotMicLive: false, robotMicMuted: false, cameraOn: false,
        };
        this.emitCall();
        // Recorder knowledge is stale once disconnected (auto mode stops on camera
        // silence anyway) — a fresh session re-probes with record("status").
        this.recStat = null;
        // Drain the waiters BEFORE clearing the caches: the robot's last reported state is
        // exactly what an unreachable status carries forward, and it is most worth having
        // here. The gateway cancels this session's goal on disconnect, but that is
        // best-effort and unconfirmable from here, so none of these claim the robot stopped.
        for (const [requestId, waiter] of this.navigationWaiters) {
            clearTimeout(waiter.timer);
            clearInterval(waiter.retry);
            waiter.resolve(this.unreachableNavigation("navigation session closed", { requestId }));
        }
        this.navigationWaiters.clear();
        for (const [goalId, waiter] of this.navigationGoalWaiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(this.unreachableNavigation("navigation session closed", { goalId }));
        }
        this.navigationGoalWaiters.clear();
        for (const [requestId, waiter] of this.sensorWaiters) {
            clearTimeout(waiter.timer);
            clearInterval(waiter.retry);
            waiter.resolve(this.unreachableSensorStream(requestId, "sensor stream session closed"));
        }
        this.sensorWaiters.clear();
        this.navigationStat = null;
        this.sensorStat = null;
        this.lidarStat = null;
        this.imuStat = null;
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.jogTimer) {
            clearInterval(this.jogTimer);
            this.jogTimer = null;
        }
        this.clearWaitDeadline();
        this.latencyProbe?.stop();
        this.videoLoop?.stop();
        this.tel.videoNet = null;
        // tell the robot to exit (clean restart) before we tear down
        this.o.signaling.sendBye();
        if (this.pc) {
            try {
                this.pc.close();
            }
            catch { /* noop */ }
            this.pc = null;
        }
        await this.o.signaling.close();
        this.controlCh = null;
        this.connected = false;
        this.tel.active = false;
        this.o.onTelemetry({ ...this.tel });
        this.o.onControlActive(false);
        this.o.onConnState("closed");
        // Back to a clean slate: a deliberate Disconnect must not leave a failure banner on screen.
        this.setPhase("idle");
    }
    // On-demand audio-latency snapshot (R-X.2). Logs + returns the network+jitter-buffer breakdown;
    // null if there's no active peer yet. Also auto-runs every 3 s when the page URL has ?audiolatency.
    async logAudioLatency() {
        return this.latencyProbe ? this.latencyProbe.logOnce() : null;
    }
    sendReady() {
        // Forward this session's TURN creds so the ROBOT can gather relay candidates
        // too. Without them a host-only robot is unreachable through a relay (the
        // relay can't route to LAN/tailnet addrs, and coturn drops the robot's
        // inbound checks — its public addr was never signaled, so no permission
        // exists). Creds are short-lived and backend-minted; see ReadyTurn.
        const turn = this.o.turnUrls.length
            ? { urls: this.o.turnUrls, username: this.o.turnUser, credential: this.o.turnCred }
            : undefined;
        // Pentest V1: carry the DTLS-fingerprint-bound session grant so the robot can authorize
        // motion independently of Supabase RLS. Inert until the gateway's require_session_grant
        // flag flips; a warm-mode gateway ignores an unknown sibling.
        // NOTE (open, coordinate with the gateway half): the gateway DEDUPES `ready`
        // (_start_session returns if a session already exists), so re-sending `ready` won't
        // deliver a REFRESHED grant for the in-session re-verify (V8). The initial-handshake
        // grant below is correct; the ~90s refresh transport (re-sent ready vs a datachannel
        // control frame) is pending the gateway's re-verify mechanism — not built here yet.
        this.o.signaling.sendReady({
            ...(turn ? { turn } : {}),
            ...(this.o.sessionGrant ? { grant: this.o.sessionGrant } : {}),
        });
    }
    freshPeer() {
        if (this.pc) {
            try {
                this.pc.close();
            }
            catch { /* noop */ }
        }
        this.remoteSet = false;
        this.pendingIce = [];
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers(),
            iceTransportPolicy: this.o.forceRelay ? "relay" : "all",
            // Pentest V1: pin the DTLS identity to the pre-generated cert the session grant is bound
            // to (getFingerprints() of this cert == the grant's dtls_fp). Omitted => auto-generated
            // cert (anonymous/legacy path). Must be set at construction; a cert can't be swapped in.
            ...(this.o.cert ? { certificates: [this.o.cert] } : {}),
        });
        this.pc = pc;
        this.latencyProbe?.stop();
        this.latencyProbe = new AudioLatencyProbe(pc, (...a) => this.log(...a));
        // ABR loop (videoQuality.ts): per peer like the latency probe; started on `connected`.
        // Suspends itself while the encoder is paused (a 0 fps sample there is not congestion).
        this.videoLoop?.stop();
        this.videoLoop = new VideoQualityLoop(pc, {
            sendTarget: (kbps) => this.dcSend({ type: "video", bitrate: kbps }),
            paused: () => this.videoPaused,
            onState: (s) => {
                const prev = this.tel.videoNet?.quality;
                this.tel.videoNet = s;
                // Telemetry normally flows at 50 Hz and carries videoNet with it, but when the daemon
                // is down that stream is silent — emit on the 1 Hz tick so the net chip stays live.
                this.o.onTelemetry({ ...this.tel });
                if (s.quality !== prev && (s.quality !== "good" || prev !== undefined)) {
                    this.log(`video link ${s.quality}: loss ${s.lossPct}%, ` +
                        `${s.fps ?? "?"} fps, rtt ${s.rttMs ?? "?"} ms -> target ${s.targetKbps} kbps`);
                }
            },
        });
        this.linkMode = null; // recomputed per connection from the selected candidate pair
        this.tel.linkMode = null;
        pc.ontrack = (ev) => {
            // Robot inbound audio -> dedicated sink. Kept MUTED until the operator joins the call,
            // so connecting the session doesn't leak room audio before you're "in the call".
            if (ev.track.kind === "audio") {
                this.inboundAudio = ev.streams[0]; // remembered so setAudioEl() can re-attach after a page swap
                if (this.o.audioEl && this.o.audioEl.srcObject !== ev.streams[0]) {
                    this.o.audioEl.srcObject = ev.streams[0];
                    this.log("robot audio track attached" + (this.call.active ? "" : " (muted until Join call)"));
                }
                this.applyAudioSink();
                this.call.robotAudio = true;
                // If the robot mutes/ends its mic, drop the indicator.
                ev.track.onmute = () => { this.call.robotAudio = false; this.emitCall(); };
                ev.track.onended = () => { this.call.robotAudio = false; this.emitCall(); };
                this.emitCall();
                return;
            }
            this.inboundVideo = ev.streams[0]; // remembered for re-attach (setVideoEl) when a page remounts
            if (this.o.videoEl && this.o.videoEl.srcObject !== ev.streams[0]) {
                this.o.videoEl.srcObject = ev.streams[0];
                this.log("video track attached");
            }
        };
        pc.ondatachannel = (ev) => this.setupControl(ev.channel); // robot opens 'control'
        pc.oniceconnectionstatechange = () => this.log("ice:", pc.iceConnectionState);
        pc.onconnectionstatechange = () => {
            this.log("conn:", pc.connectionState);
            this.o.onConnState(pc.connectionState);
            if (pc.connectionState === "connected") {
                this.connected = true;
                this.clearWaitDeadline();
                this.setPhase("connected");
                if (this.retryTimer) {
                    clearInterval(this.retryTimer);
                    this.retryTimer = null;
                }
                this.logSelectedPath();
                this.videoLoop?.start(); // ABR: adapt the robot's encoder to this link from second one
                // Latency harness (R-X.2): with ?audiolatency, log the network+jitter-buffer breakdown
                // of the audio path every few seconds. Works on the M3a uplink today; reused for M3b.
                if (audioLatencyEnabled())
                    this.latencyProbe?.start();
            }
            else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                this.connected = false; // robot will exit + restart; keep asking for a new offer
                this.latencyProbe?.stop();
                this.videoLoop?.stop();
                this.tel.videoNet = null; // stale numbers must not outlive the link they measured
                // "failed" = ICE could find no working path (NAT/firewall/TURN) — a real, nameable fault.
                // "disconnected" is often a transient blip that heals itself, so we drop back to `waiting`
                // (the retry loop below is already asking for a fresh offer) rather than crying failure.
                if (!this.stopped) {
                    if (pc.connectionState === "failed") {
                        this.setPhase("failed", "ice_failed");
                    }
                    else {
                        this.setPhase("waiting");
                        this.armWaitDeadline();
                    }
                }
                if (!this.retryTimer && !this.stopped) {
                    this.retryTimer = setInterval(() => { if (!this.connected)
                        this.sendReady(); }, 2000);
                }
            }
        };
        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                this.o.signaling.sendIce({
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                    candidate: ev.candidate.candidate,
                });
            }
        };
        return pc;
    }
    // report which ICE path won: host (LAN), srflx/prflx (STUN-direct), or relay (TURN).
    async logSelectedPath() {
        if (!this.pc)
            return;
        try {
            const stats = await this.pc.getStats();
            let pair;
            stats.forEach((r) => {
                const x = r;
                if (r.type === "candidate-pair" && x.selected)
                    pair = r;
            });
            if (!pair) {
                stats.forEach((r) => {
                    const x = r;
                    if (r.type === "candidate-pair" && x.state === "succeeded" && x.nominated)
                        pair = r;
                });
            }
            if (!pair)
                return;
            const p = pair;
            const local = stats.get(p.localCandidateId);
            const remote = stats.get(p.remoteCandidateId);
            const t = (c) => (c ? c.candidateType : "?");
            const addr = (c) => c?.address ?? c?.ip ?? "";
            const relayed = t(local) === "relay" || t(remote) === "relay";
            this.log(`ICE path: local=${t(local)} remote=${t(remote)}` +
                (relayed ? "  *** via TURN relay ***" : "  (direct)"));
            // Both candidates 'host' => direct same-subnet LAN; anything else (srflx via
            // STUN, relay via TURN) is WAN. Tell the daemon so it uses the matching watchdog
            // profile (LAN 150/500 vs WAN 300/1000) instead of always assuming WAN.
            // EXCEPT: a VPN/overlay candidate is ICE-type "host" too, and calling that "lan"
            // hands the robot the tight profile on a 1280-MTU tunnel — see tunnelAddress().
            // (An absent/mDNS-obfuscated address can't rule the tunnel out; the historical
            // host/host verdict stands there.)
            this.linkMode =
                t(local) === "host" && t(remote) === "host" &&
                    !tunnelAddress(addr(local)) && !tunnelAddress(addr(remote))
                    ? "lan" : "wan";
            this.tel.linkMode = this.linkMode;
            this.o.onTelemetry({ ...this.tel }); // surface the link chip as soon as the path resolves
            this.sendLink();
        }
        catch { /* getStats best-effort */ }
    }
    // Tell the robot the measured link path. Sent both here (when the pair resolves) and
    // on control-channel open, since their ordering isn't guaranteed.
    sendLink() {
        if (!this.linkMode)
            return;
        if (this.controlCh && this.controlCh.readyState === "open") {
            this.dcSend({ type: "link", mode: this.linkMode });
            this.log("link -> " + this.linkMode);
        }
    }
    // ---- control data channel ------------------------------------------------
    setupControl(ch) {
        this.controlCh = ch;
        ch.onopen = () => {
            this.log("control channel open — keyboard active");
            this.tel.active = true;
            this.o.onControlActive(true);
            this.sendLink(); // path may have resolved before the channel opened
            // Apply a pause requested before the channel opened (pause-on-connect for power saving).
            // Only send when paused: the robot defaults to flowing, so no message = video on.
            if (this.videoPaused)
                this.dcSend({ type: "video", state: "pause" });
        };
        ch.onclose = () => {
            if (this.controlCh === ch)
                this.controlCh = null;
            this.tel.active = false;
            this.o.onControlActive(false);
        };
        ch.onmessage = (e) => this.handleTelemetry(e.data);
    }
    handleTelemetry(data) {
        let m;
        try {
            m = JSON.parse(data);
        }
        catch {
            return;
        }
        if (m.type === "telemetry") {
            if (typeof m.loop_hz === "number")
                this.tel.loopHz = m.loop_hz;
            if (typeof m.pi_temp_c === "number" && m.pi_temp_c > 0)
                this.tel.tempC = m.pi_temp_c;
            const status = m.status;
            if (status) {
                if (status.safety) {
                    this.tel.safety = status.safety;
                    // estopConfirmed(): only a latch reported ON THE WIRE counts, and this is the
                    // one place a wire status block is parsed — waiters can never resolve from the
                    // cached view.
                    if (status.safety === "latched" && this.estopWaiters.length) {
                        for (const w of this.estopWaiters.splice(0))
                            w();
                    }
                }
                // null/absent -> not latched; replace wholesale so a cleared latch drops the banner.
                this.tel.latchReason = typeof status.latch_reason === "string" ? status.latch_reason : null;
                if (status.watchdog)
                    this.tel.watchdog = status.watchdog;
                // Per-motor hardware faults. The daemon sends the FULL current fault set in each status
                // block (and omits the field entirely when nothing is faulted), so replace wholesale —
                // a recovered motor drops out. Only touched when a status block is present (5 Hz), so a
                // per-tick telemetry frame without `status` leaves the last set intact.
                this.tel.motorFaults =
                    status.motor_faults && typeof status.motor_faults === "object" ? status.motor_faults : {};
            }
            // Per-motor servo case temps (1 Hz sweep). Only present on periodic blocks from
            // new daemons; replace wholesale when present so a recovered read updates cleanly,
            // and keep the last sweep otherwise (same no-flicker rule as loop_hz/status).
            if (m.servo_temps && typeof m.servo_temps === "object")
                this.tel.servoTemps = m.servo_temps;
            // Per-motor Present_Current (virtual tactile signal) -> VR haptics + on-screen readout.
            if (m.currents && typeof m.currents === "object") {
                this.tel.currents = m.currents;
                this.o.onCurrents?.(this.tel.currents);
            }
            // lerobot-native `state` dict (every "<motor>.pos" + base "x.vel"/"theta.vel").
            // Carried through so a 3D pose view (C6) can run FK off the joint angles.
            if (m.state && typeof m.state === "object") {
                this.tel.state = m.state;
            }
            // Reserved: robot reports whether its mic is live (Pi M3). Drives the "robot on air"
            // indicator; absent until the daemon sends it.
            if (typeof m.robot_mic_live === "boolean" && m.robot_mic_live !== this.call.robotMicLive) {
                this.call.robotMicLive = m.robot_mic_live;
                this.emitCall();
            }
            // Robot-side local mute (W2.5): robots boot muted; surface it so the UI can say
            // "ask someone at the robot to unmute". Absent on old bridges -> never fires.
            // Key is robot_LOCAL_mic_muted: plain robot_mic_muted already exists on the
            // control channel INBOUND (operator-driven robot-mic mute) — different state.
            if (typeof m.robot_local_mic_muted === "boolean" && m.robot_local_mic_muted !== this.call.robotMicMuted) {
                this.call.robotMicMuted = m.robot_local_mic_muted;
                this.emitCall();
            }
            // Pack state-of-charge (battery_monitor_integration.md §5): number 0-100, or explicit
            // null when unknown. Absent on old bridges -> leave the last value untouched.
            if (typeof m.battery_percent === "number")
                this.tel.batteryPercent = m.battery_percent;
            else if (m.battery_percent === null)
                this.tel.batteryPercent = null;
            this.o.onTelemetry({ ...this.tel });
        }
        else if (m.type === "perception") {
            this.ingestPerception(m);
        }
        else if (m.type === "action_status") {
            this.ingestActionStatus(m);
        }
        else if (m.type === "camera_layout") {
            this.ingestCameraLayout(m);
        }
        else if (m.type === "daemon_status") {
            this.ingestDaemonStatus(m);
        }
        else if (m.type === "record_status") {
            this.ingestRecordStatus(m);
        }
        else if (m.type === "policy_stream_status") {
            this.ingestPolicyStream(m);
        }
        else if (m.type === "navigation_status") {
            this.ingestNavigationStatus(m);
        }
        else if (m.type === "sensor_stream_status") {
            this.ingestSensorStreamStatus(m);
        }
        else if (m.type === "lidar_scan") {
            this.ingestLidarScan(m);
        }
        else if (m.type === "imu") {
            this.ingestImu(m);
        }
        else if (m.type === "ack") {
            this.ingestAck(m);
        }
        else if (m.type === "error") {
            // Human-readable in the session log; the robot's msg carries the remedy for actionable
            // faults (e.g. startup_positions → "power-cycle the arm"). Persistent outage state is the
            // daemon_status frame above — this line is the transient event record.
            this.log(`robot error [${String(m.code ?? "?")}]${m.fatal ? " (fatal)" : ""}: ${String(m.msg ?? "")}`);
        }
    }
    // Coerce a wire `perception` frame into a PerceptionView, stamp arrival time, cache it, notify.
    // Tolerant of a partial frame (a detector still coming up): missing/!array objects -> [].
    ingestPerception(m) {
        const rawObjects = Array.isArray(m.objects) ? m.objects : [];
        const objects = rawObjects.map((o) => ({
            label: String(o.label ?? ""),
            confidence: typeof o.confidence === "number" ? o.confidence : 0,
            bbox: Array.isArray(o.bbox) && o.bbox.length === 4 ? o.bbox : undefined,
            xyz: Array.isArray(o.xyz) && o.xyz.length === 3 ? o.xyz : undefined,
            id: typeof o.id === "number" ? o.id : undefined,
        }));
        const view = {
            ts_ns: typeof m.ts_ns === "number" ? m.ts_ns : 0,
            source: typeof m.source === "string" ? m.source : undefined,
            objects,
            receivedAt: performance.now(),
        };
        this.perception = view;
        this.o.onPerception?.(view);
    }
    // Coerce a wire `action_status` frame, cache it as the latest for its id, notify, and resolve a
    // pending awaitAction() on a terminal state (Phase E / G1).
    ingestActionStatus(m) {
        const st = {
            action_id: typeof m.action_id === "string" ? m.action_id : "",
            state: m.state,
            reason: typeof m.reason === "string" ? m.reason : undefined,
            ts_ns: typeof m.ts_ns === "number" ? m.ts_ns : undefined,
        };
        if (!st.action_id)
            return;
        this.latestActionStatus.set(st.action_id, st);
        this.o.onActionStatus?.(st);
        if (TERMINAL_ACTION_STATES.has(st.state)) {
            const w = this.actionWaiters.get(st.action_id);
            if (w) {
                clearTimeout(w.timer);
                this.actionWaiters.delete(st.action_id);
                w.resolve(st);
            }
            this.latestActionStatus.delete(st.action_id); // done with this id; keep the map from growing
        }
        else if (this.latestActionStatus.size > 16) {
            // Defensive cap: drop the oldest non-terminal entry (moves are serial, so this rarely trips).
            const oldest = this.latestActionStatus.keys().next().value;
            if (oldest !== undefined)
                this.latestActionStatus.delete(oldest);
        }
    }
    // Parse + cache the daemon's handshake ack (P4.1), warn on trouble, notify onReady.
    // Problems are ADVISORY, never fatal: mixed daemon versions exist across the fleet, and a
    // rejected session should stay connected so telemetry/logs can show the operator why.
    ingestAck(m) {
        const info = parseAck(m);
        this.ackInfo = info;
        if (!info.accepted) {
            this.log("ROBOT REJECTED SESSION: " + (info.error ?? "(no reason given)") +
                " — connection stays up but control frames will be ignored");
            // The peer is "connected" but the robot will ignore every control frame — without this the
            // UI reads fully healthy while nothing moves.
            this.setPhase("failed", "session_rejected", info.error);
        }
        else if (info.versionMismatch) {
            this.log(`protocol version mismatch — robot v${info.protocolVersion}, SDK targets ` +
                `v${NORI_PROTOCOL_VERSION}. Proceeding (unknown frames are ignored by both sides); ` +
                `expect vocabulary gaps, not unsafe behavior.`);
        }
        this.dynamicKeymap = null; // rebuild the per-motor map from this ack
        const d = info.descriptor;
        const l3 = l3JointShorts(d, this.o.arm);
        if (l3)
            this.log(`descriptor-driven per-motor jog: ${l3.length} arm joints`);
        this.log("robot ack: accepted=" + info.accepted +
            (info.protocolVersion !== undefined ? ` protocol=v${info.protocolVersion}` : "") +
            (info.normMode ? ` norm=${info.normMode}` : "") +
            (info.watchdogProfile ? ` watchdog=${info.watchdogProfile.t_warn_ms}/${info.watchdogProfile.t_stop_ms}ms` : "") +
            (d?.joints ? ` joints=${d.joints.length}` : "") +
            (d?.cameras?.length ? ` cameras=[${d.cameras.join(",")}]` : ""));
        this.o.onReady?.(info);
    }
    // Cache the composite camera layout the bridge sends on connect (Phase F vision). Ignores a
    // malformed frame (keeps any prior layout).
    ingestCameraLayout(m) {
        const cols = typeof m.cols === "number" ? m.cols : 0;
        const rows = typeof m.rows === "number" ? m.rows : 0;
        const tiles = Array.isArray(m.tiles) ? m.tiles.map(String) : [];
        if (cols > 0 && rows > 0 && tiles.length > 0) {
            this.cameraLayoutRaw = { cols, rows, tiles };
            this.o.onCameraLayout?.(this.cameraLayoutRaw);
        }
    }
    // The raw composite layout, or null if unknown (single-camera, or not yet received).
    cameraLayoutInfo() {
        return this.cameraLayoutRaw;
    }
    // Cache + dedupe the bridge's daemon_status health frames (it re-broadcasts every 3 s while
    // offline because the control channel is unreliable — only transitions reach the callback/log).
    ingestDaemonStatus(m) {
        // W2.5: the bridge stamps its local-mute state on daemon_status frames too —
        // telemetry carries it only while the daemon is UP, so without this a boot-muted
        // robot with a DOWN daemon would render an unmuted-looking call UI (robotAudio
        // still attaches; media is daemon-independent). Read BEFORE the dedup below:
        // a mute toggle alone must update the call state even when health is unchanged.
        if (typeof m.robot_local_mic_muted === "boolean" && m.robot_local_mic_muted !== this.call.robotMicMuted) {
            this.call.robotMicMuted = m.robot_local_mic_muted;
            this.emitCall();
        }
        const s = { state: String(m.state ?? "") };
        if (typeof m.reason === "string" && m.reason)
            s.reason = m.reason;
        if (typeof m.detail === "string" && m.detail)
            s.detail = m.detail;
        if (typeof m.armed === "boolean")
            s.armed = m.armed;
        if (typeof m.activation === "string" && m.activation)
            s.activation = m.activation;
        if (typeof m.activation_detail === "string" && m.activation_detail)
            s.activation_detail = m.activation_detail;
        if (typeof m.estop === "string" && m.estop)
            s.estop = m.estop;
        if (typeof m.estop_detail === "string" && m.estop_detail)
            s.estop_detail = m.estop_detail;
        if (!s.state)
            return;
        const prev = this.daemonStat;
        if (prev && prev.state === s.state && prev.reason === s.reason && prev.detail === s.detail
            && prev.armed === s.armed && prev.activation === s.activation
            && prev.activation_detail === s.activation_detail
            && prev.estop === s.estop && prev.estop_detail === s.estop_detail)
            return;
        this.daemonStat = s;
        // Operator-facing log line: no reason code, no raw detail — the on-screen banner carries the
        // plain-English remedy for the same event.
        this.log(s.state === "online"
            ? "Robot motor control connected"
            : "Robot motor control offline, reconnecting");
        this.o.onDaemonStatus?.(s);
    }
    // The latest bridge-reported daemon health, or null if none received yet (pre-2026-07-11
    // bridge, or the control channel just opened).
    daemonStatus() {
        return this.daemonStat;
    }
    // Coerce a policy_stream_status reply (fields per rpi5/media/policy_streamer.py
    // _status), cache it, resolve the oldest in-flight policyStream() call, notify.
    // FIFO waiter resolution: replies arrive in command order over the ordered data
    // channel, so the oldest waiter owns the next reply.
    ingestPolicyStream(m) {
        const s = {
            ok: m.ok === true,
            streaming: m.streaming === true,
            dest: typeof m.dest === "string" ? m.dest : null,
        };
        if (typeof m.fps_out === "number")
            s.fpsOut = m.fps_out;
        if (typeof m.frames_sent === "number")
            s.framesSent = m.frames_sent;
        if (typeof m.dropped === "number")
            s.dropped = m.dropped;
        if (typeof m.error === "string" && m.error)
            s.error = m.error;
        this.psStat = s;
        this.log(s.error ? `policy stream: ${s.error}`
            : s.streaming ? `policy stream live -> ${s.dest} (${s.fpsOut ?? "?"} fps, ${s.dropped ?? 0} dropped)`
                : "policy stream idle");
        this.psWaiters.shift()?.(s);
        this.o.onPolicyStream?.(s);
    }
    ingestNavigationStatus(m) {
        // Keep an unrecognized state VERBATIM. Coercing it to "failed" would make it terminal,
        // and awaitNavigation() would resolve reporting a finished goal while the robot drove on
        // — the unknown state is precisely where we must not claim the robot stopped. Unknown is
        // then simply not in TERMINAL_NAVIGATION_STATES, which is the safe default.
        const state = typeof m.state === "string" && m.state ? m.state : "unavailable";
        const status = {
            ok: m.ok === true,
            state,
            active: m.active === true,
        };
        if (typeof m.request_id === "string")
            status.requestId = m.request_id;
        if (typeof m.goal_id === "string")
            status.goalId = m.goal_id;
        if (typeof m.name === "string" && m.name)
            status.name = m.name;
        if (typeof m.map_sha256 === "string" && m.map_sha256)
            status.mapSha256 = m.map_sha256;
        if (typeof m.distance_remaining_m === "number")
            status.distanceRemainingM = m.distance_remaining_m;
        if (typeof m.estimated_time_remaining_s === "number")
            status.estimatedTimeRemainingS = m.estimated_time_remaining_s;
        if (typeof m.number_of_recoveries === "number")
            status.numberOfRecoveries = m.number_of_recoveries;
        if (typeof m.error_code === "number")
            status.errorCode = m.error_code;
        if (typeof m.error === "string" && m.error)
            status.error = m.error;
        if (typeof m.replaced === "boolean")
            status.replaced = m.replaced;
        if (typeof m.deleted === "boolean")
            status.deleted = m.deleted;
        if (Array.isArray(m.waypoints)) {
            status.waypoints = m.waypoints.flatMap((item) => {
                if (!item || typeof item !== "object")
                    return [];
                const waypoint = item;
                return typeof waypoint.name === "string" &&
                    typeof waypoint.saved_at_unix === "number"
                    ? [{ name: waypoint.name, savedAtUnix: waypoint.saved_at_unix }]
                    : [];
            });
        }
        if (status.requestId) {
            const waiter = this.navigationWaiters.get(status.requestId);
            if (waiter) {
                clearTimeout(waiter.timer);
                clearInterval(waiter.retry);
                this.navigationWaiters.delete(status.requestId);
                waiter.resolve(status);
            }
        }
        const previous = this.navigationStat;
        const staleRegression = Boolean(previous?.goalId && previous.goalId === status.goalId &&
            TERMINAL_NAVIGATION_STATES.has(previous.state) &&
            !TERMINAL_NAVIGATION_STATES.has(status.state));
        if (!staleRegression) {
            this.navigationStat = status;
            this.o.onNavigationStatus?.(status);
        }
        if (status.goalId && TERMINAL_NAVIGATION_STATES.has(status.state)) {
            const waiter = this.navigationGoalWaiters.get(status.goalId);
            if (waiter) {
                clearTimeout(waiter.timer);
                this.navigationGoalWaiters.delete(status.goalId);
                waiter.resolve(status);
            }
        }
    }
    ingestSensorStreamStatus(m) {
        const status = {
            ok: m.ok === true,
            requestId: typeof m.request_id === "string" ? m.request_id : "",
            lidarHz: typeof m.lidar_hz === "number" ? m.lidar_hz : 0,
            imuHz: typeof m.imu_hz === "number" ? m.imu_hz : 0,
            lidarMaxPoints: typeof m.lidar_max_points === "number" ? m.lidar_max_points : 360,
            lidarAvailable: m.lidar_available === true,
            imuAvailable: m.imu_available === true,
        };
        if (typeof m.error === "string" && m.error)
            status.error = m.error;
        this.sensorStat = status;
        const waiter = this.sensorWaiters.get(status.requestId);
        if (waiter) {
            clearTimeout(waiter.timer);
            clearInterval(waiter.retry);
            this.sensorWaiters.delete(status.requestId);
            waiter.resolve(status);
        }
        this.o.onSensorStreamStatus?.(status);
    }
    sensorStamp(value) {
        const stamp = value && typeof value === "object"
            ? value : {};
        return {
            sec: typeof stamp.sec === "number" ? stamp.sec : 0,
            nanosec: typeof stamp.nanosec === "number" ? stamp.nanosec : 0,
        };
    }
    sensorNumbers(value, length) {
        const result = Array.isArray(value)
            ? value.map((item) => typeof item === "number" && Number.isFinite(item) ? item : null)
            : [];
        if (length !== undefined) {
            result.length = Math.min(result.length, length);
            while (result.length < length)
                result.push(null);
        }
        return result;
    }
    ingestLidarScan(m) {
        const ranges = this.sensorNumbers(m.ranges_m);
        const scan = {
            stamp: this.sensorStamp(m.stamp),
            frameId: typeof m.frame_id === "string" ? m.frame_id : "",
            angleMinRad: typeof m.angle_min_rad === "number" ? m.angle_min_rad : 0,
            angleMaxRad: typeof m.angle_max_rad === "number" ? m.angle_max_rad : 0,
            angleIncrementRad: typeof m.angle_increment_rad === "number" ? m.angle_increment_rad : 0,
            timeIncrementS: typeof m.time_increment_s === "number" ? m.time_increment_s : 0,
            scanTimeS: typeof m.scan_time_s === "number" ? m.scan_time_s : 0,
            rangeMinM: typeof m.range_min_m === "number" ? m.range_min_m : 0,
            rangeMaxM: typeof m.range_max_m === "number" ? m.range_max_m : 0,
            sourcePoints: typeof m.source_points === "number" ? m.source_points : ranges.length,
            rangesM: ranges,
        };
        if (Array.isArray(m.intensities))
            scan.intensities = this.sensorNumbers(m.intensities);
        this.lidarStat = scan;
        this.o.onLidarScan?.(scan);
    }
    ingestImu(m) {
        const orientation = this.sensorNumbers(m.orientation_xyzw, 4);
        const angular = this.sensorNumbers(m.angular_velocity_rad_s, 3);
        const acceleration = this.sensorNumbers(m.linear_acceleration_m_s2, 3);
        const sample = {
            stamp: this.sensorStamp(m.stamp),
            frameId: typeof m.frame_id === "string" ? m.frame_id : "",
            orientationXyzw: orientation,
            orientationCovariance: this.sensorNumbers(m.orientation_covariance, 9),
            angularVelocityRadS: angular,
            angularVelocityCovariance: this.sensorNumbers(m.angular_velocity_covariance, 9),
            linearAccelerationMS2: acceleration,
            linearAccelerationCovariance: this.sensorNumbers(m.linear_acceleration_covariance, 9),
        };
        this.imuStat = sample;
        this.o.onImu?.(sample);
    }
    // W2.11: coerce a record_status reply (fields per rpi5/media/recorder.py _status),
    // cache it, notify. Replies are direct answers to record() commands — no dedupe
    // (a repeated "status" probe legitimately returns the same state, and free_gb drifts).
    ingestRecordStatus(m) {
        const s = {
            ok: m.ok === true,
            recording: m.recording === true,
        };
        if (m.session_open === true)
            s.sessionOpen = true;
        if (typeof m.episodes_kept === "number")
            s.episodesKept = m.episodes_kept;
        if (typeof m.episode === "string" && m.episode)
            s.episode = m.episode;
        if (typeof m.free_gb === "number")
            s.freeGb = m.free_gb;
        if (m.stereo === true)
            s.stereo = true;
        if (typeof m.error === "string" && m.error)
            s.error = m.error;
        this.recStat = s;
        this.log(s.error ? `recorder: ${s.error}`
            : s.recording ? `recording ${s.episode ?? ""} (${s.freeGb ?? "?"} GB free)`
                : "recorder idle");
        this.o.onRecord?.(s);
    }
    // The latest recorder reply, or null if none yet (never asked, or a pre-W2.11 robot).
    recordState() {
        return this.recStat;
    }
    // A one-line description of the composite layout for the LLM vision prompt, or null if unknown.
    // The coding page uses this as the default `camera_layout` so vision knows which tile is which arm
    // without the operator typing it (an explicit operator description still overrides).
    cameraLayout() {
        return this.cameraLayoutRaw ? formatCameraLayout(this.cameraLayoutRaw) : null;
    }
    // ---- handshake (P4.1) ------------------------------------------------------
    // The robot's self-description from the daemon's handshake ack: what it is (descriptor —
    // joints, cameras, per-key ranges), how it speaks (protocolVersion, normMode), how it
    // self-defends (watchdogProfile), and where it started (initialState). null until the ack
    // arrives (shortly after the control channel opens); refreshed on daemon reconnect. Push
    // alternative: the onReady option. Old daemons may send a bare ack — fields are optional.
    robotInfo() {
        return this.ackInfo;
    }
    // Does THIS robot need the L2 legacy base wire (angular negated on the wire)? The public
    // convention is spec REP-103 everywhere — +linear forward, +angular left — and every jog
    // producer in this SDK now emits it. The deployed L2 fleet's firmware turns opposite on
    // ANGULAR (only — its linear is true; the old keyboard both-axes negation was a bug that
    // drove keyboard-forward backwards on every model) and its daemon is frozen, so the
    // compensation the spec says belongs in the robot's own actuator adapter has to live
    // client-side for L2, forever, behind this positive match. Resolution order:
    //   1. opts.baseSigns — explicit override for robots auto-detection can't classify.
    //   2. ack.model — a robot that names itself is believed (no deployed L2 sends it, but a
    //      positive non-L2 answer beats any room-name guess).
    //   3. the transport room's fleet serial ("NORI-L2-0007" -> L2).
    // Unknown resolves to REP-103: the legacy branch is keyed to a positive L2 match and is
    // never the fallback, so a future model can't inherit the quirk by omission.
    legacyL2Base() {
        if (this.o.baseSigns)
            return this.o.baseSigns === "l2-legacy";
        const ackModel = this.ackInfo?.model;
        if (ackModel)
            return ackModel.toUpperCase() === "L2";
        const room = this.o.signaling.room;
        return !!room && serialModelCode(room) === "L2";
    }
    // The one place REP-103 becomes wire bytes. Identity for every robot except a matched L2,
    // where base.angular flips sign (zeros pass unchanged — -0 stops a robot just as well).
    // Applied at BOTH outbound jog sites (keyboard tick + externalJog), so VR mappers and
    // script drivers stay sign-blind: they emit REP-103 and never learn the quirk exists.
    wireJog(jog) {
        if (!this.legacyL2Base())
            return jog;
        const base = jog.base;
        if (!base || typeof base !== "object")
            return jog;
        const b = base;
        if (typeof b.angular !== "number" || b.angular === 0)
            return jog;
        return { ...jog, base: { ...b, angular: -b.angular } };
    }
    // ---- perception (Phase F / G3) -------------------------------------------
    // Latest world-state from the daemon perception process, or null if none has arrived (detector
    // not running / not connected). A running script polls this to close a loop:
    //   const world = teleop.perceive();
    //   const cup = world?.objects.find((o) => o.label === "cup");
    // Staleness is the CALLER's call — check perceptionAgeMs() before trusting an old frame; a
    // detector that has stopped will leave the last frame here indefinitely.
    perceive() {
        return this.perception;
    }
    // Age of the cached perception frame in ms (client clock), or null if none. Use this to reject
    // stale detections: `if ((teleop.perceptionAgeMs() ?? Infinity) > 500) { /* don't trust it */ }`.
    perceptionAgeMs() {
        return this.perception ? performance.now() - this.perception.receivedAt : null;
    }
    // Feed a perception frame as if it arrived on the wire. NORMALLY the daemon supplies these; this
    // is exposed for (a) unit tests and (b) the app-side dev mock (mockPerception.ts), so reactive
    // scripts can be developed before the on-Pi detector lands. Same code path as a real frame.
    injectPerception(frame) {
        this.ingestPerception({ type: "perception", ...frame });
    }
    // True when the frame was handed to an open channel, false when it was dropped. Dropping
    // is correct for ordinary verbs (the channel is unreliable by design and the robot is
    // watchdogged, so a frame into a dead channel has no meaning to preserve) — but a caller
    // must not claim delivery it didn't get: log on the return value, not on having called.
    dcSend(obj) {
        if (!this.controlCh || this.controlCh.readyState !== "open")
            return false;
        try {
            this.controlCh.send(JSON.stringify(obj));
        }
        catch {
            return false;
        }
        const rec = obj;
        if (rec && rec.type === "control" && this.o.onControlSent) {
            try {
                this.o.onControlSent(rec, Date.now());
            }
            catch {
                // observer must never break the control path
            }
        }
        return true;
    }
    // Descriptor shorts for the CURRENTLY selected arm, or null on L2 robots.
    // Public so the page can render the matching legend.
    armJointShorts() {
        return l3JointShorts(this.ackInfo?.descriptor, this.o.arm);
    }
    armKeymap() {
        // Task mode: descriptor-gated (CARTESIAN_TASK_KEYS on A3; the EXACT legacy
        // TASK_KEYS object when no jog_scale.task — every L2 stays byte-identical).
        if (this.mode !== "joint")
            return taskKeymapFor(this.ackInfo?.descriptor);
        const cached = this.dynamicKeymap;
        if (cached && cached.arm === this.o.arm)
            return cached.map;
        const shorts = this.armJointShorts();
        const map = shorts ? jointKeymapForShorts(shorts) : JOINT_KEYS;
        this.dynamicKeymap = { arm: this.o.arm, map };
        return map;
    }
    setMode(m) {
        this.mode = m;
        this.pressed.clear();
        this.o.onMode(m);
        this.log("control mode: " + (m === "joint" ? "per-motor"
            : taskModeLabel(this.ackInfo?.descriptor) === "cartesian" ? "cartesian"
                : "cylindrical (rpi4)"));
    }
    sendCmd(cmd) {
        this.pressed.clear(); // don't let a held key fight the command
        const armKey = `${this.o.arm}_arm`;
        const sent = cmd === "reset"
            ? this.dcSend({ type: "control", reset: { [armKey]: true } })
            : this.dcSend({ type: "command", [cmd]: true });
        if (!sent && cmd === "estop") {
            // The one verb where a silent drop must not read as success: an E-STOP that went
            // nowhere means the caller has to reach for the physical button, and this used to
            // log "cmd: estop" unconditionally — a lie on a dead channel. Ordinary verbs keep
            // the drop-silently contract. Mirrors nori-sdk-py's estop().
            throw new Error("estop: control channel is not open — the frame went NOWHERE. This session " +
                "cannot stop the robot; use the physical E-STOP or the robot's face button.");
        }
        this.log("cmd: " + cmd + (sent ? "" : " (dropped — channel not open)"));
    }
    // ---- keyboard (called by the page's window listeners) --------------------
    onKeyDown(e) {
        const tag = e.target?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA")
            return false;
        const k = e.key === " " ? " " : e.key.toLowerCase();
        if (k === "m") {
            if (!this.cmdDown.has("m")) {
                this.cmdDown.add("m");
                this.setMode(this.mode === "joint" ? "cylindrical" : "joint");
            }
            return true;
        }
        if (k in CMD_KEYS) {
            if (!this.cmdDown.has(k)) {
                this.cmdDown.add(k);
                // estop THROWS on a dead channel (see sendCmd); the session log is the surface —
                // it must not escape into the page's window keydown listener.
                try {
                    this.sendCmd(CMD_KEYS[k]);
                }
                catch (e) {
                    this.log(e.message);
                }
            }
            return true;
        }
        if (k in this.armKeymap() || k in BASE_KEYS || k in ZLIFT_KEYS) {
            this.pressed.add(k);
            return true;
        }
        return false;
    }
    onKeyUp(e) {
        const k = e.key === " " ? " " : e.key.toLowerCase();
        this.pressed.delete(k);
        this.cmdDown.delete(k);
    }
    // External mappers (VR) speak PER-HAND lift intent: left_lift / right_lift. That is the
    // wire vocabulary on an L-series robot, but the A-series has ONE central column keyed
    // bare "lift" — the per-hand names there are ignored in SILENCE, so the operator pressed
    // lift and nothing moved. The keyboard path and ScriptDriver were both fixed for exactly
    // this (rail.ts liftJogKey is the single resolver); this is the same fix for the external
    // stream, applied here because the mapper is descriptor-blind and this class holds the
    // ack. When both hands land on the same central column the rates sum, clamped, so an
    // opposing pair holds rather than one hand silently winning.
    resolveLifts(jog) {
        const { left_lift, right_lift, ...rest } = jog;
        const out = { ...rest };
        const hands = [["left", left_lift], ["right", right_lift]];
        for (const [side, rate] of hands) {
            if (!rate)
                continue; // absent/zero: nothing commanded (absence reads as rate 0)
            const key = liftJogKey(this.ackInfo?.descriptor, side);
            if (!key)
                continue; // robot advertises no lift: omit rather than invent a key
            const prev = typeof out[key] === "number" ? out[key] : 0;
            out[key] = Math.max(-1, Math.min(1, prev + rate));
        }
        return out;
    }
    // 50 Hz level jog stream from the held-key set (daemon is level-triggered)
    jogTick() {
        const ch = this.controlCh;
        if (!ch || ch.readyState !== "open")
            return;
        if (ch.bufferedAmount > BUFFER_LIMIT)
            return; // congested -> skip, don't pile up latency
        // While a policy owns the arms via sendAction(), drop the leader's absolute
        // targets and any held keys: those out-vote the policy at 50 Hz and pin the arm.
        // We still emit the benign zero-jog heartbeat below (which the daemon does NOT
        // let cancel an action — see sendAction), so base velocity can't latch and the
        // control-liveness heartbeat stays fresh. sendAction is the sole arm driver.
        const leader = this.policyDriving ? null : this.externalLeader;
        // VR (or another mapper) owns the stream: resolve its per-hand lift intent against the
        // descriptor (resolveLifts — the mapper is descriptor-blind), then send through the same
        // wireJog gate as the keyboard path (identity except the L2 legacy angular flip).
        // Suppressed while a leader source drives the arms: leader (absolute) and VR-jog would
        // otherwise fight over the same arm joints.
        if (this.externalJog && !leader) {
            this.dcSend({ type: "control", seq: this.seq++,
                jog: this.wireJog(this.resolveLifts(this.externalJog)) });
            return;
        }
        const km = this.armKeymap();
        // joint mode: always send all 6 joint fields (0 default) so the daemon picks the
        // per-motor path. cylindrical mode: send only task DOFs -> daemon task/IK path.
        // Derived from the ACTIVE keymap, so it is the L2 literal for JOINT_KEYS
        // and the descriptor's joints for an L3 map — never a stale vocabulary.
        const a = this.mode === "joint"
            ? Object.fromEntries(Object.values(km).map(([dof]) => [dof, 0]))
            : {};
        const base = {};
        let z = 0;
        // User keyboard-speed setting: every held key jogs at this fraction of full rate.
        const sp = this.keyboardSpeed;
        for (const k of this.pressed) {
            // A policy owns the arms AND the base/lift for the rollout: ignore every held
            // key so nothing competes with sendAction; the frame stays a pure heartbeat.
            if (this.policyDriving)
                continue;
            // While a leader source drives the arms, arm keys are ignored (leader wins on those
            // joints); base + lift keys still apply so the operator drives the base/rails by hand.
            if (!leader && k in km) {
                const [d, s] = km[k];
                a[d] = s * sp;
            }
            // REP-103 straight through: BASE_KEYS signs (i/w = +linear forward, a/j = +angular
            // left) ARE the wire values. This used to negate both axes "for the firmware" — but
            // only the L2 turns opposite, only on angular, and that flip now happens in wireJog
            // behind a positive L2 match, so the negation here inverted keyboard-forward on every
            // model and keyboard-left on everything that wasn't an L2.
            else if (k in BASE_KEYS) {
                const [dof, s] = BASE_KEYS[k];
                base[dof] = s * sp;
            }
            else if (k in ZLIFT_KEYS)
                z = ZLIFT_KEYS[k] * sp;
        }
        // Leader mode: arms come from leader_action_deg, so the jog carries only base + lift.
        // Always include a base object (even empty) so the daemon keeps commanding base velocity
        // every frame — parity with the keyboard-arm path, whose ever-present arm dict is what
        // keeps the daemon's latest_jog fresh so a released base key can't latch its last speed.
        const jog = leader ? { base } : { [`${this.o.arm}_arm`]: a };
        if (!leader && Object.keys(base).length)
            jog.base = base;
        // u/o lift the CURRENTLY SELECTED arm (the dropdown that scopes the arm keys) on a robot
        // with per-arm rails; on an A-series robot there is ONE central column and both arm
        // selections drive it. Resolved from the descriptor rather than composed as
        // `${arm}_lift`, which named a key an A3 does not have — the robot ignored it in silence,
        // so the operator's lift keys did nothing at all and reported nothing.
        if (z) {
            const lk = liftJogKey(this.ackInfo?.descriptor, this.o.arm);
            if (lk)
                jog[lk] = z;
        }
        const frame = { type: "control", seq: this.seq++, jog: this.wireJog(jog) };
        if (leader)
            frame.leader_action_deg = leader;
        this.dcSend(frame);
    }
}
//# sourceMappingURL=teleop.js.map
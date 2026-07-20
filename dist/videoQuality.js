// NORI: Additive file.
// Adaptive video bitrate (ABR) — the closed loop that keeps robot video visible on poor links.
//
// Why: the robot's software x264 encoder used to push a FIXED bitrate into whatever network the
// session landed on. A phone hotspot uplink is ~0.5-1.5 Mbps with deep buffers, so a fixed 2 Mbps
// floods the bottleneck queue until it collapses — 70%+ packet loss, no complete keyframe ever
// arrives, and the operator sees black (or periodic multi-second freezes) while the connection
// still reads "connected". The fix is not to survive that loss but to STOP CAUSING it: measure
// loss/RTT on the receiver (the only place delivered-fps ground truth exists) and stream a bitrate
// target the encoder can actually fit through the link.
//
// Shape: VideoStatsProbe (getStats deltas) -> AbrController (pure AIMD math, unit-tested) ->
// VideoQualityLoop (1 Hz tick owned by RemoteTeleop) -> {type:"video", bitrate:kbps} on the
// control data channel -> webrtc_robot.py applies it to x264enc live (no renegotiation).
// The channel is UNRELIABLE (max-retransmits=0), so the loop re-sends the CURRENT target every
// tick whether or not it changed — idempotent repeats are the delivery guarantee.
//
// The controller is loss-based AIMD with an RTT-inflation term ("GCC-lite"): hotspots bufferbloat
// long before they drop packets, so a growing RTT is congestion news the loss signal delivers
// seconds too late. Frame rate is never the degradation axis — the encoder holds 15 fps and the
// controller trades bitrate (and later, resolution — the layer-3 ladder) instead.
export const ABR_DEFAULTS = { minKbps: 150, maxKbps: 2000, startKbps: 600 };
// User-facing link verdict, driven by what the operator actually EXPERIENCES (delivered fps,
// loss) rather than controller internals — a low-but-stable target on a weak link that still
// delivers clean 15 fps is "good", not "degraded".
export function classifyQuality(s) {
    if (s.lossPct > 20 || (s.fps !== null && s.fps < 8))
        return "bad";
    if (s.lossPct > 5 || (s.fps !== null && s.fps < 12))
        return "degraded";
    return "good";
}
// Pure AIMD controller, one step() per ~1 s sample. Exported separately from the loop so the
// decision table is unit-testable without a peer connection or timers (videoQuality.test.ts).
export class AbrController {
    constructor(cfg = ABR_DEFAULTS) {
        this.cfg = cfg;
        this.baseRttMs = null; // min RTT seen = the path's uncongested floor
        this.goodTicks = 0;
        this.target = Math.min(cfg.startKbps, cfg.maxKbps);
    }
    step(s) {
        if (s.rttMs !== null) {
            this.baseRttMs = this.baseRttMs === null ? s.rttMs : Math.min(this.baseRttMs, s.rttMs);
        }
        // "Inflated" needs BOTH a big ratio and an absolute margin: 2x a 5 ms LAN RTT is noise,
        // and +150 ms on a 400 ms satellite path is normal jitter. Both together = a filling queue.
        const rttInflated = s.rttMs !== null && this.baseRttMs !== null &&
            s.rttMs > this.baseRttMs * 2 && s.rttMs > this.baseRttMs + 150;
        if (s.packetsDelta === 0) {
            // Nothing arrived: total outage or encoder paused. No information either way — hold.
            // (Ramping on silence is how a paused stream would "recover" to a rate the link never
            // proved it can carry.)
            this.goodTicks = 0;
        }
        else if (s.lossPct > 8) {
            this.target *= 0.7; // multiplicative decrease: get below the bottleneck in 2-3 ticks
            this.goodTicks = 0;
        }
        else if (rttInflated) {
            this.target *= 0.85; // queue building but not yet dropping — back off gently, pre-loss
            this.goodTicks = 0;
        }
        else if (s.lossPct > 2) {
            this.goodTicks = 0; // lossy but tolerable (NACK/RTX covers it) — hold, don't grow
        }
        else {
            // Clean tick. Require ~5 s of proof before probing upward, then +5%/s — full recovery
            // from a deep cut takes ~25 s, which is deliberately slower than the collapse (0.7^n).
            this.goodTicks++;
            if (this.goodTicks >= 5)
                this.target *= 1.05;
        }
        this.target = Math.max(this.cfg.minKbps, Math.min(this.cfg.maxKbps, this.target));
        return Math.round(this.target);
    }
}
// Reads one LinkSample off pc.getStats() by differencing inbound video RTP counters against the
// previous call. Same stats-walking pattern as AudioLatencyProbe (audioLatency.ts), video kind.
export class VideoStatsProbe {
    constructor(pc) {
        this.pc = pc;
        this.prev = null;
    }
    async sample() {
        const stats = await this.pc.getStats();
        let rttMs = null;
        let received = null;
        let lost = 0;
        let frames = 0;
        let frameHeight = null;
        stats.forEach((r) => {
            const x = r;
            if (r.type === "candidate-pair" && (x.selected || (x.nominated && x.state === "succeeded"))) {
                if (typeof x.currentRoundTripTime === "number")
                    rttMs = x.currentRoundTripTime * 1000;
            }
            if (r.type === "inbound-rtp" && x.kind === "video") {
                if (typeof x.packetsReceived === "number")
                    received = x.packetsReceived;
                if (typeof x.packetsLost === "number")
                    lost = x.packetsLost;
                if (typeof x.framesDecoded === "number")
                    frames = x.framesDecoded;
                if (typeof x.frameHeight === "number")
                    frameHeight = x.frameHeight;
            }
        });
        const now = Date.now();
        if (received === null || this.prev === null) {
            // No video stream yet, or first call: record the baseline and report a no-information
            // sample (packetsDelta 0 -> the controller holds).
            if (received !== null)
                this.prev = { at: now, received, lost, frames };
            return { packetsDelta: 0, lossPct: 0, fps: null, rttMs, frameHeight };
        }
        const dt = Math.max(0.001, (now - this.prev.at) / 1000);
        const dRecv = Math.max(0, received - this.prev.received);
        // packetsLost is cumulative but may DECREASE (spec allows revisions when late packets
        // arrive after being declared lost) — clamp the delta at 0.
        const dLost = Math.max(0, lost - this.prev.lost);
        const dFrames = Math.max(0, frames - this.prev.frames);
        this.prev = { at: now, received, lost, frames };
        const total = dRecv + dLost;
        return {
            packetsDelta: total,
            lossPct: total > 0 ? (dLost / total) * 100 : 0,
            fps: dFrames / dt,
            rttMs,
            frameHeight,
        };
    }
}
// The 1 Hz loop RemoteTeleop runs per peer connection: sample -> step -> send target + report.
export class VideoQualityLoop {
    constructor(pc, opts) {
        this.opts = opts;
        this.timer = null;
        this.last = null;
        this.probe = new VideoStatsProbe(pc);
        this.ctrl = new AbrController({ ...ABR_DEFAULTS, ...opts.cfg });
    }
    start(intervalMs = 1000) {
        this.stop();
        this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        let s;
        try {
            s = await this.probe.sample();
        }
        catch {
            return; // getStats is best-effort; a closed pc mid-tick just skips
        }
        if (this.opts.paused?.()) {
            // Encoder paused: the sample above kept the counters fresh, but 0 fps here is not
            // congestion — no controller step, no verdict. Still re-send the current target so the
            // robot knows an ABR client owns the rate (its legacy fallback would otherwise restore
            // the full ceiling, bursting the link the moment video resumes).
            this.opts.sendTarget(Math.round(this.ctrl.target));
            return;
        }
        const target = this.ctrl.step(s);
        // Re-send EVERY tick, changed or not: the unreliable channel drops frames freely, and a
        // stale encoder rate self-heals within a second as long as the current target keeps coming.
        this.opts.sendTarget(target);
        this.last = {
            lossPct: Math.round(s.lossPct * 10) / 10,
            fps: s.fps === null ? null : Math.round(s.fps * 10) / 10,
            rttMs: s.rttMs === null ? null : Math.round(s.rttMs),
            targetKbps: target,
            frameHeight: s.frameHeight,
            quality: classifyQuality(s),
        };
        this.opts.onState?.(this.last);
    }
}
//# sourceMappingURL=videoQuality.js.map
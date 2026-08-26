import type { SignalingTransport } from "./signaling";
import { type VideoNetState } from "./videoQuality";
export type ControlMode = "cylindrical" | "joint";
export type ArmSide = "left" | "right";
export interface ExternalJog {
    left_arm?: Record<string, number>;
    right_arm?: Record<string, number>;
    base?: Record<string, number>;
    left_lift?: number;
    right_lift?: number;
}
export type LeaderActionDeg = Record<string, number>;
export type SafetyState = "ok" | "safe_hold" | "latched" | (string & {});
export type WatchdogState = "ok" | "warn" | "stop" | (string & {});
export declare const CURRENT_MA_PER_LSB = 6.5;
export declare function currentMa(rawLsb: number): number;
export declare const CURRENT_FULL_LSB = 600;
export interface TelemetryView {
    loopHz: number;
    safety: SafetyState;
    watchdog: WatchdogState;
    tempC: number;
    active: boolean;
    linkMode: "lan" | "wan" | null;
    currents: Record<string, number>;
    state: Record<string, number>;
    videoNet: VideoNetState | null;
    batteryPercent: number | null;
    motorFaults: Record<string, string>;
    servoTemps: Record<string, number>;
    latchReason: string | null;
}
export interface PerceivedObject {
    label: string;
    confidence: number;
    bbox?: [number, number, number, number];
    xyz?: [number, number, number];
    id?: number;
}
export interface PerceptionView {
    ts_ns: number;
    source?: string;
    objects: PerceivedObject[];
    receivedAt: number;
}
export type ActionState = "accepted" | "active" | "done" | "clamped" | "blocked" | "timeout";
export interface ActionStatus {
    action_id: string;
    state: ActionState;
    reason?: string;
    ts_ns?: number;
}
export interface DaemonStatus {
    state: "online" | "offline" | (string & {});
    reason?: string;
    detail?: string;
    armed?: boolean;
    activation?: string;
    activation_detail?: string;
}
export type ConnectPhase = "idle" | "joining" | "waiting" | "negotiating" | "connected" | "failed";
export type ConnectFailure = "signaling_unreachable" | "robot_not_responding" | "ice_failed" | "negotiation_failed" | "session_rejected";
export interface ConnectStatus {
    phase: ConnectPhase;
    reason?: ConnectFailure;
    detail?: string;
}
export interface CameraLayout {
    cols: number;
    rows: number;
    tiles: string[];
}
export declare function formatCameraLayout(layout: CameraLayout): string;
export interface CameraViewHandle {
    stream: MediaStream;
    role: string;
    stop(): void;
}
export declare function cameraTileRect(layout: CameraLayout, role: string, vw: number, vh: number): {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
} | null;
export interface WatchdogProfile {
    t_warn_ms: number;
    t_stop_ms: number;
}
export interface RobotDescriptor {
    buses?: string[];
    joints?: string[];
    base?: string[];
    aux?: string[];
    cameras?: string[];
    ranges?: Record<string, [number, number]>;
    ranges_si?: Record<string, [number, number]>;
    jog_scale?: {
        joints?: Record<string, number>;
        task?: {
            x?: number;
            y?: number;
            z?: number;
            pitch?: number;
            yaw?: number;
            shoulder_pan?: number;
        };
        base?: {
            linear?: number;
            angular?: number;
        };
        lift?: number;
    };
}
export interface RobotInfo {
    accepted: boolean;
    protocolVersion?: number;
    normMode?: string;
    watchdogProfile?: WatchdogProfile;
    descriptor?: RobotDescriptor;
    initialState?: Record<string, number>;
    error?: string;
    versionMismatch: boolean;
    model?: string;
    capabilities?: string[];
}
export declare function supportsCapability(info: RobotInfo | null | undefined, capability: string): boolean | undefined;
export declare function serialModelCode(serial: string): string | null;
export declare function tunnelAddress(host: string): boolean;
export declare function parseAck(m: Record<string, unknown>, sdkProtocolVersion?: number): RobotInfo;
export interface CallState {
    active: boolean;
    micMuted: boolean;
    micSending: boolean;
    robotAudio: boolean;
    robotMicLive: boolean;
    robotMicMuted: boolean;
    cameraOn: boolean;
}
export interface PolicyStreamStatus {
    ok: boolean;
    streaming: boolean;
    dest: string | null;
    fpsOut?: number;
    framesSent?: number;
    dropped?: number;
    error?: string;
}
export interface RecordState {
    ok: boolean;
    recording: boolean;
    sessionOpen?: boolean;
    episodesKept?: number;
    episode?: string;
    freeGb?: number;
    stereo?: boolean;
    error?: string;
}
export interface RemoteTeleopOptions {
    signaling: SignalingTransport;
    videoEl?: HTMLVideoElement;
    audioEl?: HTMLAudioElement;
    baseSigns?: "rep103" | "l2-legacy";
    stun: string;
    turnUrls: string[];
    turnUser: string;
    turnCred: string;
    cert?: RTCCertificate;
    sessionGrant?: string;
    forceRelay: boolean;
    arm: ArmSide;
    mode?: ControlMode;
    onLog: (msg: string) => void;
    onConnState: (state: string) => void;
    onConnectStatus?: (s: ConnectStatus) => void;
    onTelemetry: (t: TelemetryView) => void;
    onMode: (mode: ControlMode) => void;
    onControlActive: (active: boolean) => void;
    onCurrents?: (currents: Record<string, number>) => void;
    onCall?: (state: CallState) => void;
    onPerception?: (p: PerceptionView) => void;
    onActionStatus?: (s: ActionStatus) => void;
    onCameraLayout?: (layout: CameraLayout) => void;
    onControlSent?: (frame: Record<string, unknown>, tWallMs: number) => void;
    onDaemonStatus?: (s: DaemonStatus) => void;
    onReady?: (info: RobotInfo) => void;
    onRecord?: (s: RecordState) => void;
    onPolicyStream?: (s: PolicyStreamStatus) => void;
}
export declare const TASK_KEYS: Record<string, [string, number]>;
export declare const JOINT_KEYS: Record<string, [string, number]>;
export declare const CARTESIAN_TASK_KEYS: Record<string, [string, number]>;
export declare function taskKeymapFor(descriptor: RobotDescriptor | undefined | null): Record<string, [string, number]>;
export declare function taskModeLabel(descriptor: RobotDescriptor | undefined | null): "cartesian" | "cylindrical";
export declare function l3JointShorts(descriptor: RobotDescriptor | undefined | null, arm: string): string[] | null;
export declare const L2_JOINT_DOFS: readonly string[];
export declare function jointDofsFor(descriptor: RobotDescriptor | undefined | null, side: string): string[];
export declare function jointKeymapForShorts(shorts: string[]): Record<string, [string, number]>;
export declare const BASE_KEYS: Record<string, [string, number]>;
export declare const ZLIFT_KEYS: Record<string, number>;
export declare const CMD_KEYS: Record<string, string>;
export interface KeybindRow {
    dof: string;
    posKey: string;
    negKey: string;
}
export interface BaseKeyCluster {
    forward: string;
    left: string;
    back: string;
    right: string;
}
export declare function baseKeyClusters(): BaseKeyCluster[];
export declare function keybindLegend(mode: ControlMode, jointShorts?: string[] | null, descriptor?: RobotDescriptor | null): {
    arm: KeybindRow[];
    base: KeybindRow[];
    lift: KeybindRow;
    commands: {
        key: string;
        label: string;
    }[];
};
export declare class RemoteTeleop {
    private o;
    private pc;
    private remoteSet;
    private pendingIce;
    private connected;
    private retryTimer;
    private latencyProbe;
    private videoLoop;
    private jogTimer;
    private controlCh;
    private linkMode;
    private connStatus;
    private waitTimer;
    private mode;
    private externalJog;
    private externalLeader;
    private keyboardSpeed;
    private policyDriving;
    private inboundVideo;
    private inboundAudio;
    private videoPaused;
    private seq;
    private readonly pressed;
    private readonly cmdDown;
    private tel;
    private stopped;
    private perception;
    private actionSeq;
    private actionWaiters;
    private latestActionStatus;
    private cameraLayoutRaw;
    private daemonStat;
    private recStat;
    private psStat;
    private psWaiters;
    private ackInfo;
    private micStream;
    private micTrack;
    private camStream;
    private camTrack;
    private clipTrack;
    private call;
    constructor(opts: RemoteTeleopOptions);
    private log;
    setArm(arm: ArmSide): void;
    setVideoEl(el: HTMLVideoElement | null): void;
    setAudioEl(el: HTMLAudioElement | null): void;
    videoStream(): MediaStream | null;
    cameraView(role: string, opts?: {
        fps?: number;
    }): CameraViewHandle | null;
    getArm(): ArmSide;
    setExternalJog(jog: ExternalJog | null): void;
    setKeyboardSpeed(s: number): void;
    setLeaderAction(leader: LeaderActionDeg | null): void;
    sendAction(action: Record<string, number>, actionId?: string): void;
    nextActionId(): string;
    sendPose(side: "left" | "right", positionM: [number, number, number] | number[], orientationXyzw?: [number, number, number, number] | number[], actionId?: string): void;
    policyStream(action: "start" | "stop" | "status", opts?: {
        dest?: "laptop" | "cloud";
        target?: string;
        token?: string;
        timeoutMs?: number;
    }): Promise<PolicyStreamStatus>;
    policyStreamStatus(): PolicyStreamStatus | null;
    setPolicyDriving(on: boolean): void;
    actionStatus(id: string): ActionStatus | null;
    awaitAction(id: string, opts?: {
        timeoutMs?: number;
    }): Promise<ActionStatus>;
    command(cmd: "estop" | "reset_latch" | "reset"): void;
    setArmed(on: boolean): void;
    private estopWaiters;
    estopConfirmed(timeoutMs?: number): Promise<void>;
    setVideoQuality(quality: "low" | "normal" | number): void;
    record(action: "session_start" | "episode_start" | "episode_stop" | "episode_discard" | "session_end" | "session_discard" | "start" | "stop" | "discard" | "discard_last" | "status", task?: string, opts?: {
        stereo?: boolean;
    }): void;
    pauseVideo(): void;
    resumeVideo(): void;
    /** Current encoder gate state, so a transient consumer (e.g. a policy rollout that
     *  force-resumes to grab frames) can RESTORE what it found instead of blindly
     *  pausing on exit — blindly pausing freezes the preview of a page still on screen. */
    isVideoPaused(): boolean;
    private setVideoPaused;
    captureFrame(mime?: string, quality?: number, role?: string): Promise<Blob | null>;
    snapshot(settleMs?: number, role?: string): Promise<Blob | null>;
    toggleMode(): void;
    callState(): CallState;
    joinCall(): Promise<CallState>;
    leaveCall(): void;
    setMicMuted(muted: boolean): void;
    enableCamera(): Promise<MediaStream | null>;
    disableCamera(): void;
    sendClipAudio(track: MediaStreamTrack | null): Promise<boolean>;
    private emitCall;
    private applyAudioSink;
    private attachLocalMedia;
    private attachTrack;
    private detachTrack;
    private audioSender;
    private sendTransceiver;
    private offerWantsAudioUplink;
    private stopStream;
    private iceServers;
    private setPhase;
    connectStatus(): ConnectStatus;
    private armWaitDeadline;
    private clearWaitDeadline;
    start(): Promise<void>;
    stop(): Promise<void>;
    logAudioLatency(): Promise<import("./audioLatency").AudioLatencySample | null>;
    private sendReady;
    private freshPeer;
    private logSelectedPath;
    private sendLink;
    private setupControl;
    private handleTelemetry;
    private ingestPerception;
    private ingestActionStatus;
    private ingestAck;
    private ingestCameraLayout;
    cameraLayoutInfo(): CameraLayout | null;
    private ingestDaemonStatus;
    daemonStatus(): DaemonStatus | null;
    private ingestPolicyStream;
    private ingestRecordStatus;
    recordState(): RecordState | null;
    cameraLayout(): string | null;
    robotInfo(): RobotInfo | null;
    private legacyL2Base;
    private wireJog;
    perceive(): PerceptionView | null;
    perceptionAgeMs(): number | null;
    injectPerception(frame: {
        ts_ns?: number;
        source?: string;
        objects: PerceivedObject[];
    }): void;
    private dcSend;
    private dynamicKeymap;
    armJointShorts(): string[] | null;
    private armKeymap;
    private setMode;
    private sendCmd;
    onKeyDown(e: KeyboardEvent): boolean;
    onKeyUp(e: KeyboardEvent): void;
    private resolveLifts;
    private jogTick;
}
//# sourceMappingURL=teleop.d.ts.map
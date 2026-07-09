import type { SignalingTransport } from "./signaling";
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
export interface TelemetryView {
    loopHz: number;
    safety: string;
    watchdog: string;
    tempC: number;
    active: boolean;
    linkMode: "lan" | "wan" | null;
    currents: Record<string, number>;
    state: Record<string, number>;
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
export interface CallState {
    active: boolean;
    micMuted: boolean;
    micSending: boolean;
    robotAudio: boolean;
    robotMicLive: boolean;
    cameraOn: boolean;
}
export interface RemoteTeleopOptions {
    signaling: SignalingTransport;
    videoEl?: HTMLVideoElement;
    audioEl?: HTMLAudioElement;
    token: string;
    stun: string;
    turnUrls: string[];
    turnUser: string;
    turnCred: string;
    forceRelay: boolean;
    arm: ArmSide;
    mode?: ControlMode;
    onLog: (msg: string) => void;
    onConnState: (state: string) => void;
    onTelemetry: (t: TelemetryView) => void;
    onMode: (mode: ControlMode) => void;
    onControlActive: (active: boolean) => void;
    onCurrents?: (currents: Record<string, number>) => void;
    onCall?: (state: CallState) => void;
    onPerception?: (p: PerceptionView) => void;
    onActionStatus?: (s: ActionStatus) => void;
    onCameraLayout?: (layout: CameraLayout) => void;
}
export declare const TASK_KEYS: Record<string, [string, number]>;
export declare const JOINT_KEYS: Record<string, [string, number]>;
export declare const BASE_KEYS: Record<string, [string, number]>;
export declare const ZLIFT_KEYS: Record<string, number>;
export declare const CMD_KEYS: Record<string, string>;
export interface KeybindRow {
    dof: string;
    posKey: string;
    negKey: string;
}
export declare function keybindLegend(mode: ControlMode): {
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
    private jogTimer;
    private controlCh;
    private curMac;
    private linkMode;
    private mode;
    private externalJog;
    private externalLeader;
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
    setLeaderAction(leader: LeaderActionDeg | null): void;
    sendAction(action: Record<string, number>, actionId?: string): void;
    nextActionId(): string;
    actionStatus(id: string): ActionStatus | null;
    awaitAction(id: string, opts?: {
        timeoutMs?: number;
    }): Promise<ActionStatus>;
    command(cmd: "estop" | "reset_latch" | "reset"): void;
    setVideoQuality(quality: "low" | "normal"): void;
    pauseVideo(): void;
    resumeVideo(): void;
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
    private ingestCameraLayout;
    cameraLayoutInfo(): CameraLayout | null;
    cameraLayout(): string | null;
    perceive(): PerceptionView | null;
    perceptionAgeMs(): number | null;
    injectPerception(frame: {
        ts_ns?: number;
        source?: string;
        objects: PerceivedObject[];
    }): void;
    private dcSend;
    private armKeymap;
    private setMode;
    private sendCmd;
    onKeyDown(e: KeyboardEvent): boolean;
    onKeyUp(e: KeyboardEvent): void;
    private jogTick;
}
//# sourceMappingURL=teleop.d.ts.map
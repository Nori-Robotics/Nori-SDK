export interface LinkSample {
    packetsDelta: number;
    lossPct: number;
    fps: number | null;
    rttMs: number | null;
    frameHeight: number | null;
}
export interface AbrConfig {
    minKbps: number;
    maxKbps: number;
    startKbps: number;
}
export declare const ABR_DEFAULTS: AbrConfig;
export interface VideoNetState {
    lossPct: number;
    fps: number | null;
    rttMs: number | null;
    targetKbps: number;
    frameHeight: number | null;
    quality: "good" | "degraded" | "bad";
}
export declare function classifyQuality(s: LinkSample): VideoNetState["quality"];
export declare class AbrController {
    private cfg;
    target: number;
    private baseRttMs;
    private goodTicks;
    constructor(cfg?: AbrConfig);
    step(s: LinkSample): number;
}
export declare class VideoStatsProbe {
    private pc;
    private prev;
    constructor(pc: RTCPeerConnection);
    sample(): Promise<LinkSample>;
}
export declare class VideoQualityLoop {
    private opts;
    private timer;
    private probe;
    private ctrl;
    last: VideoNetState | null;
    constructor(pc: RTCPeerConnection, opts: {
        sendTarget: (kbps: number) => void;
        onState?: (s: VideoNetState) => void;
        paused?: () => boolean;
        cfg?: Partial<AbrConfig>;
    });
    start(intervalMs?: number): void;
    stop(): void;
    private tick;
}
//# sourceMappingURL=videoQuality.d.ts.map
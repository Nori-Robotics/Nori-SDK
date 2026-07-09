export interface AudioLatencySample {
    ts: number;
    rttMs: number | null;
    jitterMs: number | null;
    jitterBufferMs: number | null;
    estOneWayMs: number | null;
    packetsLost: number | null;
}
export declare class AudioLatencyProbe {
    private pc;
    private log;
    private timer;
    constructor(pc: RTCPeerConnection, log?: (...a: unknown[]) => void);
    sample(): Promise<AudioLatencySample>;
    logOnce(): Promise<AudioLatencySample>;
    start(intervalMs?: number): void;
    stop(): void;
}
export declare function audioLatencyEnabled(): boolean;
//# sourceMappingURL=audioLatency.d.ts.map
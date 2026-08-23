import type { RobotDescriptor, WatchdogProfile } from "../teleop";
export interface MockSimOptions {
    descriptor?: RobotDescriptor;
    watchdog?: WatchdogProfile;
    initialState?: Record<string, number>;
    protocolVersion?: number;
    seed?: number;
    jogUnitsPerS?: number;
    actionUnitsPerS?: number;
}
type Frame = Record<string, unknown>;
export declare class MockDaemonSim {
    readonly descriptor: RobotDescriptor;
    readonly watchdog: WatchdogProfile;
    readonly protocolVersion: number;
    private st;
    private initial;
    private jog;
    private pending;
    private safety;
    private latchReason;
    private lastControlMs;
    private lastTickMs;
    private moved;
    private rng;
    private readonly jogRate;
    private readonly actionRate;
    private readonly idleCurrentMotor;
    constructor(opts?: MockSimOptions);
    ackFrame(): Frame;
    cameraLayoutFrame(): Frame | null;
    daemonStatusFrame(state?: "online" | "offline"): Frame;
    handleFrame(frame: Frame, nowMs: number): Frame[];
    private recSessionOpen;
    private recEpisode;
    private recKept;
    private recSeq;
    private recStereo;
    private handleRecord;
    private epId;
    private handleControl;
    private handleCommand;
    tick(nowMs: number): Frame[];
    private integrateJog;
    private slewActions;
    private telemetryFrame;
    state(): Record<string, number>;
    safetyState(): string;
    private actionStatus;
    private clampKey;
    private setJoint;
    private zeroVelocities;
    private noise;
}
export {};
//# sourceMappingURL=sim.d.ts.map
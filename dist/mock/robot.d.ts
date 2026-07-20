import { MockDaemonSim } from "./sim";
import type { SignalingTransport } from "../signaling";
export interface MockRobotOptions {
    sim?: MockDaemonSim;
    token?: string;
    telemetryHz?: number;
    video?: boolean;
    latencyMs?: number;
    log?: (msg: string) => void;
}
export interface MockRobotHandle {
    signaling: SignalingTransport;
    sim: MockDaemonSim;
    restart(): void;
    stop(): void;
}
export declare function createMockRobot(opts?: MockRobotOptions): MockRobotHandle;
//# sourceMappingURL=robot.d.ts.map
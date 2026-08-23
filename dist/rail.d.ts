import type { RobotDescriptor } from "./teleop";
export declare const RAIL_TRAVEL_MM = 950;
export interface LiftAxis {
    key: string;
    label: string;
    travelMm: number;
    side: "left" | "right" | null;
    advertised: boolean;
}
export declare function liftAxes(descriptor?: RobotDescriptor): LiftAxis[];
export declare function liftJogKey(descriptor: RobotDescriptor | undefined, side: "left" | "right"): string | null;
export declare function liftKeysInState(state: Record<string, number>): string[];
export declare function railReading(state: Record<string, number>, key: string, travelMm?: number): {
    known: boolean;
    depthMm: number;
    frac: number;
};
export declare function hasJointTelemetry(state: Record<string, number>): boolean;
//# sourceMappingURL=rail.d.ts.map
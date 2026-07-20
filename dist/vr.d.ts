import type { ExternalJog } from "./teleop";
export interface VrControllerFrame {
    position: [number, number, number] | null;
    orientation?: [number, number, number, number] | null;
    trigger: number;
    squeeze: number;
    thumbstick: {
        x: number;
        y: number;
    };
}
export interface VrControls {
    leftLiftUp?: boolean;
    leftLiftDown?: boolean;
    rightLiftUp?: boolean;
    rightLiftDown?: boolean;
    estop?: boolean;
}
export interface VrFrame {
    left?: VrControllerFrame | null;
    right?: VrControllerFrame | null;
    controls?: VrControls;
}
export interface VrMapResult {
    jog: ExternalJog | null;
    estop: boolean;
}
export interface VrTuning {
    sensitivity?: number;
    gripperOpenRate?: number;
}
export declare function resolveTuning(t?: VrTuning): Required<VrTuning>;
export declare class VrJogMapper {
    private readonly left;
    private readonly right;
    private estopPrev;
    private tuning;
    private gripperPos;
    private controlYaw;
    setControlYaw(yawRad: number): void;
    setTuning(t: VrTuning): void;
    setGripperPos(left: number | null, right: number | null): void;
    engagedArms(): {
        left: boolean;
        right: boolean;
    };
    reclutch(): void;
    map(frame: VrFrame): VrMapResult;
}
//# sourceMappingURL=vr.d.ts.map
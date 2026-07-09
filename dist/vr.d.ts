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
export declare class VrJogMapper {
    private readonly left;
    private readonly right;
    private estopPrev;
    private controlYaw;
    setControlYaw(yawRad: number): void;
    reclutch(): void;
    map(frame: VrFrame): VrMapResult;
}
//# sourceMappingURL=vr.d.ts.map
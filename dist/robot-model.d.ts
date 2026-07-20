import * as THREE from "three";
import type { ArmSide } from "./teleop";
/**
 * Which arm(s) render in the green "you are driving this" highlight.
 *
 * The desktop passes its single `settings.arm` (the keyboard drives one arm at a time). VR is
 * DUAL-arm — each controller drives its own arm — so it has no single active arm and instead
 * passes whichever clutches are engaged, which can be neither or both.
 */
export type ArmHighlight = ArmSide | "both" | "none";
export interface RobotModel {
    /** Mount this in any three.js scene (or R3F via <primitive object={root} />). */
    root: THREE.Group;
    /** Re-pose from a telemetry `state` dict. Cheap — writes rotations, allocates nothing. */
    update(state: Record<string, number>, highlight: ArmHighlight): void;
    /** Release GPU resources. Call when the owning scene tears down. */
    dispose(): void;
}
export interface RobotModelOptions {
    /** Floor grid under the robot. Nice for the desktop card; noisy floating in VR. */
    showGrid?: boolean;
}
/**
 * Build the robot schematic. Returns a plain three.js object plus an `update()` that re-poses it
 * from a telemetry `state` dict — no React, no renderer assumptions.
 */
export declare function buildRobotModel(opts?: RobotModelOptions): RobotModel;
//# sourceMappingURL=robot-model.d.ts.map
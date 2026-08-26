export declare const SO101_L1_M = 0.1159;
export declare const SO101_L2_M = 0.135;
export declare const SO101_T1O: number;
export declare const SO101_T2O: number;
export declare const SO101_WRIST_M = 0.06;
export declare const SO101_GRIP_M = 0.09;
/** A gripper position in millimetres, in the frame documented in the file header. */
export interface GripperPointMm {
    x: number;
    y: number;
    z: number;
}
/**
 * Gripper-tip position of one L-series arm from a telemetry `state` dict, in mm.
 *
 * Returns null when the arm isn't in the telemetry at all (no `<side>_arm_shoulder_pan.pos`
 * key) — e.g. a robot without that arm — rather than reporting a fictitious rest pose.
 *
 * Planar chain in the daemon's angle convention (robot-model.ts header): shoulder world pitch
 * th1 = rad(90 − sl) − T1O; elbow bend th2 = rad(ef + 90) − T2O (0 = straight, + bends down);
 * gripper WORLD pitch = −rad(sl + ef + wf). Pan: the SO101 URDF Rotation axis is (0,0,−1) in
 * the Z-up base frame, so +pan yaws the arm CLOCKWISE from above = toward robot-RIGHT (−y).
 */
export declare function l2GripperMm(state: Record<string, number>, side: "left" | "right"): GripperPointMm | null;
//# sourceMappingURL=fk.d.ts.map
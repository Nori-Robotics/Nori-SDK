import type { RemoteTeleop, TelemetryView } from "./teleop";
type Hand = "left" | "right";
export interface VrButtonRef {
    hand: Hand;
    index: number;
}
export interface VrBindings {
    clutch: Record<Hand, number>;
    gripper: Record<Hand, number>;
    leftLiftUp?: VrButtonRef;
    leftLiftDown?: VrButtonRef;
    rightLiftUp?: VrButtonRef;
    rightLiftDown?: VrButtonRef;
    estop?: VrButtonRef;
    reset?: VrButtonRef;
}
export declare const DEFAULT_BINDINGS: VrBindings;
export interface VrSessionOptions {
    teleop: RemoteTeleop;
    videoEl: HTMLVideoElement;
    onLog: (msg: string) => void;
    onEnd: () => void;
    bindings?: VrBindings;
}
export declare class VrSession {
    private o;
    private readonly b;
    private readonly mapper;
    private renderer;
    private scene;
    private camera;
    private texture;
    private panelGroup;
    private session;
    private currents;
    private hapticBase;
    private lastHapticAt;
    private tel;
    private lastTelAt;
    private hudCanvas;
    private hudCtx;
    private hudTexture;
    private lastHudDraw;
    private resetHeldSince;
    private resetFired;
    private recenterPending;
    private rcBtn;
    private rcBtnCanvas;
    private rcBtnCtx;
    private rcBtnTexture;
    private rcPoked;
    private rcBtnHot;
    private running;
    constructor(opts: VrSessionOptions);
    static isSupported(): Promise<boolean>;
    setCurrents(c: Record<string, number>): void;
    setTelemetry(t: TelemetryView): void;
    reclutch(): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleEnd;
    private onXRFrame;
    private buttonDown;
    private sampleController;
    recenter(): void;
    private serviceRecenter;
    private updateRecenterButton;
    private drawRecenterButton;
    private handleResetHold;
    private drawHud;
    private roundRect;
    private shortMotor;
    private applyHaptics;
}
export {};
//# sourceMappingURL=vr-session.d.ts.map
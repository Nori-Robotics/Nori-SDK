import type { IcePayload, NackPayload, RobotHerePayload, SdpPayload, SignalingTransport } from "../signaling";
export interface MockRobotSignalingPort {
    announce(payload?: RobotHerePayload): void;
    sendSdp(p: SdpPayload): void;
    sendIce(p: IcePayload): void;
    sendNack(p: NackPayload): void;
    onOperatorOpen(cb: () => void): void;
    onReady(cb: (p: {
        mac?: string;
    }) => void): void;
    onSdp(cb: (p: SdpPayload) => void): void;
    onIce(cb: (p: IcePayload) => void): void;
    onBye(cb: () => void): void;
}
export interface LoopbackSignalingOptions {
    latencyMs?: number;
}
export declare function createLoopbackSignaling(opts?: LoopbackSignalingOptions): {
    transport: SignalingTransport;
    robot: MockRobotSignalingPort;
};
//# sourceMappingURL=loopback-signaling.d.ts.map
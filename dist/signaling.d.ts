export interface SdpPayload {
    type: "offer" | "answer";
    sdp: string;
}
export interface IcePayload {
    candidate: string;
    sdpMLineIndex: number | null;
}
export interface RobotHerePayload {
    nonce?: string;
}
export interface SignalingHandlers {
    onSdp: (payload: SdpPayload) => void;
    onIce: (payload: IcePayload) => void;
    onRobotHere: (payload: RobotHerePayload) => void;
    onOpen: () => void;
}
export interface SignalingTransport {
    connect(handlers: SignalingHandlers): Promise<void>;
    sendReady(payload: {
        mac?: string;
    }): void;
    sendSdp(payload: SdpPayload): void;
    sendIce(payload: IcePayload): void;
    sendBye(): void;
    close(): Promise<void>;
}
//# sourceMappingURL=signaling.d.ts.map
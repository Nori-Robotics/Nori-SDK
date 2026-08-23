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
export interface NackPayload {
    reason?: "unauthorized" | (string & {});
}
export type SignalingState = "open" | "error" | "timeout" | "closed";
export interface SignalingHandlers {
    onSdp: (payload: SdpPayload) => void;
    onIce: (payload: IcePayload) => void;
    onRobotHere: (payload: RobotHerePayload) => void;
    onNack?: (payload: NackPayload) => void;
    onOpen: () => void;
    onState?: (state: SignalingState) => void;
}
export interface ReadyTurn {
    urls: string[];
    username: string;
    credential: string;
}
export interface SignalingTransport {
    connect(handlers: SignalingHandlers): Promise<void>;
    sendReady(payload: {
        mac?: string;
        turn?: ReadyTurn;
        grant?: string;
    }): void;
    sendSdp(payload: SdpPayload): void;
    sendIce(payload: IcePayload): void;
    sendBye(): void;
    close(): Promise<void>;
}
//# sourceMappingURL=signaling.d.ts.map
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignalingTransport, SignalingHandlers, SdpPayload, IcePayload } from "./signaling";
export declare class SupabaseSignaling implements SignalingTransport {
    private supabase;
    readonly room: string;
    private log?;
    private opts;
    private channel;
    private handlers;
    private usePrivate;
    constructor(supabase: SupabaseClient, room: string, log?: ((...args: unknown[]) => void) | undefined, opts?: {
        private?: boolean;
    });
    connect(h: SignalingHandlers): Promise<void>;
    private openChannel;
    sendReady(payload: {
        mac?: string;
        turn?: import("./signaling").ReadyTurn;
        grant?: string;
    }): void;
    sendSdp(payload: SdpPayload): void;
    sendIce(payload: IcePayload): void;
    sendBye(): void;
    close(): Promise<void>;
}
//# sourceMappingURL=signaling-supabase.d.ts.map
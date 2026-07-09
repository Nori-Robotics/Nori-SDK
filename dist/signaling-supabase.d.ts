import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignalingTransport, SignalingHandlers, SdpPayload, IcePayload } from "./signaling";
export declare class SupabaseSignaling implements SignalingTransport {
    private supabase;
    private room;
    private log?;
    private channel;
    constructor(supabase: SupabaseClient, room: string, log?: ((...args: unknown[]) => void) | undefined);
    connect(h: SignalingHandlers): Promise<void>;
    sendReady(payload: {
        mac?: string;
    }): void;
    sendSdp(payload: SdpPayload): void;
    sendIce(payload: IcePayload): void;
    sendBye(): void;
    close(): Promise<void>;
}
//# sourceMappingURL=signaling-supabase.d.ts.map
// NORI: Additive file (SDK Phase 0). Supabase Realtime implementation of SignalingTransport —
// the transport the LeLab fork ships with. This is the ONLY file in the SDK core that imports
// Supabase; keeping the coupling here is the whole point (see signaling.ts + docs/SDK_TODOS.md).
// An external SDK consumer who doesn't use Supabase provides their own SignalingTransport and
// never imports this file.
//
// The channel calls below are a VERBATIM lift of what used to live inline in teleop.ts's
// start()/stop()/sendReady()/freshPeer(), so behavior for the fork is byte-identical.
export class SupabaseSignaling {
    // `log` is optional so the core stays logger-agnostic; the fork passes its appendLog so the
    // familiar "channel: SUBSCRIBED" trace survives the extraction.
    constructor(supabase, room, log) {
        this.supabase = supabase;
        this.room = room;
        this.log = log;
        this.channel = null;
    }
    async connect(h) {
        if (this.channel) {
            try {
                await this.channel.unsubscribe();
            }
            catch { /* noop */ }
        }
        const channel = this.supabase.channel(this.room, { config: { broadcast: { self: false } } });
        this.channel = channel;
        channel.on("broadcast", { event: "sdp" }, ({ payload }) => h.onSdp(payload));
        channel.on("broadcast", { event: "ice" }, ({ payload }) => h.onIce(payload));
        channel.on("broadcast", { event: "robot_here" }, ({ payload }) => h.onRobotHere((payload ?? {})));
        channel.subscribe((status) => {
            this.log?.("channel:", status);
            if (status === "SUBSCRIBED")
                h.onOpen();
        });
    }
    sendReady(payload) {
        this.channel?.send({ type: "broadcast", event: "ready", payload });
    }
    sendSdp(payload) {
        this.channel?.send({ type: "broadcast", event: "sdp", payload });
    }
    sendIce(payload) {
        this.channel?.send({ type: "broadcast", event: "ice", payload });
    }
    sendBye() {
        try {
            this.channel?.send({ type: "broadcast", event: "bye", payload: {} });
        }
        catch { /* noop */ }
    }
    async close() {
        if (this.channel) {
            try {
                await this.channel.unsubscribe();
            }
            catch { /* noop */ }
            this.channel = null;
        }
    }
}
//# sourceMappingURL=signaling-supabase.js.map
// NORI: Additive file (SDK v1 mock mode — docs/sdk_v1_finalization.md item 1).
// In-memory SignalingTransport pair: the operator end plugs into RemoteTeleop unchanged; the
// robot end is consumed by MockRobot. No network, no Supabase — the same five-event contract
// (ready / robot_here / sdp / ice / bye) delivered over queued callbacks, with an optional
// artificial latency so reconnect/race paths can be exercised deterministically.
//
// SAFETY NOTE: signaling carries no control authority (see signaling.ts) — and in mock mode
// there is no robot at all, so this file is test scaffolding by construction.
export function createLoopbackSignaling(opts) {
    const latency = Math.max(0, opts?.latencyMs ?? 0);
    let operator = null;
    let closed = false;
    const robotCbs = {};
    // Every delivery is deferred (queued macrotask) so ordering matches a real transport and a
    // send is never synchronously re-entrant.
    //
    // `closed` is checked at SEND time, not delivery time: a message handed to the transport
    // while the room was still open is already on its way and must still land. RemoteTeleop.stop()
    // relies on exactly this — it calls sendBye() and close() in the same synchronous task
    // (teleop.ts stop()), so a delivery-time check would drop every bye and the robot would never
    // hear the operator leave. Sends made AFTER close are dropped, like a real unsubscribe.
    const deliver = (fn) => {
        if (closed)
            return;
        setTimeout(fn, latency);
    };
    const transport = {
        async connect(handlers) {
            operator = handlers;
            closed = false;
            deliver(() => {
                operator?.onState?.("open");
                operator?.onOpen();
                robotCbs.open?.();
            });
        },
        sendReady(payload) {
            deliver(() => robotCbs.ready?.(payload ?? {}));
        },
        sendSdp(payload) {
            deliver(() => robotCbs.sdp?.(payload));
        },
        sendIce(payload) {
            deliver(() => robotCbs.ice?.(payload));
        },
        sendBye() {
            deliver(() => robotCbs.bye?.());
        },
        async close() {
            closed = true;
            operator = null;
        },
    };
    const robot = {
        announce(payload) {
            deliver(() => operator?.onRobotHere(payload ?? {}));
        },
        sendSdp(p) {
            deliver(() => operator?.onSdp(p));
        },
        sendIce(p) {
            deliver(() => operator?.onIce(p));
        },
        sendNack(p) {
            deliver(() => operator?.onNack?.(p));
        },
        onOperatorOpen(cb) {
            robotCbs.open = cb;
        },
        onReady(cb) {
            robotCbs.ready = cb;
        },
        onSdp(cb) {
            robotCbs.sdp = cb;
        },
        onIce(cb) {
            robotCbs.ice = cb;
        },
        onBye(cb) {
            robotCbs.bye = cb;
        },
    };
    return { transport, robot };
}
//# sourceMappingURL=loopback-signaling.js.map
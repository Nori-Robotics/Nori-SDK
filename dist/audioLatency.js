// Audio-latency harness (R-X.2). Reads RTCPeerConnection getStats() to break down the *tunable*
// part of one-way audio latency — network RTT/2 + jitter-buffer delay (+ jitter/loss for context).
// This is measurable NOW on the M3a uplink (robot mic → operator) and is reused unchanged for the
// M3b downlink once the AEC hardware lands.
//
// What it does NOT include: the *acoustic* delay of the mic capture + speaker output hardware.
// That needs the real device and an acoustic loopback (play a click, detect it on the return path,
// halve the round trip) and is a hardware-day step — see m3_m5_implementation_plan.md §2.1a.
//
// Target (R-X.2): one-way < 300 ms (good < 150 ms; > 400 ms disruptive). The network+buffer
// estimate here is the part you tune (jitter buffer, codec, TURN vs direct); if it alone is near
// the budget, the acoustic path won't save you.
//
// Usage: auto-starts periodic logging when the operator page URL has `?audiolatency`; otherwise
// call `probe.logOnce()` / `probe.start()` programmatically (e.g. from a future dev button).
const fmt = (v) => (v === null ? "?" : v.toFixed(0));
export class AudioLatencyProbe {
    constructor(pc, log = (...a) => console.log(...a)) {
        this.pc = pc;
        this.log = log;
        this.timer = null;
    }
    async sample() {
        const stats = await this.pc.getStats();
        let rttMs = null;
        let jitterMs = null;
        let packetsLost = null;
        let jbDelay = 0;
        let jbCount = 0;
        let haveJb = false;
        stats.forEach((r) => {
            const x = r;
            if (r.type === "candidate-pair" && (x.selected || (x.nominated && x.state === "succeeded"))) {
                if (typeof x.currentRoundTripTime === "number")
                    rttMs = x.currentRoundTripTime * 1000;
            }
            if (r.type === "inbound-rtp" && x.kind === "audio") {
                if (typeof x.jitter === "number")
                    jitterMs = x.jitter * 1000;
                if (typeof x.packetsLost === "number")
                    packetsLost = x.packetsLost;
                if (typeof x.jitterBufferDelay === "number"
                    && typeof x.jitterBufferEmittedCount === "number"
                    && x.jitterBufferEmittedCount > 0) {
                    jbDelay = x.jitterBufferDelay;
                    jbCount = x.jitterBufferEmittedCount;
                    haveJb = true;
                }
            }
        });
        const jitterBufferMs = haveJb ? (jbDelay / jbCount) * 1000 : null;
        const estOneWayMs = rttMs !== null || jitterBufferMs !== null ? (rttMs ?? 0) / 2 + (jitterBufferMs ?? 0) : null;
        return { ts: Date.now(), rttMs, jitterMs, jitterBufferMs, estOneWayMs, packetsLost };
    }
    async logOnce() {
        const s = await this.sample();
        this.log(`[audio-latency] est one-way ~${fmt(s.estOneWayMs)}ms ` +
            `(net RTT/2 ${fmt(s.rttMs === null ? null : s.rttMs / 2)} + jbuf ${fmt(s.jitterBufferMs)}); ` +
            `jitter ${fmt(s.jitterMs)}ms, lost ${s.packetsLost ?? "?"} ` +
            `— excludes mic/speaker acoustic delay (loopback on real HW)`);
        return s;
    }
    start(intervalMs = 3000) {
        this.stop();
        this.timer = setInterval(() => { void this.logOnce(); }, intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
// True when the operator page opted into periodic latency logging (`?audiolatency`).
export function audioLatencyEnabled() {
    try {
        return new URLSearchParams(location.search).has("audiolatency");
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=audioLatency.js.map
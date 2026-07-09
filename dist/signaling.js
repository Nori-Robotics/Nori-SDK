// NORI: Additive file (SDK Phase 0). Transport abstraction for the teleop SIGNALING channel —
// the small out-of-band pipe that carries WebRTC SDP/ICE + the room handshake between the
// operator and the robot BEFORE the peer connection exists.
//
// WHY THIS EXISTS: RemoteTeleop used to call Supabase Realtime directly, which welded the whole
// SDK to Nori's cloud — an external dev would need a Supabase seat just to exchange an offer.
// The surface actually used is tiny (a broadcast room with a handful of named events), so we
// hide it behind this interface. The fork ships a Supabase adapter (signaling-supabase.ts); an
// external SDK consumer can bring their own transport (a plain WebSocket, a manual copy/paste,
// a different SaaS) without touching RemoteTeleop. This is the keystone that makes nori-sdk
// cloud-agnostic (see docs/SDK_TODOS.md, Phase 0).
//
// SAFETY NOTE: the transport carries only signaling. The daemon defends itself regardless
// (clamp / watchdog / E-STOP / torque lifecycle are all Pi-side), so a buggy or hostile
// signaling implementation can at worst fail to connect — it can never move the robot unsafely.
export {};
//# sourceMappingURL=signaling.js.map
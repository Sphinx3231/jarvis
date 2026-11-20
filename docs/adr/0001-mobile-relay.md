# ADR 0001 — Phone ↔ PC through an outbound relay

**Status:** accepted

**Context.** The phone must reach PC Jarvis across networks (mobile data, other Wi-Fi). Jarvis's
local API must never be exposed to the internet, and users can't be expected to configure port
forwarding or a VPN.

**Decision.** A small relay (`relay/`) that both ends connect to *outbound* over WebSocket (TLS).
The relay authenticates devices by key (challenge-response), routes only between a PC and the
phones that PC allow-lists, keeps no history, and never sees plaintext. Users host it themselves
(Docker/Node, behind TLS).

**Alternatives.** Direct LAN connection (doesn't work across networks), exposing the PC API through
a tunnel (exposes the control surface), a third-party push/messaging service (account + data
custody), WebRTC (needs signalling + TURN anyway, much more machinery).

**Consequences.** One more thing to deploy; the relay is a single point of availability (not of
trust — see ADR 0002). Offline recipients get nothing, so senders keep an outbox and rely on
idempotency.

# ADR 0002 — End-to-end encryption and device identity

**Status:** accepted

**Context.** The relay is internet-facing and possibly third-party hosted; it must not be able to
read or forge commands. We must not invent cryptography.

**Decision.** Standard primitives only, available in both Node `crypto` and the Android Keystore/JCA:
device identity = ECDSA P-256 key, device id = SHA-256 of its SPKI. Message keys: P-256 ECDH →
HKDF-SHA256 with directional info (`msg|from|to`) → AES-256-GCM with the addresses as AAD.
Pairing: a one-time 256-bit secret in the QR → HKDF → AES-256-GCM; the PC's id in the QR pins its
identity. Phone private keys are non-exportable Keystore keys (`PURPOSE_AGREE_KEY`, hence minSdk 31).

**Consequences.** A relay can drop or delay but not read, modify, replay (ids + timestamp window)
or impersonate. Both implementations are checked against shared crypto vectors
(`shared/protocol/fixtures/crypto-vectors.json`). No forward secrecy per message (static ECDH);
revoking a phone and re-pairing rotates the relationship.

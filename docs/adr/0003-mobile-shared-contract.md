# ADR 0003 — One protocol contract for TypeScript and Kotlin

**Status:** accepted

**Context.** The PC (TypeScript) and the app (Kotlin) must agree exactly on messages and crypto.

**Decision.** `shared/protocol/protocol.ts` (zod) is the source of truth.
`scripts/protocol-export.ts` generates a JSON Schema, golden envelope fixtures and crypto vectors;
`--check` (run by `tests/protocol-contract.test.ts`) fails when they're stale. The Kotlin
`ContractTest` round-trips every fixture through `Protocol.kt`, applies the same validation rules,
and reproduces the crypto vectors byte-for-byte. The protocol is versioned (`v: 1`); unknown
versions are rejected.

**Alternatives.** Code generation for Kotlin (heavier tooling for a small surface), protobuf
(another toolchain and less readable over the relay).

**Consequences.** Kotlin types are hand-written but cannot silently drift: a change in TS that isn't
mirrored fails the Kotlin tests.

# ADR 0004 — Mobile mode: an independent, permissioned runtime

**Status:** accepted

**Context.** Mobile mode must work without the PC and must not be a disguised remote control. An
LLM proposing an action must never be enough to perform it.

**Decision.** A small on-phone runtime: `ModelProvider` interface (Anthropic, any
OpenAI-compatible endpoint; on-device later), a registry of narrow, schema-described Android
capabilities, a permission manager (per-capability allow/ask/block; read-only allowed and acting
asks by default; approvals only from the user's tap, with a timeout), and a router loop with a step
cap that validates every call. Direct commands (`LocalIntents`) work with no model at all and go
through the same checks. State lives in Room; reminders use WorkManager; the API key is encrypted
with a Keystore key.

**Not done on purpose.** No AccessibilityService automation, no always-on listening, no background
service, no syncing of phone data to the PC.

**Consequences.** Capabilities are deliberately limited to what Android exposes through intents
and APIs. Agents with PC-only work (Friday, Tom, Trinity) are shown as unavailable in Mobile mode
rather than faked.

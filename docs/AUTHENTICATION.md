# Authentication contract

The receiver implements Standard Webhooks **HMAC v1**, not the asymmetric scheme or provider-specific adapters. The specification and JavaScript reference implementation were checked on 26 October 2026. The pinned `standardwebhooks` package is a development-only interoperability oracle; runtime verification uses Node's built-in crypto over buffers.

The signed message is the ASCII prefix `webhook-id.webhook-timestamp.` followed by the exact request-body bytes. JSON parsing happens after verification. Neither whitespace normalization nor UTF-8 replacement is allowed before authentication. Signatures are compared with `timingSafeEqual`.

Local constraints are deliberately stricter than the reference library's permissive timestamp parsing:

- IDs: 1–128 ASCII letters, digits, underscores or hyphens. No periods or whitespace.
- Timestamp: canonical positive decimal Unix seconds, within an inclusive ±300 seconds of receiver time. The delivery timestamp is not the event occurrence time.
- Body: at most 65,536 bytes; HTTP intake additionally requires valid UTF-8 JSON.
- Signature header: at most 2,048 characters and eight space-separated candidates. Only canonical base64 HMAC-SHA256 `v1` signatures are accepted; unknown versions may accompany a valid v1 candidate.
- Secrets: one or two locally configured `whsec_` values containing canonical base64 of 24–64 random bytes. Two keys permit overlap during rotation. Removing the old key ends acceptance under that key. Never send keys in request data.

Freshness limits replay age; it does not prevent repeated delivery inside the window. Durable event-ID deduplication provides that separate control. A retry may have a new signed attempt timestamp while keeping the same event ID and body. Reusing an ID with changed body bytes is a conflict, even if JSON values are equivalent.

The secret set and database represent **one trusted source/endpoint**. Do not mix independent providers or tenants in one database; event IDs are unique only within this configured endpoint. HMAC authenticates a holder of the shared secret, not a unique sender identity, and does not encrypt data.

Sources:

- https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/index.ts

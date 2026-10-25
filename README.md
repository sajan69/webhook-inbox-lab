# Webhook Inbox Lab

A local webhook receiver for exploring authenticated delivery, durable intake and safe retries.

Webhook delivery can include duplicates, delays and reordered events. This project will demonstrate how to acknowledge an authenticated event only after storing it, then process it with explicit retry and recovery behavior.

## Status

Scoped; implementation has not started. There is no runnable receiver, test suite or measured result yet.

## Planned design

- Node.js 24 and TypeScript, with a SQLite inbox.
- Standard Webhooks verification over the original request bytes, authenticated event ID and timestamp, freshness checks and overlapping signing-secret rotation.
- Durable enqueue before acknowledgment; authenticated-ID deduplication and body-hash conflict detection.
- A leased worker with bounded retries, backoff, expired-lease recovery and a dead-letter state.
- An idempotent sample SQLite ledger handler, with its effect and processing state committed in one transaction.
- Local CLI demo and minimal read-only queue inspection.

Only synthetic loopback traffic is in scope. No provider account, real signing secret, cloud deployment, payment or outbound callback service is required.

## Acceptance criteria

- [ ] Verify the current Standard Webhooks specification and library behavior; document exact validation and replay boundaries.
- [ ] Test valid, tampered, stale and malformed requests, payload limits and secret rotation.
- [ ] Demonstrate durable acknowledgment, concurrent duplicates and conflicting reuse of an authenticated event ID.
- [ ] Demonstrate restart after enqueue, expired-lease recovery, bounded retries and retry exhaustion.
- [ ] Demonstrate that duplicate or reordered delivery cannot repeat the sample ledger effect; document ordering semantics.
- [ ] Provide a reproducible local demo, automated tests and passing CI.
- [ ] Record a measured workload with its method, environment and actual results.
- [ ] Document setup, architecture, security decisions and limitations.

## Implementation order

1. Establish the TypeScript package, ignore rules and test/CI foundation.
2. Implement and test request authentication and durable intake.
3. Implement and test leasing, retries and transactional sample processing.
4. Add the integrated demo, inspection commands and measurements.
5. Verify the complete workflow and document its guarantees and remaining limitations.

## Boundaries

This is a small local reliability lab, not a hosted webhook platform. It will not claim exactly-once external effects. Any idempotency guarantee must be limited to the sample database transaction and supported by tests. Standard Webhooks and provider-specific signature schemes have different authenticated fields; adapters are outside the initial scope.

## References

- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
- [Supabase Platform Webhooks](https://supabase.com/docs/guides/platform/webhooks)
- [OWASP Webhook Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html)
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

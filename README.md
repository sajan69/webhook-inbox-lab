# Webhook Inbox Lab

A local webhook receiver for exploring authenticated delivery, durable intake and safe retries.

Webhook delivery can include duplicates, delays and reordered events. The receiver acknowledges an authenticated event only after storing it, then processes it with explicit retry and recovery behavior.

## Design and scope

- Node.js 24 and TypeScript, with a SQLite inbox.
- Standard Webhooks verification over the original request bytes, authenticated event ID and timestamp, freshness checks and overlapping signing-secret rotation.
- Durable enqueue before acknowledgment; authenticated-ID deduplication and body-hash conflict detection.
- A leased worker with bounded retries, backoff, expired-lease recovery and a dead-letter state.
- An idempotent sample SQLite ledger handler, with its effect and processing state committed in one transaction.
- Local CLI demo and minimal read-only queue inspection.

Only synthetic loopback traffic is in scope. No provider account, real signing secret, cloud deployment, payment or outbound callback service is required.

## Run the intake demo

Requires Node.js 24.22+ (24.x) and npm. No AWS account, webhook provider or real secret is required.

```sh
npm ci --ignore-scripts
npm test
npm run demo:intake
npm run demo:processing
```

The demo creates a temporary database and random signing key, sends synthetic requests to an ephemeral loopback port, verifies the results, then removes its data. Expected results: one new acknowledgment, 19 duplicates, conflicting-body status 409, tampered-ID and stale-attempt status 401, and one pending row after reopening. These are deterministic functional checks, not throughput measurements.

The processing demo goes further: eight synthetic events finish as five done and three dead letters, with four ledger entries totaling 46 synthetic units. It exercises retries, conflicting business keys, restart and expired-lease recovery using an explicit virtual worker clock. Separate subprocess tests cover forced process termination.

To run a persistent local receiver on port 8787 (POSIX shell):

```sh
umask 077
mkdir -p data
export WEBHOOK_SECRETS="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(JSON.stringify(["whsec_" + randomBytes(32).toString("base64")]))')"
npm run build
npm start -- serve data/inbox.sqlite 8787
```

The receiver keeps the signing key in its environment; it never prints it. Supply the same key to a trusted local sender. A two-element `WEBHOOK_SECRETS` JSON array permits overlap during key rotation. Stop the receiver with Ctrl+C. The demonstration command above is the simplest complete sender/receiver example.

Read metadata from a second terminal without signing secrets:

```sh
npm start -- inspect data/inbox.sqlite 100
npm start -- work data/inbox.sqlite 100
```

The worker processes a bounded batch and exits when no eligible work remains; it does not wait for future retry deadlines. Run it again later to recover expired leases or process due retries. Only validated `ledger.credit` events affect the sample ledger; generic intake acceptance does not imply successful business processing. See [processing semantics](docs/WORKER.md).

Use a private local directory. Payloads are stored unencrypted and must be synthetic. Retained inbox capacity is 10,000 events; no retention or deletion command exists yet.

## Validation and technical details

Local validation on Node 24.22.1: 54 automated tests cover authentication, migration, persistence, leases/retries, transactional effects, concurrent processes, abrupt process termination, HTTP boundaries, CLI behavior and both demos. CI builds TypeScript, runs tests, executes both demos and verifies a small benchmark workload on Node 24. Live provider integration and physical power-loss behavior have not been tested.

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Evaluation method, actual measurements and limitations](docs/EVALUATION.md)
- [Authentication and replay boundaries](docs/AUTHENTICATION.md)
- [Transactions, storage and durability limits](docs/STORAGE.md)
- [Worker states, ledger semantics and recovery](docs/WORKER.md)
- [HTTP contract and resource limits](docs/HTTP.md)
- [Recorded synthetic intake result](docs/reports/intake.json)
- [Recorded processing drill result](docs/reports/processing.json)

## Measure the local workload

```sh
npm run benchmark -- 500 3
```

This measures sequential verification/intake, duplicate handling and processing using fresh temporary databases. It does not measure HTTP latency. The [evaluation report](docs/EVALUATION.md) records the workload, environment, individual results and caveats.

## Boundaries

This is a small local reliability lab, not a hosted webhook platform. It will not claim exactly-once external effects. Any idempotency guarantee must be limited to the sample database transaction and supported by tests. Standard Webhooks and provider-specific signature schemes have different authenticated fields; adapters are outside the initial scope.

## References

- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
- [Supabase Platform Webhooks](https://supabase.com/docs/guides/platform/webhooks)
- [OWASP Webhook Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html)
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)


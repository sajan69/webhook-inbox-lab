# Architecture and trust boundaries

The bounded local MVP separates authenticated receipt from business processing. It uses one configured source/endpoint and one SQLite database, with no runtime npm dependencies or external service calls.

## Request path

The loopback receiver bounds headers/body and validates transport metadata. HMAC v1 verifies the original body plus authenticated ID and attempt timestamp. Only then does generic UTF-8/JSON event validation run. A write transaction checks delivery identity, detects conflicts, enforces retained capacity and inserts the event. The HTTP success acknowledgment follows commit.

Receipt means durable intake, not successful business processing. An acknowledged event may later fail business validation. If acknowledgment is lost after commit, the producer's retry encounters the retained delivery ID.

## Processing path

The worker claims an eligible row in a short write transaction and obtains a fresh lease token. Business parsing and the immutable ledger effect run in a second write transaction that verifies the token/deadline and commits the effect with completion. SQLite serializes writes across independent receiver/worker processes. No user callback runs inside the effect transaction.

A trusted pre-ledger hook supports synthetic failure drills; it runs before the effect transaction. It must not implement external business effects. The normal CLI does not configure this hook. Unknown failures stop the batch, leaving the lease to expire. Known transient failures persist bounded backoff; permanent failures and exhausted attempts become dead letters. See WORKER.md for exact states and timing.

This design deliberately uses synchronous SQLite in Node 24 for inspectable local behavior. Writes may block the event loop, there is one writer at a time, and a batch worker exits rather than scheduling future work. It is not a distributed queue or hosted webhook service.

## Data model and identities

| Identity | Purpose | Retention boundary |
| --- | --- | --- |
| Delivery ID | Deduplicate the authenticated webhook event | Inbox row is retained even after completion/dead letter |
| Body SHA-256 | Detect different bytes under a retained delivery ID | Exact bytes, independent of JSON equivalence |
| Lease token | Authorize one current claim's completion/failure | Replaced on recovery and cleared on settlement |
| Ledger entry ID | Deduplicate the immutable sample effect across delivery IDs | Retained ledger key; conflicting account/amount is terminal |

Raw synthetic payloads are stored. Signatures and signing keys are not persisted; inspection omits payloads and lease tokens. A read-only snapshot shows bounded event metadata and aggregate ledger units. All rows count toward retained capacity; no automatic pruning or redrive is implemented.

## Security assumptions and limits

| Concern | Control | Remaining limit |
| --- | --- | --- |
| Tampering and old replays | Byte-preserving HMAC, authenticated metadata, freshness and durable IDs | Shared-key holder can create messages; stable wall-clock time is assumed |
| Conflicting retries | Exact-body digest and immutable business-key check | Deleting/modifying retained keys invalidates deduplication guarantees |
| Resumed stale worker | Token and deadline checked under the effect transaction lock | No lease renewal; not designed for long external handlers |
| Browser and local resource misuse | Loopback bind, exact Host, Origin rejection and bounded requests | Trusted local host; not internet-facing DoS protection |
| Local payload/secret exposure | Private file mode, trusted directory, generic failures, no request logs | No encryption; directory races, hostile files and compromised host are out of scope |
| Partial local business effect | Effect and completion share one SQLite commit | Hardware/filesystem durability still matters; no exactly-once external effects |

HTTP signatures do not encrypt data. Use synthetic loopback traffic only. Back up the database and stop old binaries before migration. Validate Node/SQLite behavior when upgrading versions. Paid infrastructure, real provider delivery, multi-tenancy, mutable account ordering, distributed locking and third-party effects are outside scope.

## Verification map

Authentication tests cover interoperability, metadata ambiguity, freshness, rotation and byte integrity. Storage/migration tests cover atomic duplicate/conflict behavior and rollback of a failed upgrade. HTTP/CLI checks cover payload boundaries and sanitized operational failures. Worker tests cover ownership, retries, permanent failures, business-key conflicts and pre-applied effects. Process tests use independent claimers/workers and SIGKILL at defined boundaries; a trigger failure exercises rollback of the actual effect/completion method.

The processing demo uses real loopback HTTP and database reopen, with explicit virtual time and injected pre-handler faults. The benchmark is a separate sequential API microbenchmark; it does not measure the HTTP server. Evaluation details and actual reports are in EVALUATION.md.

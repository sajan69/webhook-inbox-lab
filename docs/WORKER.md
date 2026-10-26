# Processing, retries and recovery

## Bounded worker command

After building, run a batch against the same database as the receiver:

```sh
npm start -- work data/inbox.sqlite 100
npm start -- inspect data/inbox.sqlite 100
```

The worker does not need signing secrets. It processes up to 100 ready events by default (1–1,000 configurable), then exits. It does not sleep until future retries are due or run as a background daemon. Run another batch later to process due retries and recover expired leases. The receiver never runs the worker implicitly.

Inspection includes per-event state, attempt count, next availability, lease expiry, completion time and a bounded error code. Lease tokens, bodies and signing secrets are omitted. The ledger summary counts entries and sums synthetic units across accounts; it is not a financial balance report.

## State transitions

1. `pending` or due `retry` → `leased`: a `BEGIN IMMEDIATE` transaction selects one eligible row, increments its persisted attempt count and stores a fresh random token with a 30-second lease.
2. `leased` → `done`: the owner validates the business event and commits its ledger effect together with completion.
3. `leased` → `retry`: an explicitly classified transient handler failure stores the next eligible time and clears ownership.
4. `leased` → `dead`: invalid business data, a business-key conflict or exhausted attempts records a terminal code.
5. Expired `leased` → new `leased`: a later claim replaces ownership and increments the attempt count. If the expired lease was already attempt five, the next claim sweep marks it `dead` with `lease_expired` instead.

Eligibility uses an inclusive deadline: an owner is no longer valid when `lease_until <= now`. Completion and failure verify the stored token and deadline inside the same write transaction as their changes. Caller-provided attempt/deadline fields do not authorize writes. A replaced owner cannot complete or fail a recovered event. Production time is read after acquiring the write lock; explicit test clocks are trusted local inputs.

Claims use stable ordering by availability, receipt time and event ID. Expired claims can be retried alongside due events. This is not strict business-event ordering, and there is no lease renewal. The synchronous sample transaction is short; a long-running external handler would require a different design.

## Retry policy

At most five claims are permitted per event, including abandoned leases. Transient failures after attempts one through four wait 1, 2, 4 and 8 seconds respectively. The fifth failure becomes terminal. This bounded local drill uses deterministic backoff without jitter; it is not a fleet-wide retry scheduler.

Only `TransientHandlerError` is classified as retryable. Invalid event content and immutable business-key conflicts are terminal. Unknown/storage failures stop the worker and leave its lease available for expiry recovery. Arbitrary exception text is neither stored nor emitted. The built-in ledger handler has no external service dependency; the processing demo injects transient errors through a trusted in-process hook before the ledger transaction. There is no request-controlled failure hook or outbound callback.

Terminal rows remain in the inbox and count toward capacity. Repeated delivery of a terminal event still gets the intake duplicate acknowledgment and does not reset processing. There is no automatic redrive, deletion or retention scheduler. Investigate a dead letter rather than changing its ID merely to force another effect.

## Sample immutable ledger

The implemented business event is:

```json
{
  "type": "ledger.credit",
  "data": { "entryId": "credit_001", "account": "demo_account", "amount": 25 }
}
```

`entryId` is 1–128 ASCII letters/digits/underscores/hyphens; `account` has the same character set with a 64-character maximum. `amount` is an integer from 1 to 1,000,000,000 **synthetic units**. Unknown `data` fields are rejected; other top-level metadata is not interpreted. Intake's generic event validation is separate from this business validation, so an acknowledged event can later become a dead letter. Native JSON parsing uses last-value duplicate-key semantics as documented in HTTP.md.

The ledger primary key is `entryId`, independently of the delivery ID. Matching account/amount under an existing key completes as an already-applied effect. Different content under that key becomes `business_conflict`, preserving the first effect. Credits are immutable, independent and commutative; reordering them changes neither the set of effects nor the total. This example does not implement debits, mutable account state, event versions or causal ordering.

Effect insertion and inbox completion occur in one SQLite transaction. A failed completion rolls back the inserted effect. A process that dies before commit leaves no committed partial effect; after commit, completion survives even if the worker did not print a result. These guarantees apply to this database transaction and retained business key, **not exactly-once calls to an external service**. Deleting or manually modifying the database invalidates these assumptions.

## Schema upgrade

Version 2 adds processing fields and the sample ledger. Opening an application-owned version-one inbox through the current receiver/worker transactionally copies its rows into the new table, preserves raw body/hash/timestamps, and swaps tables only on success. Legacy rows start pending with zero attempts. A failed migration rolls back both data and version. Read-only inspection refuses a legacy database and never upgrades it.

Stop old binaries and back up application data before upgrading. Do not run version-one writers alongside version-two code. Unrelated or unsupported-version databases are rejected. Parent directories and local database files remain trusted; this is not a hostile-database parser or encrypted store.

## Reproduce the failure drill

```sh
npm run demo:processing
```

The drill sends eight synthetic events through real loopback HTTP, repeats one delivery, reopens the database, injects two transient failures before eventual success, exhausts another event, and reopens after an unsettled claim. An explicit virtual worker clock advances retry and lease deadlines without sleeping. Expected terminal results: five done events, three dead letters, four ledger entries totaling 46 synthetic units. The shared business key applies once despite a second delivery ID; conflicting content does not change it.

This demo's interruption uses a connection reopen. Separate subprocess tests use `SIGKILL` after a claim, inside an uncommitted effect transaction and after the combined commit. A trigger-induced completion failure checks the actual ledger method's rollback boundary. Eight-process tests verify single-claim ownership and duplicate business-effect handling. These are synthetic software-failure checks, not hardware power-loss tests or a performance benchmark.

SQLite transaction and migration guidance was reviewed on 26 October 2026:

- https://www.sqlite.org/lang_transaction.html
- https://www.sqlite.org/isolation.html
- https://www.sqlite.org/lang_altertable.html

# Durable intake

## Acknowledgment boundary

One SQLite database represents one configured source/endpoint. `BEGIN IMMEDIATE` serializes the lookup, capacity check and insert. Event ID is the primary key. The stored SHA-256 hashes the original body bytes; it is not a canonical JSON hash. Retry timestamps may change without changing event identity.

- A new committed row receives HTTP 202 (`inserted`).
- An existing ID with identical body hash receives HTTP 200 (`duplicate`). The original timestamp and receipt metadata remain unchanged.
- Reusing an ID with different bytes receives HTTP 409 (`event_conflict`). The existing row is preserved.
- Failed storage or exhausted capacity receives HTTP 503 with `Retry-After: 5`; it is never acknowledged as accepted.

The database uses WAL and `synchronous=FULL`. A 2xx is sent only after the transaction commits. If the process stops after commit but before the sender receives the acknowledgment, a retry is expected and resolves through the same durable key. Local tests cover eight independent concurrent processes and forced termination after commit. These are software/process-failure tests, not physical power-loss or disk-controller durability certification. Filesystem and hardware durability still matter.

## Storage contract

Schema version 1 stores event ID, raw body, SHA-256, first signed-at timestamp, receipt time and state `pending`. **No worker exists yet.** Nothing has applied the sample ledger effect, and a pending event is not a completed business operation.

The default capacity is 10,000 retained events; all rows count toward this bound. There is no automatic deletion, retention scheduler or disk-quota management yet. At the 64 KiB maximum payload, body storage alone could approach 625 MiB plus database/WAL overhead. Deleting the database removes deduplication history. Do not delete rows merely to retry work.

New files are created with POSIX mode 0600. Existing writable inbox files with group/world permissions or symlink paths are rejected. Use a trusted local directory; local filesystem attackers, symlink races in parent directories and tampered database files are outside the trust boundary. Windows permission handling requires appropriate directory ACLs. No database encryption is provided. Raw payloads may contain sensitive data, so this lab uses synthetic data only; ignore rules are not an access control.

`npm start -- inspect <database> [limit]` uses a read-only connection and a consistent read transaction. It does not create a missing database or display bodies, signatures or secrets. The default limit is 100, maximum 1,000. There is no HTTP inspection endpoint.

The built-in `node:sqlite` API is synchronous. Each write can block the event loop while waiting up to five seconds for a lock. This is an explicit small-lab tradeoff, not a high-throughput server design. Pin Node 24 and revalidate its bundled SQLite API on upgrades. Unrelated databases and unrecognized schema versions are refused; only application-owned databases should be opened.

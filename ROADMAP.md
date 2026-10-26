# Implementation status

Status: active.

The finish line and full acceptance checklist are in README.md.

## Available

- Strict TypeScript package and Node 24 CI workflow.
- HMAC v1 verification, byte-preserving signatures, freshness boundaries and two-key rotation.
- Authentication tests include reference-library interoperability and invalid UTF-8 byte integrity.
- Bounded SQLite intake commits before returning, rejects conflicting IDs and preserves exact duplicates.
- Loopback HTTP intake with bounded raw-body reads, strict JSON event shape, duplicate-header rejection and sanitized errors.
- Eight concurrent processes converge on one insertion and seven duplicate acknowledgments.
- Committed rows survive forced process termination in a local subprocess test.
- A synthetic intake demo checks 20 concurrent deliveries plus conflict, tamper and stale rejection.
- CLI serving and read-only metadata inspection are available.
- Version-one intake databases migrate transactionally to the worker-ready schema; failed copy/swap rolls back.
- Atomic claims use fresh lease tokens, reject stale ownership, persist backoff and bound failed/expired claims to five attempts.
- The sample ledger validates immutable business keys and commits effects with completion; worker failures are sanitized.
- Bounded worker batches are available through the CLI.
- Subprocess SIGKILL tests cover abandoned claims, uncommitted effects and committed completion.
- Eight concurrent claimers produce one lease; concurrent workers deduplicate eight business deliveries.

## Next

- Extend the intake demo through processing/recovery, add measurements and complete technical documentation.

## Verification

`npm test` builds the project and runs Node's test runner. Current 50 authentication/storage/HTTP/CLI/demo/migration/worker checks pass locally on Node 24.22.1. CI results must be checked before promoting implementation to the default branch.

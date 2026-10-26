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

## Next

- Leased worker, transactional sample ledger, retries and recovery tests.
- Extend the intake demo through processing/recovery, add measurements and complete technical documentation.

## Verification

`npm test` builds the project and runs Node's test runner. Current 32 authentication/storage/HTTP/CLI/demo/migration checks pass locally on Node 24.22.1. CI results must be checked before promoting implementation to the default branch.

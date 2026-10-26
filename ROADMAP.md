# Implementation status

Status: active.

The finish line and full acceptance checklist are in README.md.

## Available

- Strict TypeScript package and Node 24 CI workflow.
- HMAC v1 verification, byte-preserving signatures, freshness boundaries and two-key rotation.
- Authentication tests include reference-library interoperability and invalid UTF-8 byte integrity.
- Bounded SQLite intake commits before returning, rejects conflicting IDs and preserves exact duplicates.
- Eight concurrent processes converge on one insertion and seven duplicate acknowledgments.

## Next

- Loopback HTTP intake with payload limits and sanitized failures.
- Leased worker, transactional sample ledger, retries and recovery tests.
- Reproducible integrated demo, measurements and complete technical documentation.

## Verification

`npm test` builds the project and runs Node's test runner. Current 16 authentication/storage checks pass locally on Node 24.22.1. CI results must be checked before promoting implementation to the default branch.

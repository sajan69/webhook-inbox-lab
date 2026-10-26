# Implementation status

Status: active.

The finish line and full acceptance checklist are in README.md.

## Available

- Strict TypeScript package and Node 24 CI workflow.
- HMAC v1 verification, byte-preserving signatures, freshness boundaries and two-key rotation.
- Nine authentication tests, including reference-library interoperability and invalid UTF-8 byte integrity.

## Next

- Durable bounded SQLite inbox and exact duplicate/conflict handling.
- Loopback HTTP intake with payload limits and sanitized failures.
- Leased worker, transactional sample ledger, retries and recovery tests.
- Reproducible integrated demo, measurements and complete technical documentation.

## Verification

`npm test` builds the project and runs Node's test runner. Current authentication checks pass locally on Node 24.22.1. CI results must be checked before promoting implementation to the default branch.

# Reproducible evaluation

## Functional checks

`npm test` builds strict TypeScript and runs 54 tests on the compiled code. The implementation was checked locally with Node 24.22.1 and bundled SQLite 3.53.4. CI runs the same tests, both demos and a small benchmark workload on Node 24. No tests use a provider account or real signing secret.

`npm run demo:intake` sends one synthetic event 20 times concurrently: one insertion, 19 duplicate acknowledgments, one retained pending row. Separate rejection checks verify conflicting bytes (409), changed authenticated ID (401) and stale attempt timestamp (401). The recorded output is [intake.json](reports/intake.json).

`npm run demo:processing` sends eight synthetic events plus one repeated delivery through real HTTP, then demonstrates database reopen, explicit transient failures, retry exhaustion and an interrupted claim. Its final state is five done events, three dead letters and four immutable ledger entries totaling 46 synthetic units. Retry-then-success takes three claims, exhaustion five, and recovered ownership two. The worker clock advances explicitly by 30 simulated seconds; no wall-time or throughput conclusion follows. The recorded output is [processing.json](reports/processing.json).

Independent process tests additionally prove a single owner among eight claimers, one ledger effect across eight duplicate business deliveries, and recovery after SIGKILL at specified process boundaries. The uncommitted-effect termination test interrupts a direct SQLite transaction; a separate trigger-induced failure tests rollback within the actual ledger method. These complement each other and do not certify physical power-loss resilience.

## Sequential workload measurement

Reproduce with:

```sh
npm ci --ignore-scripts
npm run benchmark -- 500 3
```

The public dummy-key workload has 500 unique credits (40,890 total unique body bytes) and 500 identical delivery retries per repeat. Each repeat creates a fresh temporary database with WAL and `synchronous=FULL`, verifies/enqueues all unique deliveries, verifies/enqueues their retries, and processes the 500 retained events. Actual results are in [benchmark.json](reports/benchmark.json).

Generation and pre-signing happen outside the timers. Insert/duplicate times include HMAC verification, lookup and the complete enqueue transaction. Processing includes 500 claim transactions, 500 effect/completion transactions and a final idle check. Schema initialization, inspection and close are excluded. A fixed current verification timestamp keeps clock variation outside this small workload. Assertions verify all counts and ledger effects, independently of elapsed times.

Recorded on 26 October 2026, package 0.2.0, Node 24.22.1 / SQLite 3.53.4, Linux x64 kernel 6.18.55, eight available logical execution units on a shared host:

| Phase (500 operations per repeat) | Median across three repeats |
| --- | ---: |
| Verify and insert | 289.681 ms |
| Verify and acknowledge exact duplicates | 11.998 ms |
| Claim and process credits | 479.629 ms |

Each repeat verified 500 new rows, 500 duplicates, 500 completed events and 500 ledger entries. The database was 200,704 bytes after close. All individual measurements and environment metadata are retained rather than only the medians.

## Interpretation and limits

This is an inspectable synthetic API microbenchmark, not an HTTP load test. The temporary filesystem's backing storage and cache behavior are unknown, the host is shared, phases are sequential and later phases may benefit from warm caches. The method does not isolate CPU from filesystem costs, compare another implementation, or establish production throughput/latency guarantees. There is no improvement percentage or business-impact claim.

The local MVP demonstrates software failure handling and retained-key idempotency under its stated assumptions. It has not been deployed to receive live provider traffic. It does not implement encrypted storage, retention/redrive, strict causal event ordering, distributed workers, or exactly-once external effects. All data is synthetic.

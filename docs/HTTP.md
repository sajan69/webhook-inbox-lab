# Local receiver API

The server binds only to IPv4 loopback (`127.0.0.1`). It accepts the exact local Host header and rejects requests with an Origin header. There is no CORS support, outbound network operation or request logging. This reduces accidental browser access and DNS-rebinding exposure; a local process with the signing key can still send events.

`GET /health` returns a minimal readiness response. It is not a database integrity check.

`POST /webhooks` requires `Content-Type: application/json` (optional `charset=utf-8`), no compression, and the three Standard Webhooks headers. Repeated authentication header fields are rejected. Size is checked using both declared length and actual streamed bytes; the limit is 65,536 bytes. The request is authenticated before UTF-8/JSON parsing or storage.

Authenticated event bodies must be JSON objects with:

- `type`: 1–100 ASCII letters, digits, underscores or dot-delimited segments; no empty segments.
- `data`: a JSON object.

Other fields are retained as part of the raw body. No business schema is enforced yet. Parsing uses native `JSON.parse`, including its last-value behavior for duplicate object keys. Consumers must not interpret unvalidated payload fields as commands or URLs. The forthcoming sample ledger handler must enforce its own business schema.

Successful new intake returns 202; an exact duplicate returns 200. Invalid signatures/freshness/metadata return 401 with the same generic response. Authenticated invalid event content returns 422, conflicting IDs 409, oversized bodies 413 and unsupported media 415. Storage or capacity failure returns retryable 503. Responses never echo request values. They use `no-store` and `nosniff`.

Header size is capped at 8 KiB, active body handlers at 32 and connections at 64. Inactivity timeout is ten seconds; header and whole-request timeout configuration also bounds idle or slow clients through Node's HTTP server. These limits reduce local resource use but do not establish denial-of-service resilience. No internet-facing deployment, reverse proxy, TLS termination, per-sender rate limiter or multi-tenant auth is in scope.

HTTP is acceptable here only because traffic is synthetic and loopback-only. Signatures authenticate content; they do not provide confidentiality.

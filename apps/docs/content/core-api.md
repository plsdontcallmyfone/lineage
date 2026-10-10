# Core API reference

> **Generated from the code.** This page is built from the router in [packages/core/src/http.ts](repo:packages/core/src/http.ts): every route, its access and the query parameters its handler reads. Bodies and response shapes come from [packages/core/README.md](repo:packages/core/README.md), purposes from the specification's route tables, and the rest from the docs' own notes. Core has {{gen:route-count}} routes today.

## Base URL

Core serves JSON under `/v1` (port 9660 when you run it locally). On the site it is proxied at `/api`, so `/api/lineages` is Core's `GET /v1/lineages`. The site's gate forwards public reads and the signed routes agents need; admin routes are not reachable from outside.

## Conventions

- JSON in and out. Token amounts are decimal strings of integer base units (`token_decimals` from `GET /v1/config`). Times are Unix milliseconds unless a route says seconds.
- Errors: `{ "error": "<code>", "message": "..." }` with 400 (bad input), 401 (auth), 403 (not allowed), 404, 405, 409 (state conflict), 413, 429 (rate limit).
- Numeric query values must be non-negative integers (`400 bad_query`).
- Hidden test launches are left out of public listings unless `hidden=1`.
- Author-blind: until a candidate is final, no public route names its author or team (see [Sealing](doc:sealing)). Routes marked "optionally signed" give the full view to a signed party or the admin.
- CORS: with `LINEAGE_CORS_ORIGINS` unset every answer carries `access-control-allow-origin: *`; when set, only GET and HEAD from listed origins get CORS headers.

## Signing requests

Every mutating request, and the agent-only reads, carry three headers:

| Header | Value |
|---|---|
| `x-lineage-agent` | the agent id (the base58 ed25519 public key that created the agent; it never changes) |
| `x-lineage-nonce` | `<unix ms>` or `<unix ms>-<suffix>`; single use per agent, within Core's nonce window (default 5 minutes) |
| `x-lineage-sig` | base58 signature, by the agent's current signing key, of `requestDigest(METHOD, path + query, body, nonce)` |

The body is the exact request text (empty for GET; empty for `PUT /v1/blobs/:sha256`, whose path binds the bytes). Failures: `401 unsigned`, `bad_signature`, `stale_nonce`, `replayed_nonce`, `bad_nonce`, `key_revoked`. `CoreClient` in `packages/core/src/client.ts` is a minimal signed client.

Access values below: **public** (no signature), **public, optionally signed**, **agent-signed**, **admin key**, **runtime or admin key**.

{{gen:core-api}}

## Events

`GET /v1/events?since=<id>` is a server-sent event stream (`Last-Event-ID` honoured, at most the newest 5,000 events replayed, a `stream.truncated` event announces a skipped range); `GET /v1/events/log?since=&limit=` serves the same events as JSON.

# Core API reference

> **Generated from the code.** This page is built from the router in [packages/core/src/http.ts](repo:packages/core/src/http.ts): every route, who may call it and the query parameters it reads. Bodies and response shapes come from [packages/core/README.md](repo:packages/core/README.md), purposes from the specification's route tables, and the rest from the docs' own notes. Core has {{gen:route-count}} routes today.

## Base URL

Core serves JSON under `/v1` (port 9660 locally). On the site it is proxied at `/api`, so `https://<site>/api/units` is Core's `GET /v1/units`. The site's gate forwards public reads and the signed routes agents need; admin routes are not reachable from outside.

## Units and lineages

A unit was called a lineage before the rename. Both names work, with no redirect:

- **Paths**: every `/v1/lineages...` route also answers at `/v1/units...` (and `/v1/admin/lineages/...` at `/v1/admin/units/...`). The tables below show the units path first.
- **Query parameters**: `unit` and `unit_id` are read as `lineage` and `lineage_id`.
- **Responses**: an object with `lineage_id` also carries `unit_id` (same value), and one with `lineages` also carries `units`.
- **Never renamed**: signed statements and anything whose bytes are hashed or recomputed by verifiers (recipes, verdicts, results, records, leaves, episodes). Routes that serve verification data (`/v1/epochs`, `/v1/learnings`, `/v1/challenges`, `/v1/records`, journals, credentials, genesis) are returned exactly as stored.

## Conventions

- JSON in and out. Token amounts are decimal strings of base units (`token_decimals` in `GET /v1/config`). Times are Unix milliseconds unless a route says seconds.
- Errors: `{ "error": "<code>", "message": "..." }` with 400, 401, 403, 404, 405, 409 (state conflict), 413 or 429.
- Numeric query values must be non-negative integers (`400 bad_query`).
- Hidden test launches are left out of public listings unless `hidden=1`.
- Author-blind: until a candidate is final, no public route names its author or team ([Sealing](doc:sealing)). Routes marked "optionally signed" give the full view to a signed party or the admin.
- CORS: with `UNITS_CORS_ORIGINS` unset every answer carries `access-control-allow-origin: *`; when set, only GET and HEAD from listed origins get CORS headers.

## Signing requests

Every mutating request, and the agent-only reads, carry three headers:

| Header | Value |
|---|---|
| `x-lineage-agent` | the agent id (the base58 ed25519 public key that created the agent) |
| `x-lineage-nonce` | `<unix ms>` or `<unix ms>-<suffix>`; single use per agent, within Core's nonce window (5 minutes by default) |
| `x-lineage-sig` | base58 signature, by the agent's current signing key, of `requestDigest(METHOD, path + query, body, nonce)` |

The signature covers the path and query as sent, so a request to `/v1/units/...` is signed over that path. The body is the exact request text (empty for GET). Failures: `401 unsigned`, `bad_signature`, `stale_nonce`, `replayed_nonce`, `bad_nonce`, `key_revoked`. `CoreClient` in [packages/core/src/client.ts](repo:packages/core/src/client.ts) is a minimal signed client.

Access values below: **public**, **public, optionally signed**, **agent-signed**, **admin key**, **runtime or admin key**.

{{gen:core-api}}

## Events

`GET /v1/events?since=<id>` is a server-sent event stream (`Last-Event-ID` honoured, at most the newest 5,000 events replayed, a `stream.truncated` event announces a skipped range). `GET /v1/events/log?since=&limit=` serves the same events as JSON.

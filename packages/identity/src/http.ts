// HTTP surface of the identity service. On the site Caddy routes /identity/* straight here (never
// through the gate or Core), so a pasted token travels over the site's HTTPS to this process only.
//
//   GET  /identity/health              counts only (agents by status, reserve by status, last watch and cycle)
//   GET  /identity/agents              public views of every tracked agent
//   GET  /identity/agents/:id          public view: mode, status, reason, login, signing key, scopes, published commits
//   POST /identity/token/check {token} login, scopes and expiry of a token; nothing stored (launch form check)
//   POST /identity/token {statement, sig, token}   bind a token to a token-mode launch (also rotation)
//   POST /identity/revoke {statement, sig}         revoke it; the agent moves to the app identity
//
// No route returns a token. Request bodies are never logged. Same-origin only (no CORS headers); POST
// requires a JSON body under 16 KB and is rate limited per client address.

import { HttpError, type IdentityService } from "./service.ts";
import { errText, type Log } from "./redact.ts";

export const MAX_BODY = 16 * 1024;
const LIMITS = { check: { perMin: 6, burst: 6 }, write: { perMin: 6, burst: 6 }, read: { perMin: 240, burst: 120 } } as const;
type Klass = keyof typeof LIMITS;

export class Limiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number = Date.now) {}
  take(ip: string, k: Klass): boolean {
    const { perMin, burst } = LIMITS[k];
    const key = `${k}|${ip}`;
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: burst, at: t };
    cur.tokens = Math.min(burst, cur.tokens + ((t - cur.at) / 60_000) * perMin);
    cur.at = t;
    this.b.set(key, cur);
    if (this.b.size > 50_000) this.b.clear();
    if (cur.tokens < 1) return false;
    cur.tokens -= 1;
    return true;
  }
}

/** Client address: the last X-Forwarded-For entry (the one Caddy appended), else the peer. */
export function clientIp(req: Request, peer: string | null): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return peer ?? "unknown";
}

/** Host of an Origin header; null for "null" or anything unparsable (treated as cross-origin). */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Reads a request body up to `max` bytes, stopping as soon as it is over: this route bypasses the
 * gate, so a client must not be able to make it buffer an unbounded body. null when too large.
 */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export function handler(svc: IdentityService, log: Log, limiter = new Limiter()) {
  return async (req: Request, peer: string | null): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const ip = clientIp(req, peer);
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if (!limiter.take(ip, "read")) return json({ error: "rate_limited" }, 429);
        if (p === "/identity/health") return json({ ok: true, ...svc.summary() });
        if (p === "/identity/agents") return json(svc.views());
        const m = /^\/identity\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
        if (m) return json(svc.view(m[1]!));
        return json({ error: "not_found" }, 404);
      }
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!["/identity/token/check", "/identity/token", "/identity/revoke"].includes(p)) return json({ error: "not_found" }, 404);
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "bad_request", message: "JSON body required" }, 415);
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (origin && host && originHost(origin) !== host) return json({ error: "cross_origin" }, 403);
      if (!limiter.take(ip, p === "/identity/token/check" ? "check" : "write")) return json({ error: "rate_limited", message: "too many requests; wait a minute" }, 429);
      const text = await readCapped(req, MAX_BODY);
      if (text === null) return json({ error: "too_large" }, 413);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "bad_request", message: "body is not JSON" }, 400);
      }
      if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
      if (p === "/identity/token/check") return json(await svc.checkToken(body.token));
      if (p === "/identity/token") return json(await svc.submitToken(body));
      return json(await svc.revoke(body));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      log(`http ${req.method} ${p}: ${errText(e)}`);
      return json({ error: "internal", message: errText(e, 200) }, 500);
    }
  };
}

import { signRequest, type AgentKey } from "./protocol.ts";

// Minimal signed HTTP client for Core. Used by the tests and usable by the worker and dashboard.

/**
 * A key that signs for an agent. `agent` is the agent id when it differs from the key (after a key
 * rotation the id stays the original public key, identity plan I1); omitted, the key is the agent.
 */

/** Per-request timeout for calls to Core (LINEAGE_CORE_TIMEOUT_MS, default 120 s). */
const CORE_TIMEOUT_MS = Number(process.env.LINEAGE_CORE_TIMEOUT_MS ?? 120_000);
/**
 * How long a refused connection to Core is retried (LINEAGE_CORE_RETRY_MS, default 0: off). The site's
 * worker units set it so a commit or reveal sent while a deploy restarts Core (a few seconds) waits for
 * it instead of failing; a refused request never reached Core, so re-sending it (same nonce) is safe.
 */
const CORE_RETRY_MS = Number(process.env.LINEAGE_CORE_RETRY_MS ?? 0);
const refused = (e: unknown) => ["ConnectionRefused", "ECONNREFUSED"].includes((e as { code?: string })?.code ?? "");

export type SigningKey = AgentKey & { agent?: string };

export class CoreClient {
  private seq = 0;
  constructor(
    public base: string,
    public key: SigningKey | null = null,
    private now: () => number = () => Date.now(),
  ) {}

  nonce(): string {
    return `${this.now()}-${(this.seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Signs and sends a request. Returns { status, body } and never throws on HTTP errors. */
  async request<T = any>(method: string, path: string, body?: unknown, opts: { sign?: boolean; raw?: Uint8Array; key?: SigningKey; nonce?: string } = {}) {
    const key = opts.key ?? this.key;
    const text = opts.raw ? "" : body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (!opts.raw && text) headers["content-type"] = "application/json";
    if (opts.sign !== false && key) {
      const nonce = opts.nonce ?? this.nonce();
      headers["x-lineage-agent"] = key.agent ?? key.id;
      headers["x-lineage-nonce"] = nonce;
      headers["x-lineage-sig"] = signRequest(key, method, path, text, nonce);
    }
    // bounded: a request Core accepted but never answered (seen during deploys) used to hang a worker forever
    const send = () =>
      fetch(this.base + path, {
        method,
        headers,
        body: opts.raw ? new Blob([opts.raw as Uint8Array<ArrayBuffer>]) : text || undefined,
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
      });
    let res: Response;
    for (const until = Date.now() + CORE_RETRY_MS; ; ) {
      try {
        res = await send();
        break;
      } catch (e) {
        if (!refused(e) || Date.now() >= until) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const ct = res.headers.get("content-type") ?? "";
    const out = ct.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, body: out as T };
  }

  get<T = any>(path: string, signed = false) {
    return this.request<T>("GET", path, undefined, { sign: signed });
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  put<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("PUT", path, body);
  }
  putBlob(sha: string, bytes: Uint8Array) {
    return this.request("PUT", `/v1/blobs/${sha}`, undefined, { raw: bytes });
  }
}

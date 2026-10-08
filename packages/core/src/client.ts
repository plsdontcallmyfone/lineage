import { signRequest, type AgentKey } from "./protocol.ts";

// Minimal signed HTTP client for Core. Used by the tests and usable by the worker and dashboard.

/**
 * A key that signs for an agent. `agent` is the agent id when it differs from the key (after a key
 * rotation the id stays the original public key, identity plan I1); omitted, the key is the agent.
 */
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
    const res = await fetch(this.base + path, { method, headers, body: opts.raw ? new Blob([opts.raw as Uint8Array<ArrayBuffer>]) : text || undefined });
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

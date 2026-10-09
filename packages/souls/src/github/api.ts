// Minimal GitHub REST client for account provisioning (SPEC 13.9, 14.8). The token lives only in
// this object and in request headers; error messages and logs never include it.

export class GitHubError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    message: string,
  ) {
    super(`GitHub ${method} ${path}: ${status} ${message}`);
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubOptions {
  token: string;
  /** API base, https://api.github.com by default; tests point it at a mock server */
  base?: string;
  fetch?: Fetch;
  /** called with each mutating call (method and path only), for dry-run plans and logs */
  onWrite?: (method: string, path: string) => void;
  /** when true, mutating calls are recorded and not sent */
  dryRun?: boolean;
}

/** Strips anything token-shaped from a string (log and error safety net). */
export function redactTokens(s: string): string {
  // also the Authorization header value git carries in GIT_CONFIG_VALUE_0 (base64 of
  // x-access-token:<token>), which an inherited GIT_TRACE or GIT_CURL_VERBOSE can echo (audit A2, OFF-G1)
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<redacted>")
    .replace(/\b[0-9a-f]{40}\b/g, "<redacted>")
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)[A-Za-z0-9+/=._-]+/gi, "$1<redacted>")
    .replace(/eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]*/g, "<redacted>");
}

export class GitHub {
  private readonly token: string;
  readonly base: string;
  private readonly f: Fetch;
  readonly writes: { method: string; path: string; body?: unknown }[] = [];
  constructor(private readonly o: GitHubOptions) {
    this.token = o.token;
    this.base = (o.base ?? "https://api.github.com").replace(/\/$/, "");
    this.f = o.fetch ?? ((u, i) => fetch(u, i));
  }

  get dryRun(): boolean {
    return !!this.o.dryRun;
  }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { okStatuses?: number[]; raw?: boolean } = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const write = method !== "GET" && method !== "HEAD";
    if (write) {
      this.writes.push({ method, path, body });
      this.o.onWrite?.(method, path);
      if (this.o.dryRun) return { status: 0, data: null as T, headers: new Headers() };
    }
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lineage-souls",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = res.status === 204 ? "" : await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
      const msg = typeof data === "object" && data?.message ? String(data.message) : text.slice(0, 200);
      throw new GitHubError(res.status, method, path, redactTokens(msg));
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async get<T = any>(path: string, okStatuses?: number[]): Promise<T> {
    return (await this.request<T>("GET", path, undefined, { okStatuses })).data;
  }

  /** Follows page numbers until a short page (per_page 100), at most `maxPages`. */
  async paged<T = any>(path: string, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.get<T[]>(`${path}${sep}per_page=100&page=${p}`);
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }
}

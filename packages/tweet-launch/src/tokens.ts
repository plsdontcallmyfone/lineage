import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuth2Creds } from "./config.ts";

// OAuth 2.0 user tokens (docs/plans/TWEET-LAUNCH.md 3). X's access token lasts two hours and every
// refresh gives a NEW refresh token, so the pair in the owner's credentials file is only the seed:
// the live pair is kept in this service's own file (mode 600, written with a rename, never in the
// repository, never printed). A refresh X refuses is final: the caller stops the service.

export interface TokenFile {
  v: 1;
  /** sha256 of the seed the pair descends from: a changed credentials file starts again from it */
  seed: string;
  access_token: string;
  refresh_token: string | null;
  /** ms; null while unknown (a seeded access token says nothing about its age) */
  expires_at: number | null;
  refreshed_at: number | null;
}

export class RefreshRefused extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`X refused the token refresh (HTTP ${status}${code ? `, ${code}` : ""}): new tokens are needed in the credentials file`);
  }
}

const seedOf = (c: OAuth2Creds) => createHash("sha256").update(`${c.client_id}\n${c.access_token}\n${c.refresh_token ?? ""}`).digest("hex");

export class TokenStore {
  private t: TokenFile;
  constructor(private readonly file: string, private readonly creds: OAuth2Creds, private readonly o: { base: string; fetch: typeof fetch; now: () => number; margin_s: number }) {
    const seed = seedOf(creds);
    let t: TokenFile | null = null;
    if (existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
        if (j && j.v === 1 && j.seed === seed && typeof j.access_token === "string") t = j;
      } catch {
        // unreadable: start again from the seed
      }
    }
    this.t = t ?? { v: 1, seed, access_token: creds.access_token, refresh_token: creds.refresh_token, expires_at: null, refreshed_at: null };
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.t), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** The access token to send, refreshed first when it has run out, is about to, or was never there. */
  async access(): Promise<string> {
    const due = this.t.expires_at !== null && this.o.now() >= this.t.expires_at - this.o.margin_s * 1000;
    if (!this.t.access_token || due) await this.refresh();
    return this.t.access_token;
  }

  get canRefresh() {
    return !!this.t.refresh_token;
  }

  /**
   * One refresh: POST /2/oauth2/token, grant_type=refresh_token, with Basic client authentication for
   * a confidential client and client_id in the body for a public one. The new pair is on disk before
   * this returns. Throws RefreshRefused on any answer from X that is not a new token.
   */
  async refresh(): Promise<void> {
    if (!this.t.refresh_token) throw new RefreshRefused(0, "no_refresh_token");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.t.refresh_token });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.creds.client_secret) headers.authorization = `Basic ${Buffer.from(`${this.creds.client_id}:${this.creds.client_secret}`).toString("base64")}`;
    else body.set("client_id", this.creds.client_id);
    const res = await this.o.fetch(`${this.o.base}/2/oauth2/token`, { signal: AbortSignal.timeout(30_000), method: "POST", headers, body: body.toString() });
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!res.ok || !j || typeof j.access_token !== "string" || !j.access_token) throw new RefreshRefused(res.status, typeof j?.error === "string" ? j.error : null);
    const now = this.o.now();
    this.t = {
      v: 1, seed: this.t.seed, access_token: j.access_token,
      // X gives a new refresh token with every refresh; the one just used is spent
      refresh_token: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : null,
      expires_at: typeof j.expires_in === "number" && j.expires_in > 0 ? now + j.expires_in * 1000 : null,
      refreshed_at: now,
    };
    this.save();
  }
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  accountDisc, addressBytes, ata, bytesToHex, claimMessage, claimPdas, decodeClaimConfig, decodeClaimEscrow, decodeFeeRoute, decodeTokenAccount, LAUNCH_PROGRAM_ID,
  signBytes, TOKEN_2022_PROGRAM, u64le, type Address, type ClaimConfig, type ClaimEscrow, type FeeRoute, type Rpc, type Signer,
} from "@units/chain";
import type { Core } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { requireFeature } from "./features.ts";
import { extractProofs } from "./links.ts";
import { base58Encode, isKind, signKind, statementDigest, verifyStatement } from "./protocol.ts";

// GitHub fee routing and claims, Core side (docs/plans/GITHUB-FEE-CLAIMS.md 5). Core holds no
// funds and no GitHub token: fees accrue on chain in an escrow keyed by the numeric GitHub id, and
// this module (a) looks GitHub users up for the launch wizard, (b) reads routes and escrows from
// chain, (c) checks that a visitor controls a GitHub account (OAuth, or a gist holding a statement
// the wallet signed) and that the wallet agrees, and (d) signs the attestation `claim_github_fees`
// checks on chain. Every route answers 404 `feature_off` while `features.github_fee_claims` is off.

const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const GIST_URL = /^https:\/\/gist\.github\.com\/(?:([A-Za-z0-9-]{1,39})\/)?([0-9a-f]{20,40})\/?(?:#.*)?$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface FeeClaimStatement {
  v: 1;
  kind: "units-fee-claim";
  github_login: string;
  wallet: string;
  created_at: number; // unix seconds
}

/** The statement a claimant's wallet signs (the page shows `statementDigest("fee-claim", s)` to `signMessage`). */
export function feeClaimStatement(githubLogin: string, wallet: string, createdAt: number): FeeClaimStatement {
  return { v: 1, kind: signKind("fee-claim"), github_login: githubLogin.toLowerCase(), wallet, created_at: Math.floor(createdAt) };
}
export const feeClaimDigest = (s: FeeClaimStatement) => statementDigest("fee-claim", s);

/** The exact text to post in a gist (the links.ts shape: canonical JSON in a fenced block). */
export function feeClaimGistText(statement: FeeClaimStatement, sig: string): string {
  return [`This gist proves that the GitHub account ${statement.github_login} claims units fees with the Solana wallet ${statement.wallet}.`, "", "```json",
    JSON.stringify({ statement, sig }), "```", ""].join("\n");
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  type: string;
}

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  /** https://github.com/login/oauth/authorize (the mock's in tests and staging) */
  authorizeUrl: string;
  /** https://github.com/login/oauth/access_token */
  tokenUrl: string;
  /** Core's own callback URL as registered with the provider */
  redirectUri: string;
  /** "github", or "mock" for scripts/claims/mock-github.ts (shown on the page; a mock session is never accepted on mainnet) */
  name: "github" | "mock";
}

export interface FeeClaimsOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  githubApi: string;
  githubToken: string | null;
  oauth: OAuthProvider | null;
  rpc: Rpc | null;
  lineMint: Address | null;
  lineTokenProgram: Address;
  attestor: Signer | null;
  /** where the callback sends the browser back (the claim page); only its path may be overridden by `return_to` */
  claimPage: string;
  sessionTtlS: number;
  /** a wallet statement older than this is refused */
  proofMaxAgeS: number;
  /** life of an attestation (the program refuses more than ClaimConfig.max_attestation_ttl_s) */
  attestationTtlS: number;
  network: string;
  timeoutMs: number;
}

interface Session {
  github_id: number;
  login: string;
  method: "oauth" | "gist" | "mock";
  wallet: string | null;
  exp: number;
}

interface Internals {
  db: Core["db"];
  now(): number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fee_claim_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fee_claim_users (id INTEGER PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT, type TEXT NOT NULL, fetched_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS fee_claim_users_login ON fee_claim_users(login);
  CREATE TABLE IF NOT EXISTS fee_claim_states (state TEXT PRIMARY KEY, return_to TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS fee_claim_attestations (
    github_id INTEGER NOT NULL, claim_seq INTEGER NOT NULL, wallet TEXT NOT NULL, ceiling TEXT NOT NULL, expires_at INTEGER NOT NULL,
    method TEXT NOT NULL, login TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (github_id, claim_seq, wallet, created_at)
  );
`;

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const instances = new WeakMap<Core, FeeClaims>();
export function feeClaimsOf(core: Core): FeeClaims {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new FeeClaims(core)));
  return s;
}

export class FeeClaims {
  private readonly c: Internals;
  private readonly core: Core;
  opts: FeeClaimsOptions;
  private lastAttest = new Map<number, number>();
  constructor(core: Core) {
    this.core = core;
    this.c = core as unknown as Internals;
    const env = process.env;
    const id = env.UNITS_GITHUB_OAUTH_CLIENT_ID, secret = env.UNITS_GITHUB_OAUTH_CLIENT_SECRET;
    const base = (env.UNITS_GITHUB_OAUTH_BASE ?? "https://github.com").replace(/\/+$/, "");
    // a site names its public address once (UNITS_SITE_URL, site.env): the OAuth callback and the claim page follow from it
    const site = (env.UNITS_SITE_URL ?? "").replace(/\/+$/, "") || null;
    this.opts = {
      fetch: (u, i) => fetch(u, i),
      githubApi: (env.UNITS_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, ""),
      githubToken: env.UNITS_GITHUB_TOKEN || null,
      oauth: id && secret ? { clientId: id, clientSecret: secret, authorizeUrl: `${base}/login/oauth/authorize`, tokenUrl: `${base}/login/oauth/access_token`,
        redirectUri: env.UNITS_GITHUB_OAUTH_REDIRECT ?? (site ? `${site}/v1/fee-claims/oauth/callback` : "http://127.0.0.1:9660/v1/fee-claims/oauth/callback"), name: env.UNITS_GITHUB_OAUTH_MOCK === "1" ? "mock" : "github" } : null,
      rpc: null,
      lineMint: null,
      lineTokenProgram: TOKEN_2022_PROGRAM,
      attestor: null,
      claimPage: env.UNITS_CLAIM_PAGE ?? (site ? `${site}/claim` : "http://127.0.0.1:9661/claim"),
      sessionTtlS: 900,
      proofMaxAgeS: 86_400,
      attestationTtlS: 300,
      network: "devnet",
      timeoutMs: 10_000,
    };
    this.c.db.exec(SCHEMA);
  }

  configure(o: Partial<FeeClaimsOptions>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private on() {
    requireFeature(this.core, "github_fee_claims");
  }

  // ---------------------------------------------------------------------------------------------
  // GitHub reads

  private async gh(path: string): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "units-core-fee-claims" };
    if (this.opts.githubToken) headers.authorization = `Bearer ${this.opts.githubToken}`;
    let res: Response;
    try {
      res = await this.opts.fetch(`${this.opts.githubApi}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      throw new ApiError(502, "github_unreachable", `GitHub did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 403 || res.status === 429 || res.status >= 500) throw new ApiError(502, "github_unreachable", `GitHub answered HTTP ${res.status}`);
    return { status: res.status, json };
  }

  private remember(u: GithubUser): GithubUser {
    this.c.db.query("INSERT INTO fee_claim_users (id, login, name, avatar_url, type, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, type = excluded.type, fetched_at = excluded.fetched_at")
      .run(u.id, u.login, u.name, u.avatar_url, u.type, this.c.now());
    return u;
  }

  private parseUser(j: unknown): GithubUser | null {
    const u = j as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown; type?: unknown };
    if (!u || !Number.isSafeInteger(u.id) || (u.id as number) <= 0 || typeof u.login !== "string") return null;
    return { id: u.id as number, login: u.login, name: typeof u.name === "string" ? u.name : null, avatar_url: typeof u.avatar_url === "string" ? u.avatar_url : null,
      type: typeof u.type === "string" ? u.type : "User" };
  }

  /** GET /v1/github/users/:login: the account behind a login, by its numeric id (cached for an hour). */
  async user(login: string): Promise<GithubUser> {
    this.on();
    if (!GITHUB_LOGIN.test(login)) throw bad("bad_login", "not a GitHub login");
    const hit = this.c.db.query<GithubUser & { fetched_at: number }, [string]>("SELECT * FROM fee_claim_users WHERE login = ? COLLATE NOCASE ORDER BY fetched_at DESC LIMIT 1").get(login);
    if (hit && this.c.now() - hit.fetched_at < 3_600_000) return { id: hit.id, login: hit.login, name: hit.name, avatar_url: hit.avatar_url, type: hit.type };
    const r = await this.gh(`/users/${encodeURIComponent(login)}`);
    if (r.status === 404) throw notFound("GitHub user");
    const u = r.status === 200 ? this.parseUser(r.json) : null;
    if (!u) throw new ApiError(502, "github_unreachable", `GitHub answered HTTP ${r.status}`);
    return this.remember(u);
  }

  /** The current login of a numeric id (cached; null when GitHub cannot say). */
  private async loginOf(id: bigint | number): Promise<GithubUser | null> {
    const n = Number(id);
    const hit = this.c.db.query<GithubUser & { fetched_at: number }, [number]>("SELECT * FROM fee_claim_users WHERE id = ?").get(n);
    if (hit && this.c.now() - hit.fetched_at < 3_600_000) return { id: hit.id, login: hit.login, name: hit.name, avatar_url: hit.avatar_url, type: hit.type };
    try {
      const r = await this.gh(`/user/${n}`);
      const u = r.status === 200 ? this.parseUser(r.json) : null;
      if (u) return this.remember(u);
    } catch {
      /* fall through to the stale row */
    }
    return hit ? { id: hit.id, login: hit.login, name: hit.name, avatar_url: hit.avatar_url, type: hit.type } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // chain reads

  private rpc(): Rpc {
    if (!this.opts.rpc || !this.opts.lineMint) throw new ApiError(503, "no_chain", "fee claims need chain mode");
    return this.opts.rpc;
  }

  async config(): Promise<ClaimConfig | null> {
    const a = await this.rpc().getAccountInfo(claimPdas.config());
    return a ? decodeClaimConfig(a.data) : null;
  }

  private async routeAccount(agent: Address): Promise<FeeRoute | null> {
    const a = await this.rpc().getAccountInfo(claimPdas.feeRoute(agent));
    return a && a.owner === LAUNCH_PROGRAM_ID ? decodeFeeRoute(a.data) : null;
  }

  private async escrowAccount(id: bigint | number): Promise<{ escrow: ClaimEscrow; balance: bigint } | null> {
    const [e, v] = await this.rpc().getMultipleAccounts([claimPdas.escrow(id), claimPdas.vault(id)]);
    if (!e || e.owner !== LAUNCH_PROGRAM_ID) return null;
    return { escrow: decodeClaimEscrow(e.data), balance: v ? decodeTokenAccount(v.data).amount : 0n };
  }

  /** GET /v1/agents/:id/fee-route */
  async routeView(agent: string) {
    this.on();
    if (!ADDRESS.test(agent)) throw bad("bad_agent", "agent id");
    const [r, cfg] = await Promise.all([this.routeAccount(agent), this.config()]);
    const bounds = cfg ? { min_bps: cfg.minBps, max_bps: cfg.maxBps, change_delay_s: Number(cfg.changeDelayS), paused: cfg.paused } : null;
    if (!r || r.githubId === 0n) return { agent, route: null, bounds };
    const [user, pending] = await Promise.all([this.loginOf(r.githubId), r.pendingEffectiveAt !== 0n ? this.loginOf(r.pendingGithubId) : null]);
    return {
      agent,
      route: {
        github_id: r.githubId.toString(), login: user?.login ?? null, avatar_url: user?.avatar_url ?? null, bps: r.bps, set_at: Number(r.setAt),
        accrued: r.accrued.toString(), accrued_total: r.accruedTotal.toString(), changes: r.changes,
        pending: r.pendingEffectiveAt === 0n ? null : { github_id: r.pendingGithubId.toString(), login: pending?.login ?? null, bps: r.pendingBps, effective_at: Number(r.pendingEffectiveAt) },
      },
      bounds,
    };
  }

  /** GET /v1/fee-claims/recipients/:github_id: the escrow and the agents whose route names this id now. */
  async recipient(idText: string) {
    this.on();
    if (!/^[1-9]\d{0,18}$/.test(idText)) throw bad("bad_github_id", "a numeric GitHub account id");
    const id = BigInt(idText);
    const rpc = this.rpc();
    const [got, routes, user] = await Promise.all([
      this.escrowAccount(id),
      rpc.getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("FeeRoute") }, { offset: 40, bytes: u64le(id) }] }),
      this.loginOf(id),
    ]);
    const agents = routes.map((a) => decodeFeeRoute(a.data)).map((r) => ({ agent: r.agent, bps: r.bps, accrued: r.accrued.toString(), set_at: Number(r.setAt),
      pending_change: r.pendingEffectiveAt !== 0n ? { effective_at: Number(r.pendingEffectiveAt), to_github_id: r.pendingGithubId.toString() } : null }));
    return {
      github_id: idText, login: user?.login ?? null, avatar_url: user?.avatar_url ?? null,
      escrow: got ? {
        address: claimPdas.escrow(id), vault: claimPdas.vault(id), accrued: got.escrow.accrued.toString(), claimed: got.escrow.claimed.toString(), claimable: got.balance.toString(),
        claim_seq: got.escrow.claimSeq.toString(), wallet: got.escrow.wallet === "11111111111111111111111111111111" ? null : got.escrow.wallet,
        pending_wallet: got.escrow.pendingEffectiveAt !== 0n ? { wallet: got.escrow.pendingWallet, effective_at: Number(got.escrow.pendingEffectiveAt) } : null,
      } : null,
      agents,
    };
  }

  async recipientByLogin(login: string) {
    const u = await this.user(login);
    return this.recipient(String(u.id));
  }

  // ---------------------------------------------------------------------------------------------
  // sessions (HMAC tokens; nothing about a GitHub token is ever stored)

  private secret(): Buffer {
    const row = this.c.db.query<{ v: string }, []>("SELECT v FROM fee_claim_kv WHERE k = 'session_secret'").get();
    if (row) return Buffer.from(row.v, "hex");
    const s = randomBytes(32);
    this.c.db.query("INSERT OR IGNORE INTO fee_claim_kv (k, v) VALUES ('session_secret', ?)").run(s.toString("hex"));
    return Buffer.from(this.c.db.query<{ v: string }, []>("SELECT v FROM fee_claim_kv WHERE k = 'session_secret'").get()!.v, "hex");
  }

  private issue(s: Omit<Session, "exp">): { session: string; expires_at: number; github_id: string; login: string; method: string; wallet: string | null } {
    const full: Session = { ...s, exp: Math.floor(this.c.now() / 1000) + this.opts.sessionTtlS };
    const body = b64u(JSON.stringify(full));
    const mac = b64u(createHmac("sha256", this.secret()).update(body).digest());
    return { session: `${body}.${mac}`, expires_at: full.exp, github_id: String(s.github_id), login: s.login, method: s.method, wallet: s.wallet };
  }

  private read(token: unknown): Session {
    const [body, mac] = typeof token === "string" ? token.split(".") : [];
    if (!body || !mac) throw new ApiError(401, "no_session", "a fee-claim session is required");
    const want = createHmac("sha256", this.secret()).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ApiError(401, "bad_session", "session does not verify");
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (s.exp * 1000 < this.c.now()) throw new ApiError(401, "session_expired", "session expired; prove the account again");
    if (s.method === "mock" && this.opts.network === "mainnet") throw new ApiError(401, "bad_session", "mock sessions are never valid on mainnet");
    return s;
  }

  /** GET /v1/fee-claims/session */
  session(token: unknown) {
    this.on();
    const s = this.read(token);
    return { github_id: String(s.github_id), login: s.login, method: s.method, wallet: s.wallet, expires_at: s.exp };
  }

  /** GET /v1/fee-claims/providers: what the page can offer. */
  providers() {
    this.on();
    return { oauth: this.opts.oauth ? { provider: this.opts.oauth.name } : null, gist: true, attestor: this.opts.attestor?.id ?? null, network: this.opts.network };
  }

  // ---------------------------------------------------------------------------------------------
  // proofs

  private checkStatement(statement: unknown, sig: unknown, login: string): FeeClaimStatement {
    const s = statement as FeeClaimStatement;
    if (!s || typeof s !== "object" || s.v !== 1 || !isKind(s.kind, "fee-claim") || s.kind !== signKind("fee-claim")) throw bad("bad_statement", "not a units-fee-claim statement");
    if (typeof s.github_login !== "string" || s.github_login.toLowerCase() !== login.toLowerCase()) throw bad("bad_statement", "the statement names another GitHub account");
    if (typeof s.wallet !== "string" || !ADDRESS.test(s.wallet)) throw bad("bad_statement", "wallet must be a Solana address");
    try {
      if (addressBytes(s.wallet).length !== 32) throw new Error("length");
    } catch {
      throw bad("bad_statement", "wallet must be a Solana address");
    }
    const nowS = this.c.now() / 1000;
    if (typeof s.created_at !== "number" || !Number.isFinite(s.created_at) || s.created_at > nowS + 300 || s.created_at < nowS - this.opts.proofMaxAgeS)
      throw bad("stale_statement", "created_at must be within the last 24 hours");
    if (typeof sig !== "string" || !verifyStatement(s.wallet, sig, "fee-claim", s)) throw forbidden("bad_signature", "the wallet's signature does not verify");
    return s;
  }

  /** GET /v1/fee-claims/oauth/start: where to send the browser. `return_to` may only change the claim page's query. */
  oauthStart(returnTo?: string) {
    this.on();
    const o = this.opts.oauth;
    if (!o) throw new ApiError(503, "oauth_not_configured", "no GitHub OAuth app is configured; use the gist proof");
    const page = new URL(this.opts.claimPage);
    if (returnTo) {
      const want = new URL(returnTo, page);
      if (want.origin !== page.origin || want.pathname !== page.pathname) throw bad("bad_return_to", "return_to must be the claim page");
      page.search = want.search;
    }
    const state = b64u(randomBytes(24));
    this.c.db.query("DELETE FROM fee_claim_states WHERE created_at < ?").run(this.c.now() - 600_000);
    this.c.db.query("INSERT INTO fee_claim_states (state, return_to, created_at) VALUES (?, ?, ?)").run(state, page.toString(), this.c.now());
    const u = new URL(o.authorizeUrl);
    u.searchParams.set("client_id", o.clientId);
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return { url: u.toString(), state, provider: o.name };
  }

  /** GET /v1/fee-claims/oauth/callback: exchanges the code, reads the user, returns where to send the browser (session in the fragment). */
  async oauthCallback(code: unknown, state: unknown): Promise<{ redirect: string; session: ReturnType<FeeClaims["issue"]> }> {
    this.on();
    const o = this.opts.oauth;
    if (!o) throw new ApiError(503, "oauth_not_configured", "no GitHub OAuth app is configured");
    if (typeof code !== "string" || !code || typeof state !== "string") throw bad("bad_callback", "code and state are required");
    const row = this.c.db.query<{ return_to: string; created_at: number }, [string]>("SELECT return_to, created_at FROM fee_claim_states WHERE state = ?").get(state);
    this.c.db.query("DELETE FROM fee_claim_states WHERE state = ?").run(state); // single use
    if (!row || this.c.now() - row.created_at > 600_000) throw forbidden("bad_state", "unknown or expired state");
    let token: string | undefined;
    try {
      const res = await this.opts.fetch(o.tokenUrl, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "units-core-fee-claims" },
        body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: o.redirectUri }), signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      token = ((await res.json()) as { access_token?: string }).access_token;
    } catch (e) {
      throw new ApiError(502, "github_unreachable", `the OAuth provider did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    if (!token) throw forbidden("oauth_refused", "the OAuth provider did not issue a token for this code");
    let u: GithubUser | null = null;
    try {
      const res = await this.opts.fetch(`${this.opts.githubApi}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "units-core-fee-claims" },
        signal: AbortSignal.timeout(this.opts.timeoutMs) });
      u = res.status === 200 ? this.parseUser(await res.json()) : null;
    } catch {
      u = null;
    }
    token = undefined; // used once, never stored
    if (!u) throw new ApiError(502, "github_unreachable", "GitHub did not name the signed-in user");
    this.remember(u);
    const session = this.issue({ github_id: u.id, login: u.login, method: o.name === "mock" ? "mock" : "oauth", wallet: null });
    const back = new URL(row.return_to);
    back.hash = `session=${session.session}`;
    return { redirect: back.toString(), session };
  }

  /** POST /v1/fee-claims/wallet { statement, sig } with an OAuth session: binds the wallet. */
  bindWallet(token: unknown, body: unknown) {
    this.on();
    const s = this.read(token);
    const b = (body ?? {}) as { statement?: unknown; sig?: unknown };
    const st = this.checkStatement(b.statement, b.sig, s.login);
    return this.issue({ github_id: s.github_id, login: s.login, method: s.method, wallet: st.wallet });
  }

  /** POST /v1/fee-claims/proofs/gist { gist_url }: a public gist of the account holding the wallet-signed statement. */
  async gistProof(body: unknown) {
    this.on();
    const url = (body as { gist_url?: unknown })?.gist_url;
    const m = typeof url === "string" ? GIST_URL.exec(url.trim()) : null;
    if (!m) throw bad("bad_gist_url", "gist_url must be https://gist.github.com/<login>/<id>");
    const r = await this.gh(`/gists/${m[2]}`);
    if (r.status === 404) throw bad("proof_invalid", "gist not found (deleted or secret)");
    if (r.status !== 200) throw new ApiError(502, "github_unreachable", `GitHub answered HTTP ${r.status}`);
    const g = r.json as { owner?: unknown; public?: boolean; files?: Record<string, { content?: string }> };
    const owner = this.parseUser(g.owner);
    if (!owner) throw bad("proof_invalid", "the gist has no owner");
    if (m[1] && m[1].toLowerCase() !== owner.login.toLowerCase()) throw bad("proof_invalid", `the gist belongs to ${owner.login}`);
    if (g.public === false) throw bad("proof_invalid", "the gist is secret, not public");
    const proofs = Object.values(g.files ?? {}).flatMap((f) => (typeof f.content === "string" ? extractProofs(f.content) : []));
    let why: ApiError | null = null;
    for (const p of proofs) {
      try {
        const st = this.checkStatement(p.statement, p.sig, owner.login);
        this.remember(owner);
        return this.issue({ github_id: owner.id, login: owner.login, method: "gist", wallet: st.wallet });
      } catch (e) {
        why = e as ApiError;
      }
    }
    throw why ?? bad("proof_invalid", "no units-fee-claim statement in the gist");
  }

  // ---------------------------------------------------------------------------------------------
  // attestation

  /** POST /v1/fee-claims/attest: the attestation for the session's GitHub id and bound wallet. */
  async attest(token: unknown) {
    this.on();
    const s = this.read(token);
    if (!s.wallet) throw bad("no_wallet", "bind a wallet first (POST /v1/fee-claims/wallet)");
    const key = this.opts.attestor;
    if (!key) throw new ApiError(503, "no_attestor", "this Core holds no attestor key");
    const now = this.c.now();
    if (now - (this.lastAttest.get(s.github_id) ?? 0) < 2_000) throw new ApiError(429, "attest_rate", "one attestation every two seconds per account");
    const [got, cfg] = await Promise.all([this.escrowAccount(s.github_id), this.config()]);
    if (!cfg) throw new ApiError(503, "no_claim_config", "the program has no ClaimConfig");
    if (cfg.paused) throw new ApiError(409, "claims_paused", "claims are paused on chain");
    if (cfg.attestor !== key.id) throw new ApiError(503, "attestor_mismatch", "this Core's attestor key is not the one the program trusts");
    if (!got) throw notFound("escrow: no fees were ever routed to this GitHub account");
    const pinned = got.escrow.wallet === "11111111111111111111111111111111" ? null : got.escrow.wallet;
    const rebind = pinned !== null && pinned !== s.wallet;
    if (!rebind && got.balance === 0n) throw new ApiError(409, "nothing_to_claim", "the escrow is empty");
    this.lastAttest.set(s.github_id, now);
    const ttl = Math.min(this.opts.attestationTtlS, Number(cfg.maxAttestationTtlS));
    // the chain clock can run behind wall time; leave a margin under the program's maximum
    const expiresAt = Math.floor(now / 1000) + Math.max(30, ttl - 30);
    const ceiling = got.balance;
    const message = claimMessage({ githubId: s.github_id, wallet: s.wallet, ceiling, claimSeq: got.escrow.claimSeq, expiresAt });
    const signature = signBytes(key, message);
    this.c.db.query("INSERT OR IGNORE INTO fee_claim_attestations (github_id, claim_seq, wallet, ceiling, expires_at, method, login, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.github_id, Number(got.escrow.claimSeq), s.wallet, ceiling.toString(), expiresAt, s.method, s.login, now);
    return {
      github_id: String(s.github_id), login: s.login, wallet: s.wallet, ceiling: ceiling.toString(), claim_seq: got.escrow.claimSeq.toString(), expires_at: expiresAt,
      attestor: key.id, signature: base58Encode(signature), message: bytesToHex(message), program: LAUNCH_PROGRAM_ID,
      escrow: claimPdas.escrow(s.github_id), vault: claimPdas.vault(s.github_id), line_mint: this.opts.lineMint, line_token_program: this.opts.lineTokenProgram,
      wallet_token: ata(s.wallet, this.opts.lineMint!, this.opts.lineTokenProgram),
      // a pinned escrow pays another wallet only after the program's delay: this attestation would start it
      rebind: rebind ? { pinned_wallet: pinned, delay_s: Number(cfg.rebindDelayS) } : null,
    };
  }

  /** GET /v1/fee-claims/attestations?github_id=: what this Core attested (never a signature). */
  attestations(idText: string | undefined) {
    this.on();
    if (!idText || !/^[1-9]\d{0,18}$/.test(idText)) throw bad("bad_github_id", "github_id is required");
    return this.c.db.query("SELECT github_id, claim_seq, wallet, ceiling, expires_at, method, login, created_at FROM fee_claim_attestations WHERE github_id = ? ORDER BY created_at DESC LIMIT 200").all(Number(idText));
  }
}

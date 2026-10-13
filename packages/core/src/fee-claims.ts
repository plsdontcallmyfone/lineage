import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  accountDisc, addressBytes, ata, bytesToHex, claimMessage, claimPdas, decodeClaimConfig, decodeClaimEscrow, decodeFeeRoute, decodeTokenAccount, LAUNCH_PROGRAM_ID,
  Reader, signBytes, TOKEN_2022_PROGRAM, u64le, type Address, type ClaimConfig, type ClaimEscrow, type FeeRoute, type Rpc, type Signer,
} from "@units/chain";
import type { Core } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { requireFeature } from "./features.ts";
import { extractProofs } from "./links.ts";
import { base58Encode, canonicalUrl, isKind, signKind, statementDigest, verifyStatement } from "./protocol.ts";
import { revenueOf } from "./revenue.ts";

// GitHub fee routing and claims, Core side (docs/plans/GITHUB-FEE-CLAIMS.md 5 and 11). Core holds
// no funds and no GitHub token: fees accrue on chain in an escrow keyed by the numeric id of the
// REPOSITORY the agent works on, and this module (a) resolves a repository to that id for the
// launch wizard, (b) reads routes and escrows from chain, (c) checks who a visitor is on GitHub and
// which of those repositories the visitor has admin on (the sign-in, or for a personally owned
// repository a gist holding a statement the wallet signed) and that the wallet agrees, and (d)
// signs the attestation `claim_github_fees` checks on chain. Every route answers 404 `feature_off`
// while `features.github_fee_claims` is off.
//
// One kind of id, always: every `github_id` this module reads, shows or attests for is a repository
// id. An account id is only ever the claimant's identity inside a session and is never turned into
// an escrow key. An escrow is claimable only once Core has seen an agent that is registered on that
// very repository route fees to it (`bound`), so a number that came from anything else (the account
// ids of the first devnet build, a route set by hand to an arbitrary number) never pays anyone.

const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
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

export interface GithubRepo {
  id: number;
  full_name: string;
  owner_id: number;
  owner_login: string;
  owner_type: string;
  avatar_url: string | null;
  private: boolean;
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
  /** OAuth scope asked for at the sign-in ("" asks for none: read-only public information, section 11) */
  scope?: string;
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
  /** above this many routed repositories a sign-in reads the user's own list instead of asking GitHub about each one */
  directCheckMax: number;
  /** the quote coin's dollar price now and its decimals (Core's copy of the market indexer's reading), or why there is none */
  usd: () => { ok: true; quote_usd: number; read_at: number; decimals: number } | { ok: false; reason: string };
}

/** One repository's escrow as anyone may read it (GET /v1/fee-claims/waiting): amounts in the quote coin's base units, dollars beside them. */
export interface WaitingRepo {
  github_id: string;
  repository: { id: string; full_name: string; html_url: string; owner: { id: string; login: string; type: string; avatar_url: string | null } };
  /** unclaimed: the escrow vault's balance on chain */
  waiting: string;
  waiting_usd: number | null;
  claimed: string;
  claimed_usd: number | null;
  /** everything ever routed to this escrow */
  routed_total: string;
  /** the agents whose route names this repository now, largest contribution first */
  agents: { agent: string; bps: number; routed_total: string; set_at: number }[];
  /** unix seconds: when the first of those routes was set on chain; null with no route now */
  routed_since: number | null;
  /** unix seconds: when Core first saw the balance that is waiting now (since the last claim); null while nothing waits */
  waiting_since: number | null;
}

interface Session {
  /** the claimant's GitHub ACCOUNT id: who signed in, never an escrow key */
  github_id: number;
  login: string;
  method: "oauth" | "gist" | "mock";
  wallet: string | null;
  /** REPOSITORY ids this account was shown to have admin on when the session was issued (the only ids `attest` signs for) */
  repos: number[];
  /**
   * REPOSITORY ids GitHub said this account has admin on at the sign-in, routed or not (public only). Never an
   * escrow key and never signed for by `attest`: it is what the owner mark of a bounty reads (bounty-owners.ts).
   */
  admin?: number[];
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
  CREATE TABLE IF NOT EXISTS fee_claim_repos (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, owner_id INTEGER NOT NULL, owner_login TEXT NOT NULL, owner_type TEXT NOT NULL,
    avatar_url TEXT, private INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS fee_claim_repo_names (name TEXT NOT NULL, repo_id INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (name, repo_id));
  CREATE TABLE IF NOT EXISTS fee_claim_bound (repo_id INTEGER PRIMARY KEY, agent TEXT NOT NULL, bound_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS fee_claim_waiting (repo_id INTEGER NOT NULL, claim_seq INTEGER NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (repo_id, claim_seq));
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
  private routesAt = 0;
  private routesHeld: FeeRoute[] = [];
  private unboundAt = new Map<number, number>();
  private waitingAt = 0;
  private waitingHeld: Omit<WaitingRepo, "waiting_usd" | "claimed_usd">[] = [];
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
        redirectUri: env.UNITS_GITHUB_OAUTH_REDIRECT ?? (site ? `${site}/v1/fee-claims/oauth/callback` : "http://127.0.0.1:9660/v1/fee-claims/oauth/callback"),
        scope: (env.UNITS_GITHUB_OAUTH_SCOPE ?? "").trim(), name: env.UNITS_GITHUB_OAUTH_MOCK === "1" ? "mock" : "github" } : null,
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
      directCheckMax: 60,
      usd: () => {
        const u = revenueOf(core).usd(), d = revenueOf(core).quoteDecimals();
        if (!u.ok) return { ok: false, reason: u.reason };
        return d === null ? { ok: false, reason: "the market indexer has not named the quote coin's decimals yet" } : { ok: true, quote_usd: u.quote_usd, read_at: u.read_at, decimals: d };
      },
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

  /**
   * One GitHub API read. `as`: a visitor's sign-in token, used for this call only (the caller drops it when the callback returns).
   * Repository reads follow GitHub's own redirect from a former name to the repository's id.
   */
  private async gh(path: string, as?: string): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "units-core-fee-claims" };
    const bearer = as ?? this.opts.githubToken;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await this.opts.fetch(`${this.opts.githubApi}${path}`, { headers, redirect: path.startsWith("/repos/") ? "follow" : "error", signal: AbortSignal.timeout(this.opts.timeoutMs) });
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

  private parseRepo(j: unknown): (GithubRepo & { admin: boolean | null }) | null {
    const r = j as { id?: unknown; full_name?: unknown; private?: unknown; owner?: unknown; permissions?: { admin?: unknown } };
    const owner = this.parseUser(r?.owner);
    if (!r || !Number.isSafeInteger(r.id) || (r.id as number) <= 0 || typeof r.full_name !== "string" || !owner) return null;
    return { id: r.id as number, full_name: r.full_name, owner_id: owner.id, owner_login: owner.login, owner_type: owner.type, avatar_url: owner.avatar_url, private: r.private === true,
      // admin only when GitHub says so in so many words; a missing or false field is "no"
      admin: r.permissions && typeof r.permissions === "object" ? r.permissions.admin === true : null };
  }

  private rememberRepo(r: GithubRepo, asked?: string): GithubRepo {
    const now = this.c.now();
    this.c.db.query("INSERT INTO fee_claim_repos (id, full_name, owner_id, owner_login, owner_type, avatar_url, private, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name, owner_id = excluded.owner_id, owner_login = excluded.owner_login, owner_type = excluded.owner_type, avatar_url = excluded.avatar_url, private = excluded.private, fetched_at = excluded.fetched_at")
      .run(r.id, r.full_name, r.owner_id, r.owner_login, r.owner_type, r.avatar_url, r.private ? 1 : 0, now);
    // every name GitHub ever resolved to this id, kept: a rename or a transfer changes the name, never the id
    for (const n of new Set([r.full_name.toLowerCase(), ...(asked ? [asked.toLowerCase()] : [])]))
      this.c.db.query("INSERT INTO fee_claim_repo_names (name, repo_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(name, repo_id) DO UPDATE SET seen_at = excluded.seen_at").run(n, r.id, now);
    return { id: r.id, full_name: r.full_name, owner_id: r.owner_id, owner_login: r.owner_login, owner_type: r.owner_type, avatar_url: r.avatar_url, private: r.private };
  }

  private cachedRepo(id: number): (GithubRepo & { fetched_at: number }) | null {
    const row = this.c.db.query<Omit<GithubRepo, "private"> & { private: number; fetched_at: number }, [number]>("SELECT * FROM fee_claim_repos WHERE id = ?").get(id);
    return row ? { ...row, private: row.private === 1 } : null;
  }
  private static bare(r: GithubRepo): GithubRepo {
    return { id: r.id, full_name: r.full_name, owner_id: r.owner_id, owner_login: r.owner_login, owner_type: r.owner_type, avatar_url: r.avatar_url, private: r.private };
  }

  /** The public repository behind owner/name, by its numeric id (cached for an hour under the name asked for). */
  private async repoByName(fullName: string): Promise<GithubRepo> {
    const [owner, name, extra] = fullName.split("/");
    if (!owner || !name || extra !== undefined || !GITHUB_LOGIN.test(owner) || !GITHUB_REPO.test(name) || name === "." || name === "..") throw bad("bad_repository", "a repository is owner/name");
    const asked = `${owner}/${name.replace(/\.git$/i, "")}`;
    const hit = this.c.db.query<{ repo_id: number; seen_at: number }, [string]>("SELECT repo_id, seen_at FROM fee_claim_repo_names WHERE name = ? ORDER BY seen_at DESC LIMIT 1").get(asked.toLowerCase());
    const held = hit && this.c.now() - hit.seen_at < 3_600_000 ? this.cachedRepo(hit.repo_id) : null;
    if (held && this.c.now() - held.fetched_at < 3_600_000) return FeeClaims.bare(held);
    const r = await this.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(asked.split("/")[1]!)}`);
    if (r.status === 404) throw notFound("public GitHub repository");
    const repo = r.status === 200 ? this.parseRepo(r.json) : null;
    if (!repo) throw new ApiError(502, "github_unreachable", `GitHub answered HTTP ${r.status}`);
    if (repo.private) throw notFound("public GitHub repository");
    return this.rememberRepo(repo, asked);
  }

  /** The repository with a numeric id (cached; null when GitHub has none, or cannot say and nothing is held). */
  private async repoById(id: bigint | number): Promise<GithubRepo | null> {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const hit = this.cachedRepo(n);
    if (hit && this.c.now() - hit.fetched_at < 3_600_000) return FeeClaims.bare(hit);
    try {
      const r = await this.gh(`/repositories/${n}`);
      const repo = r.status === 200 ? this.parseRepo(r.json) : null;
      if (repo && !repo.private) return this.rememberRepo(repo);
    } catch {
      /* fall through to the stale row */
    }
    return hit ? FeeClaims.bare(hit) : null;
  }

  private static repoView(r: GithubRepo) {
    return { id: String(r.id), full_name: r.full_name, html_url: `https://github.com/${r.full_name}`, owner: { id: String(r.owner_id), login: r.owner_login, type: r.owner_type, avatar_url: r.avatar_url } };
  }

  /** GET /v1/github/repos/:owner/:repo: the public repository behind a name, with the numeric id a fee route is keyed by. */
  async repo(owner: string, name: string) {
    this.on();
    return FeeClaims.repoView(await this.repoByName(`${owner}/${name}`));
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

  /** Every fee route on chain (held for 20 seconds). */
  private async routes(): Promise<FeeRoute[]> {
    const now = this.c.now();
    if (now - this.routesAt < 20_000 && this.routesAt !== 0) return this.routesHeld;
    const all = await this.rpc().getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("FeeRoute") }] });
    this.routesHeld = all.map((a) => decodeFeeRoute(a.data)).filter((r) => r.githubId !== 0n);
    this.routesAt = now;
    return this.routesHeld;
  }

  /** The repository URL an agent was registered on (its AgentLaunch on chain), canonical; null when it has none. */
  private async agentRepoUrl(agent: Address): Promise<string | null> {
    const found = await this.rpc().getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }, { offset: 8, bytes: addressBytes(agent) }] });
    for (const a of found) {
      try {
        const rd = new Reader(a.data).expect("AgentLaunch");
        if (rd.address() !== agent) continue;
        rd.address(); rd.address(); rd.hex32();
        return canonicalUrl(rd.string());
      } catch {
        /* not an AgentLaunch this build reads */
      }
    }
    return null;
  }

  /**
   * Whether the escrow keyed by `id` is a REPOSITORY's: some agent whose route names `id` (now, or as its
   * pending change) is registered on chain on the repository GitHub knows under that id. Recorded the first
   * time it is seen and kept, so a later redirect of the route does not strand what accrued. An id that is
   * not a repository's (an account id from the first devnet build, any number set by hand) is never bound.
   */
  private async bound(id: bigint | number): Promise<boolean> {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    if (this.c.db.query("SELECT 1 FROM fee_claim_bound WHERE repo_id = ?").get(n)) return true;
    const now = this.c.now();
    if (now - (this.unboundAt.get(n) ?? -Infinity) < 60_000) return false;
    const agents = (await this.routes()).filter((r) => r.githubId === BigInt(n) || (r.pendingEffectiveAt !== 0n && r.pendingGithubId === BigInt(n))).map((r) => r.agent);
    if (agents.length && (await this.repoById(n))) {
      const names = new Set(this.c.db.query<{ name: string }, [number]>("SELECT name FROM fee_claim_repo_names WHERE repo_id = ?").all(n).map((x) => `https://github.com/${x.name}`));
      for (const agent of agents.slice(0, 25)) {
        const url = await this.agentRepoUrl(agent);
        if (url && names.has(url)) {
          this.c.db.query("INSERT OR IGNORE INTO fee_claim_bound (repo_id, agent, bound_at) VALUES (?, ?, ?)").run(n, agent, now);
          return true;
        }
      }
    }
    this.unboundAt.set(n, now);
    return false;
  }

  /** The repository ids fees are routed to: every id a route names that is bound to its repository. */
  private async routedRepos(): Promise<number[]> {
    const ids = new Set<number>();
    for (const r of await this.routes()) {
      ids.add(Number(r.githubId));
      if (r.pendingEffectiveAt !== 0n) ids.add(Number(r.pendingGithubId));
    }
    for (const row of this.c.db.query<{ repo_id: number }, []>("SELECT repo_id FROM fee_claim_bound").all()) ids.add(row.repo_id);
    const out: number[] = [];
    for (const id of ids) if (await this.bound(id)) out.push(id);
    return out;
  }

  /** GET /v1/agents/:id/fee-route */
  async routeView(agent: string) {
    this.on();
    if (!ADDRESS.test(agent)) throw bad("bad_agent", "agent id");
    const [r, cfg] = await Promise.all([this.routeAccount(agent), this.config()]);
    const bounds = cfg ? { min_bps: cfg.minBps, max_bps: cfg.maxBps, change_delay_s: Number(cfg.changeDelayS), paused: cfg.paused } : null;
    if (!r || r.githubId === 0n) return { agent, route: null, bounds };
    // the repository is named only when the id is bound to it (section 11): an id of any other origin shows as a bare number
    const named = async (id: bigint) => ((await this.bound(id).catch(() => false)) ? this.repoById(id) : null);
    const [repo, pending] = await Promise.all([named(r.githubId), r.pendingEffectiveAt !== 0n ? named(r.pendingGithubId) : null]);
    return {
      agent,
      route: {
        github_id: r.githubId.toString(), repository: repo ? FeeClaims.repoView(repo) : null, bps: r.bps, set_at: Number(r.setAt),
        accrued: r.accrued.toString(), accrued_total: r.accruedTotal.toString(), changes: r.changes,
        pending: r.pendingEffectiveAt === 0n ? null : { github_id: r.pendingGithubId.toString(), repository: pending ? FeeClaims.repoView(pending) : null, bps: r.pendingBps, effective_at: Number(r.pendingEffectiveAt) },
      },
      bounds,
    };
  }

  /** GET /v1/fee-claims/recipients/:github_id: a repository's escrow (by the repository's numeric id) and the agents whose route names it now. */
  async recipient(idText: string) {
    this.on();
    if (!/^[1-9]\d{0,18}$/.test(idText)) throw bad("bad_github_id", "a numeric GitHub repository id");
    const id = BigInt(idText);
    const rpc = this.rpc();
    const [got, routes, isBound] = await Promise.all([
      this.escrowAccount(id),
      rpc.getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("FeeRoute") }, { offset: 40, bytes: u64le(id) }] }),
      this.bound(id),
    ]);
    const repo = isBound ? await this.repoById(id) : null;
    const agents = routes.map((a) => decodeFeeRoute(a.data)).map((r) => ({ agent: r.agent, bps: r.bps, accrued: r.accrued.toString(), set_at: Number(r.setAt),
      pending_change: r.pendingEffectiveAt !== 0n ? { effective_at: Number(r.pendingEffectiveAt), to_github_id: r.pendingGithubId.toString() } : null }));
    return {
      github_id: idText, repository: repo ? FeeClaims.repoView(repo) : null,
      // false: no agent registered on a repository with this id routes fees here, so nobody can claim it (section 11)
      claimable_by_admins: isBound,
      escrow: got ? {
        address: claimPdas.escrow(id), vault: claimPdas.vault(id), accrued: got.escrow.accrued.toString(), claimed: got.escrow.claimed.toString(), claimable: got.balance.toString(),
        claim_seq: got.escrow.claimSeq.toString(), wallet: got.escrow.wallet === "11111111111111111111111111111111" ? null : got.escrow.wallet,
        pending_wallet: got.escrow.pendingEffectiveAt !== 0n ? { wallet: got.escrow.pendingWallet, effective_at: Number(got.escrow.pendingEffectiveAt) } : null,
      } : null,
      agents,
    };
  }

  /** GET /v1/fee-claims/recipients?repo=owner/name */
  async recipientByRepo(fullName: string) {
    this.on();
    return this.recipient(String((await this.repoByName(fullName.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, ""))).id));
  }

  // ---------------------------------------------------------------------------------------------
  // fees waiting for the owners (owner 2026-10-13): a public view, no sign-in

  /** Every repository escrow with its agents, read from chain (held for 30 seconds). Only ids bound to their repository appear. */
  private async waitingRows() {
    const now = this.c.now();
    if (this.waitingAt !== 0 && now - this.waitingAt < 30_000) return this.waitingHeld;
    const [routes, ids] = [await this.routes(), await this.routedRepos()];
    const rows: FeeClaims["waitingHeld"] = [];
    for (const id of ids) {
      const [got, repo] = await Promise.all([this.escrowAccount(id), this.repoById(id)]);
      if (!repo || repo.private) continue;
      const mine = routes.filter((r) => r.githubId === BigInt(id)).sort((a, b) => (b.accruedTotal > a.accruedTotal ? 1 : b.accruedTotal < a.accruedTotal ? -1 : a.agent < b.agent ? -1 : 1));
      const balance = got?.balance ?? 0n, seq = Number(got?.escrow.claimSeq ?? 0n);
      let since: number | null = null;
      if (balance > 0n) {
        // the chain keeps no time for an escrow: Core notes when it first saw a balance at this claim number
        this.c.db.query("INSERT OR IGNORE INTO fee_claim_waiting (repo_id, claim_seq, since) VALUES (?, ?, ?)").run(id, seq, Math.floor(now / 1000));
        since = this.c.db.query<{ since: number }, [number, number]>("SELECT since FROM fee_claim_waiting WHERE repo_id = ? AND claim_seq = ?").get(id, seq)?.since ?? null;
      }
      rows.push({
        github_id: String(id), repository: FeeClaims.repoView(repo), waiting: balance.toString(), claimed: (got?.escrow.claimed ?? 0n).toString(), routed_total: (got?.escrow.accrued ?? 0n).toString(),
        agents: mine.map((r) => ({ agent: r.agent, bps: r.bps, routed_total: r.accruedTotal.toString(), set_at: Number(r.setAt) })),
        routed_since: mine.length ? Math.min(...mine.map((r) => Number(r.setAt))) : null, waiting_since: since,
      });
    }
    rows.sort((a, b) => (BigInt(b.waiting) > BigInt(a.waiting) ? 1 : BigInt(b.waiting) < BigInt(a.waiting) ? -1 : a.repository.full_name.toLowerCase() < b.repository.full_name.toLowerCase() ? -1 : 1));
    this.waitingHeld = rows;
    this.waitingAt = now;
    return rows;
  }

  /**
   * GET /v1/fee-claims/waiting[?repo=owner/name]: what sits unclaimed in each repository's escrow, largest first, with the agents
   * that route to it, what was claimed so far and since when it has been waiting. Dollars are the amount at the quote coin's
   * current price (the indexer's dollar rule for a figure of now); null with `usd_reason` when Core holds no reading. With `repo`
   * the list holds that repository alone, or nothing when no agent routes fees to it. Chain facts and public GitHub names only.
   */
  async waiting(repo?: string) {
    this.on();
    let rows = await this.waitingRows();
    const name = repo === undefined ? null : repo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    if (name !== null) {
      const [o, n] = name.split("/");
      if (name.split("/").length !== 2 || !GITHUB_LOGIN.test(o ?? "") || !GITHUB_REPO.test(n ?? "")) throw bad("bad_repo", "repo is owner/name");
      // by the names GitHub ever resolved to the id (a renamed repository keeps its escrow), without asking GitHub again
      const known = new Set(this.c.db.query<{ repo_id: number }, [string]>("SELECT repo_id FROM fee_claim_repo_names WHERE name = ? COLLATE NOCASE").all(name).map((x) => String(x.repo_id)));
      rows = rows.filter((r) => known.has(r.github_id) || r.repository.full_name.toLowerCase() === name.toLowerCase());
    }
    const u = this.opts.usd();
    const usd = (base: string) => (u.ok ? (Number(BigInt(base)) / 10 ** u.decimals) * u.quote_usd : null);
    const repositories: WaitingRepo[] = rows.map((r) => ({ ...r, waiting_usd: usd(r.waiting), claimed_usd: usd(r.claimed) }));
    const total = rows.reduce((s, r) => s + BigInt(r.waiting), 0n).toString();
    return {
      repositories, total_waiting: total, total_waiting_usd: usd(total),
      usd: u.ok ? { quote_usd: u.quote_usd, read_at: u.read_at, decimals: u.decimals } : null, usd_reason: u.ok ? null : u.reason,
    };
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

  private repoList(ids: number[]) {
    return ids.map((id) => this.cachedRepo(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => FeeClaims.repoView(r));
  }

  private issue(s: Omit<Session, "exp">): { session: string; expires_at: number; github_id: string; login: string; method: string; wallet: string | null; repositories: ReturnType<FeeClaims["repoList"]> } {
    const full: Session = { ...s, exp: Math.floor(this.c.now() / 1000) + this.opts.sessionTtlS };
    const body = b64u(JSON.stringify(full));
    const mac = b64u(createHmac("sha256", this.secret()).update(body).digest());
    return { session: `${body}.${mac}`, expires_at: full.exp, github_id: String(s.github_id), login: s.login, method: s.method, wallet: s.wallet, repositories: this.repoList(s.repos) };
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
    // a session of the first build proved an account and no repository: it claims nothing
    if (!Array.isArray(s.repos) || s.repos.some((r) => !Number.isSafeInteger(r) || r <= 0)) throw new ApiError(401, "bad_session", "sign in again");
    return s;
  }

  /** GET /v1/fee-claims/session */
  session(token: unknown) {
    this.on();
    const s = this.read(token);
    return { github_id: String(s.github_id), login: s.login, method: s.method, wallet: s.wallet, expires_at: s.exp, repositories: this.repoList(s.repos) };
  }

  /** GET /v1/fee-claims/providers: what the page can offer. */
  providers() {
    this.on();
    return { oauth: this.opts.oauth ? { provider: this.opts.oauth.name, scope: this.opts.oauth.scope ?? "" } : null, gist: true, attestor: this.opts.attestor?.id ?? null, network: this.opts.network,
      recipient: "repository" as const };
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

  /**
   * GET /v1/fee-claims/oauth/start: where to send the browser. `return_to` may only change the claim page's query.
   * `repo` (owner/name): a repository to check by name at the callback, whatever the size of the routed set.
   */
  oauthStart(returnTo?: string, repo?: string) {
    this.on();
    const o = this.opts.oauth;
    if (!o) throw new ApiError(503, "oauth_not_configured", "no GitHub OAuth app is configured; use the gist proof");
    const page = new URL(this.opts.claimPage);
    if (returnTo) {
      const want = new URL(returnTo, page);
      // the claim page, or the Bounties pages (an owner proving a repository for the mark on a bounty: bounty-owners.ts)
      const bounties = /^\/bounties(\/[1-9A-HJ-NP-Za-km-z]{32,44})?$/.test(want.pathname);
      if (want.origin !== page.origin || (want.pathname !== page.pathname && !bounties)) throw bad("bad_return_to", "return_to must be the claim page or a Bounties page");
      page.pathname = want.pathname;
      page.search = want.search;
    }
    if (repo) {
      const [owner, name, extra] = repo.split("/");
      if (!owner || !name || extra !== undefined || !GITHUB_LOGIN.test(owner) || !GITHUB_REPO.test(name)) throw bad("bad_repository", "a repository is owner/name");
      page.searchParams.set("repo", `${owner}/${name}`);
    }
    const state = b64u(randomBytes(24));
    this.c.db.query("DELETE FROM fee_claim_states WHERE created_at < ?").run(this.c.now() - 600_000);
    this.c.db.query("INSERT INTO fee_claim_states (state, return_to, created_at) VALUES (?, ?, ?)").run(state, page.toString(), this.c.now());
    const u = new URL(o.authorizeUrl);
    u.searchParams.set("client_id", o.clientId);
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    if (o.scope) u.searchParams.set("scope", o.scope);
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
    let repos: number[] = [];
    let admin: number[] = [];
    try {
      if (u) ({ repos, admin } = await this.adminRepos(token, new URL(row.return_to).searchParams.get("repo")));
    } finally {
      token = undefined; // used inside this callback only, never stored, never in the session
    }
    if (!u) throw new ApiError(502, "github_unreachable", "GitHub did not name the signed-in user");
    this.remember(u);
    const session = this.issue({ github_id: u.id, login: u.login, method: o.name === "mock" ? "mock" : "oauth", wallet: null, repos, admin });
    const back = new URL(row.return_to);
    back.hash = `session=${session.session}`;
    return { redirect: back.toString(), session };
  }

  /**
   * The routed repositories the signed-in user has admin on, asked of GitHub with the user's own token:
   * `GET /repositories/{id}` answers `permissions.admin` for whoever the token belongs to, on a personal
   * and on an organisation repository alike. A small routed set is asked about one by one; a large one is
   * matched against the user's own repository list, plus the one repository named at the sign-in.
   */
  private async adminRepos(token: string, hint: string | null): Promise<{ repos: number[]; admin: number[] }> {
    const routed = new Set(await this.routedRepos());
    const out = new Set<number>();
    const admin = new Set<number>();
    const check = async (path: string) => {
      const r = await this.gh(path, token).catch(() => null);
      const repo = r?.status === 200 ? this.parseRepo(r.json) : null;
      if (!repo || repo.private) return;
      this.rememberRepo(repo);
      if (repo.admin === true) admin.add(repo.id);
      if (repo.admin === true && (routed.has(repo.id) || (await this.bound(repo.id)))) out.add(repo.id);
    };
    if (hint && /^[^/]+\/[^/]+$/.test(hint)) await check(`/repos/${hint.split("/").map(encodeURIComponent).join("/")}`);
    if (routed.size <= this.opts.directCheckMax) {
      const ids = [...routed];
      for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map((id) => check(`/repositories/${id}`)));
    } else {
      for (let page = 1; page <= 10; page++) {
        const r = await this.gh(`/user/repos?per_page=100&page=${page}`, token).catch(() => null);
        const list = r?.status === 200 && Array.isArray(r.json) ? r.json : [];
        for (const j of list) {
          const repo = this.parseRepo(j);
          if (repo && !repo.private && repo.admin === true && routed.has(repo.id)) {
            this.rememberRepo(repo);
            out.add(repo.id);
            admin.add(repo.id);
          }
        }
        if (list.length < 100) break;
      }
    }
    return { repos: [...out].slice(0, 100), admin: [...admin].slice(0, 100) };
  }

  /**
   * What a session proves, for the owner mark of a bounty (bounty-owners.ts): the account, the wallet it bound, and
   * the repository ids GitHub said it has admin on when it signed in. Throws like every session read.
   */
  adminSession(token: unknown): { github_id: number; login: string; method: Session["method"]; wallet: string | null; admin: number[] } {
    this.on();
    const s = this.read(token);
    const admin = [...new Set([...(Array.isArray(s.admin) ? s.admin : []), ...s.repos])].filter((r) => Number.isSafeInteger(r) && r > 0);
    return { github_id: s.github_id, login: s.login, method: s.method, wallet: s.wallet, admin };
  }
  /** The repository id GitHub resolved `owner/name` to, from what Core has already seen (no request is made). */
  knownRepoId(fullName: string): number | null {
    return this.c.db.query<{ repo_id: number }, [string]>("SELECT repo_id FROM fee_claim_repo_names WHERE name = ? ORDER BY seen_at DESC LIMIT 1").get(fullName.toLowerCase())?.repo_id ?? null;
  }
  /** owner/name of a repository id Core has seen, as GitHub last spelled it. */
  knownRepoName(id: number): string | null {
    return this.cachedRepo(id)?.full_name ?? null;
  }
  /** The newest attestation Core signed for this repository's escrow and wallet (a claim), or null. */
  lastAttestation(repoId: number, wallet: string): { created_at: number } | null {
    return this.c.db.query<{ created_at: number }, [number, string]>("SELECT created_at FROM fee_claim_attestations WHERE github_id = ? AND wallet = ? ORDER BY created_at DESC LIMIT 1").get(repoId, wallet) ?? null;
  }

  /** POST /v1/fee-claims/wallet { statement, sig } with an OAuth session: binds the wallet. */
  bindWallet(token: unknown, body: unknown) {
    this.on();
    const s = this.read(token);
    const b = (body ?? {}) as { statement?: unknown; sig?: unknown };
    const st = this.checkStatement(b.statement, b.sig, s.login);
    return this.issue({ github_id: s.github_id, login: s.login, method: s.method, wallet: st.wallet, repos: s.repos, admin: s.admin });
  }

  /**
   * POST /v1/fee-claims/proofs/gist { gist_url }: a public gist of the account holding the wallet-signed statement.
   * A gist proves an account, not a role, so it opens only the routed repositories that account owns itself
   * (a personal repository's owner always has admin on it). Organisation repositories need the sign-in.
   */
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
        const repos: number[] = [];
        if (owner.type === "User") for (const id of await this.routedRepos()) {
          const repo = await this.repoById(id);
          if (repo && !repo.private && repo.owner_type === "User" && repo.owner_id === owner.id) repos.push(id);
        }
        return this.issue({ github_id: owner.id, login: owner.login, method: "gist", wallet: st.wallet, repos: repos.slice(0, 100) });
      } catch (e) {
        why = e as ApiError;
      }
    }
    throw why ?? bad("proof_invalid", "no units-fee-claim statement in the gist");
  }

  // ---------------------------------------------------------------------------------------------
  // attestation

  /**
   * POST /v1/fee-claims/attest { session, repo_id }: the attestation for one repository's escrow and the bound wallet.
   * Signed only for a repository the session's account was shown to have admin on; any one admin claims the whole balance.
   */
  async attest(token: unknown, repoIdText?: unknown) {
    this.on();
    const who = this.read(token);
    if (repoIdText !== undefined && repoIdText !== null && !/^[1-9]\d{0,15}$/.test(String(repoIdText))) throw bad("bad_github_id", "repo_id is a numeric GitHub repository id");
    const repoId = repoIdText === undefined || repoIdText === null ? (who.repos.length === 1 ? who.repos[0]! : null) : Number(repoIdText);
    if (repoId === null) throw bad("no_repository", "name the repository to claim for (repo_id)");
    if (!who.repos.includes(repoId)) throw forbidden("not_admin", "this GitHub account was not shown to have admin on that repository");
    if (!(await this.bound(repoId))) throw forbidden("not_a_repository_escrow", "no agent working on that repository routes fees to it");
    // from here on the id is the repository's: the escrow key, never the account's
    const s = { ...who, github_id: repoId };
    if (!s.wallet) throw bad("no_wallet", "bind a wallet first (POST /v1/fee-claims/wallet)");
    const key = this.opts.attestor;
    if (!key) throw new ApiError(503, "no_attestor", "this Core holds no attestor key");
    const now = this.c.now();
    if (now - (this.lastAttest.get(s.github_id) ?? 0) < 2_000) throw new ApiError(429, "attest_rate", "one attestation every two seconds per repository");
    const [got, cfg] = await Promise.all([this.escrowAccount(s.github_id), this.config()]);
    if (!cfg) throw new ApiError(503, "no_claim_config", "the program has no ClaimConfig");
    if (cfg.paused) throw new ApiError(409, "claims_paused", "claims are paused on chain");
    if (cfg.attestor !== key.id) throw new ApiError(503, "attestor_mismatch", "this Core's attestor key is not the one the program trusts");
    if (!got) throw notFound("escrow: no fees were ever routed to this repository");
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
      github_id: String(s.github_id), repository: this.repoList([repoId])[0] ?? null, login: s.login, wallet: s.wallet, ceiling: ceiling.toString(), claim_seq: got.escrow.claimSeq.toString(), expires_at: expiresAt,
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

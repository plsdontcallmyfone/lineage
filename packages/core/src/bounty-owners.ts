import type { Core } from "./core.ts";
import { ApiError } from "./errors.ts";
import { featureOn } from "./features.ts";
import { feeClaimsOf } from "./fee-claims.ts";

// "Posted by an owner of owner/repo" (docs/plans/OPEN-BOUNTIES.md 9): the mark on a bounty whose
// funder wallet belongs to someone GitHub says has admin on the bounty's repository. There is no
// second identity system here. The proof is the fee claims' own (fee-claims.ts): a GitHub sign-in
// at whose callback Core asks GitHub about the repository with the visitor's token, and a statement
// the wallet signs. The mark is read from two records and nothing else:
//   - a claim: a wallet Core attested for the repository's fee escrow (fee_claim_attestations);
//   - the direct proof below (bounty_owner_marks), for a funder who claims nothing.
// It is never set from anything a poster types, it is computed at every read, and it lapses
// `ttl_s` after GitHub last answered: Core keeps no GitHub token, so it cannot ask again by itself;
// the owner renews by proving again. It changes nothing about who wins or how an escrow moves.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bounty_owner_marks (
    repo_id INTEGER NOT NULL,            -- the repository's numeric GitHub id
    wallet TEXT NOT NULL,                -- the wallet that signed the statement
    github_id INTEGER NOT NULL,          -- the account that proved admin (never served)
    login TEXT NOT NULL,
    show_login INTEGER NOT NULL,         -- 1: the person agreed to show the login
    repo_name TEXT NOT NULL,             -- owner/name as GitHub spelled it at the proof
    method TEXT NOT NULL,
    proved_at INTEGER NOT NULL,          -- ms, when GitHub answered
    expires_at INTEGER NOT NULL,         -- ms
    PRIMARY KEY (repo_id, wallet)
  );
  CREATE TABLE IF NOT EXISTS bounty_owner_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export const OWNER_MARK_DEFAULTS = { ttl_s: 30 * 86_400 };
const TTL_MIN_S = 3_600, TTL_MAX_S = 365 * 86_400;

/** What the pages are served about a bounty's poster: a fact Core holds, and the login only with consent. */
export interface OwnerMark { verified: true; repository: string; login: string | null; source: "proof" | "claim"; proved_at: number; expires_at: number }

interface Internals { db: Core["db"]; now(): number }
const bad = (code: string, message: string) => new ApiError(400, code, message);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** owner/name of a GitHub repository address (the only host the proof exists for), lower case; null otherwise. */
export function githubName(repo: string | null | undefined): string | null {
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec((repo ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const instances = new WeakMap<Core, BountyOwners>();
export function bountyOwnersOf(core: Core): BountyOwners {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new BountyOwners(core)));
  return s;
}

export class BountyOwners {
  private readonly c: Internals;
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /** The proof exists only where fee claims run (their sign-in and their records). */
  available(): boolean {
    return featureOn(this.core, "github_fee_claims");
  }

  config(): { ttl_s: number } {
    const row = this.c.db.query<{ v: string }, []>("SELECT v FROM bounty_owner_kv WHERE k = 'config'").get();
    try {
      return { ...OWNER_MARK_DEFAULTS, ...(row ? (JSON.parse(row.v) as { ttl_s: number }) : {}) };
    } catch {
      return { ...OWNER_MARK_DEFAULTS };
    }
  }
  /** POST /v1/admin/bounty-owners/config { ttl_s }: how long a proof counts. */
  setConfig(body: unknown) {
    const ttl = (body as { ttl_s?: unknown })?.ttl_s;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < TTL_MIN_S || ttl > TTL_MAX_S) throw bad("bad_config", `ttl_s must be a whole number of seconds from ${TTL_MIN_S} to ${TTL_MAX_S}`);
    this.c.db.query("INSERT INTO bounty_owner_kv (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ ttl_s: ttl }));
    return this.config();
  }

  /**
   * POST /v1/bounties/owner-proof { session, repo_id, show_login }: the direct proof. `session` is a fee-claim session
   * of a GitHub sign-in that has bound a wallet (POST /v1/fee-claims/wallet); `repo_id` must be a repository GitHub
   * said that account has admin on at the sign-in. No transaction is involved.
   */
  prove(body: unknown) {
    const b = (body ?? {}) as { session?: unknown; repo_id?: unknown; show_login?: unknown };
    const s = feeClaimsOf(this.core).adminSession(b.session);
    if (s.method === "gist") throw new ApiError(403, "sign_in_required", "sign in with GitHub to show ownership of a repository");
    if (!s.wallet) throw bad("no_wallet", "sign the statement with the wallet first (POST /v1/fee-claims/wallet)");
    const repoId = Number(b.repo_id);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) throw bad("bad_repository", "repo_id must be the repository's numeric id");
    if (!s.admin.includes(repoId)) throw new ApiError(403, "not_admin", "GitHub did not say this account has admin on that repository");
    const name = feeClaimsOf(this.core).knownRepoName(repoId);
    if (!name) throw new ApiError(403, "not_admin", "the repository is not one this sign-in was checked against");
    const now = this.c.now();
    const expires = now + this.config().ttl_s * 1000;
    this.c.db
      .query(`INSERT INTO bounty_owner_marks (repo_id, wallet, github_id, login, show_login, repo_name, method, proved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, wallet) DO UPDATE SET github_id = excluded.github_id, login = excluded.login, show_login = excluded.show_login, repo_name = excluded.repo_name,
          method = excluded.method, proved_at = excluded.proved_at, expires_at = excluded.expires_at`)
      .run(repoId, s.wallet, s.github_id, s.login, b.show_login === true ? 1 : 0, name, s.method, now, expires);
    return this.markById(repoId, s.wallet)!;
  }

  /** DELETE-like: POST /v1/bounties/owner-proof/forget { session, repo_id }: the same person takes the mark back. */
  forget(body: unknown) {
    const b = (body ?? {}) as { session?: unknown; repo_id?: unknown };
    const s = feeClaimsOf(this.core).adminSession(b.session);
    if (!s.wallet) throw bad("no_wallet", "sign the statement with the wallet first");
    this.c.db.query("DELETE FROM bounty_owner_marks WHERE repo_id = ? AND wallet = ? AND github_id = ?").run(Number(b.repo_id), s.wallet, s.github_id);
    return { removed: true };
  }

  private markById(repoId: number, wallet: string): OwnerMark | null {
    const now = this.c.now();
    const fc = feeClaimsOf(this.core);
    const m = this.c.db.query<{ login: string; show_login: number; repo_name: string; proved_at: number; expires_at: number }, [number, string]>(
      "SELECT login, show_login, repo_name, proved_at, expires_at FROM bounty_owner_marks WHERE repo_id = ? AND wallet = ?").get(repoId, wallet);
    if (m && m.expires_at > now) return { verified: true, repository: fc.knownRepoName(repoId) ?? m.repo_name, login: m.show_login === 1 ? m.login : null, source: "proof", proved_at: m.proved_at, expires_at: m.expires_at };
    // a claim: Core attested this wallet for the repository's fee escrow, which it does only for an admin's bound wallet
    const a = fc.lastAttestation(repoId, wallet);
    const ttl = this.config().ttl_s * 1000;
    const name = fc.knownRepoName(repoId);
    if (a && name && a.created_at + ttl > now) return { verified: true, repository: name, login: null, source: "claim", proved_at: a.created_at, expires_at: a.created_at + ttl };
    return null;
  }

  /** The mark of `wallet` on the repository at `repo` (a GitHub address or owner/name), from Core's own records only. */
  mark(repo: string | null | undefined, wallet: string | null | undefined): OwnerMark | null {
    if (!wallet || !this.available()) return null;
    const name = githubName(repo);
    const id = name ? feeClaimsOf(this.core).knownRepoId(name) : null;
    return id === null ? null : this.markById(id, wallet);
  }

  /** GET /v1/bounties/owners?repo=owner/name&wallet=: public, a boolean and what the person agreed to show. */
  view(repo: string | undefined, wallet: string | undefined) {
    if (!githubName(repo)) throw bad("bad_repository", "repo is owner/name or a GitHub address");
    if (!wallet || !ADDRESS.test(wallet)) throw bad("bad_wallet", "wallet must be a Solana address");
    const m = this.mark(repo, wallet);
    return m ?? { verified: false as const, repository: githubName(repo), login: null, source: null, proved_at: null, expires_at: null };
  }

  /** GET /v1/bounties/owner-proof: what the pages can offer, and how long a proof counts. */
  offer() {
    const on = this.available();
    let provider: string | null = null;
    if (on) try { provider = feeClaimsOf(this.core).providers().oauth?.provider ?? null; } catch { provider = null; }
    return { available: on && provider !== null, provider, ttl_s: this.config().ttl_s };
  }
}

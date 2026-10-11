// The units-agents GitHub organization (docs/plans/GITHUB-ORG.md). Agents with an account of their own
// join it: purchased (pool or adopted) accounts always, a launcher's pasted-token account only when the
// launcher opted in with `join_org` in the signed token statement. Three REST calls (GitHub docs,
// Organization members, API 2022-11-28):
//   1. PUT   /orgs/{org}/memberships/{username} {role: member}   publisher token (org owner): invitation
//   2. PATCH /user/memberships/orgs/{org} {state: active}        the agent's token: accept
//   3. PUT   /orgs/{org}/public_members/{username}               the agent's token: publicize (only the
//                                                                 member may publicize their own membership)
// Each is skipped when GitHub already shows its effect, so a pass is idempotent. Transient failures
// retry in place, then with backoff across passes; missing scopes are reported, never silent.
// Tokens are never logged or stored outside the encrypted records.

import { GitHub, GitHubError, type Fetch } from "../../souls/src/github/api.ts";
import { publisherRecord } from "./publisher.ts";
import { errText, type Log } from "./redact.ts";
import type { IdentityService } from "./service.ts";

export const DEFAULT_ORG = "units-agents";
export const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export type OrgStatus = "joined" | "pending" | "failed" | "scope_missing" | "not_eligible";

export interface OrgRecord {
  v: 1;
  agent: string;
  org: string;
  login: string | null;
  status: OrgStatus;
  /** the step that last ran or stopped: check | invite | accept | publicize | done */
  step: string;
  public: boolean;
  reason: string | null;
  attempts: number;
  /** epoch ms before which the timer does not retry */
  next_at: number;
  updated_at: string;
  history: { at: string; status: OrgStatus; step: string; reason: string | null }[];
}

export interface OrgPublic {
  name: string;
  status: OrgStatus;
  public: boolean;
  reason: string | null;
  updated_at: string;
}

export interface OrgOptions {
  svc: IdentityService;
  org?: string;
  apiBase?: string;
  fetch?: Fetch;
  log?: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ORG_WRITE = ["admin:org", "write:org"];
const hasScope = (scopes: string[] | null, any: string[]) => scopes === null || scopes.some((s) => any.includes(s));

/** A failure worth retrying: GitHub busy or rate limited, or the network. */
export function transient(e: unknown): boolean {
  if (!(e instanceof GitHubError)) return true;
  if (e.status >= 500 || e.status === 429) return true;
  if ((e.status === 403 || e.status === 422) && /rate limit|limit exceeded|secondary|too many/i.test(e.message)) return true;
  return false;
}

export function orgPublic(r: OrgRecord | null): OrgPublic | null {
  return r ? { name: r.org, status: r.status, public: r.public, reason: r.reason, updated_at: r.updated_at } : null;
}

export class OrgMembership {
  readonly org: string;
  private readonly log: Log;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private busy = new Set<string>();

  constructor(private readonly o: OrgOptions) {
    this.org = o.org ?? o.svc.o.org ?? DEFAULT_ORG;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  private get store() {
    return this.o.svc.o.store;
  }

  private gh(token: string) {
    return new GitHub({ token, base: this.o.apiBase ?? this.o.svc.o.apiBase, fetch: this.o.fetch ?? this.o.svc.o.fetch });
  }

  record(agent: string): OrgRecord | null {
    return this.store.get<OrgRecord>("org", agent);
  }

  private save(r: OrgRecord, status: OrgStatus, step: string, reason: string | null) {
    r.status = status;
    r.step = step;
    r.reason = reason;
    r.updated_at = this.now().toISOString();
    r.history.push({ at: r.updated_at, status, step, reason });
    if (r.history.length > 30) r.history.splice(0, r.history.length - 30);
    this.store.put("org", r.agent, r);
    return r;
  }

  /** Whether the agent's account joins: purchased always, a pasted token only with the opt-in. */
  eligible(agent: string): { ok: true; login: string; token: string } | { ok: false; why: string } {
    const s = this.o.svc.state(agent);
    const c = this.o.svc.creds.record(agent);
    if (!c) return { ok: false, why: "the agent has no GitHub account of its own" };
    if (s && s.status !== "ready") return { ok: false, why: `the agent's identity is ${s.status}` };
    const mode = s?.mode ?? c.mode;
    if (mode === "token" && s?.join_org !== true) return { ok: false, why: "the launcher did not opt in (pasted-token accounts join only with the launch's join_org)" };
    return { ok: true, login: c.login, token: c.token };
  }

  /** Retries a call on transient failures: 3 tries, 2 s then 4 s apart. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (!transient(e) || i === 2) throw e;
        await this.sleep(2000 * 2 ** i);
      }
    }
    throw last;
  }

  /** Classic token scopes from X-OAuth-Scopes (null: a fine-grained or app token, which lists none). */
  private async scopes(gh: GitHub): Promise<string[] | null> {
    const r = await this.retry(() => gh.request("GET", "/user"));
    const h = r.headers.get("x-oauth-scopes");
    return h === null ? null : h.split(",").map((s) => s.trim()).filter(Boolean);
  }

  /** One join pass for an agent. `force` ignores the backoff and the attempt cap. */
  async join(agent: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<OrgRecord> {
    const at = this.now();
    const prev = this.record(agent);
    const r: OrgRecord = prev ?? { v: 1, agent, org: this.org, login: null, status: "pending", step: "check", public: false, reason: null, attempts: 0, next_at: 0, updated_at: at.toISOString(), history: [] };
    r.org = this.org;
    const el = this.eligible(agent);
    if (!el.ok) return opts.dryRun ? { ...r, status: "not_eligible", reason: el.why } : this.save(r, "not_eligible", "check", el.why);
    if (r.login && r.login.toLowerCase() !== el.login.toLowerCase()) Object.assign(r, { public: false, attempts: 0, next_at: 0 }); // a new account
    r.login = el.login;
    if (!opts.force && r.status === "joined" && r.public) return r;
    if (!opts.force && r.status === "failed" && (r.attempts >= MAX_ATTEMPTS || at.getTime() < r.next_at)) return r;
    const pub = publisherRecord(this.o.svc);
    if (!pub) return opts.dryRun ? { ...r, status: "failed", reason: "no publisher account is configured" } : this.save(r, "failed", "check", "no publisher account is configured (it sends the invitation)");
    if (this.busy.has(agent)) return r;
    this.busy.add(agent);
    let step = "check";
    try {
      const P = this.gh(pub.token);
      const A = this.gh(el.token);
      const login = el.login;
      const pubScopes = await this.scopes(P);
      if (!hasScope(pubScopes, ORG_WRITE)) return this.save(r, "scope_missing", "invite", `the publisher's token lacks admin:org (has: ${pubScopes!.join(", ") || "none"})`);
      const agentScopes = await this.scopes(A);
      if (!hasScope(agentScopes, ORG_WRITE)) return this.save(r, "scope_missing", "accept", `${login}'s token lacks write:org, needed to accept the invitation and make the membership public (has: ${agentScopes!.join(", ") || "none"})`);

      // 1. invitation (skipped when GitHub already lists the membership)
      const cur = await this.retry(() => P.request<{ state?: string }>("GET", `/orgs/${this.org}/memberships/${login}`, undefined, { okStatuses: [404] }));
      let state = cur.status === 404 ? null : (cur.data?.state ?? null);
      if (!state) {
        step = "invite";
        if (opts.dryRun) return { ...r, status: "pending", step, reason: "dry run: would invite" };
        const inv = await this.retry(() => P.request<{ state?: string }>("PUT", `/orgs/${this.org}/memberships/${login}`, { role: "member" }));
        state = inv.data?.state ?? "pending";
        this.log(`org: invited ${login} to ${this.org} (${state})`);
      }
      // 2. accept with the agent's token
      if (state === "pending") {
        step = "accept";
        if (opts.dryRun) return { ...r, status: "pending", step, reason: "dry run: would accept" };
        const acc = await this.retry(() => A.request<{ state?: string }>("PATCH", `/user/memberships/orgs/${this.org}`, { state: "active" }));
        state = acc.status === 202 ? "active" : (acc.data?.state ?? "active");
        this.log(`org: ${login} accepted the ${this.org} invitation`);
      }
      // 3. public membership
      step = "publicize";
      const isPublic = await this.retry(() => A.request("GET", `/orgs/${this.org}/public_members/${login}`, undefined, { okStatuses: [404] }));
      if (isPublic.status !== 204) {
        if (opts.dryRun) return { ...r, status: "pending", step, reason: "dry run: would publicize" };
        await this.retry(() => A.request("PUT", `/orgs/${this.org}/public_members/${login}`));
        this.log(`org: ${login} is a public member of ${this.org}`);
      }
      r.public = true;
      r.attempts = 0;
      r.next_at = 0;
      return this.save(r, "joined", "done", null);
    } catch (e) {
      const why = errText(e);
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !transient(e)) {
        // fine-grained tokens list no scopes: a refusal here is a missing permission
        const who = step === "invite" || step === "check" ? "the publisher's token" : `${el.login}'s token`;
        return this.save(r, "scope_missing", step, `${who} was refused at ${step} (${why}); it needs organization Members: write (classic scope write:org or admin:org)`);
      }
      r.attempts += 1;
      r.next_at = at.getTime() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (r.attempts - 1));
      this.log(`org: ${el.login} at ${step} failed (attempt ${r.attempts}/${MAX_ATTEMPTS}): ${why}`);
      return this.save(r, "failed", step, why);
    } finally {
      this.busy.delete(agent);
    }
  }

  /** Called when an agent's account becomes ready: joins it when eligible, records nothing otherwise. */
  async afterReady(agent: string): Promise<OrgRecord | null> {
    if (!this.eligible(agent).ok && !this.record(agent)) return null;
    return this.join(agent);
  }

  /** Watcher tick: retries agents with an unfinished record whose backoff has passed. */
  async tick(): Promise<number> {
    let n = 0;
    for (const a of this.store.list("org")) {
      const r = this.record(a);
      if (!r || r.status === "joined" || r.status === "scope_missing" || r.status === "not_eligible") continue;
      if (r.status === "failed" && (r.attempts >= MAX_ATTEMPTS || this.now().getTime() < r.next_at)) continue;
      await this.join(a).catch((e) => this.log(`org: ${a}: ${errText(e)}`));
      n++;
    }
    return n;
  }

  /** The publisher's role in the org and the org's public members (operator status). */
  async status(): Promise<{ org: string; publisher: { login: string; role: string | null; state: string | null; scopes: string[] | null } | null; public_members: string[]; agents: OrgPublic[] }> {
    const pub = publisherRecord(this.o.svc);
    let publisher = null;
    let members: string[] = [];
    if (pub) {
      const P = this.gh(pub.token);
      const scopes = await this.scopes(P);
      const m = await P.request<{ role?: string; state?: string }>("GET", `/user/memberships/orgs/${this.org}`, undefined, { okStatuses: [404] });
      publisher = { login: pub.login, role: m.status === 404 ? null : (m.data?.role ?? null), state: m.status === 404 ? null : (m.data?.state ?? null), scopes };
      members = (await P.paged<{ login: string }>(`/orgs/${this.org}/public_members`)).map((x) => x.login);
    }
    return { org: this.org, publisher, public_members: members, agents: this.store.list("org").map((a) => ({ agent: a, ...orgPublic(this.record(a))! }) as OrgPublic) };
  }
}

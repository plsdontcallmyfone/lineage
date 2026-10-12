// The identity service (plan AUDIT-AND-IDENTITY B, SPEC 13.9): watches launch_agent on chain and
// acts by identity mode, takes pasted tokens bound by a signed statement, and revokes.
//
//   purchased  waiting_soul -> provisioning -> ready | failed. Assigns one reserve account, validates
//              it, cleans the previous owner's traces, sets name and bio from the soul, registers an
//              SSH signing key and marks it assigned (packages/souls provisionAccount). Paid in SOL in
//              the launch transactions (see below); unpaid launches get no account.
//   token      awaiting_token until the launcher submits a token (POST /identity/token with a signed
//              statement); then validated (login, scopes, expiry), stored encrypted, signing key
//              registered -> ready. Revocable and rotatable by the launcher.
//   app        no account; commits are recorded as fallbacks by the mirror.
// "A units account" (owner direction 2026-10-11): a purchased launch created at or after
// `payment.since` gets a pool account only when its launch transactions carry the configured SOL
// payment (amount and recipient from Core's prepay config) from the launcher; otherwise it stays
// `unpaid` and no pool account is touched. Launches before that keep what they have.
// Only launches created at or after `since` are acted on (older TEST launches are left alone).

import type { AgentLaunch, AgentRecord } from "../../chain/src/index.ts";
import type { SoulDoc } from "../../souls/src/schema.ts";
import { provisionAccount } from "../../souls/src/github/provision.ts";
import type { Fetch } from "../../souls/src/github/api.ts";
import { EncryptedCredentialStore, ReservePool } from "./creds.ts";
import { registerSigningKey, removeSigningKey, sshKeygen, TokenRejected, tokenShapeOk, validateToken, type Keygen, type TokenInfo } from "./github-token.ts";
import { MODES, publicView, setStatus, type AgentState, type LaunchMode, type PublicView, type PublishedRecord } from "./records.ts";
import { errText, type Log } from "./redact.ts";
import { genesisPublic, type GenesisRecord } from "./genesis.ts";
import { orgPublic, type OrgRecord } from "./org.ts";
import { checkStatement, tokenSha256, type RevokeStatement, type TokenStatement } from "./statement.ts";
import type { EncryptedStore } from "./store.ts";

export interface ChainView {
  launches(): Promise<AgentLaunch[]>;
  agentLaunch(mint: string): Promise<AgentLaunch | null>;
  agent(agent: string): Promise<AgentRecord | null>;
}

export interface ServiceOptions {
  store: EncryptedStore;
  runDir: string;
  chain: ChainView;
  /** the agent's public soul from Core, or null when Core has none (yet) */
  soul: (agent: string) => Promise<SoulDoc | null>;
  /** public site base; profile links point at <site>/agents/<id> */
  site: string | null;
  /** launches created before this (unix seconds) are ignored */
  since: number;
  /** how long a purchased launch waits for its soul before provisioning with a plain profile */
  soulWaitS?: number;
  /** minimum seconds between provisioning attempts of one agent after a failure */
  retryS?: number;
  maxAttempts?: number;
  apiBase?: string;
  fetch?: Fetch;
  keygen?: Keygen;
  log?: Log;
  now?: () => Date;
  /** GitHub organization agents join (docs/plans/GITHUB-ORG.md); default units-agents */
  org?: string;
  /** the units account payment check (owner direction 2026-10-11); absent: no payment required */
  payment?: PaymentCheck;
  /** GET /identity/pool says `low` when this many accounts or fewer are free (default POOL_LOW_WATER) */
  poolLowWater?: number;
}

/** Free accounts at or below which the pool reports `low`: the reserve target push-reserve.ts has always topped up to. */
export const POOL_LOW_WATER = 5;
/** Why a paid launch has no account yet when none is free (the wizard and the agent page show it). */
export const POOL_EMPTY_REASON = "paid, but no units account is free right now: this agent gets the next one added to the reserve, or the operator refunds the payment";

export interface PaymentCheck {
  /** purchased launches created at or after this (unix seconds) must carry the payment */
  since: number;
  /** the configured price and recipient now (Core's prepay block), or null when none is configured */
  terms: () => Promise<{ lamports: bigint; recipient: string } | null>;
  /** lamports the launcher sent `recipient` in the launch's transactions (launch-bundle.ts identityPaymentIn) */
  paid: (l: AgentLaunch, recipient: string) => Promise<{ lamports: bigint; signatures: string[] }>;
  /** how long after first seeing a launch the payment is still looked for (default 1800 s: its transactions land in order) */
  windowS?: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class IdentityService {
  readonly reserve: ReservePool;
  readonly creds: EncryptedCredentialStore;
  private readonly log: Log;
  private readonly now: () => Date;
  /** mode of every launch the watcher has seen (for agents without a state record) */
  private modes = new Map<string, LaunchMode>();
  private busy = new Set<string>();
  lastWatch: { at: string; launches: number; error: string | null } | null = null;
  /** Called (not awaited) when an agent's account becomes ready: provisioning, a pasted token, a re-provision (genesis.ts). */
  afterReady: ((agent: string) => Promise<unknown>) | null = null;

  constructor(readonly o: ServiceOptions) {
    this.reserve = new ReservePool(o.store);
    this.creds = new EncryptedCredentialStore(o.store, o.runDir);
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  private get store() {
    return this.o.store;
  }

  state(agent: string): AgentState | null {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) return null;
    return this.store.get<AgentState>("state", agent);
  }

  private save(s: AgentState) {
    this.store.put("state", s.agent, s);
  }

  view(agent: string): PublicView {
    const s = this.state(agent);
    const pub = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent) ? (this.store.get<PublishedRecord[]>("published", agent) ?? []) : [];
    const v = publicView(agent, s, pub, this.modes.get(agent) ?? null);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) return v;
    const org = orgPublic(this.store.get<OrgRecord>("org", agent));
    return { ...v, genesis: genesisPublic(this.store.get<GenesisRecord>("genesis", agent)), org, ...(s?.mode === "token" ? { join_org: s.join_org === true } : {}) };
  }

  private ready(agent: string) {
    if (!this.afterReady) return;
    void this.afterReady(agent).catch((e) => this.log(`genesis: ${agent}: ${errText(e)}`));
  }

  views(): PublicView[] {
    return this.store.list("state").map((a) => this.view(a));
  }

  /**
   * GET /identity/payments: the units account payments found in launch transactions (public chain
   * facts: who paid how many lamports to which recipient, in which signatures, for which launch).
   * `launched_at` is the launch's chain time in unix seconds; the payment rides in the launch transactions.
   */
  payments(): { since: number | null; payments: { agent: string; mint: string; launcher: string; lamports: string; recipient: string; signatures: string[]; launched_at: number; account: "assigned" | "waiting" }[] } {
    const out = [];
    for (const a of this.store.list("state")) {
      const s = this.state(a);
      if (!s?.paid || !/^\d+$/.test(s.paid.lamports)) continue;
      out.push({ agent: s.agent, mint: s.mint, launcher: s.launcher, lamports: s.paid.lamports, recipient: s.paid.recipient, signatures: s.paid.signatures, launched_at: s.launched_at });
    }
    out.sort((x, y) => x.launched_at - y.launched_at || (x.agent < y.agent ? -1 : 1));
    return { since: this.o.payment?.since ?? null, payments: out.map((p) => ({ ...p, account: this.state(p.agent)?.status === "ready" ? ("assigned" as const) : ("waiting" as const) })) };
  }

  /**
   * GET /identity/pool: counts of the reserve, no login and no token. `available` accounts can still be
   * given out; `waiting_paid` launches paid for an account and have none yet (each takes the next free
   * one, oldest first, so they come off `available` first); `offer` is whether a new launch can be sold
   * an account now (Core hides the option when it is false); `low` is the top-up warning.
   */
  pool(): { available: number; assigning: number; assigned: number; unusable: number; total: number; waiting_paid: number; low_water: number; low: boolean; offer: boolean } {
    const c = this.reserve.counts();
    let waiting = 0;
    for (const a of this.store.list("state")) {
      const s = this.state(a);
      if (s?.mode === "purchased" && s.paid && s.status !== "ready" && !this.reserve.assignedTo(a)) waiting += 1;
    }
    const lowWater = this.o.poolLowWater ?? POOL_LOW_WATER;
    const free = Math.max(0, c.available - waiting);
    return { available: c.available, assigning: c.assigning, assigned: c.assigned, unusable: c.unusable, total: c.total, waiting_paid: waiting, low_water: lowWater, low: free <= lowWater, offer: free > 0 };
  }

  summary() {
    const counts: Record<string, number> = {};
    for (const a of this.store.list("state")) {
      const s = this.state(a);
      if (s) counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    const reserve: Record<string, number> = {};
    for (const a of this.reserve.publicList()) reserve[a.status] = (reserve[a.status] ?? 0) + 1;
    return { agents: counts, reserve, pool: this.pool(), since: new Date(this.o.since * 1000).toISOString(), last_watch: this.lastWatch, last_cycle: this.store.get<any>("cycle", "last")?.summary ?? null };
  }

  private newState(l: AgentLaunch, mode: LaunchMode): AgentState {
    const at = this.now().toISOString();
    const s: AgentState = {
      v: 1, agent: l.agent, mint: l.mint, launcher: l.launcher, repo: l.repoUrl, mode, status: "app", reason: null, login: null, github_id: null,
      ssh_public_key: null, scopes: null, token_kind: null, expires_at: null, launched_at: Number(l.createdAt), first_seen_at: at, updated_at: at,
      attempts: 0, last_statement_at: 0, history: [],
    };
    return setStatus(s, mode === "purchased" ? "waiting_soul" : mode === "token" ? "awaiting_token" : "app", null, this.now());
  }

  /** One pass of the launch watcher. Provisioning runs inline, one agent at a time. */
  async watchOnce(): Promise<void> {
    let launches: AgentLaunch[];
    try {
      launches = await this.o.chain.launches();
    } catch (e) {
      this.lastWatch = { at: this.now().toISOString(), launches: 0, error: errText(e) };
      this.log(`watch: reading launches failed: ${errText(e)}`);
      return;
    }
    this.lastWatch = { at: this.now().toISOString(), launches: launches.length, error: null };
    for (const l of launches) this.modes.set(l.agent, MODES[l.identityMode] ?? "app");
    const fresh = launches.filter((l) => Number(l.createdAt) >= this.o.since).sort((a, b) => Number(a.createdAt - b.createdAt));
    for (const l of fresh) {
      const mode = MODES[l.identityMode] ?? "app";
      let s = this.state(l.agent);
      if (!s) {
        s = this.newState(l, mode);
        this.save(s);
        this.log(`watch: new launch ${l.agent} (${mode}) on ${l.repoUrl}: ${s.status}`);
      }
      if (mode === "purchased" && (await this.paymentOk(l, s))) await this.advancePurchased(s);
    }
  }

  /** Whether a purchased launch may get a pool account: paid in its launch transactions, or launched before the payment started. */
  private async paymentOk(l: AgentLaunch, s: AgentState): Promise<boolean> {
    const p = this.o.payment;
    if (!p || Number(l.createdAt) < p.since || s.status === "ready" || s.paid) return true;
    if (s.status === "unpaid" && this.now().getTime() - Date.parse(s.first_seen_at) > (p.windowS ?? 1800) * 1000) return false;
    let why: string;
    try {
      const t = await p.terms();
      if (!t) why = "no units account price is configured; no pool account is assigned";
      else {
        const got = await p.paid(l, t.recipient);
        if (got.lamports >= t.lamports) {
          s.paid = { lamports: got.lamports.toString(), recipient: t.recipient, signatures: got.signatures };
          if (s.status === "unpaid") setStatus(s, "waiting_soul", null, this.now());
          this.save(s);
          this.log(`watch: ${s.agent} paid ${got.lamports} lamports for its units account in ${got.signatures.join(", ")}`);
          return true;
        }
        why = `the launch transactions carry ${got.lamports} of the ${t.lamports} lamports to ${t.recipient}; no pool account is assigned`;
      }
    } catch (e) {
      why = `the payment could not be read yet: ${errText(e)}`;
    }
    if (s.status !== "unpaid" || s.reason !== why) {
      this.save(setStatus(s, "unpaid", why, this.now()));
      this.log(`watch: ${s.agent} unpaid: ${why}`);
    }
    return false;
  }

  private async advancePurchased(s: AgentState) {
    if (s.status === "ready" || this.busy.has(s.agent)) return;
    const nowMs = this.now().getTime();
    if (s.status === "failed") {
      if (s.attempts >= (this.o.maxAttempts ?? 5)) return;
      if (nowMs - Date.parse(s.updated_at) < (this.o.retryS ?? 600) * 1000) return;
    }
    let soul: SoulDoc | null = null;
    try {
      soul = await this.o.soul(s.agent);
    } catch (e) {
      this.log(`watch: soul of ${s.agent} not readable: ${errText(e)}`);
    }
    if (!soul && s.status === "waiting_soul" && nowMs - Date.parse(s.first_seen_at) < (this.o.soulWaitS ?? 600) * 1000) return;
    this.busy.add(s.agent);
    try {
      s.attempts += 1;
      this.save(setStatus(s, "provisioning", soul ? null : "no soul in Core; plain profile", this.now()));
      const profileUrl = this.o.site ? `${this.o.site.replace(/\/$/, "")}/agents/${s.agent}` : null;
      const doc = soul ?? ({ agent: s.agent, persona: { name: `units agent ${s.agent.slice(0, 8)}`, tagline: "An autonomous units agent." } } as unknown as SoulDoc);
      const r = await provisionAccount({
        agent: s.agent, soul: doc, pool: this.reserve, store: this.creds, profileUrl, apiBase: this.o.apiBase, fetch: this.o.fetch,
        keygen: this.o.keygen ?? sshKeygen, log: (m) => this.log(m), now: this.now,
      });
      const cred = this.creds.record(s.agent);
      s.login = r.login;
      s.github_id = r.github_id;
      s.ssh_public_key = cred?.ssh_public_key ?? r.ssh_signing_key;
      this.save(setStatus(s, "ready", null, this.now()));
      this.ready(s.agent);
      this.log(`watch: ${s.agent} provisioned as ${r.login} (cleaned ${r.cleaned.unstarred} stars, ${r.cleaned.gists_deleted} gists, ${r.cleaned.signing_keys_removed} old signing keys; ${r.skipped.length} reserve accounts skipped)`);
    } catch (e) {
      const why = errText(e);
      const empty = why === "no usable account left in the pool";
      // an empty reserve is not this agent's failure: it does not use up an attempt, so the agent is tried
      // again (every retryS) for as long as it takes and gets the first account the operator adds
      if (empty) s.attempts = Math.max(0, s.attempts - 1);
      this.save(setStatus(s, "failed", empty ? (s.paid ? POOL_EMPTY_REASON : "no units account is free right now; this agent gets the next one added to the reserve") : why, this.now()));
      this.log(`watch: provisioning ${s.agent} failed: ${why}${empty && s.paid ? ` (it paid ${s.paid.lamports} lamports: an account or a refund is owed)` : ""}`);
    } finally {
      this.creds.cleanup();
      this.busy.delete(s.agent);
    }
  }

  /** Reads a token's login, scopes and expiry without storing anything (the launch form's check). */
  async checkToken(token: unknown): Promise<TokenInfo> {
    if (!tokenShapeOk(token)) throw new HttpError(400, "bad_token", "the token is not a GitHub token");
    try {
      return await validateToken(token, this.o);
    } catch (e) {
      if (e instanceof TokenRejected) throw new HttpError(422, "token_rejected", e.message);
      throw new HttpError(502, "github_unavailable", errText(e));
    }
  }

  private async bound(st: TokenStatement | RevokeStatement): Promise<{ s: AgentState | null; launch: AgentLaunch }> {
    const launch = await this.o.chain.agentLaunch(st.mint);
    if (!launch || launch.agent !== st.agent) throw new HttpError(404, "no_launch", "no launch of this agent with this mint on chain");
    if ((MODES[launch.identityMode] ?? "app") !== "token") throw new HttpError(409, "not_token_mode", `the agent was launched with identity mode ${MODES[launch.identityMode] ?? "app"}, not token`);
    let ok = st.signer === launch.launcher;
    if (!ok) {
      const rec = await this.o.chain.agent(st.agent);
      ok = !!rec?.signingKey && rec.signingKey === st.signer;
    }
    if (!ok) throw new HttpError(403, "not_launcher", "the statement must be signed by the launcher or the agent's current signing key");
    const s = this.state(st.agent);
    if (s && st.created_at <= s.last_statement_at) throw new HttpError(409, "replayed", "a newer or equal statement was already accepted for this agent");
    return { s, launch };
  }

  /** Accepts a pasted token bound to its launch by a signed statement (also a rotation). */
  async submitToken(body: { statement?: unknown; sig?: unknown; token?: unknown }): Promise<PublicView> {
    const nowS = Math.floor(this.now().getTime() / 1000);
    const why = checkStatement(body.statement, body.sig, "units-identity-token", nowS);
    if (why) throw new HttpError(400, "bad_statement", why);
    const st = body.statement as TokenStatement;
    if (!tokenShapeOk(body.token)) throw new HttpError(400, "bad_token", "the token is not a GitHub token");
    const token = body.token;
    if (tokenSha256(token) !== st.token_sha256) throw new HttpError(400, "token_mismatch", "the token does not match the statement's token_sha256");
    if (this.busy.has(st.agent)) throw new HttpError(409, "busy", "another identity change for this agent is in progress");
    this.busy.add(st.agent);
    try {
      const { s: prev, launch } = await this.bound(st);
      const s = prev ?? this.newState(launch, "token");
      s.last_statement_at = st.created_at;
      s.attempts += 1;
      // the opt-in rides on the signed statement; a statement without the field keeps the earlier choice
      if (typeof st.join_org === "boolean") s.join_org = st.join_org;
      this.save(s);
      let info: TokenInfo;
      try {
        info = await validateToken(token, this.o);
      } catch (e) {
        this.save(setStatus(s, s.status === "ready" ? "ready" : "failed", e instanceof TokenRejected ? e.message : `validation failed: ${errText(e)}`, this.now()));
        throw e instanceof TokenRejected ? new HttpError(422, "token_rejected", e.message) : new HttpError(502, "github_unavailable", errText(e));
      }
      s.scopes = info.scopes;
      s.token_kind = info.token_kind;
      s.expires_at = info.expires_at;
      // the agent's signing key: a new one per token
      const kp = (this.o.keygen ?? sshKeygen)(this.creds.keyDir(st.agent), `lineage-agent-${st.agent}`);
      let keyId: number | null;
      try {
        keyId = await registerSigningKey(token, st.agent, kp.publicKey, this.o);
      } catch (e) {
        this.creds.cleanup();
        const m = errText(e);
        const hint = /\b(403|404)\b/.test(m) ? " (the token needs permission to manage SSH signing keys: classic scope write:ssh_signing_key, or the fine-grained account permission SSH signing keys: write)" : "";
        if (s.status !== "ready") this.save(setStatus(s, "failed", `could not register the signing key: ${m}${hint}`, this.now()));
        throw new HttpError(422, "signing_key", `could not register the signing key: ${m}${hint}`);
      }
      // rotation: the previous token's signing key goes (best effort; the old token may already be revoked)
      const old = this.creds.record(st.agent);
      if (old && old.ssh_signing_key_id !== null && old.token !== token) {
        try {
          await removeSigningKey(old.token, old.ssh_signing_key_id, this.o);
        } catch (e) {
          this.log(`token: old signing key of ${st.agent} not removed: ${errText(e)}`);
        }
      }
      this.creds.put({ v: 1, agent: st.agent, login: info.login, github_id: info.github_id, token, ssh_private_key_path: kp.privatePath, ssh_public_key: kp.publicKey, ssh_signing_key_id: keyId, assigned_at: this.now().toISOString(), mode: "token" });
      s.login = info.login;
      s.github_id = info.github_id;
      s.ssh_public_key = kp.publicKey;
      this.save(setStatus(s, "ready", prev?.status === "ready" ? "token rotated" : null, this.now()));
      this.ready(st.agent);
      this.log(`token: ${st.agent} ready as ${info.login} (${info.token_kind}${info.scopes ? `, scopes ${info.scopes.join(" ") || "none"}` : ""})`);
      return this.view(st.agent);
    } finally {
      this.creds.cleanup();
      this.busy.delete(st.agent);
    }
  }

  /** Revokes a pasted token: its signing key is removed from GitHub, the record dropped, the agent moves to the app identity. */
  async revoke(body: { statement?: unknown; sig?: unknown }): Promise<PublicView> {
    const nowS = Math.floor(this.now().getTime() / 1000);
    const why = checkStatement(body.statement, body.sig, "units-identity-revoke", nowS);
    if (why) throw new HttpError(400, "bad_statement", why);
    const st = body.statement as RevokeStatement;
    if (this.busy.has(st.agent)) throw new HttpError(409, "busy", "another identity change for this agent is in progress");
    this.busy.add(st.agent);
    try {
      const { s: prev, launch } = await this.bound(st);
      const s = prev ?? this.newState(launch, "token");
      s.last_statement_at = st.created_at;
      const cred = this.creds.record(st.agent);
      let note = "revoked by the launcher; the agent uses the app identity. Delete the token on GitHub as well.";
      if (cred) {
        if (cred.ssh_signing_key_id !== null) {
          try {
            await removeSigningKey(cred.token, cred.ssh_signing_key_id, this.o);
          } catch (e) {
            note += ` The signing key could not be removed from GitHub (${errText(e, 120)}).`;
          }
        }
        this.creds.delete(st.agent);
      }
      s.login = null;
      s.github_id = null;
      s.ssh_public_key = null;
      this.save(setStatus(s, "revoked", note, this.now()));
      this.log(`revoke: ${st.agent} revoked; app identity`);
      return this.view(st.agent);
    } finally {
      this.creds.cleanup();
      this.busy.delete(st.agent);
    }
  }

  /** A token GitHub rejected on use: the agent moves to the app identity (called by the cycle). */
  markRejected(agent: string, reason: string) {
    const s = this.state(agent);
    this.creds.delete(agent);
    if (!s) return;
    s.login = null;
    s.github_id = null;
    s.ssh_public_key = null;
    this.save(setStatus(s, "rejected", reason, this.now()));
  }
}

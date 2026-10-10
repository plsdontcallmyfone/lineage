import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Core } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { canonicalJson, isKind, signStatement, verifyStatement, type AgentKey } from "./protocol.ts";
import { GENESIS_FILES, verifyGenesis, type GenesisFile } from "../../identity/src/genesis-proof.ts";

// Verified external links (identity plan I3, 2.3; Keybase pattern). The agent signs a statement
// `{ v: 1, kind: "lineage-link", agent, service, handle, created_at }` with purpose "link" and posts
// it where only the claimed account can post; Core fetches it, checks the account and the signature
// (against the agent's signing key at created_at), and re-checks on a schedule.
//
//   github   a public gist owned by `handle` (the GitHub API names the owner); the gist holds the
//            proof text (`proofText`): the canonical JSON `{ statement, sig }` in a fenced block
//   domain   https://<handle>/.well-known/lineage-agent.json: one `{ statement, sig }`, or
//            `{ lineage: [{ statement, sig }, ...] }` when one domain proves several agents (it may
//            sit next to ERC-8004's `/.well-known/agent-registration.json`, plan 2.8)
//
// Status: `verified` (the last check passed), `stale` (the proof could not be fetched: network,
// rate limit, server error), `broken` (the proof is gone, changed owner, or no longer verifies),
// `revoked` (the agent removed the link). Only `verified` gets a badge. Core verifies before it
// stores anything; the recheck job runs from Core.tick() with a per-tick budget so external APIs
// are never hammered. Links name an external account, never a candidate, so author-blind replay
// (SPEC 10.7) is untouched: no candidate view links an author while it is open.
//
//   github-genesis  the agent's profile repository <login>/<login> holds lineage-proof.json, a
//            statement signed with purpose "github-genesis" (docs/plans/GITHUB-GENESIS.md). Core
//            fetches it from raw.githubusercontent.com, checks the signature against the agent's key
//            at issued_at and that the identity service's record names the same login. Recorded with
//            POST /v1/agents/:id/genesis { login } (no signature: Core checks everything itself).

export type LinkService = "github" | "domain" | "github-genesis";
export type LinkStatus = "verified" | "stale" | "broken" | "revoked";

export interface LinkStatement {
  v: 1;
  kind: "lineage-link";
  agent: string;
  service: LinkService;
  handle: string;
  created_at: number; // unix seconds
}

export interface LinkProof {
  statement: LinkStatement;
  sig: string;
}

export interface LinkRow {
  agent_id: string;
  service: LinkService;
  handle: string;
  proof_url: string;
  statement: string;
  sig: string;
  status: LinkStatus;
  added_at: number;
  checked_at: number;
  verified_at: number | null;
  detail: string | null;
  fails: number;
}

export const LINKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS links (
    agent_id TEXT NOT NULL,
    service TEXT NOT NULL,               -- github | domain
    handle TEXT NOT NULL,                -- GitHub login (lowercase) or domain (lowercase)
    proof_url TEXT NOT NULL,             -- where the proof lives (gist URL or the well-known URL)
    statement TEXT NOT NULL,             -- canonical JSON of the signed statement
    sig TEXT NOT NULL,                   -- signStatement(signing key, "link", statement)
    status TEXT NOT NULL,                -- verified | stale | broken | revoked
    added_at INTEGER NOT NULL,           -- ms
    checked_at INTEGER NOT NULL,         -- ms, last check (or revoke)
    verified_at INTEGER,                 -- ms, last check that passed
    detail TEXT,                         -- why the last check failed
    fails INTEGER NOT NULL DEFAULT 0,    -- consecutive failed checks
    PRIMARY KEY (agent_id, service, handle)
  );
  CREATE INDEX IF NOT EXISTS links_due ON links(status, checked_at);
`;

const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const GIST_URL = /^https:\/\/gist\.github\.com\/(?:([A-Za-z0-9-]{1,39})\/)?([0-9a-f]{20,40})\/?(?:#.*)?$/;
const MAX_PROOF_BYTES = 256 * 1024;

/** The statement an agent signs for one link (created_at in unix seconds). */
export function linkStatement(agent: string, service: LinkService, handle: string, createdAt: number): LinkStatement {
  return { v: 1, kind: "lineage-link", agent, service, handle: handle.toLowerCase(), created_at: Math.floor(createdAt) };
}

export function signLink(key: AgentKey, statement: LinkStatement): LinkProof {
  return { statement, sig: signStatement(key, "link", statement) };
}

/** The exact text to post in a gist (a fenced block survives Markdown rendering). */
export function proofText(p: LinkProof): string {
  return [
    `This gist proves that the GitHub account ${p.statement.handle} speaks for Lineage agent ${p.statement.agent}.`,
    "",
    "```json",
    canonicalJson({ statement: p.statement, sig: p.sig }),
    "```",
    "",
  ].join("\n");
}

/** The JSON a domain serves at /.well-known/lineage-agent.json. */
export function domainProofJson(proofs: LinkProof[]): string {
  return JSON.stringify(proofs.length === 1 ? proofs[0] : { lineage: proofs }, null, 2) + "\n";
}

/** Every `{ statement, sig }` object found in a text: the whole text as JSON, then each fenced block. */
export function extractProofs(text: string): LinkProof[] {
  const out: LinkProof[] = [];
  const take = (v: unknown) => {
    const xs = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { lineage?: unknown }).lineage) ? (v as { lineage: unknown[] }).lineage : [v];
    for (const x of xs) {
      const p = x as LinkProof;
      if (p && typeof p === "object" && p.statement && typeof p.statement === "object" && typeof p.sig === "string") out.push(p);
    }
  };
  const tryParse = (s: string) => {
    try {
      take(JSON.parse(s));
    } catch {
      /* not JSON */
    }
  };
  tryParse(text);
  for (const m of text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)) tryParse(m[1]!);
  return out;
}

type CheckResult = { ok: true } | { ok: false; status: "stale" | "broken"; detail: string };

interface Internals {
  db: Core["db"];
  identity: Core["identity"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
}

export interface LinksOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Hosts (host or host:port) a domain proof may use over plain http and on private addresses. Tests only. */
  httpHosts: string[];
  /** Optional GitHub token for the gist API rate limit (never logged, never returned). */
  githubToken: string | null;
  githubApi: string;
  /** Seconds between rechecks of one link (link_recheck_s, plan Q14; TEST value). */
  recheckS: number;
  /** Links rechecked per tick at most. */
  perTick: number;
  timeoutMs: number;
  /** raw file host for genesis proofs (tests point it at a mock) */
  githubRaw: string;
  /** the identity service's base URL (its public GET /identity/agents/:id names the agent's login); null skips that check (tests only) */
  identityApi: string | null;
}

const envList = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const instances = new WeakMap<Core, Links>();
/** The one Links of a Core (created on first use, schema included). */
export function linksOf(core: Core): Links {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Links(core)));
  return s;
}

export class Links {
  private readonly c: Internals;
  opts: LinksOptions;
  private inflight = 0;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.opts = {
      fetch: (u, i) => fetch(u, i),
      httpHosts: envList(process.env.LINEAGE_LINK_HTTP_HOSTS),
      githubToken: process.env.LINEAGE_GITHUB_TOKEN || null,
      githubApi: "https://api.github.com",
      recheckS: Number(process.env.LINEAGE_LINK_RECHECK_S ?? 3600), // TEST value; launch value TBA
      perTick: 2,
      timeoutMs: 10_000,
      githubRaw: "https://raw.githubusercontent.com",
      identityApi: (process.env.LINEAGE_IDENTITY ?? "http://127.0.0.1:9665").replace(/\/+$/, "") || null,
    };
    this.ensure();
  }

  configure(o: Partial<LinksOptions>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private ensure() {
    this.c.db.exec(LINKS_SCHEMA);
  }

  private known(agent: string): boolean {
    return !!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ? AND kind != 'shadow'").get(agent);
  }

  // ---------------------------------------------------------------------------------------------
  // checks

  private normHandle(service: unknown, handle: unknown): { service: LinkService; handle: string } {
    if (service !== "github" && service !== "domain") throw bad("bad_service", "service must be github or domain");
    if (typeof handle !== "string") throw bad("bad_handle", "handle is required");
    const h = handle.trim().toLowerCase();
    if (service === "github" && !GITHUB_LOGIN.test(h)) throw bad("bad_handle", "not a GitHub login");
    if (service === "domain" && !HOSTNAME.test(h) && !this.opts.httpHosts.includes(h)) throw bad("bad_handle", "a DNS hostname (no scheme, path, port or IP address)");
    return { service, handle: h };
  }

  /** Where Core fetches a proof from, given the submitted proof_url. */
  private proofUrlFor(service: LinkService, handle: string, proofUrl: unknown): string {
    if (service === "domain") {
      const scheme = this.opts.httpHosts.includes(handle) ? "http" : "https";
      return `${scheme}://${handle}/.well-known/lineage-agent.json`;
    }
    if (typeof proofUrl !== "string") throw bad("bad_proof_url", "proof_url: the gist URL");
    const m = GIST_URL.exec(proofUrl.trim());
    if (!m) throw bad("bad_proof_url", "proof_url must be https://gist.github.com/<login>/<id>");
    if (m[1] && m[1].toLowerCase() !== handle) throw bad("bad_proof_url", "the gist URL names another account");
    return `https://gist.github.com/${handle}/${m[2]}`;
  }

  private async get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string } | { error: string }> {
    try {
      const res = await this.opts.fetch(url, { headers: { "user-agent": "lineage-core-links", ...headers }, redirect: "error", signal: AbortSignal.timeout(this.opts.timeoutMs) });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_PROOF_BYTES) return { status: res.status, text: "" };
      return { status: res.status, text: new TextDecoder().decode(buf) };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /** A statement matching this link whose signature verifies against the agent's key at created_at. */
  private matchProof(agent: string, service: LinkService, handle: string, proofs: LinkProof[], want?: { statement: string; sig: string }): CheckResult & { proof?: LinkProof } {
    const nowS = this.c.now() / 1000;
    let why = "no Lineage link statement for this agent and account in the proof";
    for (const p of proofs) {
      const s = p.statement;
      if (s.v !== 1 || !isKind(s.kind, "link") || s.agent !== agent || s.service !== service || typeof s.handle !== "string" || s.handle.toLowerCase() !== handle) continue;
      if (typeof s.created_at !== "number" || !Number.isFinite(s.created_at)) continue;
      if (s.created_at > nowS + 300) {
        why = "statement created_at is in the future";
        continue;
      }
      if (want && (canonicalJson(s) !== want.statement || p.sig !== want.sig)) {
        why = "the proof now holds a different statement than the one Core verified";
        continue;
      }
      const key = this.c.identity.keyAt(agent, s.created_at * 1000);
      if (!key) {
        why = "the agent's signing key was revoked at created_at";
        continue;
      }
      if (!verifyStatement(key, p.sig, "link", s)) {
        why = "signature does not verify against the agent's signing key at created_at";
        continue;
      }
      return { ok: true, proof: { statement: s, sig: p.sig } };
    }
    return { ok: false, status: "broken", detail: why };
  }

  private async fetchGithub(handle: string, gistUrl: string): Promise<{ proofs: LinkProof[] } | { status: "stale" | "broken"; detail: string }> {
    const id = GIST_URL.exec(gistUrl)![2]!;
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.opts.githubToken) headers.authorization = `Bearer ${this.opts.githubToken}`;
    const r = await this.get(`${this.opts.githubApi}/gists/${id}`, headers);
    if ("error" in r) return { status: "stale", detail: `GitHub did not answer: ${r.error}` };
    if (r.status === 404) return { status: "broken", detail: "gist not found (deleted or private)" };
    if (r.status === 403 || r.status === 429 || r.status >= 500) return { status: "stale", detail: `GitHub answered HTTP ${r.status}` };
    if (r.status !== 200) return { status: "stale", detail: `GitHub answered HTTP ${r.status}` };
    let g: { owner?: { login?: string } | null; public?: boolean; files?: Record<string, { content?: string; truncated?: boolean }> };
    try {
      g = JSON.parse(r.text);
    } catch {
      return { status: "stale", detail: "GitHub answered with something other than JSON" };
    }
    const owner = g.owner?.login?.toLowerCase();
    if (owner !== handle) return { status: "broken", detail: owner ? `the gist belongs to ${owner}` : "the gist has no owner" };
    if (g.public === false) return { status: "broken", detail: "the gist is secret, not public" };
    const proofs = Object.values(g.files ?? {}).flatMap((f) => (typeof f.content === "string" ? extractProofs(f.content) : []));
    return { proofs };
  }

  /** Refuses private, loopback and link-local targets for domain proofs (except test hosts). */
  private async publicHost(handle: string): Promise<string | null> {
    if (this.opts.httpHosts.includes(handle)) return null;
    if (isIP(handle)) return "an IP address is not a domain";
    try {
      const addrs = await lookup(handle, { all: true });
      for (const a of addrs) if (privateAddr(a.address)) return `${handle} resolves to a private address`;
      return addrs.length ? null : `${handle} does not resolve`;
    } catch (e) {
      return `${handle} does not resolve (${(e as { code?: string }).code ?? "error"})`;
    }
  }

  private async fetchDomain(handle: string, url: string): Promise<{ proofs: LinkProof[] } | { status: "stale" | "broken"; detail: string }> {
    const why = await this.publicHost(handle);
    if (why) return { status: "stale", detail: why };
    const r = await this.get(url, { accept: "application/json" });
    if ("error" in r) return { status: "stale", detail: `${handle} did not answer: ${r.error}` };
    if (r.status === 404 || r.status === 410) return { status: "broken", detail: `${url} answered HTTP ${r.status}` };
    if (r.status !== 200) return { status: "stale", detail: `${url} answered HTTP ${r.status}` };
    return { proofs: extractProofs(r.text) };
  }

  private async check(agent: string, service: LinkService, handle: string, proofUrl: string, want?: { statement: string; sig: string }): Promise<CheckResult & { proof?: LinkProof }> {
    if (service === "github-genesis") return this.checkGenesis(agent, handle, want);
    const got = service === "github" ? await this.fetchGithub(handle, proofUrl) : await this.fetchDomain(handle, proofUrl);
    if (!("proofs" in got)) return { ok: false, ...got };
    return this.matchProof(agent, service, handle, got.proofs, want);
  }

  /** The genesis proof in <login>/<login>: shape, agent, login, signature at issued_at, identity record. */
  private async checkGenesis(agent: string, login: string, want?: { statement: string; sig: string }): Promise<CheckResult & { proof?: LinkProof; file?: string }> {
    // the proof file under its units name, else its pre-rebrand name (REBRAND-UNITS.md 3.9)
    let r: { status: number; text: string } | { error: string } = { error: "not fetched" };
    let fileName: string = GENESIS_FILES[0];
    for (const name of GENESIS_FILES) {
      fileName = name;
      r = await this.get(`${this.opts.githubRaw}/${login}/${login}/HEAD/${name}`);
      if ("error" in r || r.status !== 404) break;
    }
    if ("error" in r) return { ok: false, status: "stale", detail: `GitHub did not answer: ${r.error}` };
    if (r.status === 404) return { ok: false, status: "broken", detail: `no ${GENESIS_FILES.join(" or ")} in ${login}/${login}` };
    if (r.status !== 200) return { ok: false, status: "stale", detail: `GitHub answered HTTP ${r.status}` };
    let file: GenesisFile;
    try {
      file = JSON.parse(r.text);
    } catch {
      return { ok: false, status: "broken", detail: `${fileName} is not JSON` };
    }
    const issued = typeof file?.issued_at === "number" ? file.issued_at : 0;
    if (issued > this.c.now() / 1000 + 300) return { ok: false, status: "broken", detail: "issued_at is in the future" };
    const key = this.c.identity.keyAt(agent, issued * 1000);
    const v = verifyGenesis(file, { agent, login, key: key ?? null });
    if (!v.ok) return { ok: false, status: "broken", detail: v.reason };
    const { sig, ...statement } = v.file;
    if (want && (canonicalJson(statement) !== want.statement || sig !== want.sig)) {
      // a newer proof replaces the recorded one only through POST /genesis (which re-verifies it)
      return { ok: false, status: "broken", detail: "the repository now holds a different proof than the one Core verified" };
    }
    if (this.opts.identityApi) {
      const id = await this.get(`${this.opts.identityApi}/identity/agents/${agent}`, { accept: "application/json" });
      if ("error" in id || id.status !== 200) return { ok: false, status: "stale", detail: "the identity service did not answer" };
      let rec: { login?: string | null };
      try {
        rec = JSON.parse(id.text);
      } catch {
        return { ok: false, status: "stale", detail: "the identity service answered with something other than JSON" };
      }
      if ((rec.login ?? "").toLowerCase() !== login) return { ok: false, status: "broken", detail: rec.login ? `the identity service names ${rec.login.toLowerCase()} for this agent` : "the identity service has no account for this agent" };
    }
    return { ok: true, proof: { statement: statement as unknown as LinkStatement, sig: sig! }, file: fileName };
  }

  // ---------------------------------------------------------------------------------------------
  // endpoints

  /** POST /v1/agents/:id/genesis `{ login }`: Core fetches and verifies the genesis proof, then stores it as a link. */
  async addGenesis(agent: string, body: unknown) {
    this.ensure();
    if (!this.known(agent)) throw notFound("agent");
    const login = typeof (body as { login?: unknown })?.login === "string" ? (body as { login: string }).login.trim().toLowerCase() : "";
    if (!GITHUB_LOGIN.test(login)) throw bad("bad_handle", "login: a GitHub login");
    const prev = this.c.db.query<LinkRow, [string, string]>("SELECT * FROM links WHERE agent_id = ? AND service = 'github-genesis' AND handle = ?").get(agent, login);
    // a burst of calls for a proof that just verified costs one fetch (a re-publish comes seconds later at the earliest)
    if (prev && prev.status === "verified" && this.c.now() - prev.checked_at < 5_000) return this.view(prev);
    const res = await this.checkGenesis(agent, login);
    const now = this.c.now();
    if (!res.ok) {
      if (prev) this.c.db.query("UPDATE links SET status = ?, checked_at = ?, detail = ?, fails = fails + 1 WHERE agent_id = ? AND service = 'github-genesis' AND handle = ?").run(res.status, now, res.detail, agent, login);
      throw new ApiError(res.status === "stale" ? 502 : 400, res.status === "stale" ? "proof_unreachable" : "proof_invalid", res.detail);
    }
    const url = `https://github.com/${login}/${login}/blob/HEAD/${res.file ?? GENESIS_FILES[1]}`;
    return this.c.tx(() => {
      this.c.db
        .query(
          `INSERT INTO links (agent_id, service, handle, proof_url, statement, sig, status, added_at, checked_at, verified_at, detail, fails)
           VALUES (?, 'github-genesis', ?, ?, ?, ?, 'verified', ?, ?, ?, NULL, 0)
           ON CONFLICT(agent_id, service, handle) DO UPDATE SET proof_url = excluded.proof_url, statement = excluded.statement, sig = excluded.sig,
             status = 'verified', checked_at = excluded.checked_at, verified_at = excluded.verified_at, detail = NULL, fails = 0`,
        )
        .run(agent, login, url, canonicalJson(res.proof!.statement), res.proof!.sig, now, now, now);
      this.c.emitEvent("link.verified", { agent, service: "github-genesis", handle: login });
      return this.row(agent, "github-genesis", login)!;
    });
  }

  /** GET /v1/agents/:id/genesis: the agent's newest genesis proof row (any status but revoked). */
  genesisOf(agent: string) {
    this.ensure();
    const r = this.c.db.query<LinkRow, [string]>("SELECT * FROM links WHERE agent_id = ? AND service = 'github-genesis' AND status != 'revoked' ORDER BY added_at DESC LIMIT 1").get(agent);
    if (!r) throw notFound("genesis proof");
    return this.view(r);
  }

  /** POST /v1/agents/:id/links (agent-signed): `{ service, handle, proof_url? }`. Core verifies before storing. */
  async add(caller: string | null, agent: string, body: unknown) {
    this.ensure();
    if (caller !== agent) throw forbidden("not_agent", "only the agent itself adds its links");
    if (!this.known(agent)) throw notFound("agent");
    const b = (body ?? {}) as { service?: unknown; handle?: unknown; proof_url?: unknown };
    const { service, handle } = this.normHandle(b.service, b.handle);
    const url = this.proofUrlFor(service, handle, b.proof_url);
    const res = await this.check(agent, service, handle, url);
    if (!res.ok) throw new ApiError(res.status === "stale" ? 502 : 400, res.status === "stale" ? "proof_unreachable" : "proof_invalid", res.detail);
    const now = this.c.now();
    const stmt = canonicalJson(res.proof!.statement);
    return this.c.tx(() => {
      this.c.db
        .query(
          `INSERT INTO links (agent_id, service, handle, proof_url, statement, sig, status, added_at, checked_at, verified_at, detail, fails)
           VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, NULL, 0)
           ON CONFLICT(agent_id, service, handle) DO UPDATE SET proof_url = excluded.proof_url, statement = excluded.statement, sig = excluded.sig,
             status = 'verified', added_at = excluded.added_at, checked_at = excluded.checked_at, verified_at = excluded.verified_at, detail = NULL, fails = 0`,
        )
        .run(agent, service, handle, url, stmt, res.proof!.sig, now, now, now);
      this.c.emitEvent("link.verified", { agent, service, handle });
      return this.row(agent, service, handle)!;
    });
  }

  /** DELETE /v1/agents/:id/links/:service[/:handle] (agent-signed): marks the link revoked. */
  revoke(caller: string | null, agent: string, service: string, handle?: string) {
    this.ensure();
    if (caller !== agent) throw forbidden("not_agent", "only the agent itself removes its links");
    const rows = this.c.db
      .query<LinkRow, [string, string]>("SELECT * FROM links WHERE agent_id = ? AND service = ? AND status != 'revoked'")
      .all(agent, service)
      .filter((r) => handle === undefined || r.handle === handle.toLowerCase());
    if (!rows.length) throw notFound("link");
    const now = this.c.now();
    for (const r of rows) {
      this.c.db.query("UPDATE links SET status = 'revoked', checked_at = ?, detail = 'removed by the agent' WHERE agent_id = ? AND service = ? AND handle = ?").run(now, agent, r.service, r.handle);
      this.c.emitEvent("link.revoked", { agent, service: r.service, handle: r.handle });
    }
    return { revoked: rows.map((r) => ({ service: r.service, handle: r.handle })) };
  }

  private row(agent: string, service: string, handle: string): ReturnType<Links["view"]> | null {
    const r = this.c.db.query<LinkRow, [string, string, string]>("SELECT * FROM links WHERE agent_id = ? AND service = ? AND handle = ?").get(agent, service, handle);
    return r ? this.view(r) : null;
  }

  view(r: LinkRow) {
    const statement = JSON.parse(r.statement) as LinkStatement;
    return {
      agent: r.agent_id,
      service: r.service,
      handle: r.handle,
      url: r.service === "github" ? `https://github.com/${r.handle}` : r.service === "github-genesis" ? `https://github.com/${r.handle}/${r.handle}` : new URL(r.proof_url).origin,
      proof_url: r.proof_url,
      status: r.status,
      added_at: r.added_at,
      checked_at: r.checked_at,
      verified_at: r.verified_at,
      detail: r.detail,
      statement,
      sig: r.sig,
    };
  }

  /** GET /v1/agents/:id/links: every link of an agent (revoked ones included, as history). */
  list(agent: string) {
    this.ensure();
    if (!this.known(agent)) throw notFound("agent");
    return this.c.db.query<LinkRow, [string]>("SELECT * FROM links WHERE agent_id = ? ORDER BY service, handle").all(agent).map((r) => this.view(r));
  }

  /** GET /v1/links: all current (not revoked) links, for the agents page. */
  all(status?: string) {
    this.ensure();
    const rows = status
      ? this.c.db.query<LinkRow, [string]>("SELECT * FROM links WHERE status = ? ORDER BY checked_at DESC LIMIT 1000").all(status)
      : this.c.db.query<LinkRow, []>("SELECT * FROM links WHERE status != 'revoked' ORDER BY checked_at DESC LIMIT 1000").all();
    return { recheck_s: this.opts.recheckS, links: rows.map((r) => this.view(r)) };
  }

  /** Verified links of an agent (for the card and the registration file). */
  verified(agent: string) {
    this.ensure();
    return this.c.db.query<LinkRow, [string]>("SELECT * FROM links WHERE agent_id = ? AND status = 'verified' ORDER BY service, handle").all(agent).map((r) => this.view(r));
  }

  // ---------------------------------------------------------------------------------------------
  // recheck

  private async recheckRow(r: LinkRow) {
    const res = await this.check(r.agent_id, r.service, r.handle, r.proof_url, { statement: r.statement, sig: r.sig });
    const now = this.c.now();
    return this.c.tx(() => {
      // the agent may have revoked or replaced the link while the fetch ran
      const cur = this.c.db.query<LinkRow, [string, string, string]>("SELECT * FROM links WHERE agent_id = ? AND service = ? AND handle = ?").get(r.agent_id, r.service, r.handle);
      if (!cur || cur.status === "revoked" || cur.statement !== r.statement || cur.sig !== r.sig) return { agent: r.agent_id, service: r.service, handle: r.handle, status: cur?.status ?? "gone", skipped: true };
      if (res.ok) {
        this.c.db.query("UPDATE links SET status = 'verified', checked_at = ?, verified_at = ?, detail = NULL, fails = 0 WHERE agent_id = ? AND service = ? AND handle = ?").run(now, now, r.agent_id, r.service, r.handle);
        if (cur.status !== "verified") this.c.emitEvent("link.verified", { agent: r.agent_id, service: r.service, handle: r.handle });
      } else {
        this.c.db.query("UPDATE links SET status = ?, checked_at = ?, detail = ?, fails = fails + 1 WHERE agent_id = ? AND service = ? AND handle = ?").run(res.status, now, res.detail, r.agent_id, r.service, r.handle);
        if (cur.status !== res.status) this.c.emitEvent(`link.${res.status}`, { agent: r.agent_id, service: r.service, handle: r.handle, detail: res.detail });
      }
      return { agent: r.agent_id, service: r.service, handle: r.handle, status: res.ok ? "verified" : res.status, detail: res.ok ? null : res.detail };
    });
  }

  private due(limit: number, agent?: string, force = false): LinkRow[] {
    const cutoff = force ? Number.MAX_SAFE_INTEGER : this.c.now() - this.opts.recheckS * 1000;
    return agent
      ? this.c.db.query<LinkRow, [string, number, number]>("SELECT * FROM links WHERE agent_id = ? AND status != 'revoked' AND checked_at <= ? ORDER BY checked_at LIMIT ?").all(agent, cutoff, limit)
      : this.c.db.query<LinkRow, [number, number]>("SELECT * FROM links WHERE status != 'revoked' AND checked_at <= ? ORDER BY checked_at LIMIT ?").all(cutoff, limit);
  }

  /** POST /v1/admin/links/recheck `{ agent?, force? }`: rechecks due (or, with force, all) links now and waits. */
  async recheck(body: unknown) {
    this.ensure();
    const b = (body ?? {}) as { agent?: unknown; force?: unknown };
    const rows = this.due(200, typeof b.agent === "string" ? b.agent : undefined, b.force === true);
    const results = [];
    for (const r of rows) results.push(await this.recheckRow(r));
    return { checked: results.length, results };
  }

  /** Called from Core.tick(): starts at most `perTick` due rechecks in the background, one batch at a time. */
  tick() {
    this.ensure();
    if (this.inflight > 0) return;
    const rows = this.due(this.opts.perTick);
    if (!rows.length) return;
    this.inflight = rows.length;
    for (const r of rows)
      void this.recheckRow(r)
        .catch((e) => console.error("links: recheck failed", e))
        .finally(() => this.inflight--);
  }

  /** Resolves once background rechecks started by tick() have finished (tests). */
  async idle() {
    while (this.inflight > 0) await Bun.sleep(5);
  }
}

function privateAddr(a: string): boolean {
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
  }
  const l = a.toLowerCase();
  if (l.startsWith("::ffff:")) return privateAddr(l.slice(7));
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
}

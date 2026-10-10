// GitHub genesis proof and living README (docs/plans/GITHUB-GENESIS.md). After an agent's account is
// ready, the identity service publishes the profile repository <login>/<login> with a factual README
// and lineage-proof.json signed by the agent's registry signing key (one signed, Verified commit), asks
// Core to record the proof, and afterwards keeps the README's status section in step with the agent's
// final verdicts. Nothing sealed is ever read into the README: the status facts come only from the
// stats row, accepted generations and session states/start times (SPEC 10.7, 17.3).

import { createHash } from "node:crypto";
import type { AgentKey } from "../../protocol/src/index.ts";
import { explorerUrl } from "../../chain/src/profile.ts";
import type { Fetch } from "../../souls/src/github/api.ts";
import { lineageTrailers } from "../../souls/src/github/commit.ts";
import { profileRepoCommit, type ProfileCommitResult } from "../../souls/src/github/profile-repo.ts";
import { EncryptedCredentialStore } from "./creds.ts";
import { GENESIS_FILE, GENESIS_KIND, genesisFileText, genesisShapeError, signGenesis, verifyGenesis, type GenesisFile, type UnsignedGenesis } from "./genesis-proof.ts";
import type { PublishedRecord } from "./records.ts";
import { errText, type Log } from "./redact.ts";
import type { IdentityService } from "./service.ts";

export const MARK_GENESIS = "<!-- lineage:genesis v1 -->";
export const MARK_START = "<!-- lineage:status:start -->";
export const MARK_END = "<!-- lineage:status:end -->";
/** At most one README commit per agent in this window (owner rule). */
export const README_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** How often the serve loop reads Core for one agent's status. */
export const README_POLL_MS = 60 * 1000;

// ------------------------------------------------------------------------------------------------
// facts

/** What the README says about the agent (public facts, read once per render). */
export interface GenesisFacts {
  agent: string;
  name: string;
  tagline: string | null;
  repo: string | null;
  mint: string | null;
  symbol: string | null;
  launch_tx: string | null;
  model: string | null;
  soul_digest: string | null;
  network: string;
  explorer_cluster: string | null;
  site: string | null;
  hidden: boolean;
}

/** The status section's inputs. Only final, public data: see statusFacts. */
export interface StatusFacts {
  state: "working" | "idle" | "new";
  repo: string | null;
  /** start of the live/sealed session (working) or end of the newest session (idle), ms */
  at: number | null;
  session_id: string | null;
  last: { gen_id: string; metric: string | null; ratio: number | null; kind: string | null; height: number | null; at: number; commit_url: string | null; verified: boolean | null } | null;
  accepted: number | null;
  rejected: number | null;
  final: number | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 300) => (typeof v === "string" && v.length && v.length <= max ? v : null);

/**
 * Builds the status facts from Core's public profile and session list and the mirror's published
 * records. It reads exactly these fields and nothing else: stats.{accepted, rejected, final}; timeline
 * items of kind "generation" (accepted, final work): id, at, generation.{height, kind, effect.metric,
 * effect.ratio}; sessions: session_id, state, repo, started_at, ended_at. A sealed candidate's target,
 * diff, notes, events or journal text never enter it.
 */
export function statusFacts(profile: any, sessions: any[] | null, published: PublishedRecord[]): StatusFacts {
  const s = profile?.stats ?? null;
  const gens = (Array.isArray(profile?.timeline) ? profile.timeline : []).filter((i: any) => i && i.kind === "generation" && typeof i.id === "string" && num(i.at) !== null);
  gens.sort((a: any, b: any) => b.at - a.at);
  const g = gens[0];
  let last: StatusFacts["last"] = null;
  if (g) {
    const pub = published.find((p) => p.gen_id === g.id && p.html_url);
    const eff = g.generation?.effect ?? null;
    last = {
      gen_id: g.id, metric: str(eff?.metric, 80), ratio: num(eff?.ratio), kind: str(g.generation?.kind, 20), height: num(g.generation?.height), at: g.at,
      commit_url: pub?.html_url ?? null, verified: pub ? pub.verified : null,
    };
  }
  const ss = (Array.isArray(sessions) ? sessions : []).filter((x) => x && typeof x.session_id === "string").map((x) => ({
    id: x.session_id as string, state: str(x.state, 20), repo: str(x.repo), started: num(x.started_at), ended: num(x.ended_at),
  }));
  ss.sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  const active = ss.find((x) => x.state === "live" || x.state === "sealed");
  const newest = ss[0];
  return {
    state: active ? "working" : newest ? "idle" : "new",
    repo: active?.repo ?? newest?.repo ?? str(profile?.target_repo),
    at: active ? active.started : newest ? (newest.ended ?? newest.started) : null,
    session_id: (active ?? newest)?.id ?? null,
    last,
    accepted: num(s?.accepted), rejected: num(s?.rejected), final: num(s?.final),
  };
}

// ------------------------------------------------------------------------------------------------
// rendering (no em dashes; every figure copied from Core)

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const repoName = (u: string | null) => (u ? u.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "") : null);
const siteBase = (s: string | null) => (s ? s.replace(/\/+$/, "") : null);

export function renderStatus(f: GenesisFacts, st: StatusFacts): string {
  const site = siteBase(f.site);
  const repo = repoName(st.repo ?? f.repo);
  const lines: string[] = [];
  if (st.state === "working") lines.push(`- Status: working on ${repo ?? "its target repository"}${st.at ? ` (session started ${day(st.at)})` : ""}`);
  else if (st.state === "idle") lines.push(`- Status: idle${st.at ? `, last session ${day(st.at)}` : ""}`);
  else lines.push("- Status: launched, no session yet");
  if (st.last) {
    const what = [st.last.metric ?? st.last.kind, st.last.ratio !== null ? `ratio ${st.last.ratio.toFixed(4)} (new / old, as replayed)` : null].filter(Boolean).join(", ");
    const genUrl = site ? `${site}/generations/${st.last.gen_id}` : null;
    const link = st.last.commit_url ? `[${st.last.verified ? "Verified commit" : "commit"}](${st.last.commit_url})` : genUrl ? `[generation](${genUrl})` : null;
    lines.push(`- Last verified improvement: ${what || "accepted"}${st.last.height !== null ? `, generation ${st.last.height}` : ""}, ${day(st.last.at)}${link ? `, ${link}` : ""}`);
  } else lines.push("- Last verified improvement: none yet");
  if (st.accepted !== null || st.final !== null) lines.push(`- Final verdicts: ${st.final ?? 0} (${st.accepted ?? 0} accepted, ${st.rejected ?? 0} rejected)`);
  return lines.join("\n");
}

export function renderReadme(f: GenesisFacts, st: StatusFacts, o: { noToken: boolean; signed: boolean; login: string }): string {
  const site = siteBase(f.site);
  const repo = repoName(f.repo);
  const prof = site ? `${site}/agents/${f.agent}/profile` : null;
  const tokenPage = site && f.mint ? `${site}/tokens/${f.mint}` : null;
  const session = site && st.session_id ? `${site}/sessions/${st.session_id}` : null;
  const net = f.network === "mainnet" ? "" : ` (${f.network})`;
  const out: string[] = [MARK_GENESIS, `# ${f.name}`, ""];
  if (f.tagline) out.push(f.tagline, "");
  out.push(`${f.name} is an autonomous agent on Lineage${net}. It improves ${repo ? `[${repo}](${f.repo})` : "its target repository"}; every change is replayed by independent verifiers before it counts.`, "");
  if (f.repo) out.push(`- Target repository: [${repo}](${f.repo})`);
  if (!o.noToken && f.mint) out.push(`- Token: ${f.symbol ? `${f.symbol}, mint ` : "mint "}\`${f.mint}\` ([explorer](${explorerUrl({ explorer_cluster: f.explorer_cluster }, "address", f.mint)}))`);
  out.push(`- Model: ${f.model ?? "TBA"}`);
  if (prof) out.push(`- Lineage profile: ${prof}`);
  if (!o.noToken && tokenPage) out.push(`- Token page: ${tokenPage}`);
  if (session) out.push(`- ${st.state === "working" ? "Live session" : "Latest session"}: ${session}`);
  out.push("", "## Status", "", MARK_START, renderStatus(f, st), MARK_END, "", "## Proof", "");
  out.push(
    o.signed
      ? `\`${GENESIS_FILE}\` in this repository is signed by this agent's registry signing key (ed25519, purpose \`github-genesis\`). It names the agent, its GitHub login and target repository, and when it was issued.`
      : `\`${GENESIS_FILE}\` in this repository names the agent, its GitHub login and target repository. Its signature is pending: the agent's signing key was not available when it was written.`,
    "",
    "To verify it offline:",
    "",
    `1. Take every field of the file except \`sig\` and encode it as canonical JSON (keys sorted, no spaces).`,
    `2. Hash \`lineage-github-genesis-v1\` and that JSON with the Lineage statement digest (\`statementDigest\` in packages/protocol).`,
    "3. Check `sig` as an ed25519 signature by `signer` over that digest.",
    "4. Check that `signer` was the agent's signing key at `issued_at` (the agent's key history on Lineage, or its registry record on chain).",
    "",
    `Or, from a checkout of the Lineage repository: \`bun scripts/identity/verify-genesis.ts https://github.com/${o.login}/${o.login} --core ${site ?? "<site>"}\`.`,
    "",
  );
  return out.join("\n");
}

/** The README section between the markers, for a quick look (tests, logs). */
export function statusBlock(readme: string): string | null {
  const a = readme.indexOf(MARK_START);
  const b = readme.indexOf(MARK_END);
  return a >= 0 && b > a ? readme.slice(a + MARK_START.length, b).trim() : null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------------------------------------
// sources (HTTP on the site; mocks in tests)

export interface GenesisSources {
  /** GET Core /v1/agents/:id/profile */
  profile(agent: string): Promise<any | null>;
  /** GET Core /v1/sessions?agent= (newest first) */
  sessions(agent: string): Promise<any[] | null>;
  /** GET Core /v1/hidden */
  hidden(): Promise<{ mint: string | null; agent: string | null }[]>;
  /** GET indexer /market/tokens/:mint */
  token(mint: string): Promise<any | null>;
  /** asks the key holder (the hosted runtime) to sign; null when it holds no key for the agent */
  sign(agent: string, st: UnsignedGenesis): Promise<GenesisFile | null>;
  /** POST Core /v1/agents/:id/genesis { login } */
  record(agent: string, login: string): Promise<{ status: string; detail: string | null }>;
}

export function httpSources(o: { core: string; indexer?: string | null; runtime?: string | null; fetch?: Fetch; log?: Log }): GenesisSources {
  const f = o.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const log = o.log ?? (() => {});
  const get = async (url: string) => {
    const r = await f(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${new URL(url).pathname} answered ${r.status}`);
    return r.json();
  };
  const core = o.core.replace(/\/+$/, "");
  return {
    profile: (a) => get(`${core}/v1/agents/${a}/profile`),
    sessions: async (a) => ((await get(`${core}/v1/sessions?agent=${a}&limit=10`)) as any[] | null),
    hidden: async () => ((await get(`${core}/v1/hidden`)) as any)?.hidden ?? [],
    token: async (m) => (o.indexer ? get(`${o.indexer.replace(/\/+$/, "")}/market/tokens/${m}`).catch((e) => (log(`genesis: indexer: ${errText(e)}`), null)) : null),
    sign: async (a, st) => {
      if (!o.runtime) return null;
      try {
        const r = await f(`${o.runtime.replace(/\/+$/, "")}/runtime/genesis/${a}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ statement: st }), signal: AbortSignal.timeout(15_000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`runtime answered ${r.status}`);
        return (await r.json()) as GenesisFile;
      } catch (e) {
        log(`genesis: runtime signer for ${a}: ${errText(e)}`);
        return null;
      }
    },
    record: async (a, login) => {
      try {
        const r = await f(`${core}/v1/agents/${a}/genesis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login }), signal: AbortSignal.timeout(30_000) });
        const j: any = await r.json().catch(() => null);
        if (!r.ok) return { status: "refused", detail: String(j?.message ?? j?.error ?? `Core answered ${r.status}`).slice(0, 300) };
        return { status: String(j?.status ?? "verified"), detail: j?.detail ?? null };
      } catch (e) {
        return { status: "unreachable", detail: errText(e, 200) };
      }
    },
  };
}

// ------------------------------------------------------------------------------------------------
// records

export interface GenesisRecord {
  v: 1;
  agent: string;
  login: string | null;
  repo: string | null;
  status: "published" | "failed" | "skipped";
  reason: string | null;
  opts: { no_token: boolean; explicit: boolean };
  /** README.md kept (the launcher's own profile README): ours goes to LINEAGE.md */
  readme_path: "README.md" | "LINEAGE.md";
  proof: { text: string; issued_at: number; signed: boolean } | null;
  commit: { sha: string; verified: boolean | null; reason: string; html_url: string } | null;
  readme: { hash: string; status_hash: string; at: number; sha: string; verified: boolean | null } | null;
  core: { status: string; detail: string | null; at: number } | null;
  updated_at: string;
}

export interface GenesisPublic {
  status: GenesisRecord["status"];
  reason: string | null;
  repo_url: string | null;
  proof_url: string | null;
  signed: boolean;
  commit_url: string | null;
  verified: boolean | null;
  readme_updated_at: string | null;
  core_status: string | null;
}

export function genesisPublic(r: GenesisRecord | null): GenesisPublic | null {
  if (!r) return null;
  return {
    status: r.status, reason: r.reason, repo_url: r.repo ? `https://github.com/${r.repo}` : null,
    proof_url: r.repo && r.status === "published" ? `https://github.com/${r.repo}/blob/HEAD/${GENESIS_FILE}` : null,
    signed: !!r.proof?.signed, commit_url: r.commit?.html_url ?? null, verified: r.commit?.verified ?? null,
    readme_updated_at: r.readme ? new Date(r.readme.at).toISOString() : null, core_status: r.core?.status ?? null,
  };
}

// ------------------------------------------------------------------------------------------------
// runner

export interface GenesisOptions {
  svc: IdentityService;
  sources: GenesisSources;
  network: { name: string; explorer_cluster: string | null };
  site: string | null;
  apiBase?: string;
  gitBase?: string;
  fetch?: Fetch;
  log?: Log;
  now?: () => Date;
  verifyPolls?: number;
}

export class GenesisRunner {
  private readonly creds: EncryptedCredentialStore;
  private readonly busy = new Set<string>();
  private readonly polled = new Map<string, number>();
  private readonly log: Log;
  private readonly now: () => Date;
  constructor(readonly o: GenesisOptions) {
    // its own materialised-key directory, so the service's cleanup never pulls a key from under git
    this.creds = new EncryptedCredentialStore(o.svc.o.store, `${o.svc.creds.runDir}/genesis`);
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  private get store() {
    return this.o.svc.o.store;
  }

  record(agent: string): GenesisRecord | null {
    return this.store.get<GenesisRecord>("genesis", agent);
  }

  private save(r: GenesisRecord) {
    r.updated_at = this.now().toISOString();
    this.store.put("genesis", r.agent, r);
  }

  /** Every agent with a genesis record (for the README loop). */
  agents(): string[] {
    return this.store.list("genesis");
  }

  private async facts(agent: string, mint: string | null, repo: string | null): Promise<{ facts: GenesisFacts; profile: any | null; sessions: any[] | null }> {
    const [profile, sessions] = await Promise.all([this.o.sources.profile(agent), this.o.sources.sessions(agent).catch(() => null)]);
    const m = str(profile?.mint, 44) ?? mint;
    const tok = m ? await this.o.sources.token(m).catch(() => null) : null;
    const launch = Array.isArray(tok?.events) ? tok.events.find((e: any) => e?.kind === "launch" && typeof e.signature === "string") : null;
    const soul = profile?.soul ?? null;
    let hidden = !!profile?.hidden;
    if (!hidden) {
      const list = await this.o.sources.hidden().catch(() => []);
      hidden = list.some((h) => h.agent === agent || (!!m && h.mint === m));
    }
    return {
      profile, sessions,
      facts: {
        agent, name: str(soul?.name, 120) ?? `Lineage agent ${agent.slice(0, 8)}`, tagline: str(soul?.tagline, 400),
        repo: str(profile?.target_repo) ?? repo, mint: m, symbol: str(tok?.symbol, 20), launch_tx: launch?.signature ?? null,
        model: str(profile?.soul?.model?.id ?? profile?.model, 80), soul_digest: str(soul?.digest, 64), network: this.o.network.name,
        explorer_cluster: this.o.network.explorer_cluster, site: this.o.site, hidden,
      },
    };
  }

  private published(agent: string): PublishedRecord[] {
    return this.store.get<PublishedRecord[]>("published", agent) ?? [];
  }

  /**
   * Publishes (or re-publishes) the genesis repository. `explicit`: an operator run (also for hidden
   * test launches); `noToken`: README without token lines (kept for later updates); `key`: sign with
   * this key instead of asking the runtime; `force`: issue a new proof even if the facts are unchanged.
   */
  async run(agent: string, o: { explicit?: boolean; noToken?: boolean; force?: boolean; key?: AgentKey } = {}): Promise<GenesisRecord> {
    if (this.busy.has(agent)) throw new Error(`genesis for ${agent} is already running`);
    this.busy.add(agent);
    const prev = this.record(agent);
    const rec: GenesisRecord = prev ?? {
      v: 1, agent, login: null, repo: null, status: "failed", reason: null, opts: { no_token: false, explicit: false }, readme_path: "README.md",
      proof: null, commit: null, readme: null, core: null, updated_at: "",
    };
    if (o.noToken !== undefined) rec.opts.no_token = o.noToken;
    if (o.explicit) rec.opts.explicit = true;
    try {
      const s = this.o.svc.state(agent);
      const cred = this.creds.get(agent);
      if (!s || s.status !== "ready" || !cred) {
        rec.status = "failed";
        rec.reason = "the agent has no ready GitHub account";
        this.save(rec);
        return rec;
      }
      const login = cred.login.toLowerCase();
      const { facts, profile, sessions } = await this.facts(agent, s.mint, s.repo);
      if (facts.hidden && !rec.opts.explicit) {
        rec.status = "skipped";
        rec.reason = "hidden test launch; only an explicit run publishes a genesis repository";
        rec.login = login;
        this.save(rec);
        this.log(`genesis: ${agent} skipped (hidden)`);
        return rec;
      }
      // the proof: reuse the last one while its facts hold, else ask the key holder to sign a new one
      const unsigned: UnsignedGenesis = {
        v: 1, kind: GENESIS_KIND, agent, mint: facts.mint, launch_tx: facts.launch_tx, soul_digest: facts.soul_digest, target_repo: facts.repo,
        github_login: login, network: facts.network, site: facts.site ? siteBase(facts.site) : null, issued_at: Math.floor(this.now().getTime() / 1000),
      };
      const shape = genesisShapeError(unsigned, { withSigner: false });
      if (shape) throw new Error(`genesis statement: ${shape}`);
      let file: GenesisFile | null = null;
      if (prev?.proof && !o.force && !o.key) {
        const old = JSON.parse(prev.proof.text) as GenesisFile;
        const same = (["mint", "launch_tx", "soul_digest", "target_repo", "github_login", "network", "site"] as const).every((k) => old[k] === unsigned[k]);
        if (same && (old.sig || !prev.proof.signed)) file = old;
      }
      if (!file || !file.sig) {
        const signed = o.key ? signGenesis(o.key, unsigned) : await this.o.sources.sign(agent, unsigned);
        if (signed) {
          const chk = verifyGenesis(signed, { agent, login });
          if (!chk.ok) throw new Error(`the signer returned a proof that does not verify: ${chk.reason}`);
          file = signed;
        } else if (!file) file = { ...unsigned, signer: null, sig: null };
      }
      const proofText = genesisFileText(file);
      const st = statusFacts(profile, sessions, this.published(agent));
      const readme = renderReadme(facts, st, { noToken: rec.opts.no_token, signed: !!file.sig, login });
      const res = await this.commit(agent, cred, s.mode === "token" ? "token" : "purchased", readme, proofText, `Lineage genesis: ${facts.name}`, rec);
      rec.login = login;
      rec.repo = res.repo;
      rec.status = "published";
      rec.reason = file.sig ? null : "published without a signature (the agent's key was not available); run genesis with --sign-key to sign";
      rec.proof = { text: proofText, issued_at: file.issued_at, signed: !!file.sig };
      rec.commit = { sha: res.sha, verified: res.verified, reason: res.reason, html_url: res.html_url };
      rec.readme = { hash: sha256(readme), status_hash: sha256(renderStatus(facts, st)), at: this.now().getTime(), sha: res.sha, verified: res.verified };
      this.save(rec);
      this.log(`genesis: ${agent} published ${res.repo}@${res.sha.slice(0, 12)} (${res.unchanged ? "unchanged" : res.verified ? "Verified" : `not verified: ${res.reason}`}${file.sig ? "" : ", unsigned proof"})`);
      if (file.sig) {
        const c = await this.o.sources.record(agent, login);
        rec.core = { ...c, at: this.now().getTime() };
        this.save(rec);
        this.log(`genesis: Core says ${c.status}${c.detail ? `: ${c.detail}` : ""}`);
      }
      return rec;
    } catch (e) {
      rec.status = prev?.status === "published" ? "published" : "failed";
      rec.reason = errText(e);
      this.save(rec);
      this.log(`genesis: ${agent} failed: ${rec.reason}`);
      return rec;
    } finally {
      this.creds.cleanup();
      this.busy.delete(agent);
    }
  }

  private async commit(agent: string, cred: NonNullable<ReturnType<EncryptedCredentialStore["get"]>>, mode: "token" | "purchased", readme: string, proofText: string, title: string, rec: GenesisRecord): Promise<ProfileCommitResult> {
    const site = siteBase(this.o.site);
    return profileRepoCommit({
      cred, replaceTree: mode === "purchased",
      plan: (s) => {
        // a launcher's own profile README (no genesis marker) is never overwritten (plan 2.5)
        const foreign = mode === "token" && s.readme !== null && !s.readme.includes(MARK_GENESIS);
        rec.readme_path = foreign ? "LINEAGE.md" : "README.md";
        return { [rec.readme_path]: readme, [GENESIS_FILE]: proofText };
      },
      message: `${title}\n\n${lineageTrailers({ agent })}\n`,
      description: "Lineage agent: genesis proof and status",
      homepage: site ? `${site}/agents/${agent}/profile` : undefined,
      apiBase: this.o.apiBase, gitBase: this.o.gitBase, fetch: this.o.fetch, log: (m) => this.log(m), verifyPolls: this.o.verifyPolls,
    });
  }

  /**
   * Refreshes one agent's README status. Reads Core at most every README_POLL_MS, commits only when the
   * rendered README changed and the last README commit is README_MIN_INTERVAL_MS old.
   */
  async refresh(agent: string, o: { force?: boolean } = {}): Promise<"committed" | "unchanged" | "rate_limited" | "skipped" | "failed"> {
    const rec = this.record(agent);
    if (!rec || rec.status !== "published" || !rec.proof || !rec.readme) return "skipped";
    const t = this.now().getTime();
    if (!o.force && t - (this.polled.get(agent) ?? 0) < README_POLL_MS) return "skipped";
    if (this.busy.has(agent)) return "skipped";
    this.polled.set(agent, t);
    this.busy.add(agent);
    try {
      const s = this.o.svc.state(agent);
      if (!s || s.status !== "ready") return "skipped";
      const { facts, profile, sessions } = await this.facts(agent, s.mint, s.repo);
      if (!profile) return "skipped";
      const st = statusFacts(profile, sessions, this.published(agent));
      const readme = renderReadme(facts, st, { noToken: rec.opts.no_token, signed: rec.proof.signed, login: rec.login ?? "" });
      const hash = sha256(readme);
      if (hash === rec.readme.hash) return "unchanged";
      if (t - rec.readme.at < README_MIN_INTERVAL_MS) return "rate_limited";
      const cred = this.creds.get(agent);
      if (!cred) return "skipped";
      const line = renderStatus(facts, st).split("\n")[0]!.replace(/^- /, "");
      const res = await this.commit(agent, cred, s.mode === "token" ? "token" : "purchased", readme, rec.proof.text, `Lineage status: ${line}`, rec);
      rec.readme = { hash, status_hash: sha256(renderStatus(facts, st)), at: t, sha: res.sha, verified: res.verified };
      this.save(rec);
      this.log(`genesis: ${agent} README ${res.unchanged ? "unchanged on GitHub" : `updated ${res.sha.slice(0, 12)} (${res.verified ? "Verified" : res.reason})`}`);
      return "committed";
    } catch (e) {
      this.log(`genesis: README of ${agent} not updated: ${errText(e)}`);
      return "failed";
    } finally {
      this.creds.cleanup();
      this.busy.delete(agent);
    }
  }

  /** One pass of the README loop over every published genesis repository. */
  async tick(): Promise<void> {
    for (const a of this.agents()) await this.refresh(a);
  }
}

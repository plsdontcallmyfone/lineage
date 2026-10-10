// The wallet bundle (devnet only), loaded on demand as /assets/wallet.js (bundled with packages/chain's
// browser build). Two pages since the app consolidation (docs/plans/APP-CONSOLIDATION.md):
//   Launch  (/launch, mountLaunch, launch.ts renders the steps): a six-step wizard in the Stags step
//           pattern that launches an agent token with this file's launch transaction code (prepay
//           planner, soul drafting, model registry, identity check, hosted bind)
//   Profile (/profile, mountProfile, profile.ts renders it): the connected wallet's balances and
//           faucet, its agents and their management (GitHub token rotate or revoke, images, trading
//           allocation, signing key), holdings, follows, claims and bounties (C6), and the
//           verifier registration kit
// and the token page's trade box (trade.ts). The connection is the site's one wallet session
// (standard.ts), owned by the header's Connect button. Every figure is read from chain (or from Core
// for proofs); nothing here holds a user's key: the wallet signs, and the fresh keys a launch needs
// are WebCrypto keys made in this page.
import "../../../packages/chain/src/browser/buffer.ts";
import {
  ata,
  base58Encode,
  base64Encode,
  canonicalJson,
  canonicalUrl,
  claimFromCoreProof,
  dbc,
  decodeAgent,
  decodeAgentLaunch,
  decodeDbcPool,
  decodeMint,
  decodeT22Metadata,
  decodeTokenAccount,
  DEVNET_GENESIS,
  explorerAddress,
  explorerTx,
  generateWebKey,
  H,
  IDENTITY_MODE,
  launch,
  launchPdas,
  METEORA,
  accountDisc,
  bounty,
  bountyPdas,
  BOUNTY_ROLES,
  COND,
  hashJson,
  releaseFromContribution,
  targetDigest,
  type BountyAccount,
  type BountyConfig,
  registry,
  registryPdas,
  REGISTRY_PROGRAM_ID,
  LAUNCH_PROGRAM_ID,
  repoId,
  token,
  TOKEN_2022_PROGRAM,
  addressBytes,
  type AgentLaunch,
  type AgentRecord,
  type LaunchConfig,
  type RegistryConfig,
  type Simulation,
  type WebKey,
  type DbcPoolView,
  type Ix,
  planLaunch,
  type LaunchPlan,
} from "../../../packages/chain/src/browser/index.ts";
import { checkSoul, soulDigest, soulSigningMessage, type SoulDoc, type SoulPersona } from "../../../packages/souls/src/doc.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { badge, banner, icon, kv, panel, stat } from "../src/ui.ts";
import { budgetIxs, buildAndSimulate, isMainnet, loadChainCfg, NET, netName, parseUnits, qsym, reader, rpc, signAndSend, sol, testLabels, units, devnetGate, type Built, type ChainCfg } from "./chain.ts";
import { connectWallet, onSession, walletChain, restoreSession, session, signsV0, startDiscovery, type StdAccount, type StdWallet } from "./standard.ts";
export { mountTradeBox } from "./trade.ts";
import { custodyHtml, ghClick, initGithubIdentity, showIdentity, submitLaunchToken } from "./identity.ts";
import { depositBase, depositNote, loadPrepay, P, prepayHelp, showCorePrepay, usdMode } from "./prepay.ts";
import { payAsset, prepareSwapThen, routeLines, sendSwapPlan, simulatePlan, type PreparedSwap } from "./swap.ts";
import { loadTradingEscrow, sendAllocation } from "./trading.ts";
import { entryOf, isDefaultChoice, loadModels, modelChoice, modelsBody, onModelInput, priceText, withModel } from "./models.ts";
import { launchSkeleton, profileSkeleton, stepNav, STEPS } from "./pages.ts";
import { feedItemHtml, uploadMedia } from "../src/pages/social-ui.ts";
import { agentAvatar, agentTitle, buildingLine, injectBuildingStyle, paramCells, type DirToken } from "../src/building.ts";
import { githubCallsLeft, spendGithubCall } from "../src/github.ts";

const T22 = TOKEN_2022_PROGRAM;
const W = "bun packages/worker/src/main.ts";

// ------------------------------------------------------------------------------------------------
// state

interface SigRow {
  at: number;
  label: string;
  signature: string;
  fee?: number;
  ok: boolean;
}
interface MintMeta {
  name: string;
  symbol: string;
  uri: string;
}
const S = {
  root: null as HTMLElement | null,
  page: null as null | "launch" | "profile",
  cfg: null as ChainCfg | null,
  gate: "checking" as "checking" | "ok" | string,
  wallet: null as StdWallet | null,
  account: null as StdAccount | null,
  walletErr: null as string | null,
  sol: null as bigint | null,
  line: null as bigint | null,
  faucet: null as any,
  faucetMsg: null as Raw | null,
  reg: null as RegistryConfig | null,
  lc: null as LaunchConfig | null,
  supply: null as bigint | null,
  launches: [] as AgentLaunch[],
  launchesErr: null as Raw | null,
  /** registry Agent records by agent id (owner, signing key) */
  records: new Map<string, AgentRecord>(),
  /** agent -> current registry owner (the launcher until an owner transfer); bounty powers follow it (audit A1-03) */
  owners: new Map<string, string>(),
  metas: new Map<string, MintMeta | null>(),
  pools: new Map<string, DbcPoolView | null>(),
  decimals: new Map<string, number>(),
  sigs: [] as SigRow[],
  // launch
  repo: null as null | { url: string; state: "checking" | "ok" | "bad"; msg: string; gh?: any; lineage?: any; core?: "ok" | "down"; recipes?: any[] },
  draft: null as null | { agent: WebKey; mint: WebKey; built: Built; args: any; ix: Ix; ixs: Ix[]; soul: SoulDoc | null; plan: LaunchPlan; builts: Built[]; deposit: bigint; swap?: { prepared: PreparedSwap; sim: Simulation; sig?: string } | null },
  launchOut: null as Raw | null,
  launched: null as null | { agent: WebKey; mint: string; sig: string; sigs?: string[]; deposit?: bigint; mode?: LaunchPlan["mode"] },
  // soul (SPEC 14.8): the agent key is made when the soul is drafted, so the soul names it
  soul: null as null | { agent: WebKey; doc: SoulDoc | null; note: Raw | null; edited: boolean; usd: number | null },
  soulPub: null as Raw | null,
  ghLaunch: null as Raw | null,
  busy: new Set<string>(),
  // wizard (launch): the step shown, the images picked, and the one-launch guard
  step: 0,
  image: null as File | null,
  bannerFile: null as File | null,
  /** set while a launch is between the wallet's signature and its confirmation: nothing is sent twice */
  sending: false,
  // profile: the agent whose management panel is open
  manage: null as string | null,
  // verifier
  vkey: "",
  vrec: undefined as AgentRecord | null | undefined,
  vOut: null as Raw | null,
  partial: null as null | { b64: string; until: number; agent: string },
  // identity (Agent v2: signing key, revocation, owner transfer)
  ikey: "",
  irec: undefined as AgentRecord | null | undefined,
  iOut: null as Raw | null,
  ipartial: null as null | { b64: string; until: number; agent: string; newKey: string },
  // claims
  claims: null as null | { rows: any[]; note: Raw | null },
  claimOut: null as Raw | null,
  // bounties (C6)
  bcfg: undefined as BountyConfig | null | undefined,
  bounties: null as null | (BountyAccount & { address: string })[],
  bErr: null as Raw | null,
  bOut: null as Raw | null,
  bRelease: new Map<string, { rows: any[]; note: Raw | null }>(),
};

const dec = () => S.cfg?.state?.line_decimals ?? 6;
const lineMint = () => S.cfg!.state!.line_mint;
const dbcConfig = () => S.lc?.dbcConfig ?? S.cfg!.state!.dbc_config;
const me = () => S.account?.address ?? null;
const tl = (base: bigint | null | undefined, min = 0) =>
  base === null || base === undefined ? html`<span class="faint">TBA</span>` : html`<span class="num">${units(base, dec(), min)}</span><span class="unit">${qsym()}</span>`;
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const addr = (a: string | null | undefined, label?: string) =>
  a ? html`<a class="link nowrap" href="${explorerAddress(a)}" target="_blank" rel="noopener" title="${a}">${label ?? short(a)}</a>` : html`<span class="faint">none</span>`;
const txLink = (sig: string, label?: string) => html`<a class="link nowrap" href="${explorerTx(sig)}" target="_blank" rel="noopener" title="${sig}">${label ?? short(sig)} ${icon.ext}</a>`;
const when = (s: bigint | number) => {
  const ms = Number(s) * 1000;
  if (!ms) return html`<span class="faint">none</span>`;
  const d = new Date(ms);
  return html`<span class="nowrap" title="${d.toISOString()}">${d.toISOString().replace("T", " ").slice(0, 19)} UTC</span>`;
};
const set = (id: string, r: Raw | string) => {
  const el = S.root?.querySelector<HTMLElement>(`#${id}`);
  if (el) el.innerHTML = typeof r === "string" ? r : r.s;
};
const val = (name: string) => (S.root?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "").trim();
const errBox = (e: unknown, logs?: string[]) =>
  html`<div class="banner bad" data-err>${icon.x}<div><div class="t1">${String((e as Error)?.message ?? e)}</div>${logs?.length ? html`<pre class="block wl-logs">${logs.slice(-12).join("\n")}</pre>` : ""}</div></div>`;
const btn = (action: string, label: string | Raw, opts: { disabled?: string | false; primary?: boolean; data?: Record<string, string> } = {}) =>
  html`<button type="button" class="wl-btn${opts.primary ? " primary" : ""}" data-act="${action}"${raw(Object.entries(opts.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join(""))}${opts.disabled ? raw(` disabled title="${esc(opts.disabled)}"`) : ""}>${label}</button>${opts.disabled ? html`<span class="wl-why">${opts.disabled}</span>` : ""}`;

function logSig(label: string, signature: string, fee: number | undefined, ok: boolean) {
  S.sigs.unshift({ at: Date.now(), label, signature, fee, ok });
  renderSigs();
}

// ------------------------------------------------------------------------------------------------
// gate, wallet, balances, network

function renderGate() {
  const c = S.cfg;
  const cl = S.root?.querySelector("#w-cluster");
  if (cl) cl.innerHTML = c ? (c.genesis === NET.p.genesis ? badge(netName(), "good", icon.check, `genesis ${c.genesis}`) : badge(c.cluster, "bad", icon.x)).s : "";
  if (S.gate === "checking") return set("w-gate", banner("info", "Checking the cluster…", `The RPC's genesis hash must be ${netName()}'s before anything is built.`));
  if (S.gate !== "ok") return set("w-gate", banner("bad", "Refusing to build transactions", html`${S.gate} This page is set to ${netName()} only.`));
  // mainnet (SPEC 14.10): no TEST wording; the quote token as configured, a stand-in until $LINE exists
  if (isMainnet())
    return set(
      "w-gate",
      banner(
        "info",
        html`Solana mainnet. Every transaction here is built for mainnet and nothing else.`,
        html`The RPC answers with mainnet's genesis hash (${NET.p.genesis.slice(0, 8)}…), checked again before every build. Amounts are in ${qsym()} ${addr(lineMint())}${NET.p.quote.status === "stand-in" ? ", a stand-in for $LINE (TBA)" : ""}.`,
      ),
    );
  set(
    "w-gate",
    banner(
      "warn",
      html`Devnet only. Every transaction here is built for Solana devnet and nothing else.`,
      html`The RPC answers with devnet's genesis hash (${DEVNET_GENESIS.slice(0, 8)}…), checked again before every build. Any other cluster is refused. ${qsym()} is the TEST mint ${addr(lineMint())} with a fixed supply and no value; agent tokens launched here are TEST tokens too.`,
    ),
  );
}

async function refreshBalances() {
  const a = me();
  if (!a || !S.cfg?.state) return;
  try {
    const [s, l] = await Promise.all([rpc.getBalance(a), reader.tokenBalance(ata(a, lineMint(), T22))]);
    S.sol = s;
    S.line = l ?? 0n;
  } catch (e) {
    S.walletErr = `balances: ${(e as Error).message}`;
  }
  S.faucet = NET.p.faucet ? await fetch(`/chain/faucet?wallet=${a}`).then((r) => r.json()).catch(() => null) : null;
  renderConn();
}

/** Profile header: the address, SOL and tLINE, and the faucet (devnet). */
function renderConn() {
  if (S.page !== "profile") return;
  if (!S.account) return;
  const f = S.faucet;
  const devnetOk = !S.account.chains?.length || S.account.chains.includes(walletChain());
  const next = f?.last && f?.per_wallet_hours ? f.last.at + f.per_wallet_hours * 3_600_000 : 0;
  const faucetBtn = !f?.enabled
    ? btn("faucet", `Get ${qsym()}`, { disabled: f?.reason ?? "faucet not funded" })
    : next > Date.now()
      ? btn("faucet", `Get ${qsym()}`, { disabled: `one drip per wallet every ${f.per_wallet_hours} h; next after ${new Date(next).toLocaleString()}` })
      : btn("faucet", html`Get ${units(BigInt(f.amount), dec())} ${qsym()}`, { primary: true });
  const h = S.root?.querySelector("#me-h");
  if (h) h.textContent = short(S.account.address);
  set(
    "w-conn",
    html`<div class="stats wl-bal" style="--n:3">
        ${stat("Address", html`<span title="${S.account.address}">${short(S.account.address)}</span> <button type="button" class="copy" data-copy="${S.account.address}" aria-label="Copy address">${icon.copy}</button>`, html`${S.wallet!.name}${devnetOk ? `, ${netName()}` : `, ${netName()} not offered`}`, "sm")}
        ${stat("SOL", S.sol === null ? "TBA" : sol(S.sol), `${netName()}, for fees and rent`, "sm")}
        ${stat(`${qsym()}`, S.line === null ? "TBA" : units(S.line, dec()), testLabels() ? "TEST mint, Token-2022" : NET.p.quote.status === "stand-in" ? "stand-in for $LINE" : "quote token", "sm")}
      </div>
      ${devnetOk ? "" : html`<div class="panel-b">${banner("bad", `This wallet account does not offer ${walletChain()}`, `Pick an account or wallet that supports ${netName()}. Nothing will be built for it.`)}</div>`}
      ${NET.p.faucet ? html`<div class="panel-b wl-row">
        ${faucetBtn}
        <a class="wl-btn" href="https://faucet.solana.com/?cluster=devnet" target="_blank" rel="noopener">Devnet SOL faucet ${icon.ext}</a>
        ${btn("refresh", "Refresh")}
      </div>
      <div class="panel-b wl-fine" style="padding-top:0">${qsym()} cannot be minted (its mint authority is revoked). The faucet is a devnet wallet of this server, ${f?.address ? addr(f.address) : "not set up"}, that transfers ${f?.amount ? units(BigInt(f.amount), dec()) : "TBA"} ${qsym()} from the existing TEST supply, at most once per wallet every ${f?.per_wallet_hours ?? "TBA"} h and ${f?.per_hour ?? "TBA"} drips an hour; every drip is logged. SOL comes from the public devnet faucet.</div>` : html`<div class="panel-b wl-row">${btn("refresh", "Refresh")}</div>`}
      ${S.faucetMsg ?? ""}${S.walletErr ? html`<div class="panel-b">${errBox(S.walletErr)}</div>` : ""}`,
  );
}

async function loadNetwork() {
  try {
    const [reg, lc, mint] = await Promise.all([reader.registryConfig(), reader.launchConfig(), reader.mint(lineMint())]);
    S.reg = reg;
    S.lc = lc;
    S.supply = mint?.supply ?? null;
  } catch (e) {
    set("w-net", html`<div class="panel-b">${errBox(e)}</div>`);
    return;
  }
  renderNet();
}

/** Funding step: the launch parameters exactly as the LaunchConfig on chain holds them (no fee figures, APP-CONSOLIDATION.md amendment 2026-10-10 (2)). */
function renderNet() {
  const l = S.lc;
  if (!l || !S.reg) return set("w-fees", html`${banner("bad", "Programs not initialized on this cluster", "The registry or launch config account does not exist.")}`);
  set(
    "w-fees",
    html`<div class="params wl-params">
      <div><span class="k">agent wakes at</span><span class="v">${tl(l.wakeThreshold)}</span></div>
      <div><span class="k">agent sleeps below</span><span class="v">${tl(l.sleepThreshold)}</span></div>
      <div><span class="k">graduates at</span><span class="v">${tl(l.migrationQuoteThreshold)}</span></div>
      <div><span class="k">launches paused</span><span class="v">${l.paused ? badge("paused", "bad") : badge("no", "good")}</span></div>
    </div>
    <div class="wl-fine" style="margin-top:6px">Read from the LaunchConfig ${addr(launchPdas.config())}.</div>`,
  );
}

// ------------------------------------------------------------------------------------------------
// launch (SPEC 13.7 to 13.9)

function custodyText(mode: string): Raw {
  return custodyHtml(mode);
}

const GH = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(\.git)?\/?$/;

async function checkRepo() {
  const raw0 = val("l_repo");
  if (!raw0) {
    S.repo = null;
    return renderRepo();
  }
  const m = GH.exec(raw0);
  if (!m) {
    S.repo = { url: raw0, state: "bad", msg: "Must be https://github.com/<owner>/<repo>." };
    return renderRepo();
  }
  const url = canonicalUrl(raw0);
  if (S.repo?.url === url && S.repo.state !== "bad") return;
  S.repo = { url, state: "checking", msg: "Checking GitHub…" };
  renderRepo();
  /** The recipes Core runs on this repository (active lineages, with what each measures); null when Core does not answer. */
  const coreRecipes = async (): Promise<{ lineage: any; recipes: any[] } | null> => {
    try {
      const ls = await fetch("/api/lineages").then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))));
      const mine = (ls as any[]).filter((l) => /^https:/.test(String(l.repo)) && canonicalUrl(String(l.repo)) === url && (l.status ?? "active") === "active");
      const recipes = (await Promise.all(mine.map((l) => fetch(`/api/lineages/${l.lineage_id}`).then((x) => (x.ok ? x.json() : null)).catch(() => null)))).filter(Boolean);
      return { lineage: mine[0] ?? null, recipes };
    } catch {
      return null;
    }
  };
  try {
    const left = await githubCallsLeft();
    if (left === 0) await spendGithubCall();
    const r = left === 0 ? new Response(null, { status: 429 }) : await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { accept: "application/vnd.github+json" } });
    if (left !== 0) await spendGithubCall();
    if (r.status === 404) S.repo = { url, state: "bad", msg: "GitHub has no public repository at this URL (it does not exist or is private)." };
    else if (r.status === 403 || r.status === 429) {
      // GitHub's unauthenticated limit (60 an hour per address): a repository Core already runs a
      // recipe on is public (Core cloned it), so it is accepted on Core's word; any other waits
      const c = await coreRecipes();
      if (c?.recipes.length) S.repo = { url, state: "ok", msg: "", gh: { html_url: `https://github.com/${m[1]}/${m[2]}`, full_name: `${m[1]}/${m[2]}`, default_branch: null, language: null, from_core: true }, lineage: c.lineage, core: "ok", recipes: c.recipes };
      else S.repo = { url, state: "bad", msg: `GitHub's API is rate limiting this browser (HTTP ${r.status}); try again in a few minutes.` };
    } else if (!r.ok) S.repo = { url, state: "bad", msg: `GitHub API answered HTTP ${r.status}; try again later.` };
    else {
      const gh = await r.json();
      if (gh.private) S.repo = { url, state: "bad", msg: "The repository is private." };
      else {
        const c = await coreRecipes();
        S.repo = { url, state: "ok", msg: "", gh, lineage: c?.lineage ?? null, core: c ? "ok" : "down", recipes: c?.recipes ?? [] };
      }
    }
  } catch (e) {
    S.repo = { url, state: "bad", msg: `GitHub API did not answer (${(e as Error).message}).` };
  }
  renderRepo();
}

function renderRepo() {
  const r = S.repo;
  renderWizard();
  set("w-work", r?.state === "ok" ? workView(r) : "");
  if (!r) return set("w-repo", "Any public GitHub repository, as an https URL. Checked against the GitHub API and Core's lineages.");
  if (r.state === "checking") return set("w-repo", html`<span class="dim">${r.msg}</span>`);
  if (r.state === "bad") return set("w-repo", html`<span class="mark warn">${icon.warn} ${r.msg}</span>`);
  const gh = r.gh;
  set("w-repo", gh.from_core
    ? html`<span class="mark good">${icon.check} public</span> <a class="link" href="${gh.html_url}" target="_blank" rel="noopener">${gh.full_name}</a>: Core runs a recipe on it (GitHub's API is rate limiting this browser, so its details are not shown). On chain as <span class="num">${r.url}</span>.`
    : html`<span class="mark good">${icon.check} public on GitHub</span> <a class="link" href="${gh.html_url}" target="_blank" rel="noopener">${gh.full_name}</a>, default branch ${gh.default_branch}, ${gh.language ?? "language not reported"}. On chain as <span class="num">${r.url}</span>.`);
  // the class follows the recipe when one exists
  const cls = r.recipes?.[0]?.recipe?.class;
  const sel = S.root?.querySelector<HTMLSelectElement>('[name="l_class"]');
  if (sel && cls && [...sel.options].some((o) => o.value === cls)) {
    sel.value = cls;
    set("w-class-help", html`Set from the recipe ${r.recipes![0].recipe.name}: <b>${cls}</b>. Recorded in the token metadata URI.`);
  }
}

/** What the agent can improve on this repository: the recipes Core runs on it, their class and measurable targets. */
function workView(r: NonNullable<typeof S.repo>): Raw {
  if (r.core === "down") return html`<div class="lz-work">${banner("warn", "Core is not answering", "What this repository can improve is TBA until it does.")}</div>`;
  const rs = r.recipes ?? [];
  if (!rs.length)
    return html`<div class="lz-work">${banner("info", "No recipe for this repository yet", html`Core has no active lineage on it, so nothing here is measurable yet. The agent's first job is drafting a recipe; it authors only after calibration replays agree on one (SPEC 13.8). A repository that cannot be calibrated (no runnable tests, no metric, a policy against AI changes) stays in setting up with a public reason.`)}</div>`;
  return html`<div class="lz-work"><div class="eyebrow" style="margin-bottom:6px">What it can improve, read from Core</div>
    ${rs.map((v) => {
      const rc = v.recipe ?? {};
      const metrics = (rc.metrics ?? []) as any[];
      const fix = (rc.fix?.targets ?? rc.targets ?? []) as any[];
      return html`<div class="lz-rec"><div class="lz-rec-h"><a class="link" href="/lineages/${v.lineage_id}">${rc.name ?? "recipe"}</a> ${badge(rc.class ?? "class TBA", "info")} <span class="dim">height ${v.height ?? 0}, ${v.generations?.length ?? 0} accepted generation${(v.generations?.length ?? 0) === 1 ? "" : "s"}</span></div>
        ${metrics.length ? html`<ul class="lz-mets">${metrics.map((m) => html`<li><b>${m.name}</b> <span class="dim">${m.direction ?? ""} is better, ${m.kind ?? "metric"}${typeof m.min_effect === "number" ? `, at least ${(m.min_effect * 100).toFixed(m.min_effect * 100 < 1 ? 2 : 0)}% to count` : ""}</span></li>`)}</ul>` : ""}
        ${fix.length ? html`<div class="dim">Failing tests it can fix: ${fix.map((t) => (typeof t === "string" ? t : t.id ?? JSON.stringify(t))).join(", ")}</div>` : ""}
        ${!metrics.length && !fix.length ? html`<div class="dim">This recipe publishes no measurable target.</div>` : ""}</div>`;
    })}</div>`;
}

/** What to do when the wallet holds too little of the quote token. */
const topUp = () => (NET.p.faucet ? ` Get ${qsym()} from the faucet on your Profile.` : NET.p.swap ? " Pay with SOL or USDC (swapped through Jupiter), or add it to this wallet." : "");

/** The on-chain name prefix: "TEST " on devnet, none on mainnet (no TEST labels, SPEC 14.10). */
const namePrefix = () => (testLabels() ? "TEST " : "");

function launchArgs() {
  const name = val("l_name");
  const symbol = val("l_symbol").toUpperCase();
  const cls = val("l_class") || "rust";
  const hosted = (S.root?.querySelector<HTMLInputElement>('input[name="l_hosted"]:checked')?.value ?? "hosted") === "hosted";
  const identity = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"]:checked')?.value ?? "token";
  if (!name || new TextEncoder().encode(`${namePrefix()}${name}`).length > 32) throw new Error(testLabels() ? "Agent name: 1 to 27 characters (the on-chain name is TEST + name, 32 bytes max)." : "Agent name: 1 to 32 bytes.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol: 1 to 10 characters, A to Z and 0 to 9.");
  if (!S.repo || S.repo.state !== "ok") throw new Error("Target repository: enter a public GitHub https URL and wait for the check to pass.");
  const uri = `https://lineage.invalid/${netName()}/agents/${symbol.toLowerCase()}.json?class=${cls}`;
  return { name: `${namePrefix()}${name}`, symbol, uri, repoUrl: S.repo.url, identityMode: IDENTITY_MODE[identity as keyof typeof IDENTITY_MODE], hosted, cls, identity };
}

function labelFor(a: string, x: { agent?: string; mint?: string; pool?: string }): string {
  const L: Record<string, string> = {
    [me() ?? "-"]: "your wallet (launcher, fee payer)",
    ...(me() ? { [ata(me()!, lineMint(), T22)]: `your ${qsym()} account (deposit source)` } : {}),
    [launchPdas.config()]: "launch config",
    [launchPdas.authority()]: "launch authority PDA",
    [lineMint()]: `${qsym()} mint${testLabels() ? " (TEST)" : ""}`,
    [dbcConfig()]: "DBC config",
    [registryPdas.config()]: "registry config",
    [registryPdas.treasury()]: "registry treasury",
    [REGISTRY_PROGRAM_ID]: "lineage_registry",
    [LAUNCH_PROGRAM_ID]: "lineage_launch",
    [METEORA.dbcProgram]: "Meteora DBC",
    [METEORA.dbcPoolAuthority]: "DBC pool authority",
    [METEORA.dbcEventAuthority]: "DBC event authority",
    [T22]: "Token-2022",
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
    "11111111111111111111111111111111": "System",
    ComputeBudget111111111111111111111111111111: "Compute budget",
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated token",
  };
  if (x.agent) {
    L[x.agent] = "agent key (new, this page)";
    L[launchPdas.computeVault(x.agent)] = "compute vault (new)";
    L[registryPdas.agent(x.agent)] = "registry Agent record";
  }
  if (x.mint) {
    L[x.mint] = "agent token mint (new, this page)";
    L[launchPdas.agentLaunch(x.mint)] = "AgentLaunch (new)";
    const pool = launchPdas.dbcPool(dbcConfig(), x.mint, lineMint());
    L[pool] = "DBC pool";
    L[launchPdas.dbcVault(x.mint, pool)] = "DBC base vault";
    L[launchPdas.dbcVault(lineMint(), pool)] = "DBC quote vault";
    L[ata(launchPdas.authority(), x.mint, T22)] = "authority's agent-token account";
  }
  return L[a] ?? "";
}

function simTable(sim: Simulation, x: { agent?: string; mint?: string }, payer: string): Raw {
  const created = sim.accounts.filter((a) => a.created);
  const rent = created.reduce((n, a) => n + (a.after ?? 0n), 0n);
  const payerRow = sim.accounts.find((a) => a.address === payer);
  const change = payerRow && payerRow.before !== null && payerRow.after !== null ? payerRow.before - payerRow.after : null;
  return html`
    <div class="stats wl-stats2" style="--n:2">
      ${stat("Rent deposits", html`${sol(rent)}<span class="unit">SOL</span>`, `${created.length} new account${created.length === 1 ? "" : "s"}, from the simulation`, "sm")}
      ${stat("Network fee", sim.fee === null ? "TBA" : html`${sol(sim.fee)}<span class="unit">SOL</span>`, "getFeeForMessage", "sm")}
      ${stat("Wallet change", change === null ? "TBA" : html`${sol(-change)}<span class="unit">SOL</span>`, "simulated post-state", "sm")}
      ${stat("Compute", sim.unitsConsumed === undefined ? "TBA" : sim.unitsConsumed.toLocaleString("en-US"), "units consumed", "sm")}
    </div>
    <div class="tw"><table class="t wl-acc"><thead><tr><th>Account</th><th>Role</th><th class="right">SOL after</th></tr></thead><tbody>
      ${sim.accounts.map(
        (a) => html`<tr><td>${addr(a.address)}<div class="sub">${a.signer ? "signer" : ""}${a.signer && a.writable ? ", " : ""}${a.writable ? "writable" : a.signer ? "" : "read-only"}</div></td>
          <td class="wrap">${labelFor(a.address, x) || html`<span class="faint">other</span>`}${a.created ? html` ${badge("created", "info")}` : ""}</td>
          <td class="right num">${a.after === null ? html`<span class="faint">none</span>` : sol(a.after)}${a.created ? html`<div class="sub">rent paid by you</div>` : ""}</td></tr>`,
      )}
    </tbody></table></div>`;
}

// soul (SPEC 14.8): seed, Claude draft, review and edit, then sign with the agent key at launch

/** The launcher's links: up to three https URLs, one per line. Throws a message for the form. */
function linksTyped(): string[] {
  const raw0 = (S.root?.querySelector<HTMLTextAreaElement>('[name="l_links"]')?.value ?? "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  if (raw0.length > 3) throw new Error("Links: at most 3.");
  for (const l of raw0) if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(l)) throw new Error(`Links: ${l.slice(0, 60)} is not an https URL.`);
  return raw0;
}

/** The seed the agent's soul is drafted from: the agent step's vibe, specialty and values (plus the temperament's word), and the coin step's description and links as the launcher's lines. */
function soulSeed() {
  const values = val("s_values").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6);
  const t = temperPick();
  if (t && t !== "aggressive" && !values.some((v) => new RegExp(`\\b${t}\\b`, "i").test(v))) values.push(t);
  let links: string[] = [];
  try {
    links = linksTyped();
  } catch {
    links = [];
  }
  const desc = (S.root?.querySelector<HTMLTextAreaElement>('[name="l_desc"]')?.value ?? "").trim();
  const lines = [desc, links.length ? `Links: ${links.join(" ")}` : ""].filter(Boolean).join("\n");
  return { vibe: val("s_vibe"), specialty: val("s_specialty"), values, lines };
}

async function soulGenerate() {
  const seed = soulSeed();
  if (!seed.vibe || !seed.specialty || !seed.values.length) return set("w-soul", errBox("Vibe, specialty and at least one value are needed."));
  const agent = S.soul?.agent ?? (await generateWebKey());
  S.soul = { agent, doc: null, note: null, edited: false, usd: null };
  S.draft = null;
  set("w-soul", html`<div class="wl-fine" style="margin-top:8px">Drafting a soul for agent ${addr(agent.id)}. This takes a minute or two.</div>`);
  const r = await fetch("/souls/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed, agent: agent.id, repo: S.repo?.url ?? null }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    S.soul.note = errBox(j.problems ? `${j.error}: ${j.problems.join("; ")}` : (j.message ?? `HTTP ${r.status}`));
    return renderSoul();
  }
  S.soul.doc = withModel(j.doc as SoulDoc, modelChoice()); // plan M: the picked model is part of the signed profile
  S.soul.usd = typeof j.usd === "number" ? j.usd : null;
  renderSoul();
}

function soulApply() {
  if (!S.soul?.doc) return;
  const text = S.root?.querySelector<HTMLTextAreaElement>('[name="s_persona"]')?.value ?? "";
  let persona: SoulPersona;
  try {
    persona = JSON.parse(text);
  } catch {
    S.soul.note = errBox("The persona is not valid JSON.");
    return renderSoul(text);
  }
  const doc: SoulDoc = { ...S.soul.doc, persona, origin: { ...S.soul.doc.origin, by: "edited" } };
  const errs = checkSoul(doc);
  if (errs.length) {
    S.soul.note = errBox(`Not applied: ${errs.slice(0, 6).join("; ")}`);
    return renderSoul(text);
  }
  S.soul.doc = doc;
  S.soul.edited = true;
  S.soul.note = html`<span class="mark good">${icon.check} edits applied; the digest below is what goes on chain</span>`;
  S.draft = null;
  renderSoul();
}

function renderSoul(editing?: string) {
  const s = S.soul;
  if (!s) return set("w-soul", "");
  if (!s.doc) return set("w-soul", html`<div style="margin-top:8px">${s.note ?? ""}</div>`);
  const p = s.doc.persona;
  const li = (xs: string[]) => html`<ul class="wl-soul-list">${xs.map((x) => html`<li>${x}</li>`)}</ul>`;
  set(
    "w-soul",
    html`<div class="wl-soul">
      <div class="wl-soul-h"><b>${p.name}</b> <span class="dim">${p.tagline}</span></div>
      <div class="wl-fine">${s.edited ? "Edited by you" : `Drafted by ${s.doc.origin.model ?? "the model"}`}${s.usd !== null ? `, ${s.usd.toFixed(4)} USD of model spend` : ""}. Digest <span class="wl-hash">${soulDigest(s.doc)}</span></div>
      <p>${p.backstory}</p>
      <div class="wl-2">
        <div><div class="eyebrow">Voice</div><p>${p.voice.register.replace(/\.$/, "")}. ${p.voice.style}</p></div>
        <div><div class="eyebrow">Taste</div><p>${p.taste.aesthetic}</p></div>
      </div>
      <div class="wl-2">
        <div><div class="eyebrow">Optimises for</div>${li(p.taste.optimises_for)}</div>
        <div><div class="eyebrow">Refuses</div>${li(p.taste.refuses)}</div>
      </div>
      <div class="wl-2">
        <div><div class="eyebrow">Values</div>${li(p.values)}</div>
        <div><div class="eyebrow">Collaboration</div><p>${p.collaboration.seeks} ${p.collaboration.disagrees}</p></div>
      </div>
      <details${raw(s.edited || editing !== undefined ? " open" : "")}><summary class="eyebrow">Edit the persona (JSON)</summary>
        <textarea name="s_persona" rows="16" class="wl-soul-edit">${editing ?? JSON.stringify(p, null, 2)}</textarea>
        <div class="wl-row" style="margin-top:6px">${btn("soul-apply", "Apply edits")}</div>
      </details>
      <div style="margin-top:6px">${s.note ?? ""}</div>
    </div>`,
  );
}

async function publishLaunchedSoul(agent: WebKey, doc: SoulDoc) {
  try {
    const sig = base58Encode(await agent.sign(new TextEncoder().encode(soulSigningMessage(doc))));
    const r = await fetch("/souls/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig }) });
    const j = await r.json().catch(() => ({}));
    S.soulPub = r.ok
      ? html`stored, seq ${j.seq}${j.public ? "" : html` <span class="dim">(public once Core's next chain sync sees the launch)</span>`}`
      : html`<span class="mark warn">${icon.warn} not stored: ${j.message ?? j.error ?? `HTTP ${r.status}`}</span> <span class="dim">Download the agent key; the soul can be published later.</span>`;
  } catch (e) {
    S.soulPub = html`<span class="mark warn">${icon.warn} not stored: ${(e as Error).message}</span>`;
  }
}

async function launchReview() {
  if (!requireReady()) return;
  S.launchOut = null;
  let args;
  try {
    args = launchArgs();
  } catch (e) {
    set("w-launch-out", html`<div class="panel-b">${errBox(e)}</div>`);
    return;
  }
  set("w-launch-out", html`<div class="panel-b dim">Making the agent and mint keys, building and simulating…</div>`);
  try {
    const keep = S.draft && S.draft.args.repoUrl === args.repoUrl && S.draft.args.symbol === args.symbol;
    // plan M: the picked model is recorded in the soul the agent key signs; without a soul the agent runs the default
    const choice = modelChoice();
    if (S.soul?.doc) {
      S.soul.doc = withModel(S.soul.doc, choice);
      renderSoul();
    }
    const soul = S.soul?.doc ?? null;
    if (S.soul && !soul) throw new Error("The soul has problems; fix them, generate again, or choose Launch without a soul.");
    if (!soul && !isDefaultChoice(choice)) throw new Error("The model choice is recorded in the agent's soul: generate a soul, or pick the default model.");
    const agent = soul ? S.soul!.agent : keep ? S.draft!.agent : await generateWebKey();
    const mint = keep ? S.draft!.mint : await generateWebKey();
    // prepaid credits (plan C): the deposit and refresh_awake ride in the launch transaction
    const deposit = depositBase(val("l_deposit"), dec());
    // mainnet: the deposit may be paid in SOL or USDC, swapped by Jupiter to exactly the deposit first (SPEC 14.9)
    const pay = payAsset(val("l_deposit_pay"));
    if (pay === "LINE" && S.line !== null && S.line < deposit) throw new Error(`Deposit: your wallet holds ${units(S.line, dec())} ${qsym()}, the deposit is ${units(deposit, dec())}.${topUp()}`);
    const ix = launch.launchAgent({ launcher: me()!, agent: agent.id, agentMint: mint.id, lineMint: lineMint(), dbcConfig: dbcConfig(), lineTokenProgram: T22,
      args: { name: args.name, symbol: args.symbol, uri: args.uri, repoUrl: args.repoUrl, identityMode: args.identityMode, hosted: args.hosted } });
    const main = [ix, ...launch.prepay({ launcher: me()!, agent: agent.id, agentMint: mint.id, lineMint: lineMint(), amount: deposit, decimals: dec(), lineTokenProgram: T22 })];
    // the soul's digest goes on chain with the launch, signed by the agent key (its signing key until a rotation)
    const soulIx = soul ? registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: soulDigest(soul), seq: soul.seq }) : null;
    const ixs = soulIx ? [...main, soulIx] : main;
    // one legacy transaction; over 1232 bytes a v0 one with the frozen lookup table; still over, launch + deposit + wake first and the soul second
    const plan = planLaunch({ payer: me()!, main, soul: soulIx, budget: budgetIxs(450_000), table: P.table, v0: signsV0(S.wallet!) });
    // in a split the soul transaction is simulated once the first has landed (it needs the new Agent record)
    const builts = [await buildAndSimulate(me()!, plan.txs[0]!.ixs, 450_000, plan.txs[0]!.table)];
    const built = builts[0]!;
    let swap: { prepared: PreparedSwap; sim: Simulation } | null = null;
    if (pay !== "LINE") {
      const prepared = await prepareSwapThen({ pay, need: deposit, taker: me()!, action: [], cuLimit: 400_000 });
      swap = { prepared, sim: await simulatePlan(prepared, me()!) };
    }
    S.draft = { agent, mint, built, args, ix, ixs, soul, plan, builts, deposit, swap };
    renderLaunchReview();
  } catch (e) {
    set("w-launch-out", html`<div class="panel-b">${errBox(e)}</div>`);
  }
}

function renderLaunchReview() {
  const d = S.draft!;
  const sim = d.built.sim;
  const recordRows: [string, unknown][] = [
    ["Name / symbol", `${d.args.name} / ${d.args.symbol}`],
    ["Repository", d.args.repoUrl],
    ["repo_id (computed on chain)", html`<span class="wl-hash">${repoId(d.args.repoUrl)}</span>`],
    ["Identity mode", `${d.args.identity} (${d.args.identityMode})`],
    ["Runtime", d.args.hosted ? "hosted" : "self-hosted"],
    ["Model", (() => {
      const m = entryOf(d.soul?.model ?? modelChoice());
      return m ? html`${m.name} <span class="dim">${m.provider}/${m.id}, ${priceText(m)}${d.soul?.model ? ", in the signed soul" : ", the network default"}</span>` : html`<span class="faint">network default</span>`;
    })()],
    ["Class", `${d.args.cls} (metadata URI)`],
    ["Agent key", addr(d.agent.id)],
    ["Agent mint", addr(d.mint.id)],
    ["Soul", d.soul ? html`${d.soul.persona.name}, <span class="wl-hash">${soulDigest(d.soul)}</span> <span class="dim">set_profile seq ${d.soul.seq} ${d.plan.mode === "split" ? "in the second transaction" : "in this transaction"}</span>` : html`<span class="faint">none</span>`],
    ["Deposit", html`${tl(d.deposit)} <span class="dim">${depositNote(val("l_deposit"))}${depositNote(val("l_deposit")) ? "; " : ""}transferChecked into the compute vault, then refresh_awake${d.swap ? `; paid in ${d.swap.prepared.pay}, swapped first` : ""}</span>`],
    ["Transaction", d.plan.mode === "split"
      ? html`<b>2 signatures</b> <span class="dim">(1) launch_agent + deposit + refresh_awake, ${d.plan.txs[0]!.size} bytes; (2) set_profile, ${d.plan.txs[1]!.size} bytes. One transaction does not fit 1232 bytes${P.table ? ", even as v0 with the lookup table" : ""}${signsV0(S.wallet!) ? "" : " and this wallet does not sign v0"}.</span>`
      : d.plan.mode === "v0"
        ? html`one v0 transaction, ${d.plan.txs[0]!.size} of 1232 bytes, reading the frozen lookup table ${addr(P.table!.address)}`
        : html`one transaction, ${d.plan.txs[0]!.size} of 1232 bytes`],
  ];
  // paying by swap: the swap is simulated now; the launch is simulated again after the swap lands (it spends what the swap delivers)
  const sw = d.swap;
  const blocked = sw ? (sw.sim.err ? "the swap simulation failed" : false) : sim.err ? "the simulation failed; fix the inputs and review again" : false;
  set(
    "w-launch-out",
    html`${sw ? html`<div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">Swap first (Jupiter), one more signature</div>${routeLines(sw.prepared)}${sw.sim.err ? errBox(`Swap simulation failed: ${JSON.stringify(sw.sim.err)}`, sw.sim.logs) : html`<span class="mark good">${icon.check} swap simulation succeeded on ${netName()}</span>`}</div>` : ""}
      ${sim.err && sw ? html`<div class="panel-b wl-row"><span class="mark warn">${icon.warn} launch simulation before the swap: ${JSON.stringify(sim.err)}; it is simulated again after the swap lands and nothing is sent if it still fails</span></div>` : sim.err ? html`<div class="panel-b">${errBox(`Simulation failed: ${JSON.stringify(sim.err)}`, sim.logs)}</div>` : html`<div class="panel-b wl-row"><span class="mark good">${icon.check} simulation succeeded on ${netName()}</span></div>`}
      ${simTable(sim, { agent: d.agent.id, mint: d.mint.id }, me()!)}
      <div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">launch_agent arguments</div>${kv(recordRows)}</div>
      <div class="panel-b wl-row lz-launch">${btn("launch-sign", html`Launch${d.plan.mode === "split" || sw ? ` (${(d.plan.mode === "split" ? 2 : 1) + (sw ? 1 : 0)} signatures)` : ""}`, { primary: true, disabled: blocked })}${btn("launch-review", "Simulate again")}<span class="wl-why">${S.wallet!.name} signs ${d.plan.mode === "split" ? "two transactions" : "one transaction"}; a hosted agent's binding is one more signature after it.</span></div>
      <div class="panel-b" id="w-launch-status"></div>`,
  );
}

async function launchSign() {
  const d = S.draft;
  // never double-send: one launch in flight at a time, and a mint already launched is read back, not sent again
  if (!d || S.sending || S.launched?.mint === d.mint.id || !requireReady()) return;
  S.sending = true;
  renderWizard();
  for (const el of S.root?.querySelectorAll<HTMLButtonElement>('[data-act="launch-sign"], [data-act="launch-review"]') ?? []) el.disabled = true;
  const st = (m: string) => set("w-launch-status", html`<span class="dim">${m}</span>`);
  try {
    let sig: string;
    const already = await reader.agentLaunch(d.mint.id).catch(() => null);
    if (already) {
      // an earlier attempt landed although the page did not see its confirmation
      const sigs = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(d.mint.id), { limit: 50, commitment: "confirmed" }]).catch(() => []);
      sig = sigs[sigs.length - 1]?.signature ?? "";
      st("This launch is already on chain; reading it back instead of sending it again.");
    } else {
      const t0 = d.plan.txs[0]!;
      if (d.swap && !d.swap.sig) {
        // the swap first (mainnet), then the launch simulated again on the balance it delivered
        const cs = await sendSwapPlan({ rpc, wallet: S.wallet!, account: S.account!, prepared: d.swap.prepared, onStatus: st });
        d.swap.sig = cs[cs.length - 1]!.signature;
        logSig(`swap ${d.swap.prepared.pay} to ${qsym()} for the deposit`, d.swap.sig, cs[cs.length - 1]!.fee, true);
        await refreshBalances();
      }
      if (d.swap) {
        const again = await buildAndSimulate(me()!, t0.ixs, 450_000, t0.table);
        if (again.sim.err) throw Object.assign(new Error(`launch simulation after the swap failed: ${JSON.stringify(again.sim.err)}; nothing was sent (the swapped ${qsym()} stays in your wallet)`), { logs: again.sim.logs });
      }
      const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: t0.ixs, units: 450_000, local: [d.agent, d.mint], onStatus: st, table: t0.table });
      const c = r.confirmed!;
      logSig(`launch_agent + deposit + refresh_awake ${d.args.symbol}`, c.signature, c.fee, !c.err);
      if (c.err) throw Object.assign(new Error(`launch_agent failed on chain: ${JSON.stringify(c.err)}`), { logs: c.logs });
      sig = c.signature;
    }
    const sigs = [sig];
    if (d.plan.mode === "split") {
      // the agent is already awake; the soul's set_profile is the second signature, sent once
      const rec = await reader.agent(d.agent.id).catch(() => null);
      if (!rec?.profileDigest || rec.profileDigest !== soulDigest(d.soul!)) {
        const t1 = d.plan.txs[1]!;
        st("launched; now sign the soul transaction (2 of 2)");
        const r2 = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: t1.ixs, units: 100_000, local: [d.agent], onStatus: st, table: t1.table });
        logSig(`set_profile ${d.args.symbol}`, r2.confirmed!.signature, r2.confirmed!.fee, !r2.confirmed!.err);
        if (r2.confirmed!.err) throw Object.assign(new Error(`set_profile failed on chain: ${JSON.stringify(r2.confirmed!.err)} (the agent is launched and awake; press Launch again to send only the soul)`), { logs: r2.confirmed!.logs });
        sigs.push(r2.confirmed!.signature);
      }
    }
    S.launched = { agent: d.agent, mint: d.mint.id, sig, sigs, deposit: d.deposit, mode: d.plan.mode };
    S.draft = null;
    S.sending = false;
    renderWizard();
    const started = Date.now();
    track.clear();
    mark("confirmed", "ok", html`${txLink(sig)}${sigs[1] ? html` and ${txLink(sigs[1])}` : ""}, ${d.plan.mode === "split" ? "two signatures" : d.plan.mode === "v0" ? "one v0 transaction" : "one transaction"}`);
    mark("vault", "wait", "reading the compute vault");
    mark("github", "wait", "asking the identity service");
    if (d.args.hosted) mark("runtime", "wait", "the hosted runtime's binding follows");
    else mark("runtime", "skip", "self-hosted: run the worker with the agent key below");
    if (S.image || S.bannerFile) mark("images", "wait", "after Core reads the launch");
    mark("session", "wait", "after the agent is awake and bound");
    mark("verdict", "wait", "after the first candidate is replayed");
    // plan T: the optional trading allocation, a second transaction to the published escrow
    const alloc = await sendAllocation({ wallet: S.wallet!, account: S.account!, agent: d.agent.id, lineMint: lineMint(), decimals: dec(), typed: val("l_alloc"), pay: val("l_alloc_pay"), onStatus: st }).catch((e) => (console.warn(`trading allocation not sent: ${(e as Error).message}`), null));
    if (alloc) logSig(`trading allocation ${d.args.symbol}`, alloc, undefined, true);
    if (d.soul) await publishLaunchedSoul(d.agent, d.soul);
    S.ghLaunch = d.args.identity === "token" ? await submitLaunchToken({ agent: d.agent, mint: d.mint.id }) : null;
    void trackLaunch(d.agent.id, d.mint.id, d.args.hosted, started);
    void uploadImages(d.agent.id);
    await renderLaunched();
    void loadLaunches();
    void refreshBalances();
  } catch (e) {
    set("w-launch-status", errBox(e, (e as any).logs));
  } finally {
    S.sending = false;
    renderWizard();
    if (!S.launched) for (const el of S.root?.querySelectorAll<HTMLButtonElement>('[data-act="launch-sign"], [data-act="launch-review"]') ?? []) el.disabled = false;
  }
}

async function renderLaunched() {
  const L = S.launched!;
  set("w-launch-out", html`<div class="panel-b dim">Confirmed in ${txLink(L.sig)}. Reading the launch back from chain…</div>`);
  const [l, rec, mintAcc] = await Promise.all([reader.agentLaunch(L.mint), reader.agent(L.agent.id), rpc.getAccountInfo(L.mint)]);
  if (!l) return set("w-launch-out", html`<div class="panel-b">${errBox("AgentLaunch not found after confirmation")}</div>`);
  const pool = await rpc.getAccountInfo(l.dbcPool);
  const pv = pool ? decodeDbcPool(pool.data) : null;
  const vaultBal = await reader.tokenBalance(launchPdas.computeVault(l.agent));
  const meta = mintAcc ? decodeT22Metadata(mintAcc.data) : null;
  const mi = mintAcc ? decodeMint(mintAcc.data) : null;
  set(
    "w-launch-out",
    html`<div class="panel-b">${banner("info", html`Launched. ${txLink(L.sig, "View the transaction")}`, html`Everything below was read back from ${netName()} after confirmation.`)}</div>
      <div class="eyebrow wl-sub">AgentLaunch ${addr(launchPdas.agentLaunch(L.mint))}</div>
      ${kv([
        ["Agent", addr(l.agent)],
        ["Mint", html`${addr(l.mint)} ${meta ? html`<span class="dim">${meta.name} (${meta.symbol})</span>` : ""}`],
        ["Launcher", addr(l.launcher)],
        ["Repository", l.repoUrl],
        ["repo_id", html`<span class="wl-hash">${l.repoId}</span> ${l.repoId === repoId(l.repoUrl) ? html`<span class="mark good">${icon.check} equals protocol repoId</span>` : html`<span class="mark warn">${icon.warn} differs</span>`}`],
        ["Identity / runtime", `${["token", "purchased", "app"][l.identityMode]} / ${l.hosted ? "hosted" : "self-hosted"}`],
        ["DBC pool", html`${addr(l.dbcPool)}${pv ? html` <span class="dim">creator ${pv.creator === launchPdas.authority() ? "launch authority PDA" : short(pv.creator)}, quote reserve ${units(pv.quoteReserve, dec())} ${qsym()}</span>` : ""}`],
        ["Compute vault", html`${addr(launchPdas.computeVault(l.agent))} ${tl(vaultBal)}`],
        ["Awake", l.awake ? html`yes ${L.deposit !== undefined ? html`<span class="dim">woken by the deposit in the launch transaction</span>` : ""}` : "no (vault below wake_threshold)"],
        ...(L.deposit !== undefined ? [["Prepaid", html`${tl(L.deposit)} deposited; ${L.mode === "split" ? html`2 transactions, soul in ${txLink(L.sigs![1]!)}` : L.mode === "v0" ? "one v0 transaction" : "one transaction"}<div id="w-prepay-core" class="dim">Core's check of the deposit follows its next chain sync.</div>`] as [string, unknown]] : []),
        ["Created", when(l.createdAt)],
        ["Supply", mi ? html`${units(mi.supply, mi.decimals)} <span class="dim">agent tokens, ${mi.decimals} decimals, Token-2022</span>` : "TBA"],
        ["Metadata URI", meta?.uri ?? "TBA"],
        ["Registry record", rec ? html`kind ${rec.kind}, owner ${addr(rec.owner)}, hosted ${rec.hosted ? "yes" : "no"}` : "TBA"],
        ["Soul on chain", rec?.profileDigest ? html`<span class="wl-hash">${rec.profileDigest}</span> seq ${rec.profileSeq} ${S.soul?.doc && rec.profileDigest === soulDigest(S.soul.doc) ? html`<span class="mark good">${icon.check} equals the soul you signed</span>` : ""}` : html`<span class="faint">none</span>`],
        ["Soul in Core", S.soulPub ?? html`<span class="faint">none</span>`],
        ["GitHub identity", html`${S.ghLaunch ?? ""}<div id="w-gh-launch"><span class="dim">Reading the identity service…</span></div>`],
        ...(l.hosted ? [["Hosted runtime", html`<div id="w-rt-bind"><span class="dim">Asking the hosted runtime for its key…</span></div>`] as [string, unknown]] : []),
      ])}
      <div class="panel-b">
        <div class="wl-row">${btn("download-agent-key", "Download agent key (keypair JSON)", { primary: true })}<a class="wl-btn" href="/tokens/${l.mint}">Trade on its token page</a></div>
        <div class="wl-fine">The agent key exists only in this tab. ${l.hosted ? "Once bound, the hosted runtime's own key speaks for the agent and this key no longer does; keep the file to rotate back to it later." : "A self-hosted worker runs with it:"} <span class="num">${W} run --core &lt;core&gt; --key &lt;file&gt;</span>. Leaving the page drops it.</div>
      </div>`,
  );
  showIdentity("w-gh-launch", l.agent, l.mint, false);
  if (L.deposit !== undefined) void showCorePrepay(l.agent, dec(), (r) => set("w-prepay-core", r));
  if (l.hosted) void bindHosted(l.agent);
}

// A hosted launch binds to the site's hosted runtime (packages/runtime/src/bind.ts): the runtime made
// its own key for the agent; the owner's wallet signs rotate_agent_key to it, and the runtime checks
// the transaction, co-signs as the new key and sends it. The launcher's agent key never leaves this tab.
async function bindHosted(agent: string) {
  const out = (r: Raw | string) => set("w-rt-bind", r);
  const retry = () => btn("rt-bind", "Bind to the hosted runtime");
  try {
    let t: { new_key: string; status: string } | null = null;
    // the runtime reads the launch from chain; a few seconds of RPC lag are normal right after it lands
    for (let i = 0; i < 20 && !t; i++) {
      const r = await fetch(`/runtime/bind/${agent}`, { headers: { accept: "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (r.ok) t = j;
      else if (r.status !== 404 && r.status !== 503 && r.status !== 429) throw new Error(j.message ?? j.error ?? `the hosted runtime answered HTTP ${r.status}`);
      else await new Promise((res) => setTimeout(res, 3000));
    }
    if (!t) throw new Error("the hosted runtime has not seen this launch yet");
    const rec0 = await reader.agent(agent);
    if (t.status === "bound" || rec0?.signingKey === t.new_key)
      return out(html`<span class="mark good">${icon.check} bound</span> <span class="dim">signing key ${addr(t.new_key)} (the hosted runtime's)</span>`);
    if (!requireReady()) return out(html`${retry()} <span class="dim">connect the launcher wallet</span>`);
    if (rec0 && rec0.owner !== me()) return out(html`<span class="dim">only the owner ${addr(rec0.owner)} can bind it</span>`);
    out(html`<span class="dim">Sign the binding: your wallet signs <span class="num">rotate_agent_key</span> as owner, to the runtime's key ${addr(t.new_key)}; the runtime co-signs and sends it.</span>`);
    const ix = registry.rotateAgentKey({ owner: me()!, agent, newKey: t.new_key });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [ix], leaveFor: t.new_key, onStatus: (m) => out(html`<span class="dim">${m}</span>`) });
    out(html`<span class="dim">Signed. The hosted runtime is co-signing and sending…</span>`);
    const p = await fetch(`/runtime/bind/${agent}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: base64Encode(r.partial!) }) });
    const j = await p.json().catch(() => ({}));
    if (!p.ok) throw new Error(j.message ?? j.error ?? `HTTP ${p.status}`);
    const t2 = await rpc.getTransaction(j.signature).catch(() => null);
    logSig(`rotate_agent_key ${short(agent)} to the hosted runtime (co-signed by the runtime)`, j.signature, t2?.meta?.fee, true);
    const rec = await reader.agent(agent);
    out(rec?.signingKey === t.new_key
      ? html`<span class="mark good">${icon.check} bound</span> ${txLink(j.signature)} <span class="dim">signing key ${addr(t.new_key)} (the hosted runtime's), key changes ${rec.keySeq}; it starts on the runtime's next pass</span>`
      : html`<span class="mark warn">${icon.warn} sent ${txLink(j.signature)}, the registry has not shown the new key yet</span>`);
  } catch (e) {
    out(html`${errBox(e, (e as any).logs)}<div class="wl-row" style="margin-top:6px">${retry()}</div>`);
  }
}

async function downloadAgentKey() {
  const L = S.launched;
  if (!L) return;
  const json = JSON.stringify(await L.agent.exportSolanaJson());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `agent-${L.agent.id.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------------------------------------
// launches on chain (Profile, per agent)

async function loadLaunches() {
  try {
    const [launches, agents] = await Promise.all([reader.launches(), reader.agents()]);
    S.launches = launches;
    S.owners = new Map(agents.map((a) => [a.agent, a.owner]));
    S.records = new Map(agents.map((a) => [a.agent, a]));
    const mints = S.launches.map((l) => l.mint);
    const pools = S.launches.map((l) => l.dbcPool);
    const accs = await rpc.getMultipleAccounts([...mints, ...pools]);
    mints.forEach((m, i) => {
      S.metas.set(m, accs[i] ? decodeT22Metadata(accs[i]!.data) : null);
      if (accs[i]) S.decimals.set(m, decodeMint(accs[i]!.data).decimals);
    });
    pools.forEach((p, i) => S.pools.set(p, accs[mints.length + i] ? decodeDbcPool(accs[mints.length + i]!.data) : null));
    S.launches.sort((a, b) => Number(b.createdAt - a.createdAt));
    S.launchesErr = null;
  } catch (e) {
    S.launchesErr = errBox(e);
  }
  if (S.page === "profile") {
    mineRows.clear();
    renderMine();
    void renderHoldings();
  }
  // the bounty form lists the agents this wallet launched
  if (S.bcfg !== undefined) renderBountyForm();
}

const adec = (mint: string | null | undefined) => (mint ? (S.decimals.get(mint) ?? 6) : 6);

// ------------------------------------------------------------------------------------------------
// verifier (register needs the agent key: the worker co-signs)

function renderVerifier() {
  const p = S.reg?.params;
  const rec = S.vrec;
  const k = S.vkey;
  const mine = rec && rec.owner === me();
  let body: Raw;
  if (!k) body = html`<div class="dim">Enter the agent public key printed by <span class="num">lineage-worker keygen</span> (step 1 of the kit).</div>`;
  else if (rec === undefined) body = html`<div class="dim">Reading the registry…</div>`;
  else if (rec === null) {
    const need = p ? p.registerBurn : null;
    const short0 = need !== null && S.line !== null && S.line < need;
    body = html`<div class="wl-fine">Not registered. Registering burns <b>${tl(p?.registerBurn)}</b> from your wallet (register_burn, read from the registry config) and creates the Agent record linking this key to your wallet as owner.</div>
      <label class="wl-field" style="margin-top:10px"><span class="eyebrow">Capabilities (output of <span class="num">lineage-worker doctor</span>)</span><textarea name="v_caps" rows="4" placeholder='{"arch":"arm64","cpus":10,...}'></textarea><span class="wl-help">Committed as H("caps", canonical JSON), the digest Core compares with what the worker declares. Leave empty to commit to no capabilities.</span></label>
      <div class="wl-row" style="margin-top:10px">${btn("v-register", "Sign register as owner", { primary: true, disabled: !S.account ? "connect a wallet" : short0 ? `needs ${units(need!, dec())} ${qsym()} to burn: use Get ${qsym()}` : false })}</div>
      <div id="w-cosign">${S.partial && S.partial.agent === k ? cosignView() : ""}</div>`;
  } else {
    const now = Date.now() / 1000;
    const ready = rec.unbondAmount > 0n && now >= Number(rec.unbondReadyAt);
    body = html`${kv([
        ["Agent", addr(rec.agent)],
        ["Owner", html`${addr(rec.owner)} ${mine ? badge("your wallet", "good") : badge("another wallet", "warn")}`],
        ["Kind", rec.kind],
        ["Burned at register", tl(rec.burned)],
        ["Bond", html`${tl(rec.bond)} ${p && rec.bond >= p.minBond ? badge("at least min_bond", "good") : badge(`below min_bond ${p ? units(p.minBond, dec()) : "TBA"}`, "warn")}`],
        ["Pending unbond", rec.unbondAmount > 0n ? html`${tl(rec.unbondAmount)}, ready ${when(rec.unbondReadyAt)}` : "none"],
        ["Strikes / slashed", html`<span class="num">${rec.strikesTotal}</span> / ${tl(rec.slashedTotal)}`],
        ["Registered", when(rec.registeredAt)],
      ])}
      ${mine
        ? html`<div class="wl-2" style="margin-top:12px">
            <div><label class="wl-field"><span class="eyebrow">Bond (${qsym()})</span><input name="v_bond" inputmode="decimal" value="${p && rec.bond < p.minBond ? units(p.minBond - rec.bond, dec()) : ""}"></label>
              <div class="wl-row" style="margin-top:8px">${btn("v-bond", "Sign bond", { primary: true, disabled: rec.kind !== "verifier" ? "hosted launched agents never bond" : false })}</div></div>
            <div><label class="wl-field"><span class="eyebrow">Unbond (${qsym()})</span><input name="v_unbond" inputmode="decimal" value=""></label>
              <div class="wl-row" style="margin-top:8px">${btn("v-unbond", "Request unbond", { disabled: rec.bond === 0n ? "nothing bonded" : false })}${btn("v-withdraw", "Withdraw", { disabled: rec.unbondAmount === 0n ? "no pending unbond" : !ready ? `cooldown of ${p ? String(p.unbondCooldownS) : "TBA"} s not over` : false })}</div></div>
          </div>
          <div class="wl-fine" style="margin-top:8px">Bonds move ${qsym()} from your wallet to the bond vault ${addr(registryPdas.bondVault())}; they stay slashable until withdrawn after unbond_cooldown.</div>`
        : ""}
      <div id="w-vout">${S.vOut ?? ""}</div>`;
  }
  set(
    "w-ver",
    html`<div class="panel-b"><label class="wl-field"><span class="eyebrow">Agent public key</span><input name="v_key" placeholder="base58 key from keygen" value="${esc(k)}" spellcheck="false"></label>
      <div class="wl-row" style="margin-top:8px">${btn("v-lookup", "Look up")}</div></div>
    <div class="panel-b" style="padding-top:0">${body}</div>`,
  );
  renderKit();
}

function cosignView(): Raw {
  const pz = S.partial!;
  const cmd = `${W} cosign --key ~/.lineage/keys/verifier.json --tx ${pz.b64}`;
  return html`<div class="wl-cosign">${banner("info", "Signed by your wallet. Now the worker co-signs and sends.", html`Run this on the machine with the agent key, within about a minute (the blockhash expires; sign again if it does). The worker checks that the transaction is a <span class="num">register</span> for its own key and that your signature verifies before it adds its own. This page watches the registry and updates when the record appears.`)}
    <div class="cmd"><div class="cmd-h"><span>Co-sign with the worker</span><button type="button" class="copy" data-copy="${cmd}" aria-label="Copy command">${icon.copy} Copy</button></div><pre class="wl-wrap">${cmd}</pre></div>
    <div class="wl-fine" id="w-cosign-wait">Waiting for the Agent record…</div></div>`;
}

function renderKit() {
  const core = location.origin.includes("127.0.0.1") ? "http://127.0.0.1:9660" : "<core url>";
  const key = "~/.lineage/keys/verifier.json";
  const cmd = (lines: string[], label: string) => {
    const t = lines.join("\n");
    return html`<div class="cmd"><div class="cmd-h"><span>${label}</span><button type="button" class="copy" data-copy="${t}" aria-label="Copy commands">${icon.copy} Copy</button></div><pre>${t}</pre></div>`;
  };
  set(
    "w-kit",
    html`<div class="panel-b"><div class="kit" style="margin-top:0">
      ${cmd([`${W} keygen --out ${key}`], "1. Make the agent key on the worker machine; it prints the public key")}
      ${cmd([`${W} doctor`], "2. Capabilities to paste in the register form")}
      ${cmd([`${W} cosign --key ${key} --tx <from this page>`], "3. After your wallet signs register: co-sign and send (devnet)")}
      ${cmd([`${W} run --core ${core} --key ${key}`], "4. Run: qualification replays, then assignments")}
    </div>
    <ol class="wl-steps">
      <li>The registry's Agent record is keyed by the agent key (PDA <span class="num">agent</span> + key) and stores your wallet as <b>owner</b>. Register requires both signatures: the owner pays the burn, the agent key proves the worker holds it.</li>
      <li>Bond, unbond and withdraw are owner-only: your wallet signs them here; the worker key is not needed.</li>
      <li>Rewards for replays go to <span class="num">agent:&lt;key&gt;:wallet</span>, paid to a ${qsym()} account owned by the owner wallet (Claims and bounties on your Profile).</li>
      <li>The worker key signs Core requests and commit-reveals; it never leaves the worker machine and is never typed into this page.</li>
    </ol></div>`,
  );
}

async function vLookup() {
  S.vkey = val("v_key");
  S.vOut = null;
  if (!S.vkey) return renderVerifier();
  try {
    addressBytes(S.vkey);
  } catch {
    S.vrec = undefined;
    set("w-ver", html`<div class="panel-b">${errBox("Not a base58 public key.")}</div>`);
    return;
  }
  S.vrec = undefined;
  renderVerifier();
  S.vrec = await reader.agent(S.vkey).catch(() => null);
  renderVerifier();
}

async function vRegister() {
  if (!requireReady() || !S.reg) return;
  const capsText = (S.root?.querySelector<HTMLTextAreaElement>('[name="v_caps"]')?.value ?? "").trim();
  let digest = "00".repeat(32);
  if (capsText) {
    try {
      digest = H("caps", canonicalJson(JSON.parse(capsText)));
    } catch {
      set("w-cosign", errBox("Capabilities must be the JSON printed by lineage-worker doctor."));
      return;
    }
  }
  const agent = S.vkey;
  const ix = registry.register({ owner: me()!, agent, mint: lineMint(), ownerToken: ata(me()!, lineMint(), T22), operator: "00".repeat(32), capabilities: digest, tokenProgram: T22 });
  try {
    set("w-cosign", html`<span class="dim">Simulating…</span>`);
    const b = await buildAndSimulate(me()!, [ix]);
    // the agent signature is missing in simulation (sigVerify off), so a program error still shows here
    if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [ix], leaveFor: agent, onStatus: (m) => set("w-cosign", html`<span class="dim">${m}</span>`) });
    S.partial = { b64: base64Encode(r.partial!), until: r.lastValidBlockHeight, agent };
    set("w-cosign", cosignView());
    watchRegistration(agent, r.lastValidBlockHeight);
  } catch (e) {
    set("w-cosign", errBox(e, (e as any).logs));
  }
}

async function watchRegistration(agent: string, lastValid: number) {
  const supply0 = (await reader.mint(lineMint()))?.supply ?? null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    if (S.vkey !== agent || !S.partial) return;
    const rec = await reader.agent(agent).catch(() => null);
    if (rec) {
      const supply1 = (await reader.mint(lineMint()))?.supply ?? null;
      S.partial = null;
      S.vrec = rec;
      const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [registryPdas.agent(agent), { limit: 1, commitment: "confirmed" }]).catch(() => []);
      if (sigs[0]) {
        const t = await rpc.getTransaction(sigs[0].signature).catch(() => null);
        logSig(`register ${short(agent)} (sent by lineage-worker cosign)`, sigs[0].signature, t?.meta?.fee, !sigs[0].err);
      }
      S.vOut = html`<div class="panel-b">${banner("info", "Registered by the worker's co-signature.", html`Burned ${units(rec.burned, dec())} ${qsym()} (Agent.burned)${supply0 !== null && supply1 !== null ? html`; ${qsym()} supply fell by ${units(supply0 - supply1, dec())}` : ""}.`)}</div>`;
      refreshBalances();
      loadNetwork();
      return renderVerifier();
    }
    const h = await rpc.getBlockHeight().catch(() => 0);
    if (h > lastValid) {
      S.partial = null;
      set("w-cosign", errBox("The blockhash expired before the worker sent it; nothing was charged. Sign register again."));
      return;
    }
  }
}

async function vOwnerTx(kind: "bond" | "unbond" | "withdraw") {
  if (!requireReady() || !S.vrec) return;
  const agent = S.vrec.agent;
  const ownerToken = ata(me()!, lineMint(), T22);
  let ix: Ix;
  let label: string;
  if (kind === "withdraw") {
    ix = registry.withdrawUnbonded({ owner: me()!, agent, mint: lineMint(), ownerToken, tokenProgram: T22 });
    label = "withdraw_unbonded";
  } else {
    const amt = parseUnits(val(kind === "bond" ? "v_bond" : "v_unbond"), dec());
    if (!amt) {
      S.vOut = errBox(`Enter a positive ${qsym()} amount.`);
      return renderVerifier();
    }
    ix = kind === "bond" ? registry.bond({ owner: me()!, agent, mint: lineMint(), ownerToken, amount: amt, tokenProgram: T22 }) : registry.requestUnbond({ owner: me()!, agent, amount: amt });
    label = `${kind === "bond" ? "bond" : "request_unbond"} ${units(amt, dec())} ${qsym()}`;
  }
  try {
    const b = await buildAndSimulate(me()!, [ix]);
    if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [ix] });
    const c = r.confirmed!;
    logSig(label, c.signature, c.fee, !c.err);
    if (c.err) throw Object.assign(new Error(`${label} failed: ${JSON.stringify(c.err)}`), { logs: c.logs });
    const before = S.vrec;
    S.vrec = await reader.agent(agent);
    const after = S.vrec!;
    const what =
      kind === "bond"
        ? html`Bond ${units(before.bond, dec())} to ${units(after.bond, dec())} ${qsym()} (read back).`
        : kind === "unbond"
          ? html`Pending unbond ${units(after.unbondAmount, dec())} ${qsym()}, withdrawable from ${when(after.unbondReadyAt)}; the bond stays ${units(after.bond, dec())} ${qsym()} and slashable until then (read back).`
          : html`Bond ${units(before.bond, dec())} to ${units(after.bond, dec())} ${qsym()}; withdrawn to your wallet (read back).`;
    S.vOut = html`<div class="panel-b">${banner("info", html`${label}: ${txLink(c.signature)}`, what)}</div>`;
    refreshBalances();
  } catch (e) {
    S.vOut = errBox(e, (e as any).logs);
  }
  renderVerifier();
}

// ------------------------------------------------------------------------------------------------
// identity (identity plan I1): rotate, revoke, two-step owner transfer

function renderIdentity() {
  const rec = S.irec;
  const k = S.ikey;
  const mine = !!rec && rec.owner === me();
  const pendingMe = !!rec && !!rec.pendingOwner && rec.pendingOwner === me();
  let body: Raw;
  if (!k) body = html`<div class="dim">Enter an agent id (its original public key) to read its identity from the registry.</div>`;
  else if (rec === undefined) body = html`<div class="dim">Reading the registry…</div>`;
  else if (rec === null) body = html`<div class="dim">No Agent record for this key on ${netName()}.</div>`;
  else {
    const revoked = rec.signingKey === null;
    body = html`${kv([
        ["Agent id", addr(rec.agent)],
        ["Record layout", rec.version === 2 ? badge("Agent v2", "good") : badge("v1: needs migrate_agent", "warn")],
        ["Signing key", revoked ? badge("revoked", "bad") : html`${addr(rec.signingKey)} ${rec.signingKey === rec.agent ? badge("the agent key", "info") : badge("rotated", "info")}`],
        ["Key changes", html`<span class="num">${rec.keySeq}</span>${rec.keyChangedAt > 0n ? html`, last ${when(rec.keyChangedAt)}` : ""}`],
        ["Owner", html`${addr(rec.owner)} ${mine ? badge("your wallet", "good") : badge("another wallet", "warn")}`],
        ["Controller since", when(rec.ownerSince)],
        ["Pending owner", rec.pendingOwner ? html`${addr(rec.pendingOwner)} ${pendingMe ? badge("your wallet", "good") : ""}` : "none"],
        ["Profile digest", rec.profileDigest ? html`<span class="num" title="${rec.profileDigest}">${rec.profileDigest.slice(0, 16)}…</span> (seq ${rec.profileSeq})` : "none"],
      ])}
      ${rec.version === 1 ? html`<div class="wl-row" style="margin-top:10px">${btn("i-migrate", "Grow to Agent v2 (migrate_agent)", { disabled: !S.account ? "connect a wallet" : false })}</div>` : ""}
      ${mine && rec.version === 2
        ? html`<div class="wl-2" style="margin-top:12px">
            <div><label class="wl-field"><span class="eyebrow">New signing key (public key)</span><input name="i_newkey" placeholder="from lineage-worker keygen, or the hosted runtime" spellcheck="false"></label>
              <div class="wl-row" style="margin-top:8px">${btn("i-rotate", "Sign rotate as owner", { primary: true })}</div></div>
            <div><span class="eyebrow">Leaked key</span><div class="wl-fine" style="margin:6px 0">Revoking stops Core from accepting any request for this agent until you rotate to a new key.</div>
              <div class="wl-row">${btn("i-revoke", "Revoke signing key", { disabled: revoked ? "already revoked" : false })}</div></div>
          </div>
          <div id="w-id-cosign">${S.ipartial && S.ipartial.agent === rec.agent ? rotateCosignView() : ""}</div>
          <div class="wl-2" style="margin-top:12px">
            <div><label class="wl-field"><span class="eyebrow">Transfer: proposed new owner (wallet address)</span><input name="i_owner" spellcheck="false" placeholder="base58 wallet address"></label>
              <div class="wl-row" style="margin-top:8px">${btn("i-propose", "Propose owner")}${rec.pendingOwner ? btn("i-cancel", "Cancel proposal") : ""}</div></div>
            <div class="wl-fine">Nothing changes until the proposed wallet accepts. The transfer is public: the record's controller-since time restarts, and the agent's reputation credential shows it, so readers can tell earlier history from the new controller's. The bond and wallet payouts follow the owner; the signing key does not (rotate it after a transfer).</div>
          </div>`
        : ""}
      ${pendingMe ? html`<div style="margin-top:12px">${banner("info", "This wallet is the proposed owner.", "Accepting makes it the owner from now on.")}<div class="wl-row" style="margin-top:8px">${btn("i-accept", "Accept ownership", { primary: true })}</div></div>` : ""}
      <div class="eyebrow wl-sub" style="margin-top:12px">GitHub identity (SPEC 13.9)</div><div id="w-gh"><span class="dim">Reading the identity service…</span></div>
      <div id="w-iout">${S.iOut ?? ""}</div>`;
  }
  set(
    "w-id",
    html`<div class="panel-b"><label class="wl-field"><span class="eyebrow">Agent id</span><input name="i_key" placeholder="base58 agent id" value="${esc(k)}" spellcheck="false"></label>
      <div class="wl-row" style="margin-top:8px">${btn("i-lookup", "Look up")}</div></div>
    <div class="panel-b" style="padding-top:0">${body}</div>`,
  );
  if (rec && rec.kind === "launched") showIdentity("w-gh", rec.agent, rec.mint, true);
  else if (rec) set("w-gh", html`<span class="dim">A verifier has no GitHub identity.</span>`);
  set(
    "w-id-kit",
    html`<div class="panel-b"><div class="kit" style="margin-top:0">
      <div class="cmd"><div class="cmd-h"><span>1. Make the new key where it will live (a worker machine, or the hosted runtime)</span></div><pre>${W} keygen --out ~/.lineage/keys/agent-next.json</pre></div>
      <div class="cmd"><div class="cmd-h"><span>2. After your wallet signs rotate: the new key co-signs and sends</span></div><pre>${W} cosign --key ~/.lineage/keys/agent-next.json --tx &lt;from this page&gt;</pre></div>
      <div class="cmd"><div class="cmd-h"><span>3. Run the worker with the new key under the same agent id</span></div><pre>${W} run --core &lt;core&gt; --key ~/.lineage/keys/agent-next.json --agent &lt;agent id&gt;</pre></div>
    </div>
    <ol class="wl-steps">
      <li>Rotation needs two signatures: your wallet as owner, and the new key, which proves it is held by whoever will run the agent. Nobody can point an agent at a key they do not hold.</li>
      <li>The agent id stays the original public key forever: candidates, generations, payouts and reputation keep naming it.</li>
      <li>Core follows the registry on its next chain read; until then the old key still works. Revocation takes effect the same way.</li>
    </ol></div>`,
  );
}

function rotateCosignView(): Raw {
  const pz = S.ipartial!;
  const cmd = `${W} cosign --key ~/.lineage/keys/agent-next.json --tx ${pz.b64}`;
  return html`<div class="wl-cosign" style="margin-top:10px">${banner("info", "Signed by your wallet. Now the new key co-signs and sends.", html`Run this where the new key ${addr(pz.newKey)} lives, within about a minute (the blockhash expires; sign again if it does). The worker checks that the transaction is a <span class="num">rotate_agent_key</span> to its own key and that your signature verifies before it adds its own. This page watches the registry.`)}
    <div class="cmd"><div class="cmd-h"><span>Co-sign with the new key</span><button type="button" class="copy" data-copy="${cmd}" aria-label="Copy command">${icon.copy} Copy</button></div><pre class="wl-wrap">${cmd}</pre></div>
    <div class="wl-fine" id="w-id-wait">Waiting for the registry to show the new key…</div></div>`;
}

async function iLookup() {
  S.ikey = val("i_key");
  S.iOut = null;
  if (!S.ikey) return renderIdentity();
  try {
    addressBytes(S.ikey);
  } catch {
    S.irec = undefined;
    set("w-id", html`<div class="panel-b">${errBox("Not a base58 public key.")}</div>`);
    return;
  }
  S.irec = undefined;
  renderIdentity();
  S.irec = await reader.agent(S.ikey).catch(() => null);
  renderIdentity();
}

/** Owner (or proposed owner, or anyone for migrate) signs one registry instruction here. */
async function iTx(kind: "revoke" | "propose" | "cancel" | "accept" | "migrate") {
  if (!requireReady() || !S.irec) return;
  const agent = S.irec.agent;
  let ix: Ix;
  let label: string;
  if (kind === "propose") {
    const to = val("i_owner");
    try {
      addressBytes(to);
    } catch {
      S.iOut = errBox("The proposed owner must be a base58 wallet address.");
      return renderIdentity();
    }
    ix = registry.proposeOwner({ owner: me()!, agent, newOwner: to });
    label = `propose_owner ${short(agent)} to ${short(to)}`;
  } else if (kind === "cancel") {
    ix = registry.proposeOwner({ owner: me()!, agent, newOwner: "11111111111111111111111111111111" });
    label = `propose_owner ${short(agent)}: cancel`;
  } else if (kind === "accept") {
    ix = registry.acceptOwner({ newOwner: me()!, agent });
    label = `accept_owner ${short(agent)}`;
  } else if (kind === "migrate") {
    ix = registry.migrateAgent({ payer: me()!, agent });
    label = `migrate_agent ${short(agent)}`;
  } else {
    ix = registry.revokeAgentKey({ owner: me()!, agent });
    label = `revoke_agent_key ${short(agent)}`;
  }
  try {
    const b = await buildAndSimulate(me()!, [ix]);
    if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [ix] });
    const c = r.confirmed!;
    logSig(label, c.signature, c.fee, !c.err);
    if (c.err) throw Object.assign(new Error(`${label} failed: ${JSON.stringify(c.err)}`), { logs: c.logs });
    S.irec = await reader.agent(agent);
    const a = S.irec!;
    const what =
      kind === "revoke"
        ? html`Signing key revoked (read back: ${a.signingKey === null ? "none" : a.signingKey}); key changes ${a.keySeq}. Core refuses the agent's requests after its next chain read.`
        : kind === "accept"
          ? html`Owner is now ${addr(a.owner)}, controller since ${when(a.ownerSince)} (read back).`
          : kind === "migrate"
            ? html`Record grown to Agent v2; signing key ${addr(a.signingKey)} (read back).`
            : html`Pending owner ${a.pendingOwner ? addr(a.pendingOwner) : "none"} (read back); the owner is still ${addr(a.owner)}.`;
    S.iOut = html`<div class="panel-b">${banner("info", html`${label}: ${txLink(c.signature)}`, what)}</div>`;
    refreshBalances();
  } catch (e) {
    S.iOut = errBox(e, (e as any).logs);
  }
  renderIdentity();
}

async function iRotate() {
  if (!requireReady() || !S.irec) return;
  const agent = S.irec.agent;
  const newKey = val("i_newkey");
  try {
    addressBytes(newKey);
  } catch {
    S.iOut = errBox("The new signing key must be a base58 public key.");
    return renderIdentity();
  }
  const ix = registry.rotateAgentKey({ owner: me()!, agent, newKey });
  try {
    set("w-id-cosign", html`<span class="dim">Simulating…</span>`);
    const b = await buildAndSimulate(me()!, [ix]);
    // the new key's signature is missing in simulation (sigVerify off), so a program error still shows here
    if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [ix], leaveFor: newKey, onStatus: (m) => set("w-id-cosign", html`<span class="dim">${m}</span>`) });
    S.ipartial = { b64: base64Encode(r.partial!), until: r.lastValidBlockHeight, agent, newKey };
    set("w-id-cosign", rotateCosignView());
    watchRotation(agent, newKey, S.irec.keySeq, r.lastValidBlockHeight);
  } catch (e) {
    set("w-id-cosign", errBox(e, (e as any).logs));
  }
}

async function watchRotation(agent: string, newKey: string, seq0: number, lastValid: number) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    if (S.ikey !== agent || !S.ipartial) return;
    const rec = await reader.agent(agent).catch(() => null);
    if (rec && rec.signingKey === newKey && rec.keySeq > seq0) {
      S.ipartial = null;
      S.irec = rec;
      const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [registryPdas.agent(agent), { limit: 1, commitment: "confirmed" }]).catch(() => []);
      if (sigs[0]) {
        const t = await rpc.getTransaction(sigs[0].signature).catch(() => null);
        logSig(`rotate_agent_key ${short(agent)} to ${short(newKey)} (sent by lineage-worker cosign)`, sigs[0].signature, t?.meta?.fee, !sigs[0].err);
      }
      S.iOut = html`<div class="panel-b">${banner("info", "Rotated: the new key co-signed.", html`Signing key ${addr(newKey)}, key changes ${rec.keySeq} (read back). The agent id is unchanged.`)}</div>`;
      return renderIdentity();
    }
    const h = await rpc.getBlockHeight().catch(() => 0);
    if (h > lastValid) {
      S.ipartial = null;
      set("w-id-cosign", errBox("The blockhash expired before the new key sent it; nothing was charged. Sign rotate again."));
      return;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// claims

async function loadClaims() {
  const a = me();
  if (!a) return set("w-claims", html`<div class="panel-b dim">Connect a wallet to look up its leaves.</div>`);
  set("w-claims", html`<div class="panel-b dim">Finding agents owned or launched by this wallet, and Core's epochs…</div>`);
  try {
    const owned = await rpc.getProgramAccounts(REGISTRY_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("Agent") }, { offset: 40, bytes: addressBytes(a) }] });
    const launched = await rpc.getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }, { offset: 72, bytes: addressBytes(a) }] });
    const agents = new Map<string, string>();
    for (const x of owned) agents.set(decodeAgent(x.data).agent, "owner");
    for (const x of launched) {
      const l = decodeAgentLaunch(x.data);
      if (!agents.has(l.agent)) agents.set(l.agent, "launcher");
    }
    let epochs: any[];
    try {
      const r = await fetch("/api/epochs");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      epochs = await r.json();
    } catch (e) {
      S.claims = { rows: [], note: html`Core did not answer (${(e as Error).message}); proofs come from Core, so leaves are TBA until it does. ${agents.size} agent${agents.size === 1 ? "" : "s"} on chain are linked to this wallet.` };
      return renderClaims(agents);
    }
    const rows: any[] = [];
    for (const ep of epochs.filter((e) => e.status === "closed")) {
      const onchain = await reader.epoch(ep.n);
      if (!onchain) continue;
      for (const agent of agents.keys()) {
        const r = await fetch(`/api/epochs/${ep.n}/proofs/${agent}`);
        if (!r.ok) continue;
        for (const p of (await r.json()) as any[]) {
          let c, problem: string | null = null;
          try {
            if (p.root !== onchain.payoutRoot) throw new Error("Core's root differs from the root posted on chain");
            c = claimFromCoreProof(p);
          } catch (e) {
            problem = (e as Error).message;
          }
          const [receipt] = c ? await reader.claimReceipts(ep.n, [c.leaf]) : [null];
          rows.push({ epoch: ep.n, agent, role: agents.get(agent), dest: p.dest, amount: BigInt(p.amount), claim: c, receipt, problem });
        }
      }
    }
    S.claims = { rows, note: null };
    renderClaims(agents);
  } catch (e) {
    set("w-claims", html`<div class="panel-b">${errBox(e)}</div>`);
  }
}

function renderClaims(agents: Map<string, string>) {
  const c = S.claims!;
  const open = c.rows.filter((r) => !r.receipt && !r.problem);
  set(
    "w-claims",
    html`<div class="stats" style="--n:3">
        ${stat("Linked agents", String(agents.size), "owned (verifier) or launched by this wallet", "sm")}
        ${stat("Leaves", String(c.rows.length), "in epochs posted on chain", "sm")}
        ${stat("Claimable", html`${units(open.reduce((n, r) => n + r.amount, 0n), dec())}<span class="unit">${qsym()}</span>`, `${open.length} unclaimed ${open.length === 1 ? "leaf" : "leaves"}`, "sm")}
      </div>
      ${c.note ? html`<div class="panel-b">${banner("warn", c.note)}</div>` : ""}
      ${c.rows.length
        ? html`<div class="tw"><table class="t"><thead><tr><th>Epoch</th><th>Agent</th><th class="hide-sm">Destination</th><th class="right">Amount</th><th>Status</th></tr></thead><tbody>
          ${c.rows.map(
            (r, i) => html`<tr><td class="num">${r.epoch}</td><td>${addr(r.agent)}<div class="sub">${r.role}</div></td><td class="wrap hide-sm">${r.dest.replace(r.agent, short(r.agent))}</td>
              <td class="right">${tl(r.amount)}</td>
              <td>${r.problem ? badge(r.problem, "bad") : r.receipt ? badge("claimed on chain", "good", icon.check) : btn("claim", "Claim", { primary: true, data: { i: String(i) } })}</td></tr>`,
          )}</tbody></table></div>`
        : c.note
          ? ""
          : html`<div class="panel-b dim">No leaves for this wallet's agents in any epoch Core closed and posted on chain. Replays and accepted generations earn leaves at the next epoch close.</div>`}
      <div class="panel-b wl-row">${btn("claims-reload", "Look again")}<span class="wl-why">Core closes epochs on a timer; new leaves appear after a close is posted on chain.</span></div>
      <div id="w-claim-out">${S.claimOut ?? ""}</div>`,
  );
}

async function claim(i: number) {
  const r = S.claims?.rows[i];
  if (!r?.claim || !requireReady()) return;
  const c = r.claim;
  let destToken: string;
  const pre: Ix[] = [];
  if (r.dest.endsWith(":compute")) destToken = launchPdas.computeVault(r.agent);
  else {
    const owner = r.dest.startsWith("wallet:") ? r.dest.slice(7) : (await reader.agent(r.agent))!.owner;
    destToken = ata(owner, lineMint(), T22);
    pre.push(token.createAtaIdempotent(me()!, owner, lineMint(), T22));
  }
  const ixs = [...pre, registry.claim({ payer: me()!, mint: lineMint(), ...c, destToken, tokenProgram: T22 })];
  try {
    const b0 = (await reader.tokenBalance(destToken)) ?? 0n;
    const b = await buildAndSimulate(me()!, ixs);
    if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
    const s = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs });
    const cf = s.confirmed!;
    logSig(`claim epoch ${r.epoch} ${r.dest.split(":").pop()}`, cf.signature, cf.fee, !cf.err);
    if (cf.err) throw Object.assign(new Error(`claim failed: ${JSON.stringify(cf.err)}`), { logs: cf.logs });
    const b1 = (await reader.tokenBalance(destToken)) ?? 0n;
    S.claimOut = html`<div class="panel-b">${banner("info", html`Claimed epoch ${r.epoch}: ${txLink(cf.signature)}`, html`${addr(destToken)} received ${units(b1 - b0, dec())} ${qsym()} (read back)${b1 - b0 === r.amount ? ", exactly the leaf amount" : ""}.`)}</div>`;
    refreshBalances();
    await loadClaims();
  } catch (e) {
    S.claimOut = html`<div class="panel-b">${errBox(e, (e as any).logs)}</div>`;
    set("w-claim-out", S.claimOut);
  }
}

// ------------------------------------------------------------------------------------------------
// bounties (identity plan C6, SPEC 14.7)

const HEX64 = /^[0-9a-f]{64}$/;
const COND_NAME = ["commitment", "target"];
/** Self-hosted agents this wallet launched: the ones it can open bounties for (hosted agents' bounties are opened by the runtime). */
const myPayers = () => S.launches.filter((l) => S.owners.get(l.agent) === me() && !l.hosted);
const mintOf = (agent: string) => S.launches.find((l) => l.agent === agent)?.mint ?? null;

async function loadBounties() {
  try {
    const [cfg, list] = await Promise.all([reader.bountyConfig(), reader.bounties()]);
    S.bcfg = cfg;
    S.bounties = list.sort((a, b) => Number(b.createdAt - a.createdAt));
    S.bErr = null;
  } catch (e) {
    S.bErr = errBox(e);
  }
  renderBountyForm();
  renderBounties();
}

function renderBountyForm() {
  const c = S.bcfg;
  if (c === undefined) return set("w-bopen", html`<div class="panel-b dim">Reading the bounty config…</div>`);
  if (c === null)
    return set("w-bopen", html`<div class="panel-b">${banner("warn", "No BountyConfig on this cluster", "The launch admin has not run set_bounty_config yet, so open_bounty refuses every bounty.")}</div>`);
  const payers = myPayers();
  const cfgView = html`<div class="params wl-params">
      <div><span class="k">max_bounty_out_bps</span><span class="v num">${c.maxBountyOutBps}</span></div>
      <div><span class="k">window</span><span class="v num">${c.windowS} s</span></div>
      <div><span class="k">self-hosted payee cap</span><span class="v">${c.selfHostedInCap === 0n ? html`<span class="faint">not paid</span>` : tl(c.selfHostedInCap)}</span></div>
      <div><span class="k">deadline</span><span class="v num">${c.minTtlS} to ${c.maxTtlS} s</span></div>
      <div><span class="k">refund grace</span><span class="v num">${c.refundGraceS} s</span></div>
      <div><span class="k">min amount</span><span class="v">${tl(c.minAmount)}</span></div>
      <div><span class="k">paused</span><span class="v">${c.paused ? badge("paused", "bad") : badge("no", "good")}</span></div>
    </div>`;
  const form = !S.account
    ? html`<div class="panel-b dim">Connect a wallet to open a bounty for an agent it launched.</div>`
    : !payers.length
      ? html`<div class="panel-b dim">This wallet owns no self-hosted agent. A bounty is paid from an agent's compute vault: the agent's current registry owner signs for a self-hosted agent, the hosted runtime for a hosted one.</div>`
      : html`<form class="wl-form panel-b" autocomplete="off" data-wallet-form="bounty">
        <label><span class="eyebrow">Paying agent (its compute vault)</span><select name="b_payer">${payers.map((l) => html`<option value="${l.agent}">${S.metas.get(l.mint)?.symbol ?? short(l.mint)} · ${short(l.agent)}</option>`)}</select></label>
        <div class="wl-2">
          <label><span class="eyebrow">Amount (${qsym()})</span><input name="b_amount" inputmode="decimal" placeholder="1"></label>
          <label><span class="eyebrow">Deadline (hours from now)</span><input name="b_hours" inputmode="decimal" value="${String(Math.max(1, Math.min(72, Math.ceil(c.maxTtlS / 3600))))}"></label>
        </div>
        <label><span class="eyebrow">Payee agent</span><input name="b_payee" placeholder="leave empty: any agent credited as author" spellcheck="false"><span class="wl-help">A named payee is paid if credited in any role (author, reviewer, harness, finder); it must be a launched agent, since payment goes to its compute vault.</span></label>
        <label><span class="eyebrow">Lineage id</span><input name="b_lineage" placeholder="64 hex characters" spellcheck="false"></label>
        <fieldset><legend class="eyebrow">Condition</legend>
          <label class="radio"><input type="radio" name="b_kind" value="target" checked> <span><b>Target.</b> Any accepted generation on the lineage for this target (metric name, or test ids separated by commas); empty means any target.</span></label>
          <label class="radio"><input type="radio" name="b_kind" value="commitment"> <span><b>Commitment.</b> The accepted generation of one candidate commitment (64 hex).</span></label>
        </fieldset>
        <label><span class="eyebrow">Target or commitment</span><input name="b_value" spellcheck="false"></label>
        <label><span class="eyebrow">Terms (stored in Core; the account holds their sha256)</span><input name="b_note" maxlength="280" placeholder="what you want done"></label>
        <div class="wl-row">${btn("b-open", "Sign open_bounty", { primary: true, disabled: c.paused ? "bounties are paused" : false })}</div>
      </form>`;
  set("w-bopen", html`${cfgView}${form}<div id="w-bout">${S.bOut ?? ""}</div>`);
}

function condText(b: BountyAccount): Raw {
  if (b.conditionKind === COND.commitment) return html`commitment <span class="num" title="${b.conditionValue ?? ""}">${short(b.conditionValue ?? "")}</span>`;
  return b.conditionValue ? html`target <span class="num" title="${b.conditionValue}">#${b.conditionValue.slice(0, 8)}</span>` : html`any target`;
}

function renderBounties() {
  if (S.bErr) return set("w-blist", html`<div class="panel-b">${S.bErr}</div>`);
  const list = S.bounties;
  if (!list) return set("w-blist", html`<div class="panel-b dim">Reading Bounty accounts…</div>`);
  if (!list.length) return set("w-blist", html`<div class="panel-b dim">No bounty has been opened on ${netName()} yet.</div>
    <div class="panel-b wl-row">${btn("b-reload", "Look again")}</div>`);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const grace = BigInt(S.bcfg?.refundGraceS ?? 0);
  set(
    "w-blist",
    html`<div class="tw"><table class="t" data-bounties><thead><tr><th>Bounty</th><th>Condition</th><th class="right">Amount</th><th>Status</th></tr></thead><tbody>
      ${list.map((b) => {
        const rel = S.bRelease.get(b.address);
        const refundable = b.status === "open" && nowS > b.deadline + grace;
        // cancel_bounty signer: the payer's current registry owner for a self-hosted payer (audit A1-03), not the original opener
        const cancellable = b.status === "open" && myPayers().some((l) => l.agent === b.payer) && S.reg && S.reg.epochsPosted === b.epochsPostedAtOpen;
        const actions = b.status !== "open"
          ? ""
          : html`<div class="wl-row" style="margin-top:6px">${btn("b-find", "Find release", { data: { i: b.address } })}${refundable ? btn("b-refund", "Refund", { data: { i: b.address } }) : ""}${cancellable ? btn("b-cancel", "Cancel", { data: { i: b.address } }) : ""}</div>`;
        return html`<tr data-bounty="${b.address}"><td>${addr(b.address)}<div class="sub">payer ${short(b.payer)} · ${b.payee ? html`payee ${short(b.payee)}` : "any author"}</div>
            <div class="sub">deadline ${when(b.deadline)}</div></td>
          <td class="wrap">${condText(b)}<div class="sub">lineage ${short(b.lineageId)} · from epoch ${String(b.minEpoch)}</div></td>
          <td class="right">${tl(b.amount)}</td>
          <td>${b.status === "open" ? badge("open", "info") : b.status === "released" ? badge(`released to ${short(b.releasedTo ?? "")}`, "good", icon.check) : badge(b.status, "warn")}${actions}
            ${rel ? html`<div class="wl-brel">${rel.note ? html`<div class="wl-fine">${rel.note}</div>` : ""}${rel.rows.map((r, j) => html`<div class="wl-row" style="margin-top:6px">${r.problem
              ? badge(r.problem, "bad")
              : btn("b-release", html`Release to ${short(r.payee)} (epoch ${r.epoch})`, { primary: true, data: { i: `${b.address}:${j}` } })}</div>`)}</div>` : ""}</td></tr>`;
      })}</tbody></table></div>
    <div class="panel-b wl-row">${btn("b-reload", "Look again")}<span class="wl-why">Every row is read from chain; release proofs come from Core and are checked against the record root on chain before they are offered.</span></div>`,
  );
}

async function bSend(label: string, ixs: Ix[], units = 300_000) {
  const b = await buildAndSimulate(me()!, ixs, units);
  if (b.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(b.sim.err)}`), { logs: b.sim.logs });
  const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs, units });
  const c = r.confirmed!;
  logSig(label, c.signature, c.fee, !c.err);
  if (c.err) throw Object.assign(new Error(`${label} failed: ${JSON.stringify(c.err)}`), { logs: c.logs });
  return c;
}

async function bOpen() {
  if (!requireReady() || !S.bcfg) return;
  try {
    const payer = val("b_payer");
    const l = S.launches.find((x) => x.agent === payer);
    if (!l) throw new Error("pick a paying agent");
    const amount = parseUnits(val("b_amount"), dec());
    if (!amount) throw new Error(`enter a positive ${qsym()} amount`);
    const hours = Number(val("b_hours"));
    if (!(hours > 0)) throw new Error("enter the deadline in hours");
    const lineage = val("b_lineage").toLowerCase();
    if (!HEX64.test(lineage)) throw new Error("the lineage id is 64 hex characters");
    const kind = S.root?.querySelector<HTMLInputElement>('[name="b_kind"]:checked')?.value === "commitment" ? COND.commitment : COND.target;
    const raw0 = val("b_value");
    let value: string | null = null;
    let target: string | string[] | null = null;
    if (kind === COND.commitment) {
      if (!HEX64.test(raw0.toLowerCase())) throw new Error("a commitment is 64 hex characters");
      value = raw0.toLowerCase();
    } else if (raw0) {
      const parts = raw0.split(",").map((x) => x.trim()).filter(Boolean);
      target = parts.length === 1 && !raw0.includes(",") ? parts[0]! : parts;
      value = targetDigest(target);
    }
    const payee = val("b_payee") || null;
    const deadline = BigInt(Math.floor(Date.now() / 1000 + hours * 3600));
    const terms = { v: 1, note: val("b_note") || null, lineage_id: lineage, condition: COND_NAME[kind], value: kind === COND.commitment ? value : target, payee, amount: amount.toString(), deadline: Number(deadline) };
    const bountyId = BigInt(Date.now());
    const ix = bounty.open({ opener: me()!, payer, payerMint: l.mint, lineMint: lineMint(), lineTokenProgram: T22,
      args: { bountyId, payee, amount, termsDigest: hashJson(terms), conditionKind: kind, lineageId: lineage, conditionValue: value, deadline } });
    const v0 = (await reader.tokenBalance(launchPdas.computeVault(payer))) ?? 0n;
    const c = await bSend(`open_bounty ${units(amount, dec())} ${qsym()} from ${short(payer)}`, [ix]);
    const addrB = bountyPdas.bounty(payer, bountyId);
    const [acct, v1, esc0] = await Promise.all([reader.bounty(addrB), reader.tokenBalance(launchPdas.computeVault(payer)), reader.tokenBalance(bountyPdas.vault(addrB))]);
    // Core keeps the terms once it has mirrored the account (its next chain sync); try now, say so if not yet.
    let termsNote: Raw = html`Terms stored in Core.`;
    try {
      const r = await fetch(`/api/bounties/${addrB}/terms`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(terms) });
      if (!r.ok) termsNote = html`Core has not mirrored the bounty yet (HTTP ${r.status}); the terms digest is on chain, and the terms can be sent again once it has.`;
    } catch {
      termsNote = html`Core did not answer; the terms digest is on chain.`;
    }
    S.bOut = html`<div class="panel-b">${banner("info", html`Opened bounty ${addr(addrB)}: ${txLink(c.signature)}`,
      html`The compute vault went from ${units(v0, dec())} to ${units(v1 ?? 0n, dec())} ${qsym()} and the escrow holds ${units(esc0 ?? 0n, dec())} ${qsym()} (read back); qualifying generations from epoch ${String(acct?.minEpoch ?? "TBA")} on. ${termsNote}`)}</div>`;
  } catch (e) {
    S.bOut = html`<div class="panel-b">${errBox(e, (e as any).logs)}</div>`;
  }
  renderBountyForm();
  await loadBounties();
}

async function bFind(address: string) {
  const b = S.bounties?.find((x) => x.address === address);
  if (!b) return;
  const out: { rows: any[]; note: Raw | null } = { rows: [], note: null };
  try {
    const r = await fetch(`/api/bounties/${address}/release`);
    if (!r.ok) throw new Error(`Core answered HTTP ${r.status}`);
    const body = await r.json();
    for (const c of body.candidates as any[]) {
      const ep = await reader.epoch(c.epoch);
      for (const payee of c.payees as string[]) {
        let problem: string | null = null;
        try {
          if (!ep?.recordRoot) throw new Error(`epoch ${c.epoch} has no record root on chain`);
          if (ep.recordRoot !== c.record_root) throw new Error("Core's record root differs from the one on chain");
          if (ep.postedAt > b.deadline) throw new Error("posted after the deadline");
          releaseFromContribution(c.contribution, c.proof, ep.recordRoot);
          if (!mintOf(payee)) throw new Error("the payee has no compute vault (not a launched agent)");
        } catch (e) {
          problem = (e as Error).message;
        }
        out.rows.push({ epoch: c.epoch, payee, contribution: c.contribution, proof: c.proof, problem });
      }
    }
    if (!out.rows.length) out.note = html`No accepted generation meets this bounty yet. Core offers one once its epoch is closed and posted on chain.`;
  } catch (e) {
    out.note = html`Release proofs come from Core: ${(e as Error).message}.`;
  }
  S.bRelease.set(address, out);
  renderBounties();
}

async function bRelease(key: string) {
  if (!requireReady()) return;
  const [address, j] = key.split(":") as [string, string];
  const b = S.bounties?.find((x) => x.address === address);
  const row = S.bRelease.get(address)?.rows[Number(j)];
  if (!b || !row) return;
  try {
    const payeeMint = mintOf(row.payee)!;
    const ix = bounty.release({ caller: me()!, payer: b.payer, bountyId: b.bountyId, opener: b.opener, payee: row.payee, payeeMint, lineMint: lineMint(),
      contribution: row.contribution, proof: row.proof, lineTokenProgram: T22 });
    const v0 = (await reader.tokenBalance(launchPdas.computeVault(row.payee))) ?? 0n;
    const c = await bSend(`release_bounty ${short(address)} to ${short(row.payee)}`, [ix], 400_000);
    const [after, v1] = await Promise.all([reader.bounty(address), reader.tokenBalance(launchPdas.computeVault(row.payee))]);
    S.bOut = html`<div class="panel-b">${banner("info", html`Released ${addr(address)}: ${txLink(c.signature)}`,
      html`The payee's compute vault received ${units((v1 ?? 0n) - v0, dec())} ${qsym()}${(v1 ?? 0n) - v0 === b.amount ? ", exactly the escrow" : ""}; status ${after?.status ?? "TBA"} (read back).`)}</div>`;
    S.bRelease.delete(address);
  } catch (e) {
    S.bOut = html`<div class="panel-b">${errBox(e, (e as any).logs)}</div>`;
  }
  await loadBounties();
}

async function bBack(address: string, kind: "refund" | "cancel") {
  if (!requireReady()) return;
  const b = S.bounties?.find((x) => x.address === address);
  if (!b) return;
  try {
    const payerMint = mintOf(b.payer);
    if (!payerMint) throw new Error("the paying agent's launch was not found");
    const a = { payer: b.payer, payerMint, bountyId: b.bountyId, opener: b.opener, lineMint: lineMint(), lineTokenProgram: T22 };
    const ix = kind === "refund" ? bounty.refund(a) : bounty.cancel({ ...a, signer: me()! });
    const v0 = (await reader.tokenBalance(launchPdas.computeVault(b.payer))) ?? 0n;
    const c = await bSend(`${kind}_bounty ${short(address)}`, [ix]);
    const v1 = (await reader.tokenBalance(launchPdas.computeVault(b.payer))) ?? 0n;
    S.bOut = html`<div class="panel-b">${banner("info", html`${kind === "refund" ? "Refunded" : "Cancelled"} ${addr(address)}: ${txLink(c.signature)}`,
      html`${units(v1 - v0, dec())} ${qsym()} back in the paying agent's compute vault (read back).`)}</div>`;
  } catch (e) {
    S.bOut = html`<div class="panel-b">${errBox(e, (e as any).logs)}</div>`;
  }
  await loadBounties();
}

// ------------------------------------------------------------------------------------------------
// session log

function renderSigs() {
  if (!S.sigs.length) return set("w-sigs", html`<div class="panel-b dim">No transactions yet in this tab.</div>`);
  set(
    "w-sigs",
    html`<div class="tw"><table class="t" data-sigs><thead><tr><th>Time</th><th>What</th><th class="right">Fee</th><th>Signature</th></tr></thead><tbody>
      ${S.sigs.map((s) => html`<tr data-sig="${s.signature}"><td class="nowrap">${new Date(s.at).toLocaleTimeString()}</td><td class="wrap">${s.label} ${s.ok ? "" : badge("failed", "bad")}</td><td class="right num">${s.fee === undefined ? "TBA" : sol(BigInt(s.fee))}</td><td>${txLink(s.signature)}</td></tr>`)}
    </tbody></table></div>`,
  );
}

// ------------------------------------------------------------------------------------------------
// the launch wizard (docs/plans/APP-CONSOLIDATION.md, Stags step pattern)

const TEMPERS = ["aggressive", "balanced", "careful"] as const;
let tradingCfg: any = null;

async function loadTradingCfg() {
  for (let i = 0; i < 4 && !tradingCfg; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000 * i));
    tradingCfg = await fetch("/api/trading/config").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  renderTemper();
}

function temperPick(): string | null {
  return S.root?.querySelector<HTMLInputElement>('input[name="l_temp"]:checked')?.value ?? null;
}

/** The temperament the network will read from the soul: the rule of packages/core/src/scores.ts temperamentFromSoul. */
function effectiveTemper(doc: SoulDoc | null | undefined): string | null {
  const fallback = tradingCfg?.default_temperament ?? null;
  if (!doc) return fallback;
  const words = [...(doc.seed?.values ?? []), ...(doc.persona?.values ?? [])].map((v) => String(v).toLowerCase());
  if (typeof doc.seed?.vibe === "string") words.push(doc.seed.vibe.toLowerCase());
  const text = words.join(" ");
  if (/\b(careful|cautious|patient|conservative|prudent)\b/.test(text)) return "careful";
  if (/\b(balanced|steady|measured|moderate)\b/.test(text)) return "balanced";
  return fallback;
}

function renderTemper() {
  const c = tradingCfg;
  if (!c?.temperaments) return set("w-temp", html`<div class="wl-fine" style="margin-top:8px">Trading temperament: the trading config is not readable now (TBA); the agent takes the network default.</div>`);
  const cur = temperPick() ?? c.default_temperament;
  set(
    "w-temp",
    html`<fieldset class="lz-temp"><legend class="eyebrow">Trading temperament</legend>
      ${TEMPERS.filter((t) => c.temperaments[t]).map((t) => html`<label class="radio"><input type="radio" name="l_temp" value="${t}"${t === cur ? raw(" checked") : ""}> <span><b>${t[0]!.toUpperCase() + t.slice(1)}</b>${t === c.default_temperament ? html` <span class="mark">default</span>` : ""} <span class="dim">at most ${(c.temperaments[t].size_bps / 100).toFixed(c.temperaments[t].size_bps % 100 ? 2 : 0)}% of its trading equity per buy. ${c.temperaments[t].prompt.replace(/^[A-Za-z]+: /, "")}</span></span></label>`)}
      <div class="wl-fine" id="w-temp-eff"></div>
    </fieldset>`,
  );
  renderTemperEffect();
}

function renderTemperEffect() {
  const pick = temperPick();
  const eff = effectiveTemper(S.soul?.doc);
  set("w-temp-eff", !S.soul?.doc
    ? html`Recorded as a word in the soul's values when it is drafted; the network reads the temperament from the soul (its values and vibe), within the bounds of the trading config.`
    : eff === pick
      ? html`<span class="mark good">${icon.check} the soul reads as ${eff}</span>`
      : html`<span class="mark warn">${icon.warn} the soul reads as ${eff ?? "TBA"}, not ${pick}: its vibe or values name another temperament. Edit them and generate again.</span>`);
}

/** After a temperament change: keep the drafted soul's seed values in step (the soul is edited, not redrafted). */
function applyTemperToSoul() {
  if (!S.soul?.doc) return renderTemperEffect();
  const t = temperPick();
  const values = (S.soul.doc.seed.values ?? []).filter((v) => !TEMPERS.includes(v.toLowerCase() as (typeof TEMPERS)[number]));
  if (t && t !== "aggressive") values.push(t);
  S.soul.doc = { ...S.soul.doc, seed: { ...S.soul.doc.seed, values }, origin: { ...S.soul.doc.origin, by: "edited" } };
  S.soul.edited = true;
  S.draft = null;
  renderSoul();
  renderTemperEffect();
}

const IMG_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Why a step cannot be left yet, or null. */
function stepProblem(i: number): string | null {
  try {
    if (i === 0) {
      const name = val("l_name");
      if (!name) return "Name the coin.";
      if (new TextEncoder().encode(`${namePrefix()}${name}`).length > 32) return testLabels() ? "Name: at most 27 characters (the on-chain name is TEST + name, 32 bytes)." : "Name: at most 32 bytes.";
      if (!/^[A-Z0-9]{1,10}$/.test(val("l_symbol").toUpperCase())) return "Ticker: 1 to 10 characters, A to Z and 0 to 9.";
      if (S.image && (!IMG_TYPES.includes(S.image.type) || S.image.size > 256 * 1024)) return "Image: PNG, JPEG or WebP, at most 256 KB.";
      linksTyped();
      return null;
    }
    if (i === 1) {
      if (!S.repo) return "Enter the GitHub repository.";
      if (S.repo.state === "checking") return "Checking the repository…";
      if (S.repo.state === "bad") return S.repo.msg;
      return null;
    }
    if (i === 2) {
      if (S.bannerFile && (!IMG_TYPES.includes(S.bannerFile.type) || S.bannerFile.size > 1024 * 1024)) return "Banner: PNG, JPEG or WebP, at most 1 MB.";
      if (!S.soul?.doc) return S.soul ? "The soul draft has problems; fix the seed and generate again." : "Generate the soul from the seed.";
      if (M_ready() && !modelChoice()) return "Pick a model that can run.";
      return null;
    }
    if (i === 3) return null;
    if (i === 4) {
      if (!S.account) return "Connect a wallet (the Connect button above) to fund the launch.";
      const dep = depositBase(val("l_deposit"), dec());
      const typed = val("l_alloc");
      const alloc = typed && typed !== "0" ? parseUnits(typed, dec()) : 0n;
      if (alloc === null) return `Trading allocation: a positive ${qsym()} amount, or leave it empty.`;
      // paid by swap (mainnet), that part needs no quote balance
      const need = (payAsset(val("l_deposit_pay")) === "LINE" ? dep : 0n) + (payAsset(val("l_alloc_pay")) === "LINE" ? alloc : 0n);
      if (S.line !== null && S.line < need) return `Your wallet holds ${units(S.line, dec())} ${qsym()}; the deposit${alloc ? " and the allocation" : " needs"}${alloc ? " need" : ""} ${units(need, dec())}.${topUp()}`;
      return null;
    }
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}
const M_ready = () => !!S.root?.querySelector('[name="l_model"]');

function furthest(): number {
  for (let i = 0; i < STEPS.length - 1; i++) if (stepProblem(i)) return i;
  return STEPS.length - 1;
}

function renderWizard() {
  if (S.page !== "launch" || !S.root) return;
  const far = furthest();
  const cur = Math.min(S.step, far);
  // a launch in flight or done keeps the Review step on screen
  const lock = !!(S.launched || S.sending);
  const step = lock ? STEPS.length - 1 : cur;
  const reach = lock ? STEPS.length - 1 : far;
  // patched in place, never re-created: a field's change event (fired as focus moves to a button)
  // re-renders here, and a replaced button would swallow the click that moved the focus
  const nav = S.root.querySelector<HTMLElement>("#lz-nav");
  if (nav && !nav.querySelector(".lz-step")) nav.innerHTML = stepNav(step, reach).s;
  for (const btn0 of nav?.querySelectorAll<HTMLButtonElement>(".lz-step") ?? []) {
    const i = Number(btn0.dataset.i);
    btn0.classList.toggle("on", i === step);
    btn0.classList.toggle("done", i < step);
    btn0.setAttribute("aria-selected", String(i === step));
    btn0.disabled = i > reach || (lock && i !== step);
    btn0.toggleAttribute("aria-disabled", btn0.disabled);
  }
  for (const c of S.root.querySelectorAll<HTMLElement>("[data-step]")) c.hidden = Number(c.dataset.step) !== step;
  const why = step < STEPS.length - 1 ? stepProblem(step) : null;
  const foot = S.root.querySelector<HTMLElement>("#lz-foot");
  if (foot) {
    if (S.launched) {
      if (foot.dataset.mode !== "done") foot.innerHTML = html`<div class="lz-btns"><a class="wl-btn" href="/profile">Your agents</a><a class="wl-btn primary" href="/tokens/${S.launched.mint}">Open its token page</a></div>`.s;
      foot.dataset.mode = "done";
    } else {
      if (foot.dataset.mode !== "nav")
        foot.innerHTML = html`<div class="lz-btns"><button type="button" class="wl-btn" data-act="lz-back">Back</button><button type="button" class="wl-btn primary" data-act="lz-next">Next</button></div><p class="lz-why" role="status"></p>`.s;
      foot.dataset.mode = "nav";
      const back = foot.querySelector<HTMLButtonElement>('[data-act="lz-back"]')!;
      const next = foot.querySelector<HTMLButtonElement>('[data-act="lz-next"]')!;
      back.disabled = step === 0 || !!S.sending;
      next.hidden = step >= STEPS.length - 1;
      next.disabled = !!why;
      const w = foot.querySelector<HTMLElement>(".lz-why")!;
      w.textContent = why ?? "";
      w.hidden = !why;
    }
  }
  const conn = S.root.querySelector<HTMLElement>("#lz-conn");
  if (conn) {
    const want = S.account ? "" : "prompt";
    if (conn.dataset.mode !== want)
      conn.innerHTML = S.account ? "" : html`<div class="lz-conn">${banner("info", "Launching needs a connected wallet", html`You can fill in every step now; funding and the launch itself need a wallet. <button type="button" class="wl-btn primary" data-act="me-connect">Connect</button>`)}</div>`.s;
    conn.dataset.mode = want;
  }
}

function go(i: number) {
  const prev = S.step;
  S.step = Math.max(0, Math.min(i, furthest()));
  renderWizard();
  if (S.step !== prev) window.scrollTo({ top: 0 });
  if (S.step === STEPS.length - 1) void enterReview();
}

async function enterReview() {
  renderReview();
  if (S.launched || S.sending) return;
  if (!S.draft) await launchReview();
}

function renderReview() {
  const r = S.repo;
  const soul = S.soul?.doc ?? null;
  const m = entryOf(soul?.model ?? modelChoice());
  let links: string[] = [];
  try {
    links = linksTyped();
  } catch {
    /* step 1 refuses it */
  }
  const identity = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"]:checked')?.value ?? "purchased";
  const hosted = (S.root?.querySelector<HTMLInputElement>('input[name="l_hosted"]:checked')?.value ?? "hosted") === "hosted";
  let dep: bigint | null = null;
  try {
    dep = depositBase(val("l_deposit"), dec());
  } catch {
    dep = null;
  }
  const alloc = val("l_alloc");
  const row = (k: string, v: unknown, step: number) => html`<div class="lz-rr"><span class="eyebrow">${k}</span><span class="lz-rv">${v}</span><button type="button" class="lz-edit" data-act="lz-go" data-i="${String(step)}">Edit</button></div>`;
  set(
    "w-review",
    html`<div class="lz-review">
      ${row("Coin", html`<b>${namePrefix()}${val("l_name")}</b> <span class="dim">${val("l_symbol").toUpperCase()}</span>`, 0)}
      ${row("Description", (S.root?.querySelector<HTMLTextAreaElement>('[name="l_desc"]')?.value ?? "").trim() || html`<span class="faint">none</span>`, 0)}
      ${row("Image", S.image ? `${S.image.name}, ${Math.ceil(S.image.size / 1024)} KB, uploaded as the avatar after the launch` : html`<span class="faint">none (generated pattern)</span>`, 0)}
      ${row("Links", links.length ? links.join(", ") : html`<span class="faint">none</span>`, 0)}
      ${row("Repository", r?.gh ? html`<a class="link" href="${r.gh.html_url}" target="_blank" rel="noopener">${r.gh.full_name}</a>, ${r.recipes?.length ? `${r.recipes.length} recipe${r.recipes.length === 1 ? "" : "s"} on Core` : "no recipe yet (setting up)"}` : "TBA", 1)}
      ${row("Class", val("l_class"), 1)}
      ${row("Soul", soul ? html`${soul.persona.name}, <span class="dim">${soul.persona.tagline}</span> <span class="wl-hash">${soulDigest(soul).slice(0, 16)}…</span>` : html`<span class="faint">none</span>`, 2)}
      ${row("Temperament", html`${effectiveTemper(soul) ?? "TBA"} <span class="dim">read from the soul</span>`, 2)}
      ${row("Model", m ? html`${m.name} <span class="dim">${m.provider}, ${priceText(m)}</span>` : html`<span class="faint">network default</span>`, 2)}
      ${row("Banner", S.bannerFile ? `${S.bannerFile.name}, ${Math.ceil(S.bannerFile.size / 1024)} KB` : html`<span class="faint">none</span>`, 2)}
      ${row("Runtime", hosted ? "hosted, bound to the hosted runtime after the launch" : "self-hosted, you run the worker", 2)}
      ${row("GitHub identity", identity === "purchased" ? "purchased account from the pool" : identity === "token" ? (val("l_token") ? "your token (bound after the launch)" : "your token, none pasted yet (app identity until you add one)") : "app identity", 3)}
      ${row("Prepaid credits", dep === null ? "TBA" : html`${tl(dep)} <span class="dim">${depositNote(val("l_deposit"))}${payAsset(val("l_deposit_pay")) !== "LINE" ? ` paid in ${val("l_deposit_pay")} (swap)` : ""}</span>`, 4)}
      ${row("Trading allocation", alloc && alloc !== "0" ? html`${alloc} ${qsym()} <span class="dim">a second transaction after the launch</span>` : html`<span class="faint">none</span>`, 4)}
    </div>`,
  );
}

// after the launch: a live status list

type StepState = "wait" | "ok" | "bad" | "skip";
const track = new Map<string, { s: StepState; t: Raw | string }>();
let trackTimer: ReturnType<typeof setTimeout> | null = null;

function renderTrack() {
  const L = S.launched;
  if (!L) return set("w-launch-steps", "");
  const order: [string, string][] = [
    ["confirmed", `Confirmed on ${netName()}`],
    ["vault", "Vault funded and awake"],
    ["github", "GitHub account"],
    ["runtime", "Runtime bound"],
    ["images", "Images"],
    ["session", "First session"],
    ["verdict", "First verdict"],
  ];
  set(
    "w-launch-steps",
    html`<div class="lz-track"><div class="eyebrow">After the launch</div><ol>${order.filter(([k]) => track.has(k)).map(([k, label]) => {
      const x = track.get(k)!;
      return html`<li class="lz-t ${x.s}" data-track="${k}" data-state="${x.s}"><span class="lz-ti">${x.s === "ok" ? icon.check : x.s === "bad" ? icon.x : x.s === "skip" ? icon.dot : html`<i class="lz-spin"></i>`}</span><span><b>${label}</b> <span class="dim">${x.t}</span></span></li>`;
    })}</ol></div>`,
  );
}
const mark = (k: string, st: StepState, t: Raw | string) => {
  track.set(k, { s: st, t });
  renderTrack();
};

async function trackLaunch(agent: string, mint: string, hosted: boolean, started: number) {
  if (trackTimer) clearTimeout(trackTimer);
  const tick = async () => {
    if (S.launched?.agent.id !== agent) return;
    try {
      const [la, vault, rec] = await Promise.all([reader.agentLaunch(mint), reader.tokenBalance(launchPdas.computeVault(agent)), reader.agent(agent)]);
      if (la?.awake && (vault ?? 0n) > 0n) mark("vault", "ok", html`${tl(vault)} in the compute vault, awake on chain`);
      else mark("vault", "wait", html`vault ${tl(vault)}, ${la?.awake ? "awake" : "asleep"}`);
      if (hosted) {
        if (rec?.signingKey && rec.signingKey !== agent) mark("runtime", "ok", html`signing key ${addr(rec.signingKey)}, the hosted runtime's`);
        else if (track.get("runtime")?.s !== "bad") mark("runtime", "wait", "waiting for the binding signature");
      }
      const id = await fetch(`/identity/agents/${agent}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (id) {
        const st = String(id.status);
        if (st === "ready") mark("github", "ok", html`${id.login ? html`<a class="link" href="${id.profile_url}" target="_blank" rel="noopener">${id.login}</a>` : "ready"}, ${id.mode}`);
        else if (st === "app") mark("github", "ok", "app identity: commits are recorded, not pushed");
        else if (["failed", "rejected"].includes(st)) mark("github", "bad", `${st}${id.reason ? `: ${id.reason}` : ""}`);
        else mark("github", "wait", st.replace(/_/g, " "));
      } else mark("github", "wait", "the identity service has not answered yet");
      const ss = (await fetch(`/api/sessions?agent=${agent}&limit=20`).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as any[];
      if (Array.isArray(ss) && ss.length) {
        const first = ss[ss.length - 1];
        mark("session", "ok", html`<a class="link" href="/sessions/${first.session_id}">session ${first.session_id.slice(0, 8)}</a> on ${first.recipe_name ?? "its lineage"}, ${first.state}`);
        const v = [...ss].reverse().find((x) => x.candidate && ["accepted", "rejected", "expired"].includes(x.candidate.status));
        if (v) mark("verdict", v.candidate.status === "accepted" ? "ok" : "bad", html`${v.candidate.status}${v.candidate.reason ? ` (${v.candidate.reason})` : ""} on ${v.candidate.target ?? v.candidate.kind}${typeof v.candidate.verdict?.effect?.ratio === "number" ? `, ratio ${v.candidate.verdict.effect.ratio.toFixed(4)}` : ""}${v.candidate.gen_id ? html`, <a class="link" href="/generations/${v.candidate.gen_id}">generation</a>` : ""}`);
        else mark("verdict", "wait", "waiting for replays to judge its first candidate");
      } else {
        mark("session", "wait", hosted ? "the runtime starts it once the agent is bound and a recipe is calibrated" : "starts when you run the worker");
        mark("verdict", "wait", "after the first candidate is replayed");
      }
    } catch {
      /* the next tick retries */
    }
    // 45 minutes of watching, then the Profile carries on
    if (Date.now() - started < 45 * 60_000 && S.root?.isConnected) trackTimer = setTimeout(tick, 6000);
  };
  void tick();
}

/** The images picked in the wizard, signed by the launcher wallet and uploaded once Core knows the launch. */
async function uploadImages(agent: string) {
  const files: ["avatar" | "banner", File][] = [];
  if (S.image) files.push(["avatar", S.image]);
  if (S.bannerFile) files.push(["banner", S.bannerFile]);
  if (!files.length) return;
  mark("images", "wait", "waiting for Core to read the launch, then your wallet signs each image");
  const done: string[] = [];
  for (const [slot, f] of files) {
    let last = "";
    for (let i = 0; i < 30; i++) {
      try {
        await uploadMedia(agent, slot, f);
        done.push(slot);
        last = "";
        break;
      } catch (e) {
        last = (e as Error).message;
        // Core accepts the launcher's images once its chain sync has read the launch
        if (/refus|denied|signature/i.test(last) && !/launch|unknown|not found|launcher/i.test(last)) break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    if (last) return mark("images", "bad", `${slot} not uploaded: ${last}. Upload it again from your Profile.`);
  }
  mark("images", "ok", `${done.join(" and ")} uploaded; the hosted runtime folds ${done.length === 1 ? "it" : "them"} into the next signed soul version`);
}

// ------------------------------------------------------------------------------------------------
// profile

function myAgents(): AgentLaunch[] {
  const a = me();
  return a ? S.launches.filter((l) => l.launcher === a || S.owners.get(l.agent) === a) : [];
}

/** The market indexer's row per mint (price, market cap, volume, change, what the agent is building), for My agents. */
const mineRows = new Map<string, DirToken | null>();

// My agents leads the profile (APP-CONSOLIDATION.md amendment 2026-10-10 (2)): each agent this
// wallet launched or owns, with its token's four figures and what it is building right now (the live
// session, else its last verified improvement, and its repository), then its status and Manage.
function renderMine() {
  if (S.page !== "profile") return;
  if (S.launchesErr) return set("w-mine", html`<div class="panel-b">${S.launchesErr}</div>`);
  const mine = myAgents();
  if (!mine.length) return set("w-mine", html`<div class="panel-b dim">This wallet has launched no agent on ${netName()} yet. <a class="link" href="/launch">Launch one</a>.</div>`);
  injectBuildingStyle();
  set(
    "w-mine",
    html`<div class="me-agents">${mine.map((l) => {
      const m = S.metas.get(l.mint);
      const rec = S.records.get(l.agent);
      const t = mineRows.get(l.mint) ?? null;
      const bound = l.hosted && !!rec?.signingKey && rec.signingKey !== l.agent;
      const name = t ? agentTitle(t) : (m?.name ?? short(l.mint)).replace(/^TEST /, "");
      return html`<article class="me-ag${t?.building?.live ? " live" : ""}" data-agent="${l.agent}">
        <div class="me-ag-h">
          <a href="/agents/${l.agent}/profile" aria-label="${name}, profile">${agentAvatar(l.agent, t?.avatar, 40)}</a>
          <div class="me-ag-n"><a class="link" href="/agents/${l.agent}/profile"><b>${name}</b></a> <a class="dim" href="/tokens/${l.mint}">${m?.symbol ? `$${m.symbol}` : short(l.mint)}</a>
            <div class="me-ag-st">${l.awake ? badge("awake", "good") : badge("asleep", "")} ${l.hosted ? (bound ? badge("bound", "good") : rec?.signingKey === null ? badge("key revoked", "bad") : badge("not bound", "warn")) : badge("self-hosted", "info")}${t?.hidden ? badge("hidden from listings", "") : ""}</div></div>
          <div class="me-ag-act">${btn("me-manage", S.manage === l.agent ? "Close" : "Manage", { data: { agent: l.agent }, primary: S.manage !== l.agent })}</div>
        </div>
        <div class="me-ag-bd">${t ? buildingLine(t, { full: true }) : html`<span class="faint">Reading what it is building…</span>`}</div>
        ${t ? paramCells(t) : ""}
        <div class="me-ag-f"><span>Compute vault <b id="me-v-${l.agent}"><span class="faint">…</span></b></span><span>GitHub <span id="me-gh-${l.agent}"><span class="faint">…</span></span></span><a class="link" href="/tokens/${l.mint}">Token page</a></div>
      </article>`;
    })}</div>`,
  );
  void fillMine(mine);
}

let mineSeq = 0;
async function fillMine(mine: AgentLaunch[]) {
  const seq = ++mineSeq;
  const missing = mine.filter((l) => !mineRows.has(l.mint));
  if (missing.length) {
    await Promise.all(
      missing.map(async (l) => {
        const r = await fetch(`/market/tokens/${l.mint}`, { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        mineRows.set(l.mint, r);
      }),
    );
    if (seq === mineSeq) return renderMine();
  }
  const vaults = await reader.tokenBalances(mine.map((l) => launchPdas.computeVault(l.agent))).catch(() => mine.map(() => null));
  mine.forEach((l, i) => set(`me-v-${l.agent}`, tl(vaults[i])));
  await Promise.all(
    mine.map(async (l) => {
      const id = await fetch(`/identity/agents/${l.agent}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      set(`me-gh-${l.agent}`, id ? html`${id.login ? html`<a class="link" href="${id.profile_url}" target="_blank" rel="noopener">${id.login}</a> ` : ""}<span class="dim">${String(id.status).replace(/_/g, " ")}</span>` : html`<span class="faint">TBA</span>`);
    }),
  );
}

async function renderManage() {
  const box = S.root?.querySelector<HTMLElement>("#me-manage");
  if (!box) return;
  const l = S.launches.find((x) => x.agent === S.manage);
  if (!l) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const m = S.metas.get(l.mint);
  box.hidden = false;
  box.innerHTML = html`<div class="panel-h"><h2>Manage ${m?.symbol ?? short(l.mint)}</h2><div class="aside"><a class="link" href="/agents/${l.agent}/profile">Public page</a> · <a class="link" href="/tokens/${l.mint}">Token page</a></div></div>
    <div class="grid-2 me-b2">
      <div class="me-sec"><div class="eyebrow">Images</div>
        <p class="wl-fine">An avatar (PNG, JPEG or WebP, at most 256 KB) or a banner (at most 1 MB). Your wallet signs the upload; the hosted runtime puts its hash in the agent's next signed soul version.</p>
        <div class="wl-row"><label class="wl-btn">Upload avatar<input type="file" accept="image/png,image/jpeg,image/webp" data-me-up="avatar" hidden></label><label class="wl-btn">Upload banner<input type="file" accept="image/png,image/jpeg,image/webp" data-me-up="banner" hidden></label></div>
        <div id="me-up-out" class="wl-fine"></div>
      </div>
      <div class="me-sec"><div class="eyebrow">Fund trading</div>
        <p class="wl-fine" id="me-fund-help">${qsym()} to the allocation escrow, with a memo naming this agent; the hosted runtime forwards it to the agent's trading treasury, separate from its compute vault.</p>
        <div class="wl-row"><input name="m_alloc" inputmode="decimal" placeholder="${qsym()}" class="me-in">${btn("me-fund", "Sign and send", { primary: true, data: { agent: l.agent } })}</div>
        <div id="me-fund-out" class="wl-fine"></div>
      </div>
    </div>
    <div class="me-sub eyebrow">Signing key, owner and GitHub token</div>
    <div class="grid-2 me-b2"><div id="w-id"></div><details class="me-kit"><summary class="eyebrow">How rotation works</summary><div id="w-id-kit"></div></details></div>`.s;
  const esc0 = await loadTradingEscrow();
  if (!esc0) set("me-fund-help", "No allocation escrow is published on this network.");
  S.ikey = l.agent;
  S.iOut = null;
  S.irec = await reader.agent(l.agent).catch(() => null);
  renderIdentity();
}

async function renderHoldings() {
  if (S.page !== "profile" || !me()) return;
  const a = me()!;
  try {
    const mints = S.launches.map((l) => l.mint);
    const atas = mints.map((m) => ata(a, m, T22));
    const accs: (any | null)[] = [];
    for (let i = 0; i < atas.length; i += 100) accs.push(...(await rpc.getMultipleAccounts(atas.slice(i, i + 100))));
    const held = mints.map((m, i) => ({ mint: m, amount: accs[i] ? decodeTokenAccount(accs[i]!.data).amount : 0n })).filter((h) => h.amount > 0n);
    if (!held.length) return set("w-hold", html`<div class="panel-b dim" data-none>This wallet holds no agent tokens. Buy on any token's page from the <a class="link" href="/">Explorer</a>.</div>`);
    const market = await fetch("/market/tokens?limit=200").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const price = new Map<string, number>(((market?.tokens ?? []) as any[]).filter((t) => typeof t.price === "number").map((t) => [t.mint, t.price]));
    let total = 0;
    let complete = true;
    const rows = held.map((h) => {
      const d = adec(h.mint);
      const p = price.get(h.mint);
      const v = p === undefined ? null : (Number(h.amount) / 10 ** d) * p;
      if (v === null) complete = false;
      else total += v;
      return { ...h, d, v };
    });
    set(
      "w-hold",
      html`<div class="tw"><table class="t"><thead><tr><th>Token</th><th class="right">Balance</th><th class="right">Value</th><th></th></tr></thead><tbody>
        ${rows.map((h) => html`<tr><td><b>${S.metas.get(h.mint)?.symbol ?? short(h.mint)}</b><div class="sub">${S.metas.get(h.mint)?.name ?? ""}</div></td>
          <td class="right num">${units(h.amount, h.d)}</td>
          <td class="right">${h.v === null ? html`<span class="faint">TBA</span>` : html`<span class="num">${h.v.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span><span class="unit">${qsym()}</span>`}</td>
          <td class="right"><a class="wl-btn" href="/tokens/${h.mint}">Trade</a></td></tr>`)}
      </tbody></table></div>
      <div class="panel-b wl-fine">${complete ? html`Total <b class="num">${total.toLocaleString("en-US", { maximumFractionDigits: 4 })}</b> ${qsym()} at the indexer's last prices.` : "Some tokens have no indexed price, so no total is shown."}</div>`,
    );
  } catch (e) {
    set("w-hold", html`<div class="panel-b">${errBox(e)}</div>`);
  }
}

async function renderFollowing() {
  if (S.page !== "profile" || !me()) return;
  const a = me()!;
  const f = await fetch(`/api/social/following?wallet=${a}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!f) return set("w-follow", html`<div class="panel-b dim" data-none>Core did not answer; follows are TBA.</div>`);
  if (!f.agents?.length) return set("w-follow", html`<div class="panel-b dim" data-none>This wallet follows no agents. Follow one from its public page, or start at the <a class="link" href="/leaderboard">leaderboard</a>.</div>`);
  const feed = await fetch(`/api/feed?wallet=${a}&kinds=post,generation&limit=6`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  set(
    "w-follow",
    html`<div class="panel-b me-follow"><div class="me-chips">${(f.agents as string[]).map((id) => html`<a class="me-chip" href="/agents/${id}/profile">${short(id)}</a>`)}</div>
      ${feed?.items?.length ? html`<div class="fd-list">${feed.items.map((it: any) => feedItemHtml(it, { compact: true }))}</div>` : html`<div class="dim">Nothing new from them yet.</div>`}
      <div class="wl-fine" style="margin-top:8px"><a class="link" href="/following">The full feed of the agents you follow</a></div></div>`,
  );
}

/** Claims and bounties show only when this wallet has any. */
function claimsVisibility() {
  const box = S.root?.querySelector<HTMLElement>("#me-claims");
  if (!box) return;
  const agents = new Set(myAgents().map((l) => l.agent));
  const anyClaims = !!S.claims?.rows.length;
  const anyBounty = myPayers().length > 0 || !!S.bounties?.some((b) => agents.has(b.payer) || (b.payee && agents.has(b.payee)) || b.opener === me());
  box.hidden = !(anyClaims || anyBounty);
}

// ------------------------------------------------------------------------------------------------
// wiring

function requireReady(): boolean {
  if (S.gate !== "ok") return false;
  if (!S.account || !S.wallet) {
    S.walletErr = "Connect a wallet first.";
    renderConn();
    renderWizard();
    return false;
  }
  if (S.account.chains?.length && !S.account.chains.includes(walletChain())) return false;
  return true;
}

/** The header's session changed (connected, switched account, disconnected). */
function onWalletSession() {
  const s = session();
  const changed = (s.account?.address ?? null) !== (S.account?.address ?? null);
  S.wallet = s.wallet;
  S.account = s.account;
  if (!changed) return;
  S.sol = S.line = null;
  S.claims = null;
  S.walletErr = null;
  S.draft = null;
  if (S.page === "profile") paintProfileFrame();
  if (!S.account) {
    renderWizard();
    return;
  }
  void refreshBalances().then(() => renderWizard());
  if (S.page === "profile") {
    renderVerifier();
    renderMine();
    void renderHoldings();
    void renderFollowing();
    void loadClaims().then(claimsVisibility);
    renderBountyForm();
    renderBounties();
  }
}

function paintProfileFrame() {
  const signed = S.root?.querySelector<HTMLElement>("#me-signed");
  if (signed) signed.hidden = !S.account;
  if (!S.account) {
    const h = S.root?.querySelector("#me-h");
    if (h) h.textContent = "Your wallet";
    set("w-conn", html`<div class="panel-b me-prompt"><div><div class="t1">Connect a wallet to see your profile</div><div class="dim">Your agents, holdings, follows, claims and bounties, read for the connected wallet only. ${netName() === "devnet" ? "Devnet" : "Mainnet"}.</div></div>${btn("me-connect", "Connect", { primary: true })}</div>`);
  }
}

async function onClick(ev: Event) {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!b || (b as HTMLButtonElement).disabled) return;
  const act = b.dataset.act!;
  const key = act + (b.dataset.mint ?? b.dataset.i ?? b.dataset.agent ?? "");
  if (S.busy.has(key)) return;
  S.busy.add(key);
  b.setAttribute("aria-busy", "true");
  try {
    switch (act) {
      case "me-connect":
        // the header's Connect button owns the menu; open it (one wallet connects at once)
        document.getElementById("cn-btn")?.click();
        break;
      case "lz-go":
        go(Number(b.dataset.i));
        break;
      case "lz-next":
        go(S.step + 1);
        break;
      case "lz-back":
        go(S.step - 1);
        break;
      case "refresh":
        await Promise.all([refreshBalances(), loadNetwork(), loadLaunches()]);
        break;
      case "faucet": {
        S.faucetMsg = html`<div class="panel-b dim">Asking the faucet…</div>`;
        renderConn();
        const r = await fetch("/chain/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: me() }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          logSig(`faucet: ${units(BigInt(j.amount), dec())} ${qsym()} to you`, j.signature, j.fee, true);
          S.faucetMsg = html`<div class="panel-b">${banner("info", html`Received ${units(BigInt(j.amount), dec())} ${qsym()}: ${txLink(j.signature)}`)}</div>`;
        } else S.faucetMsg = html`<div class="panel-b">${errBox(j.message ?? `HTTP ${r.status}`)}</div>`;
        await refreshBalances();
        break;
      }
      case "launch-review":
        S.draft = null;
        await launchReview();
        break;
      case "soul-generate":
        await soulGenerate();
        renderTemperEffect();
        renderWizard();
        break;
      case "soul-apply":
        soulApply();
        renderTemperEffect();
        renderWizard();
        break;
      case "launch-sign":
        await launchSign();
        break;
      case "download-agent-key":
        await downloadAgentKey();
        break;
      case "me-manage":
        S.manage = S.manage === b.dataset.agent ? null : b.dataset.agent!;
        renderMine();
        await renderManage();
        S.root?.querySelector("#me-manage")?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      case "me-fund": {
        if (!requireReady()) break;
        const out = (r: Raw | string) => set("me-fund-out", r);
        try {
          const sig = await sendAllocation({ wallet: S.wallet!, account: S.account!, agent: b.dataset.agent!, lineMint: lineMint(), decimals: dec(), typed: val("m_alloc"), onStatus: (m) => out(html`<span class="dim">${m.replace(/^launched; now /, "")}</span>`) });
          if (!sig) out("Nothing sent: enter an amount (and the network must publish an allocation escrow).");
          else {
            logSig(`trading allocation to ${short(b.dataset.agent!)}`, sig, undefined, true);
            out(html`<span class="mark good">${icon.check} sent</span> ${txLink(sig)} <span class="dim">the runtime forwards it to the agent's trading treasury</span>`);
            void refreshBalances();
          }
        } catch (e) {
          out(errBox(e, (e as any).logs));
        }
        break;
      }
      case "v-lookup":
        await vLookup();
        break;
      case "v-register":
        await vRegister();
        break;
      case "v-bond":
        await vOwnerTx("bond");
        break;
      case "v-unbond":
        await vOwnerTx("unbond");
        break;
      case "v-withdraw":
        await vOwnerTx("withdraw");
        break;
      case "i-lookup":
        await iLookup();
        break;
      case "i-rotate":
        await iRotate();
        break;
      case "rt-bind":
        if (S.launched) await bindHosted(S.launched.agent.id);
        break;
      case "i-revoke":
        await iTx("revoke");
        break;
      case "i-propose":
        await iTx("propose");
        break;
      case "i-cancel":
        await iTx("cancel");
        break;
      case "i-accept":
        await iTx("accept");
        break;
      case "i-migrate":
        await iTx("migrate");
        break;
      case "claim":
        await claim(Number(b.dataset.i));
        break;
      case "claims-reload":
        S.claimOut = null;
        await loadClaims();
        claimsVisibility();
        break;
      case "b-open":
        await bOpen();
        break;
      case "b-reload":
        await loadBounties();
        break;
      case "b-find":
        await bFind(b.dataset.i!);
        break;
      case "b-release":
        await bRelease(b.dataset.i!);
        break;
      case "b-refund":
        await bBack(b.dataset.i!, "refund");
        break;
      case "b-cancel":
        await bBack(b.dataset.i!, "cancel");
        break;
      case "gh-check":
      case "gh-rotate":
      case "gh-revoke":
        await ghClick(act, b);
        break;
    }
  } finally {
    S.busy.delete(key);
    b.removeAttribute("aria-busy");
  }
}

let repoTimer: ReturnType<typeof setTimeout> | null = null;
function onInput(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.name === "l_repo" && ev.type === "input") {
    if (repoTimer) clearTimeout(repoTimer);
    S.repo = t.value.trim() ? { url: "", state: "checking", msg: "Checking GitHub…" } : null;
    renderWizard();
    repoTimer = setTimeout(checkRepo, 500);
  }
  if (t.name === "l_identity") set("w-custody", custodyText(t.value));
  if (t.name === "l_name") {
    const sym = S.root?.querySelector<HTMLInputElement>('[name="l_symbol"]');
    if (sym && !sym.dataset.touched) sym.value = ("T" + t.value.toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(0, 10);
  }
  if (t.name === "l_symbol") t.dataset.touched = "1";
  if (t.name?.startsWith("l_") && t.name !== "l_token") S.draft = null;
  if (t.name === "l_deposit") renderPrepay();
  if ((t.name === "l_provider" || t.name === "l_model") && onModelInput(t)) {
    set("w-models", modelsBody());
    if (S.soul?.doc) {
      S.soul.doc = withModel(S.soul.doc, modelChoice());
      renderSoul();
    }
  }
  if (t.name === "l_temp" && ev.type === "change") applyTemperToSoul();
  if ((t.name === "l_image" || t.name === "l_banner") && ev.type === "change") void pickImage(t);
  if (t.dataset?.meUp && ev.type === "change") void profileUpload(t);
  if (S.page === "launch") renderWizard();
}

async function pickImage(t: HTMLInputElement) {
  const f = t.files?.[0] ?? null;
  if (t.name === "l_image") S.image = f;
  else S.bannerFile = f;
  renderAvatar();
  renderWizard();
}

/** The coin's image as the avatar preview (the agent step shows it too); the generated pattern when none. */
function renderAvatar() {
  const url = S.image && IMG_TYPES.includes(S.image.type) ? URL.createObjectURL(S.image) : null;
  const prev = S.root?.querySelector<HTMLElement>("#lz-prev");
  if (prev) prev.innerHTML = url ? html`<img src="${url}" alt="">`.s : html`<span>${icon.agent}</span>`.s;
  set("lz-av", html`<div class="lz-avrow"><div class="lz-prev sm">${url ? html`<img src="${url}" alt="">` : html`<span>${icon.agent}</span>`}</div><div class="wl-fine">${url ? html`The coin's image is the avatar. ${S.image!.size > 256 * 1024 ? html`<span class="mark warn">${icon.warn} over 256 KB</span>` : ""}` : "No image: the avatar is a pattern generated from the agent key. Add one on the first step."}</div></div>`);
}

async function profileUpload(t: HTMLInputElement) {
  const f = t.files?.[0];
  const agent = S.manage;
  if (!f || !agent) return;
  const out = (r: Raw | string) => set("me-up-out", r);
  out(html`<span class="dim">Your wallet signs the ${t.dataset.meUp}…</span>`);
  try {
    await uploadMedia(agent, t.dataset.meUp as "avatar" | "banner", f);
    out(html`<span class="mark good">${icon.check} uploaded</span> <span class="dim">the hosted runtime signs it into the next soul version; it then shows on the public page</span>`);
  } catch (e) {
    out(html`<span class="mark warn">${icon.warn} ${(e as Error).message}</span>`);
  }
  t.value = "";
}

function renderPrepay() {
  set("w-prepay", prepayHelp(val("l_deposit"), { decimals: dec(), wake: S.lc?.wakeThreshold ?? null, balance: S.line }));
}

let unsubSession: (() => void) | null = null;

/** Shared start of both pages: listeners, the cluster gate, the session. */
async function boot(root: HTMLElement, page: "launch" | "profile", body: Raw) {
  S.root = root;
  S.page = page;
  initGithubIdentity({ root: () => S.root, wallet: () => S.wallet, account: () => S.account });
  root.innerHTML = body.s;
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("submit", (e) => e.preventDefault());
  startDiscovery();
  restoreSession();
  S.wallet = session().wallet;
  S.account = session().account;
  unsubSession?.();
  unsubSession = onSession(onWalletSession);
  renderSigs();
  try {
    S.cfg ??= await loadChainCfg();
    if (!S.cfg.state) throw new Error(isMainnet() ? "Lineage is not deployed on mainnet yet (no mainnet state on this server)." : "This server has no devnet state (scripts/devnet/devnet.json).");
    await devnetGate();
    S.gate = "ok";
  } catch (e) {
    S.gate = (e as Error).message;
  }
  renderGate();
}

/** Launch (/launch): the six-step wizard. */
export async function mountLaunch(root: HTMLElement) {
  S.step = 0;
  S.manage = null;
  // a finished launch from an earlier visit starts a fresh wizard
  if (S.launched && !S.sending) {
    S.launched = null;
    S.soul = null;
    S.draft = null;
    S.repo = null;
    S.image = S.bannerFile = null;
    track.clear();
  }
  // the network profile first: the form's labels follow it (SPEC 14.10)
  await loadChainCfg().catch(() => undefined);
  await boot(root, "launch", launchSkeleton());
  renderWizard();
  renderAvatar();
  if (S.gate !== "ok") return;
  await Promise.all([loadNetwork(), loadPrepay(S.cfg!.state as any), loadTradingEscrow(), loadTradingCfg(), loadModels().then(() => set("w-models", modelsBody()))]);
  const dep = S.root?.querySelector<HTMLInputElement>('[name="l_deposit"]');
  // devnet: the USD default typed in, as before; mainnet (quote amounts): empty means Core's default, shown as the placeholder
  if (dep && !dep.value && P.cfg) {
    if (usdMode()) dep.value = P.cfg.default_usd;
    else dep.placeholder = units(depositBase("", dec()), dec());
  }
  renderPrepay();
  if (S.account) await refreshBalances();
  renderWizard();
}

/** Profile (/profile): the connected wallet only. */
export async function mountProfile(root: HTMLElement) {
  S.manage = null;
  await loadChainCfg().catch(() => undefined);
  await boot(root, "profile", profileSkeleton());
  paintProfileFrame();
  renderVerifier();
  if (S.gate !== "ok") return;
  if (S.account) {
    renderConn();
    void refreshBalances();
  }
  await Promise.all([loadNetwork(), loadLaunches()]);
  await loadBounties();
  if (S.account) {
    void renderFollowing();
    await loadClaims();
    claimsVisibility();
  }
  if (location.hash === "#verifier") S.root?.querySelector<HTMLDetailsElement>("#verifier")?.setAttribute("open", "");
}

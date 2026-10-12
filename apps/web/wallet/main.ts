// The wallet bundle (devnet only), loaded on demand as /assets/wallet.js (bundled with packages/chain's
// browser build). Two pages since the app consolidation (docs/plans/APP-CONSOLIDATION.md):
//   Launch  (/launch, mountLaunch, launch.ts renders the steps): a six-step wizard in the Stags step
//           pattern that launches an agent token with this file's launch transaction code (prepay
//           planner, soul drafting, model registry, identity check, hosted bind)
//   Profile (/profile, mountProfile, profile.ts renders it): the connected wallet's balances and
//           faucet, its agents and their management (GitHub token rotate or revoke, images,
//           signing key), holdings, follows, claims and bounties (C6), and the
//           verifier registration kit
// and the token page's trade box (trade.ts). The connection is the site's one wallet session
// (standard.ts), owned by the header's Connect button. Every figure is read from chain (or from Core
// for proofs); nothing here holds a user's key: the wallet signs, and the fresh keys a launch needs
// are WebCrypto keys made in this page.
import "../../../packages/chain/src/browser/buffer.ts";
import {
  ata,
  moveLaunchHolding,
  base58Encode,
  base64Encode,
  canonicalJson,
  canonicalUrl,
  claimFromCoreProof,
  decodeAgent,
  decodeAgentLaunch,
  decodeBondingCurve,
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
  MAX_LAUNCH_STRINGS,
  coinMetadataUriBytes,
  partsToSend,
  PUMP,
  pumpLaunchMain,
  pumpPdas,
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
  type BondingCurve,
  type Ix,
  compileMessage,
  compileMessageV0,
  decodePumpFeeConfig,
  decodePumpGlobal,
  JITO_MAX_TXS,
  jitoTipIx,
  maxSolIn,
  planLaunchBundle,
  pumpSolToLine,
  quoteCurveBuyExactOut,
  system,
  type BundleGroup,
  type BundleTx,
  type LaunchSolCosts,
  solShortfall,
  CU_MAX,
  COIN_LINK_KEYS,
  normalizeCoinLinks,
  type CoinLinks,
  launchCostDetail,
  launchCreates,
  launchTxUnits,
  type LaunchCostDetail,
  type LaunchCostTx,
} from "../../../packages/chain/src/browser/index.ts";
import { checkSoul, localSoul, soulDigest, soulSigningMessage, type SoulDoc, type SoulPersona } from "../../../packages/souls/src/doc.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { badge, banner, icon, kv, panel, stat } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, solToUsd, usdWhy } from "../src/usd.ts";
import { budgetIxs, buildAndSimulate, unitPrice, onRpcBusy, isMainnet, loadChainCfg, NET, netName, parseUnits, qsym, reader, rpc, signAndSend, signAndSendAll, sol, testLabels, units, usym, devnetGate, type BundlePart, type ChainCfg } from "./chain.ts";
import { connectWallet, onSession, walletChain, restoreSession, session, signsV0, startDiscovery, type StdAccount, type StdWallet } from "./standard.ts";
export { mountTradeBox } from "./trade.ts";
import { custodyHtml, ghClick, hasIdentityService, initGithubIdentity, launchTrackRows, showIdentity, submitLaunchToken } from "./identity.ts";
import { builtRateNote, builtRateStale, depositBase, depositForBuild, depositNote, depositUsd, loadPrepay, P, prepayHelp, RATE_REBUILT, rateBlockedBox, rateBlockedNow, rateNote, showCorePrepay, tickRate } from "./prepay.ts";
import { costBreakdown, fundingBlocked, fundingSummary, initialBuyFor, type FundingView, type InitialBuy } from "./fronting.ts";
import { launchExtras, mountFeeRouteStep } from "./fee-route-step.ts";
import { checkedCoinUri, loadCoinOrigin, storeCoinImage, storeCoinLinks, type CoinOrigin } from "./coin-uri.ts";
export { mountClaim } from "./claim.ts";
import { registerPumpInitialBuy } from "./pump-venue.ts";
import { prepareSwapThen, routeLines, type PreparedSwap } from "./swap.ts";
import { entryOf, isDefaultChoice, loadModels, modelChoice, modelsBody, onModelInput, priceText, withModel } from "./models.ts";
import { CLASSES, launchSkeleton, profileSkeleton, stepNav, STEPS } from "./pages.ts";
import { feedItemHtml, uploadMedia } from "../src/pages/social-ui.ts";
import { agentAvatar, agentTitle, buildingLine, injectBuildingStyle, paramCells, type DirToken } from "../src/building.ts";
import { agentCard } from "../src/pages/directory.ts";
import { avatar as idAvatar, banner as idCover } from "../src/pages/social-ui.ts";
import { githubCallsLeft, spendGithubCall } from "../src/github.ts";
import { docsUrl } from "../src/docs-url.ts";
import { desktopWaitOf } from "../src/live-panel/live-only.ts";

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
  pools: new Map<string, BondingCurve | null>(),
  decimals: new Map<string, number>(),
  sigs: [] as SigRow[],
  // launch
  repo: null as null | { url: string; state: "checking" | "ok" | "bad"; msg: string; gh?: any; lineage?: any; core?: "ok" | "down"; recipes?: any[] },
  draft: null as null | { agent: WebKey; mint: WebKey; args: { name: string; symbol: string; uri: string; repoUrl: string; identityMode: number; hosted: boolean; cls: string; identity: string }; soul: SoulDoc | null; deposit: bigint; buy: InitialBuy | null; plan: BundleTx[];
    /** per transaction of `plan`: its signatures, compute unit limit and the unit price it is sent with */
    txs: LaunchCostTx[]; detail: LaunchCostDetail; swap: PreparedSwap | null; costs: LaunchSolCosts;
    /** the SOL purchase is a Jupiter quote (labelled as one), not the curve's arithmetic */
    quoted: boolean; identity: bigint; landed: string[]; metaLive: boolean; links: CoinLinks },
  /** the launch is being built (chain reads in flight) */
  building: false as boolean,
  /** why the last build stopped */
  draftErr: null as string | null,
  /** SOL/USD from /chain/sol-price (Jupiter), null when unavailable */
  solUsd: null as number | null,
  launchOut: null as Raw | null,
  launched: null as null | { agent: WebKey; mint: string; sig: string; sigs?: string[]; deposit?: bigint; mode?: "bundle" },
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
const me = () => S.account?.address ?? null;
/** $UNITS's canonical PumpSwap pool and vaults once $UNITS has migrated (Core's state.line_pool), else its curve is the quote. */
const linePool = () => (S.cfg?.state as { line_pool?: { pool: string; baseVault: string; quoteVault: string } } | undefined)?.line_pool;
// US dollars lead every $UNITS amount (owner 2026-10-12): the amount times the indexer's reading of the
// coin's dollar price, through the app's one formatter (src/usd.ts); the coin amount stays beside it,
// named, because that is what the wallet holds or signs for. No reading: "$ unavailable", never a guess.
const qUsd = (base: bigint) => quoteToUsd(Number(base) / 10 ** dec());
/** "$12.34 (100 UNITS)" as text, for messages and labels. */
const qAmt = (base: bigint, min = 0) => `${fmtUsd(qUsd(base))} (${units(base, dec(), min)} ${qsym()})`;
const tl = (base: bigint | null | undefined, min = 0) =>
  base === null || base === undefined ? html`<span class="faint">TBA</span>` : html`<span class="num" title="${usdWhy()}">${fmtUsd(qUsd(base))}</span> <span class="unit">${units(base, dec(), min)} ${usym()}</span>`;
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
  if (S.gate === "checking") return set("w-gate", "");
  if (S.gate !== "ok") return set("w-gate", banner("bad", "Refusing to build transactions", html`${S.gate} This page is set to ${netName()} only.`));
  // the cluster check passed: nothing is shown (owner 2026-10-12: no network banner on the page);
  // only a failed check keeps its refusal above
  set("w-gate", "");
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

/** Profile header: the address, SOL and UNITS, and the faucet (devnet). */
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
      : btn("faucet", html`Get ${qAmt(BigInt(f.amount))}`, { primary: true });
  const h = S.root?.querySelector("#me-h");
  if (h) h.textContent = short(S.account.address);
  // the head card, like an agent's: a cover and an avatar drawn from the address, and chips for the balances
  const a = S.account.address;
  set("me-cover", idCover(a, null));
  set("me-av", idAvatar(a, null, 96, "pf-av"));
  set("me-sub", html`<span class="hash" title="${a}">${a.slice(0, 8)}…${a.slice(-8)}</span> <span class="dim">${S.wallet!.name}, ${netName()}</span>`);
  set("me-act", html`<a class="wl-btn primary" href="/launch">${icon.agent} Launch an agent</a>`);
  set(
    "me-chips",
    html`<button type="button" class="pf-chip" data-copy="${a}" title="Copy the address">${icon.copy} Copy address</button>
      <span class="pf-chip">SOL <b class="num">${S.sol === null ? "TBA" : fmtUsd(solToUsd(Number(S.sol) / 1e9))}</b>${S.sol === null ? "" : html` <span class="dim">${sol(S.sol)}</span>`}</span>
      <span class="pf-chip">${qsym()} <b class="num">${S.line === null ? "TBA" : fmtUsd(qUsd(S.line))}</b>${S.line === null ? "" : html` <span class="dim">${units(S.line, dec())}</span>`}</span>
      <a class="pf-chip" href="#holdings">${icon.coin} Holdings</a>`,
  );
  set(
    "w-conn",
    html`<div class="panel-h"><h2>Wallet</h2></div><div class="stats wl-bal" style="--n:3">
        ${stat("Address", html`<span title="${S.account.address}">${short(S.account.address)}</span> <button type="button" class="copy" data-copy="${S.account.address}" aria-label="Copy address">${icon.copy}</button>`, html`${S.wallet!.name}${devnetOk ? `, ${netName()}` : `, ${netName()} not offered`}`, "sm")}
        ${stat("SOL", S.sol === null ? "TBA" : html`<span title="${sol(S.sol)} SOL">${fmtUsd(solToUsd(Number(S.sol) / 1e9))}</span>`, `${S.sol === null ? "" : `${sol(S.sol)} SOL, `}${netName()}, for fees and rent`, "sm")}
        ${stat(`${qsym()}`, S.line === null ? "TBA" : html`<span title="${units(S.line, dec())} ${qsym()}">${fmtUsd(qUsd(S.line))}</span>`, `${S.line === null ? "" : `${units(S.line, dec())} ${qsym()}, `}${testLabels() ? "TEST mint, Token-2022" : NET.p.quote.status === "stand-in" ? "stand-in for $UNITS" : "quote token"}`, "sm")}
      </div>
      ${devnetOk ? "" : html`<div class="panel-b">${banner("bad", `This wallet account does not offer ${walletChain()}`, `Pick an account or wallet that supports ${netName()}. Nothing will be built for it.`)}</div>`}
      ${NET.p.faucet ? html`<div class="panel-b wl-row">
        ${faucetBtn}
        <a class="wl-btn" href="https://faucet.solana.com/?cluster=devnet" target="_blank" rel="noopener">Devnet SOL faucet ${icon.ext}</a>
        ${btn("refresh", "Refresh")}
      </div>
      <div class="panel-b wl-fine" style="padding-top:0">Devnet only. ${qsym()} is a pump.fun coin on devnet, so it cannot be minted. The faucet is a devnet treasury of this server, ${f?.address ? addr(f.address) : "not set up"}, holding ${qsym()} bought on its pump.fun curve with devnet SOL; it sends ${f?.amount ? units(BigInt(f.amount), dec()) : "TBA"} ${qsym()}${f?.sol_drip_lamports && f.sol_drip_lamports !== "0" ? html` and ${sol(BigInt(f.sol_drip_lamports))} devnet SOL` : ""}, at most once per wallet every ${f?.per_wallet_hours ?? "TBA"} h and ${f?.per_hour ?? "TBA"} drips an hour; every drip is logged. More SOL comes from the public devnet faucet.</div>` : html`<div class="panel-b wl-row">${btn("refresh", "Refresh")}</div>`}
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
      <div><span class="k">venue</span><span class="v">pump.fun, quoted in ${qsym()}; curve, fees and graduation are pump.fun's</span></div>
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
  // a repository checked while a later step is open: its soul is written now
  if (S.step >= 2) soulAuto();
}

function renderRepo() {
  const r = S.repo;
  renderWizard();
  set("w-work", r?.state === "ok" ? workView(r) : "");
  if (!r) return set("w-repo", "Any public GitHub repository, as an https URL. Checked against the GitHub API and Core's units.");
  if (r.state === "checking") return set("w-repo", html`<span class="dim">${r.msg}</span>`);
  if (r.state === "bad") return set("w-repo", html`<span class="mark warn">${icon.warn} ${r.msg}</span>`);
  const gh = r.gh;
  set("w-repo", gh.from_core
    ? html`<span class="mark good">${icon.check} public</span> <a class="link" href="${gh.html_url}" target="_blank" rel="noopener">${gh.full_name}</a>: Core runs a recipe on it (GitHub's API is rate limiting this browser, so its details are not shown). On chain as <span class="num">${r.url}</span>.`
    : html`<span class="mark good">${icon.check} public on GitHub</span> <a class="link" href="${gh.html_url}" target="_blank" rel="noopener">${gh.full_name}</a>, default branch ${gh.default_branch}, ${gh.language ?? "language not reported"}. On chain as <span class="num">${r.url}</span>.`);
  // the class follows the recipe when one exists
  const cls = r.recipes?.[0]?.recipe?.class;
  // the target class is not picked by the launcher (owner 2026-10-11): it follows the recipe, else the
  // repository's language when it is one of the classes
  const sel = S.root?.querySelector<HTMLInputElement>('[name="l_class"]');
  const lang = String(gh?.language ?? "").toLowerCase().replace("c++", "cpp");
  const pick = cls ?? (CLASSES.includes(lang) ? lang : null);
  if (sel && pick) sel.value = pick;
}

/** What the agent can improve on this repository: the recipes Core runs on it, their class and measurable targets. */
function workView(r: NonNullable<typeof S.repo>): Raw {
  if (r.core === "down") return html`<div class="lz-work">${banner("warn", "Core is not answering", "What this repository can improve is TBA until it does.")}</div>`;
  const rs = r.recipes ?? [];
  if (!rs.length)
    return html`<div class="lz-work">${banner("info", "No recipe for this repository yet", html`Core has no active unit on it, so nothing here is measurable yet. The agent's first job is drafting a recipe; it authors only after calibration replays agree on one (SPEC 13.8). A repository that cannot be calibrated (no runnable tests, no metric, a policy against AI changes) stays in setting up with a public reason.`)}</div>`;
  return html`<div class="lz-work"><div class="eyebrow" style="margin-bottom:6px">What it can improve, read from Core</div>
    ${rs.map((v) => {
      const rc = v.recipe ?? {};
      const metrics = (rc.metrics ?? []) as any[];
      const fix = (rc.fix?.targets ?? rc.targets ?? []) as any[];
      return html`<div class="lz-rec"><div class="lz-rec-h"><a class="link" href="/units/${v.lineage_id}">${rc.name ?? "recipe"}</a> ${badge(rc.class ?? "class TBA", "info")} <span class="dim">height ${v.height ?? 0}, ${v.generations?.length ?? 0} accepted generation${(v.generations?.length ?? 0) === 1 ? "" : "s"}</span></div>
        ${metrics.length ? html`<ul class="lz-mets">${metrics.map((m) => html`<li><b>${m.name}</b> <span class="dim">${m.direction ?? ""} is better, ${m.kind ?? "metric"}${typeof m.min_effect === "number" ? `, at least ${(m.min_effect * 100).toFixed(m.min_effect * 100 < 1 ? 2 : 0)}% to count` : ""}</span></li>`)}</ul>` : ""}
        ${fix.length ? html`<div class="dim">Failing tests it can fix: ${fix.map((t) => (typeof t === "string" ? t : t.id ?? JSON.stringify(t))).join(", ")}</div>` : ""}
        ${!metrics.length && !fix.length ? html`<div class="dim">This recipe publishes no measurable target.</div>` : ""}</div>`;
    })}</div>`;
}

/** What to do when the wallet holds too little of the quote token. */
const topUp = () => (NET.p.faucet ? ` Get ${qsym()} from the faucet on your Profile.` : NET.p.swap ? " Pay with SOL or USDC (swapped through Jupiter), or add it to this wallet." : "");

/** The on-chain name prefix: "TEST " on devnet, none on mainnet (no TEST labels, SPEC 14.10). */
const namePrefix = () => (testLabels() ? "TEST " : "");

function launchArgs(metaOrigin: string) {
  const name = val("l_name");
  const symbol = val("l_symbol").toUpperCase();
  const cls = val("l_class") || "rust";
  const hosted = (S.root?.querySelector<HTMLInputElement>('input[name="l_hosted"]:checked')?.value ?? "hosted") === "hosted";
  const identity = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"]:checked')?.value ?? "token";
  if (!name || new TextEncoder().encode(`${namePrefix()}${name}`).length > 32) throw new Error(testLabels() ? "Agent name: 1 to 27 characters (the on-chain name is TEST + name, 32 bytes max)." : "Agent name: 1 to 32 bytes.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol: 1 to 10 characters, A to Z and 0 to 9.");
  if (!S.repo || S.repo.state !== "ok") throw new Error("Target repository: enter a public GitHub https URL and wait for the check to pass.");
  // the metadata URI names the mint, which is made after this check: counted at its longest (coin-uri.ts)
  const strings = new TextEncoder().encode(`${namePrefix()}${name}${symbol}${S.repo.url}`).length + coinMetadataUriBytes(metaOrigin, !!S.image, linkList(linksTyped()).length > 0);
  if (strings > MAX_LAUNCH_STRINGS) throw new Error(`Name, symbol, metadata URI and repository URL take ${strings} bytes; one launch transaction holds ${MAX_LAUNCH_STRINGS}.`);
  return { name: `${namePrefix()}${name}`, symbol, uri: "", repoUrl: S.repo.url, identityMode: IDENTITY_MODE[identity as keyof typeof IDENTITY_MODE], hosted, cls, identity };
}

function labelFor(a: string, x: { agent?: string; mint?: string; pool?: string }): string {
  const L: Record<string, string> = {
    [me() ?? "-"]: "your wallet (launcher, fee payer)",
    ...(me() ? { [ata(me()!, lineMint(), T22)]: `your ${qsym()} account (deposit source)` } : {}),
    [launchPdas.config()]: "launch config",
    [launchPdas.authority()]: "launch authority PDA",
    [lineMint()]: `${qsym()} mint${testLabels() ? " (TEST)" : ""}`,
    [registryPdas.config()]: "registry config",
    [registryPdas.treasury()]: "registry treasury",
    [REGISTRY_PROGRAM_ID]: "lineage_registry",
    [LAUNCH_PROGRAM_ID]: "lineage_launch",
    [PUMP.program]: "pump.fun (Pump)",
    [PUMP.global]: "Pump global",
    [PUMP.mayhem]: "Pump mayhem program (named by every create_v2)",
    [PUMP.quoteControl]: "Pump quote control",
    [PUMP.feeConfig]: "Pump fee config",
    [pumpPdas.bondingCurve(lineMint())]: `${qsym()} bonding curve (the quote)`,
    [T22]: "Token-2022",
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
    "11111111111111111111111111111111": "System",
    ComputeBudget111111111111111111111111111111: "Compute budget",
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated token",
  };
  if (x.agent) {
    L[x.agent] = "agent key (new, this page)";
    L[launchPdas.pumpCreator(x.agent)] = "agent's pump.fun creator PDA (its fees accrue here)";
    L[launchPdas.computeVault(x.agent)] = "compute vault (new)";
    L[registryPdas.agent(x.agent)] = "registry Agent record";
  }
  if (x.mint) {
    L[x.mint] = "agent token mint (new, this page)";
    L[launchPdas.agentLaunch(x.mint)] = "AgentLaunch (new)";
    const curve = pumpPdas.bondingCurve(x.mint);
    L[curve] = "pump.fun bonding curve (new)";
    L[ata(curve, x.mint, T22)] = "curve's agent-token account (new)";
    L[ata(curve, lineMint(), T22)] = `curve's ${qsym()} account (new)`;
  }
  return L[a] ?? "";
}

/** Review, folded: each transaction's size, compute unit limit and network fee, and every account the launcher pays the rent of. No simulation: arithmetic on chain reads (launch-costs.ts). */
function txTable(d: NonNullable<typeof S.draft>): Raw {
  const t = d.detail;
  const fees = t.fees.reduce((n, f) => n + f, 0n);
  return html`
    <div class="stats wl-stats2" style="--n:2">
      ${stat("Rent deposits", html`${sol(t.rent)}<span class="unit">SOL</span>`, `${t.rents.length} new account${t.rents.length === 1 ? "" : "s"}, at the cluster's rent rate`, "sm")}
      ${stat("Network fees", html`${sol(fees)}<span class="unit">SOL</span>`, `${t.fees.length} transaction${t.fees.length === 1 ? "" : "s"}: signatures and the priority fee on the compute limit`, "sm")}
    </div>
    <div class="tw"><table class="t wl-acc"><thead><tr><th>Transaction</th><th class="right">Bytes</th><th class="right">Compute limit</th><th class="right">Fee, SOL</th></tr></thead><tbody>
      ${d.plan.map((x, i) => html`<tr data-tx="${String(i)}" data-units="${String(d.txs[i]!.units)}" data-fee="${t.fees[i]!.toString()}"><td class="wrap">${x.groups.join(" + ")}${x.table ? html` <span class="dim">v0</span>` : ""}</td><td class="right num">${String(x.size)}</td><td class="right num">${d.txs[i]!.units.toLocaleString("en-US")}</td><td class="right num">${sol(t.fees[i]!)}</td></tr>`)}
    </tbody></table></div>
    <div class="tw"><table class="t wl-acc"><thead><tr><th>Account created</th><th class="right">Bytes</th><th class="right">Rent, SOL</th></tr></thead><tbody>
      ${t.rents.map((r) => html`<tr data-rent-group="${r.group}" data-lamports="${r.lamports.toString()}"><td class="wrap">${r.what}</td><td class="right num">${String(r.size)}</td><td class="right num">${sol(r.lamports)}</td></tr>`)}
    </tbody></table></div>`;
}

// soul (SPEC 14.8): seed, Claude draft, review and edit, then sign with the agent key at launch

/** The launcher's links in pump.fun's three fields (packages/chain/src/coin-metadata.ts). Throws the first problem as a message for the form. */
function linksTyped(): CoinLinks {
  const n = normalizeCoinLinks({ twitter: val("l_twitter"), telegram: val("l_telegram"), website: val("l_website") });
  if (n.problems.length) throw new Error(n.problems[0]!);
  return n.links;
}
const linkList = (l: CoinLinks): string[] => COIN_LINK_KEYS.flatMap((k) => (l[k] ? [l[k]!] : []));

/** What the soul is drafted from: the agent key, the repository and the one optional field (packages/souls/src/auto.ts). */
function soulInput(agent: string) {
  let links: string[] = [];
  try {
    links = linkList(linksTyped());
  } catch {
    links = [];
  }
  const desc = (S.root?.querySelector<HTMLTextAreaElement>('[name="l_desc"]')?.value ?? "").trim();
  const lines = [desc, links.length ? `Links: ${links.join(" ")}` : ""].filter(Boolean).join("\n");
  return { agent, vibe: val("s_vibe"), repo: S.repo?.state === "ok" ? S.repo.url : null, lines };
}
// the inputs the shown soul was drafted from, and the draft in flight: one draft per distinct input
let soulFor: string | null = null;
let soulBusy: string | null = null;
const soulKey = (i: { agent: string; vibe: string; repo: string | null }) => JSON.stringify([i.agent, i.repo, i.vibe.trim()]);

/**
 * Drafts the soul with nothing typed and nothing pressed (owner 2026-10-12): when the Agent step opens
 * with a checked repository, and again when the vibe or the repository changes. A soul the launcher
 * edited by hand is left alone.
 */
function soulAuto() {
  if (S.page !== "launch" || S.launched || S.sending || S.repo?.state !== "ok" || S.soul?.edited) return;
  const key = soulKey(soulInput(S.soul?.agent.id ?? "-"));
  if (S.soul && (soulFor === key || soulBusy === key)) return;
  void soulGenerate().then(() => renderWizard());
}

/**
 * The model's draft through the server (per-address and daily limits there), else a plain soul built
 * in this page from the same inputs: a failed draft never blocks the launch, and the page says which
 * of the two it shows.
 */
async function soulGenerate() {
  const agent = S.soul?.agent ?? (await generateWebKey());
  const input = soulInput(agent.id);
  const key = soulKey(input);
  soulBusy = key;
  S.soul = { agent, doc: null, note: null, edited: false, usd: null };
  S.draft = null;
  set("w-soul", html`<div class="wl-fine" style="margin-top:8px" data-soul-state="drafting">Writing the soul of agent ${addr(agent.id)} from ${input.repo ? "its repository" : "your inputs"}${input.vibe ? " and your vibe" : ""}. This takes up to a minute; you can go on to the next step meanwhile.</div>`);
  let doc: SoulDoc | null = null;
  let usd: number | null = null;
  let why = "";
  try {
    const r = await fetch("/souls/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(150_000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.doc) {
      doc = j.doc as SoulDoc;
      usd = typeof j.usd === "number" ? j.usd : null;
    } else why = j.problems ? `${j.error}: ${j.problems.join("; ")}` : (j.message ?? `HTTP ${r.status}`);
  } catch (e) {
    why = (e as Error).name === "TimeoutError" ? "the drafting service did not answer in time" : (e as Error).message;
  }
  // a newer draft was started while this one ran (the vibe changed): its result is the one shown
  if (soulBusy !== key || S.soul?.agent !== agent) return;
  soulBusy = null;
  if (!doc) {
    doc = localSoul(input, Math.floor(Date.now() / 1000));
    S.soul.note = html`<div class="wl-fine" style="color:var(--warn)" data-soul-local>This soul was built in this page from the repository${input.vibe ? " and your vibe" : ""}, not written by the model (${why.replace(/\.$/, "")}). It is a plain one and the launch can go ahead with it; Draft again asks the model once more.</div>`;
  }
  S.soul.doc = withModel(doc, modelChoice()); // plan M: the picked model is part of the signed profile
  S.soul.usd = usd;
  soulFor = key;
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
      <div class="wl-fine" data-soul-by="${s.edited ? "edited" : s.doc.origin.by}">${s.edited ? "Edited by you" : s.doc.origin.by === "model" ? `Written by ${s.doc.origin.model ?? "the model"}` : "Built in this page, not by the model"}${s.usd !== null ? `, ${fmtUsd(s.usd)} of model spend` : ""}. Digest <span class="wl-hash">${soulDigest(s.doc)}</span> ${btn("soul-generate", "Draft again")}</div>
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

/** A launch that cannot be built right now, with the box the Review step shows for it. */
class BuildStop extends Error {
  constructor(message: string, readonly box: Raw) {
    super(message);
  }
}
// Each build has a number: only the newest may write its result, so two builds never overlap on the page
// (an edit while one runs starts another; the older one's result is dropped).
let buildSeq = 0;
/** The whole build is bounded: after this the page says so and offers to try again. */
const BUILD_DEADLINE_MS = 25_000;
const retryBox = (e: unknown): Raw => html`<div class="panel-b">${errBox(e)}<div class="wl-row" style="margin-top:8px">${btn("launch-review", "Try again")}</div></div>`;

/**
 * Builds the launch and its cost lines. Nothing is simulated (owner 2026-10-12): the costs are
 * arithmetic on chain reads (packages/chain/src/launch-costs.ts), so the total shows as soon as the
 * reads answer. What is still checked before the wallet is asked: the cluster, the coin's metadata and
 * image read back, the price reading's age and band, and the wallet's SOL against the total.
 */
async function launchReview() {
  if (!requireReady()) return;
  const seq = ++buildSeq;
  const live = () => seq === buildSeq;
  S.launchOut = null;
  S.draftErr = null;
  S.building = true;
  renderFronting();
  set("w-launch-out", html`<div class="panel-b dim">Reading prices and building the launch…</div>`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`The server or the chain did not answer within ${BUILD_DEADLINE_MS / 1000} seconds, so the launch was not built. Nothing was signed or sent.`)), BUILD_DEADLINE_MS)));
    const draft = await Promise.race([buildLaunch(), late]);
    if (!live()) return;
    S.draft = draft;
    S.building = false;
    renderLaunchReview();
    renderFronting();
  } catch (e) {
    if (!live()) return;
    S.building = false;
    S.draftErr = (e as Error).message;
    renderFronting();
    set("w-launch-out", e instanceof BuildStop ? e.box : retryBox(e));
  } finally {
    clearTimeout(timer);
  }
}

// the keys of the launch being prepared: made once and kept across rebuilds, so an edit does not orphan a stored coin image
const launchKeys: { mint: WebKey | null; agent: WebKey | null } = { mint: null, agent: null };
// the coin image already stored for an agent key (the same file is not uploaded again on every rebuild)
let storedImage: { agent: string; file: File | null; out: { imageId: string; sha256: string } | null } | null = null;
async function coinImageFor(agent: WebKey): Promise<{ imageId: string; sha256: string } | null> {
  if (storedImage && storedImage.agent === agent.id && storedImage.file === S.image) return storedImage.out;
  const file = S.image;
  const out = await storeCoinImage(agent, file);
  storedImage = { agent: agent.id, file, out };
  return out;
}
// the cluster's rent rate (lamports for an account with no data), read once
let rent0: Promise<bigint> | null = null;
const rentRate = () => (rent0 ??= rpc.call<number>("getMinimumBalanceForRentExemption", [0]).then((n) => BigInt(n))).catch((e) => ((rent0 = null), Promise.reject(e)));

async function buildLaunch(): Promise<NonNullable<typeof S.draft>> {
  // credits at the live price (prepay.ts, market rate): no launch is built without a usable price reading; a no-op at the configured rate
  const rateWhy = await rateBlockedNow();
  renderPrepay(); // the rate line under the credits shows the reading just taken
  if (rateWhy) throw new BuildStop(rateWhy, rateBlockedBox(rateWhy));
  // launches are pump.fun only (owner decisions 2026-10-10); a cluster whose lineage_launch is still the Meteora build cannot take one
  if (S.lc && S.lc.venue !== PUMP.program)
    throw new BuildStop("launches are paused on this cluster", html`<div class="panel-b">${banner("bad", "Launches are paused on this cluster", "Agent tokens now launch on pump.fun; this cluster's lineage_launch still runs the earlier Meteora build. Existing tokens stay readable.")}</div>`);
  await devnetGate(); // the cluster check: the RPC's genesis is the profile's
  const coin: CoinOrigin = await loadCoinOrigin();
  const args = launchArgs(coin.origin);
  // plan M: the picked model is recorded in the soul the agent key signs; without a soul the agent runs the default
  const choice = modelChoice();
  if (S.soul?.doc) {
    S.soul.doc = withModel(S.soul.doc, choice);
    renderSoul();
  }
  const soul = S.soul?.doc ?? null;
  if (S.soul && !soul) throw new Error("The soul has problems; fix them, generate again, or choose Launch without a soul.");
  if (!soul && !isDefaultChoice(choice)) throw new Error("The model choice is recorded in the agent's soul: generate a soul, or pick the default model.");
  const agent = soul ? S.soul!.agent : (launchKeys.agent ??= await generateWebKey());
  const mint = (launchKeys.mint ??= await generateWebKey());
  const launcher = me()!;
  const links = linksTyped();
  // Three things at once, none a simulation: the coin's metadata (the image picked in the Coin step is stored first, signed by the
  // agent key and named in the URI by its hash; the URI is on chain for good, so the document and image are read back), the amounts
  // (credits at the price read again here, the venue's initial buy on the curve as read), and the cluster's rent rate, tip and balance.
  const [uri, deposit, buy, rate, tips, balance] = await Promise.all([
    // the image and the links are stored first (each signed by the agent key), then the URI that names both by hash is read back
    Promise.all([coinImageFor(agent), storeCoinLinks(agent, links)]).then(([image]) => checkedCoinUri({ origin: coin.origin, here: location.origin, mint: mint.id, agent: agent.id, name: args.name, symbol: args.symbol, repoUrl: args.repoUrl, image, links })),
    depositForBuild(val("l_deposit"), dec()),
    initialBuyFor({ launcher, agent: agent.id, agentMint: mint.id }, P.cfg),
    rentRate(),
    // mainnet: the Jito tip rides in the last transaction (never through a lookup table)
    isMainnet() ? Promise.all([rpc.call<string[]>("getTipAccounts", []), rpc.call<{ lamports: string }>("getTipFloor", [])]) : null,
    rpc.getBalance(launcher),
  ]);
  S.sol = balance;
  args.uri = uri;
  // pump.fun (owner decisions 2026-10-10): create_v2 at the top level, then register_pump_launch in the same transaction
  const main = pumpLaunchMain({ launcher, agent: agent.id, agentMint: mint.id, line: { mint: lineMint(), tokenProgram: T22, pool: linePool() }, name: args.name,
    symbol: args.symbol, uri: args.uri, args: { repoUrl: args.repoUrl, identityMode: args.identityMode, hosted: args.hosted }, creatorFeeBps: S.lc?.pumpCreatorFeeBps ?? 0n });
  const credits = launch.prepay({ launcher, agent: agent.id, agentMint: mint.id, lineMint: lineMint(), amount: deposit, decimals: dec(), lineTokenProgram: T22 });
  // the soul's digest goes on chain with the launch, signed by the agent key (its signing key until a rotation)
  const soulIx = soul ? registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: soulDigest(soul), seq: soul.seq }) : null;
  const need = deposit + (buy?.maxIn ?? 0n);
  const bps = P.cfg?.initial_buy_slippage_bps ?? 100;
  // A units account (owner direction 2026-10-11): its price from Core's config, to the configured recipient
  const idChosen = args.identity === "purchased";
  if (idChosen && !P.cfg?.identity_account_recipient) throw new Error("A units account: Core's config names no recipient for its payment; pick Your own token or try later.");
  const identity = idChosen ? BigInt(P.cfg!.identity_account_price_lamports) : 0n;
  const fee = idChosen ? [system.transfer(launcher, P.cfg!.identity_account_recipient!, identity)] : [];
  // SOL to $UNITS: on $UNITS's own SOL curve (devnet, and a mainnet profile with swap off: the test and the official deployment),
  // inside the same bundle; a profile with swap on converts through Jupiter (its own transaction, first in the bundle).
  let solToLine: Ix[] = [];
  let swap: PreparedSwap | null = null;
  let purchase: { whole: bigint; credits: bigint } | null = null;
  let headroom = 0n;
  if (isMainnet() && NET.p.swap) {
    swap = await prepareSwapThen({ pay: "SOL", need, taker: launcher, action: [], cuLimit: 400_000 });
    // Jupiter's quote for the whole amount, split by the amounts bought (a quote, labelled as one on the page)
    purchase = { whole: swap.route.inAmount, credits: need > 0n ? (swap.route.inAmount * deposit) / need : 0n };
  } else {
    if (linePool()) throw new Error("$UNITS has moved to its pool; buying it with SOL inside the launch is wired for its curve only.");
    const [gA, fcA, cA, bA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, pumpPdas.bondingCurve(lineMint()), ata(pumpPdas.bondingCurve(lineMint()), lineMint(), T22)]);
    if (!gA || !fcA || !cA || !bA) throw new Error("pump.fun's Global, fee config or the $UNITS curve is missing on this cluster");
    const g = decodePumpGlobal(gA.data), fc = decodePumpFeeConfig(fcA.data), c = decodeBondingCurve(cA.data), base = decodeTokenAccount(bA.data).amount;
    const whole = quoteCurveBuyExactOut(g, fc, c, need, base);
    const part = quoteCurveBuyExactOut(g, fc, c, deposit, base);
    const maxSol = maxSolIn(whole.quoteIn, bps);
    headroom = maxSol - whole.quoteIn;
    purchase = { whole: whole.quoteIn, credits: part.quoteIn };
    solToLine = pumpSolToLine({ launcher, lineMint: lineMint(), amountOut: need, maxSolIn: maxSol, lineTokenProgram: T22 });
  }
  let tip = 0n;
  let tipIxs: Ix[] = [];
  if (tips) {
    tip = BigInt(tips[1].lamports);
    tipIxs = [jitoTipIx(launcher, tips[0], tip)];
  }
  // GitHub fee route and repository pool (fee-route-step.ts): no instruction while those features are off
  const extras = await launchExtras({ launcher, agent: agent.id, agentMint: mint.id, lineMint: lineMint(), repoUrl: args.repoUrl });
  // one approval (owner direction 2026-10-11): the groups in order, packed into the fewest transactions
  const groups: BundleGroup[] = [
    { name: "launch", ixs: main },
    { name: "soul", ixs: soulIx ? [soulIx] : [] },
    { name: "fee-route", ixs: extras.feeRoute },
    { name: "pool", ixs: extras.pool },
    { name: "sol-to-units", ixs: solToLine },
    { name: "initial-buy", ixs: buy?.ixs ?? [] },
    { name: "credits", ixs: credits },
    { name: "units-account", ixs: fee },
    { name: "tip", ixs: tipIxs },
  ];
  const plan = planLaunchBundle({ payer: launcher, groups, budget: budgetIxs(CU_MAX), table: P.table, v0: signsV0(S.wallet!), maxTxs: JITO_MAX_TXS - (swap?.plan.txs.length ?? 0) });
  if (plan[0]!.groups[0] !== "launch") throw new Error("the launch transaction must come first");
  // the accounts whose rent the launcher pays: the new agent's and coin's always, the wallet's own and the shared ones only when absent
  const creates = launchCreates({ name: args.name, symbol: args.symbol, uri: args.uri,
    purchase: solToLine.length ? { launcherLine: ata(launcher, lineMint(), T22), launcherVolume: pumpPdas.userVolume(launcher) } : undefined,
    buy: buy ? { createsBuyback: buy.ixs.length > 2 } : undefined, feeRoute: extras.creates.feeRoute, pool: extras.creates.pool });
  const maybe = creates.flatMap((c) => (c.address ? [c.address] : []));
  // each transaction's unit price is read once here and the transaction is sent with it, so the fee shown is the fee paid
  const [prices, there] = await Promise.all([Promise.all(plan.map((t) => unitPrice(launcher, t.ixs))), maybe.length ? rpc.getMultipleAccounts(maybe) : []]);
  const FAKE = "11111111111111111111111111111111";
  const txs: LaunchCostTx[] = plan.map((t, i) => {
    const all = [...budgetIxs(CU_MAX), ...t.ixs];
    return { groups: t.groups, signatures: (t.table ? compileMessageV0(launcher, all, FAKE, [t.table]) : compileMessage(launcher, all, FAKE)).numSigners, units: launchTxUnits(t.groups), price: prices[i]! };
  });
  const detail = launchCostDetail({ txs, rent0: rate, creates, existing: new Set(maybe.filter((_, i) => !!there[i])), purchase, hasBuy: !!buy, identity, tip, headroom });
  return { agent, mint, args, soul, deposit, buy, plan, txs, detail, swap, costs: detail.costs, quoted: !!swap, identity, landed: [], metaLive: coin.answers, links };
}

/** The SOL/USD price (apps/web/chain-routes.ts /chain/sol-price: Jupiter, refused when stale); null when unavailable. */
async function loadSolPrice() {
  try {
    const j = await fetch("/chain/sol-price").then((r) => r.json());
    S.solUsd = j?.ok && typeof j.usd === "number" ? j.usd : null;
  } catch {
    S.solUsd = null;
  }
  renderFronting();
  renderIdPrice();
}
/** The units account price in the Identity step, from Core's config. */
function renderIdPrice() {
  const el = S.root?.querySelector<HTMLElement>("#w-id-price");
  if (!el) return;
  if (!P.cfg) return void (el.textContent = "price from Core");
  const l = BigInt(P.cfg.identity_account_price_lamports);
  const offered = !!P.cfg.identity_account_recipient;
  // (the hidden row keeps a text so a script waiting on this element can tell the config was read)
  el.textContent = offered ? `${S.solUsd === null ? "" : `${fmtUsd((Number(l) / 1e9) * S.solUsd)}, `}${sol(l)} SOL` : "not offered here";
  // No recipient in Core's config: this deployment has no identity service (the mainnet test), or it has none to give right now.
  // The option is then not shown at all (owner 2026-10-12: no dead radio); the own-token path stays, and a reason is said when there is one.
  const row = S.root?.querySelector<HTMLElement>("#w-id-paid");
  const paid = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"][value="purchased"]');
  if (row) row.hidden = !offered;
  if (paid) paid.disabled = !offered;
  const why = S.root?.querySelector<HTMLElement>("#w-id-why");
  if (why) {
    why.hidden = offered || !P.cfg.identity_account_unavailable;
    why.textContent = why.hidden ? "" : `A GitHub account for the agent is not available right now: ${P.cfg.identity_account_unavailable}.`;
  }
  if (paid && !offered) {
    const own = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"][value="token"]');
    if (paid.checked && own) {
      own.checked = true;
      set("w-custody", custodyText("token"));
    }
  }
}

function launchBlocked(): string | null {
  const d = S.draft;
  if (!d && !S.building) {
    const i = Array.from({ length: 4 }, (_, k) => k).find((k) => stepProblem(k));
    if (i !== undefined) return `finish step ${i + 1} (${STEPS[i]}) first: ${String(stepProblem(i)).replace(/\.$/, "")}`;
    if (!S.account) return "connect a wallet";
    // a wallet account that is not on this network cannot sign the launch: say so instead of waiting for ever
    if (S.account.chains?.length && !S.account.chains.includes(walletChain())) return `the connected wallet account is not on ${netName()}; switch it in the wallet`;
  }
  // a build's error belongs to that build only: once a launch is built, an older error no longer disables it
  return fundingBlocked({ costs: d?.costs ?? null, solUsd: S.solUsd, solBalance: S.sol, why: d ? null : S.draftErr, pending: S.building });
}

function fundingView(): FundingView {
  const d = S.draft;
  let usd: string | null = null;
  try {
    depositBase(val("l_deposit"), dec());
    usd = depositUsd(val("l_deposit"));
  } catch {
    usd = null;
  }
  const identityChosen = (S.root?.querySelector<HTMLInputElement>('input[name="l_identity"]:checked')?.value ?? "purchased") === "purchased";
  return { costs: d?.costs ?? null, creditsUsd: usd, bps: P.cfg?.initial_buy_bps ?? null, identityChosen, solUsd: S.solUsd, solBalance: S.sol,
    txCount: d ? d.plan.length + (d.swap?.plan.txs.length ?? 0) : null, blocked: launchBlocked(), devnet: !isMainnet(), docs: docsUrl("/launch-an-agent#5-funding"), pending: !!S.building, quoted: !!d?.quoted, retry: !d && !S.building && !!S.draftErr };
}

function renderLaunchReview() {
  const d = S.draft!;
  const recordRows: [string, unknown][] = [
    ["Name / symbol", `${d.args.name} / ${d.args.symbol}`],
    ["Repository", d.args.repoUrl],
    ["repo_id (computed on chain)", html`<span class="wl-hash">${repoId(d.args.repoUrl)}</span>`],
    ["Identity mode", `${d.args.identity === "purchased" ? "A units account" : "your own token"} (${d.args.identityMode})`],
    ["Runtime", d.args.hosted ? "hosted" : "self-hosted"],
    ["Model", (() => {
      const m = entryOf(d.soul?.model ?? modelChoice());
      return m ? html`${m.name} <span class="dim">${m.provider}/${m.id}, ${priceText(m)}${d.soul?.model ? ", in the signed soul" : ", the network default"}</span>` : html`<span class="faint">network default</span>`;
    })()],
    ["Agent key", addr(d.agent.id)],
    ["Agent mint", addr(d.mint.id)],
    ["Coin image", S.image ? `${S.image.name}: stored and named in the metadata URI by its hash, so it cannot be changed after the launch` : "none chosen: the agent's generated pattern"],
    ["Links", linkList(d.links).length ? html`${linkList(d.links).join(", ")} <span class="dim">stored and named in the metadata URI by their hash, so they cannot be changed after the launch</span>` : "none given: the coin's website is the agent's page"],
    ["Metadata URI", html`${d.args.uri} <span class="dim">${d.metaLive ? "read back before this review: document and image answer" : `read back on this host; ${new URL(d.args.uri).host} itself does not answer yet`}</span>`],
    ["Soul", d.soul ? html`${d.soul.persona.name}, <span class="wl-hash">${soulDigest(d.soul)}</span>` : html`<span class="faint">none</span>`],
    ["Credits", html`${depositNote(val("l_deposit"))} <span class="dim">${units(d.deposit, dec())} ${usym()} into the compute vault, then refresh_awake</span> ${builtRateNote(dec())}`],
    ["Transactions", html`${[...(d.swap?.plan.txs ?? []).map((_, i) => `Jupiter swap ${i + 1}`), ...d.plan.map((t) => `${t.groups.join(" + ")} (${t.size} bytes${t.table ? ", v0" : ""})`)].join("; ")}`],
  ];
  const blocked = launchBlocked();
  set(
    "w-launch-out",
    html`${d.swap ? html`<div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">SOL to ${usym()} (Jupiter)</div>${routeLines(d.swap)}</div>` : ""}
      <div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">What you pay</div>${costBreakdown(fundingView())}</div>
      ${d.metaLive ? "" : html`<div class="panel-b">${banner("warn", `${new URL(d.args.uri).host} does not answer yet`, "The coin's name details and image are served from that address, which is written on chain with the launch. Until it answers, pump.fun, wallets and explorers show this coin without them; they appear once it does.")}</div>`}
      <details class="panel-b lz-tech" data-launch-total="${d.costs.total.toString()}" data-launch-purchase="${(d.costs.credits + (d.costs.buy ?? 0n)).toString()}" data-launch-needed="${d.costs.needed.toString()}"><summary class="eyebrow">Transaction details</summary>
        ${txTable(d)}
        <div class="eyebrow" style="margin:8px 0 6px">register_pump_launch arguments</div>${kv(recordRows)}
      </details>
      <div class="panel-b wl-row lz-launch">${btn("launch-sign", "Launch (one signature)", { primary: true, disabled: blocked ? `Launch disabled: ${blocked}` : false })}${btn("launch-review", "Read prices again")}<span class="wl-why">${S.wallet!.name} approves every transaction of the launch at once; a hosted agent's binding is one more signature after it.</span></div>
      <div class="panel-b" id="w-launch-status"></div>`,
  );
}

/** Whether a group of the launch is already on chain (a retry never sends it twice; partsToSend decides per transaction). */
async function groupDone(d: NonNullable<typeof S.draft>, g: string): Promise<boolean> {
  if (g === "launch") return !!(await reader.agentLaunch(d.mint.id).catch(() => null));
  if (g === "soul") return !!d.soul && (await reader.agent(d.agent.id).catch(() => null))?.profileDigest === soulDigest(d.soul);
  if (g === "credits") return ((await reader.tokenBalance(launchPdas.computeVault(d.agent.id)).catch(() => null)) ?? 0n) >= d.deposit;
  if (g === "initial-buy") return !!d.buy && ((await reader.tokenBalance(d.buy.treasuryAccount).catch(() => null)) ?? 0n) >= d.buy.amountOut;
  return d.landed.includes(g);
}

async function launchSign() {
  const d = S.draft;
  // never double-send: one launch in flight at a time, and what is already on chain is left out
  if (!d || S.sending || S.launched?.mint === d.mint.id || !requireReady()) return;
  // market rate: the built amount's price reading has aged past Core's limit, so the launch is built again before anything is signed
  if (!d.landed.length && builtRateStale()) return void launchReview().then(() => set("w-launch-status", html`<span class="dim">${RATE_REBUILT}</span>`));
  S.sending = true;
  renderWizard();
  for (const el of S.root?.querySelectorAll<HTMLButtonElement>('[data-act="launch-sign"], [data-act="launch-review"]') ?? []) el.disabled = true;
  const st = (m: string) => set("w-launch-status", html`<span class="dim">${m}</span>`);
  try {
    const parts: BundlePart[] = [];
    for (const t of d.swap?.plan.txs ?? []) parts.push({ ixs: t.ixs, units: 0, tables: t.tables, raw: true, label: "SOL to $UNITS (Jupiter)" });
    const todo = await partsToSend(d.plan, (g) => groupDone(d, g), d.landed);
    if (todo.length < d.plan.length && d.swap) throw new Error("part of this launch is already on chain; a mainnet bundle is all or nothing, so build the launch again (Read prices again) to send the rest");
    for (const t of todo)
      // the limit and the unit price the review showed (launch-costs.ts): the fee paid is the fee shown
      parts.push({ ixs: t.ixs, units: d.txs[d.plan.indexOf(t)]!.units, price: d.txs[d.plan.indexOf(t)]!.price, table: t.table, label: t.groups.join(" + "),
        local: [...(t.groups.includes("launch") || t.groups.includes("soul") ? [d.agent] : []), ...(t.groups.includes("launch") ? [d.mint] : [])] });
    if (todo.length < d.plan.length) st(`${d.plan.length - todo.length} of ${d.plan.length} transactions are already on chain; approving the rest`);
    const r = parts.length ? await signAndSendAll({ wallet: S.wallet!, account: S.account!, parts, onStatus: st }) : { landed: [], failed: null };
    for (const x of r.landed) {
      logSig(`${x.label} ${d.args.symbol}`, x.confirmed.signature, x.confirmed.fee, !x.confirmed.err);
      d.landed.push(...x.label.split(" + "));
    }
    if (r.failed) {
      const first = !r.landed.length && todo[0]?.groups.includes("launch");
      throw Object.assign(new Error(`${r.failed.label}: ${r.failed.error}. ${first ? "Nothing was sent." : "The transactions before it landed; press Launch again to approve only what is missing."}`), { logs: r.failed.logs });
    }
    const sigs = r.landed.map((x) => x.confirmed.signature);
    let sig = sigs[0] ?? "";
    if (!todo.some((t) => t.groups.includes("launch"))) {
      const back = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(d.mint.id), { limit: 50, commitment: "confirmed" }]).catch(() => []);
      sig = back[back.length - 1]?.signature ?? sig;
      sigs.unshift(sig);
    }
    S.launched = { agent: d.agent, mint: d.mint.id, sig, sigs, deposit: d.deposit, mode: "bundle" };
    S.draft = null;
    launchKeys.mint = launchKeys.agent = null;
    storedImage = null;
    soulFor = soulBusy = null;
    S.sending = false;
    renderWizard();
    const started = Date.now();
    track.clear();
    mark("confirmed", "ok", html`${sigs.map((s, i) => html`${i ? ", " : ""}${txLink(s)}`)}, one signature${sigs.length > 1 ? ` for ${sigs.length} transactions` : ""}`);
    // an instance without the identity service gets no GitHub account row and no request to /identity/* (identity.ts)
    const idService = hasIdentityService(P.cfg);
    const first: Record<string, [StepState, string]> = {
      vault: ["wait", "reading the compute vault"],
      github: ["wait", "asking the identity service"],
      runtime: d.args.hosted ? ["wait", "the hosted runtime's binding follows"] : ["skip", "self-hosted: run the worker with the agent key below"],
      images: ["wait", "after Core reads the launch"],
      session: ["wait", "after the agent is awake and bound"],
      verdict: ["wait", "after the first candidate is replayed"],
    };
    for (const k of launchTrackRows({ identityService: idService, hosted: d.args.hosted, banner: !!S.bannerFile })) if (first[k]) mark(k, ...first[k]);
    if (d.soul) await publishLaunchedSoul(d.agent, d.soul);
    S.ghLaunch = idService && d.args.identity === "token" ? await submitLaunchToken({ agent: d.agent, mint: d.mint.id }) : null;
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
  const curveAcc = await rpc.getAccountInfo(l.bondingCurve);
  const pv = curveAcc && l.venue === "pump" ? decodeBondingCurve(curveAcc.data) : null;
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
        ["Identity / runtime", `${["your own token", "A units account", "app identity"][l.identityMode]} / ${l.hosted ? "hosted" : "self-hosted"}`],
        ["pump.fun curve", html`${addr(l.bondingCurve)}${pv ? html` <span class="dim">creator ${pv.creator === launchPdas.pumpCreator(l.agent) ? "the agent's creator PDA" : short(pv.creator)}, quoted in ${pv.quoteMint === lineMint() ? usym() : short(pv.quoteMint)}, raised ${units(pv.realQuoteReserves, dec())} ${usym()}</span>` : ""}`],
        ["Compute vault", html`${addr(launchPdas.computeVault(l.agent))} ${tl(vaultBal)}`],
        ["Awake", l.awake ? html`yes ${L.deposit !== undefined ? html`<span class="dim">woken by the deposit in the launch transaction</span>` : ""}` : "no (vault below wake_threshold)"],
        ...(L.deposit !== undefined ? [["Prepaid", html`${tl(L.deposit)} deposited; ${(L.sigs?.length ?? 1) > 1 ? html`${L.sigs!.length} transactions, one signature` : "one transaction"}<div id="w-prepay-core" class="dim">Core's check of the deposit follows its next chain sync.</div>`] as [string, unknown]] : []),
        ["Created", when(l.createdAt)],
        ["Supply", mi ? html`${units(mi.supply, mi.decimals)} <span class="dim">agent tokens, ${mi.decimals} decimals, Token-2022</span>` : "TBA"],
        ["Metadata URI", meta?.uri ?? "TBA"],
        ["Registry record", rec ? html`kind ${rec.kind}, owner ${addr(rec.owner)}, hosted ${rec.hosted ? "yes" : "no"}` : "TBA"],
        ["Soul on chain", rec?.profileDigest ? html`<span class="wl-hash">${rec.profileDigest}</span> seq ${rec.profileSeq} ${S.soul?.doc && rec.profileDigest === soulDigest(S.soul.doc) ? html`<span class="mark good">${icon.check} equals the soul you signed</span>` : ""}` : html`<span class="faint">none</span>`],
        ["Soul in Core", S.soulPub ?? html`<span class="faint">none</span>`],
        ...(hasIdentityService(P.cfg) ? [["GitHub identity", html`${S.ghLaunch ?? ""}<div id="w-gh-launch"><span class="dim">Reading the identity service…</span></div>`] as [string, unknown]] : []),
        ...(l.hosted ? [["Hosted runtime", html`<div id="w-rt-bind"><span class="dim">Asking the hosted runtime for its key…</span></div>`] as [string, unknown]] : []),
      ])}
      <div class="panel-b">
        <div class="wl-row">${btn("download-agent-key", "Download agent key (keypair JSON)", { primary: true })}<a class="wl-btn" href="/tokens/${l.mint}">Trade on its token page</a></div>
        <div class="wl-fine">The agent key exists only in this tab. ${l.hosted ? "Once bound, the hosted runtime's own key speaks for the agent and this key no longer does; keep the file to rotate back to it later." : "A self-hosted worker runs with it:"} <span class="num">${W} run --core &lt;core&gt; --key &lt;file&gt;</span>. Leaving the page drops it.</div>
      </div>`,
  );
  if (hasIdentityService(P.cfg)) showIdentity("w-gh-launch", l.agent, l.mint, false);
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
    if (t.status === "bound" || rec0?.signingKey === t.new_key) {
      out(html`<span class="mark good">${icon.check} bound</span> <span class="dim">signing key ${addr(t.new_key)} (the hosted runtime's)</span><div id="w-rt-holding"></div>`);
      return void moveHolding(agent, t.new_key);
    }
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
      ? html`<span class="mark good">${icon.check} bound</span> ${txLink(j.signature)} <span class="dim">signing key ${addr(t.new_key)} (the hosted runtime's), key changes ${rec.keySeq}; it starts on the runtime's next pass</span><div id="w-rt-holding"></div>`
      : html`<span class="mark warn">${icon.warn} sent ${txLink(j.signature)}, the registry has not shown the new key yet</span>`);
    if (rec?.signingKey === t.new_key) await moveHolding(agent, t.new_key);
  } catch (e) {
    out(html`${errBox(e, (e as any).logs)}<div class="wl-row" style="margin-top:6px">${retry()}</div>`);
  }
}

// LAUNCH-FRONTING D3 (packages/chain/src/holding.ts): once bound, the launch holding (the initial buy,
// delivered to the agent key) moves to the runtime key, the hosted agent's treasury. The agent key still
// in this tab signs the transfer; the launcher's wallet pays. Nothing to do when the holding is empty.
async function moveHolding(agent: string, treasury: string) {
  const out = (r: Raw | string) => set("w-rt-holding", r);
  const L = S.launched;
  if (!L || L.agent.id !== agent) return;
  try {
    const mint = await reader.mint(L.mint);
    const held = (await reader.tokenBalance(ata(agent, L.mint, mint?.tokenProgram ?? TOKEN_2022_PROGRAM))) ?? 0n;
    if (!mint || held === 0n) return;
    if (!requireReady()) return out(html`<span class="dim">connect the launcher wallet to move the launch holding to the agent's treasury</span>`);
    out(html`<span class="dim">Moving the launch holding (${units(held, mint.decimals)}) to the agent's treasury ${addr(treasury)}: your wallet pays, the agent key signs…</span>`);
    const ixs = moveLaunchHolding({ payer: me()!, agentKey: agent, treasury, agentMint: L.mint, amount: held, decimals: mint.decimals, tokenProgram: mint.tokenProgram });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs, local: [L.agent], onStatus: (m) => out(html`<span class="dim">${m}</span>`) });
    const sig = r.confirmed?.signature;
    if (sig) logSig(`launch holding of ${short(agent)} to its treasury ${short(treasury)}`, sig, r.confirmed?.fee, true);
    out(html`<span class="mark good">${icon.check} launch holding moved</span> ${sig ? txLink(sig) : ""} <span class="dim">${units(held, mint.decimals)} to ${addr(treasury)}, where the agent holds it</span>`);
  } catch (e) {
    out(html`${errBox(e, (e as any).logs)}`);
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
    const pools = S.launches.map((l) => l.bondingCurve);
    const accs = await rpc.getMultipleAccounts([...mints, ...pools]);
    mints.forEach((m, i) => {
      S.metas.set(m, accs[i] ? decodeT22Metadata(accs[i]!.data) : null);
      if (accs[i]) S.decimals.set(m, decodeMint(accs[i]!.data).decimals);
    });
    pools.forEach((p, i) => S.pools.set(p, accs[mints.length + i] && S.launches[i]!.venue === "pump" ? decodeBondingCurve(accs[mints.length + i]!.data) : null));
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
  if (!k) body = html`<div class="dim">Enter the agent public key printed by <span class="num">units-worker keygen</span> (step 1 of the kit).</div>`;
  else if (rec === undefined) body = html`<div class="dim">Reading the registry…</div>`;
  else if (rec === null) {
    const need = p ? p.registerBurn : null;
    const short0 = need !== null && S.line !== null && S.line < need;
    body = html`<div class="wl-fine">Not registered. Registering burns <b>${tl(p?.registerBurn)}</b> from your wallet (register_burn, read from the registry config) and creates the Agent record linking this key to your wallet as owner.</div>
      <label class="wl-field" style="margin-top:10px"><span class="eyebrow">Capabilities (output of <span class="num">units-worker doctor</span>)</span><textarea name="v_caps" rows="4" placeholder='{"arch":"arm64","cpus":10,...}'></textarea><span class="wl-help">Committed as H("caps", canonical JSON), the digest Core compares with what the worker declares. Leave empty to commit to no capabilities.</span></label>
      <div class="wl-row" style="margin-top:10px">${btn("v-register", "Sign register as owner", { primary: true, disabled: !S.account ? "connect a wallet" : short0 ? `needs ${qAmt(need!)} to burn: use Get ${qsym()}` : false })}</div>
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
      ${cmd([`${W} cosign --key ${key} --tx <from this page>`], `3. After your wallet signs register: co-sign and send (${netName()})`)}
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
      set("w-cosign", errBox("Capabilities must be the JSON printed by units-worker doctor."));
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
        logSig(`register ${short(agent)} (sent by units-worker cosign)`, sigs[0].signature, t?.meta?.fee, !sigs[0].err);
      }
      S.vOut = html`<div class="panel-b">${banner("info", "Registered by the worker's co-signature.", html`Burned ${qAmt(rec.burned)} (Agent.burned)${supply0 !== null && supply1 !== null ? html`; ${qsym()} supply fell by ${units(supply0 - supply1, dec())}` : ""}.`)}</div>`;
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
    label = `${kind === "bond" ? "bond" : "request_unbond"} ${qAmt(amt)}`;
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
        ? html`Bond ${units(before.bond, dec())} to ${qAmt(after.bond)} (read back).`
        : kind === "unbond"
          ? html`Pending unbond ${qAmt(after.unbondAmount)}, withdrawable from ${when(after.unbondReadyAt)}; the bond stays ${qAmt(after.bond)} and slashable until then (read back).`
          : html`Bond ${units(before.bond, dec())} to ${qAmt(after.bond)}; withdrawn to your wallet (read back).`;
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
            <div><label class="wl-field"><span class="eyebrow">New signing key (public key)</span><input name="i_newkey" placeholder="from units-worker keygen, or the hosted runtime" spellcheck="false"></label>
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
  if (rec && rec.kind === "launched") hasIdentityService(P.cfg) ? void showIdentity("w-gh", rec.agent, rec.mint, true) : set("w-gh", html`<span class="dim">This instance runs no GitHub identity service.</span>`);
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
        logSig(`rotate_agent_key ${short(agent)} to ${short(newKey)} (sent by units-worker cosign)`, sigs[0].signature, t?.meta?.fee, !sigs[0].err);
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
      // GET /v1/epochs is paged (newest first, 500 a page at most): every closed epoch may hold a claimable leaf, so walk them all
      epochs = [];
      for (let before: number | null = null, page = 0; page < 200; page++) {
        const r = await fetch(`/api/epochs?limit=500${before === null ? "" : `&before=${before}`}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const rows = (await r.json()) as any[];
        epochs.push(...rows);
        const last = rows.length ? Number(rows[rows.length - 1].n) : NaN;
        if (rows.length < 500 || !Number.isFinite(last) || (before !== null && last >= before)) break;
        before = last;
      }
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
        ${stat("Claimable", tl(open.reduce((n, r) => n + r.amount, 0n)), `${open.length} unclaimed ${open.length === 1 ? "leaf" : "leaves"}`, "sm")}
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
    S.claimOut = html`<div class="panel-b">${banner("info", html`Claimed epoch ${r.epoch}: ${txLink(cf.signature)}`, html`${addr(destToken)} received ${qAmt(b1 - b0)} (read back)${b1 - b0 === r.amount ? ", exactly the leaf amount" : ""}.`)}</div>`;
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
        <label><span class="eyebrow">Unit id</span><input name="b_lineage" placeholder="64 hex characters" spellcheck="false"></label>
        <fieldset><legend class="eyebrow">Condition</legend>
          <label class="radio"><input type="radio" name="b_kind" value="target" checked> <span><b>Target.</b> Any accepted generation on the unit for this target (metric name, or test ids separated by commas); empty means any target.</span></label>
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
          <td class="wrap">${condText(b)}<div class="sub">unit ${short(b.lineageId)} · from epoch ${String(b.minEpoch)}</div></td>
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
    if (!HEX64.test(lineage)) throw new Error("the unit id is 64 hex characters");
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
    const c = await bSend(`open_bounty ${qAmt(amount)} from ${short(payer)}`, [ix]);
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
      html`The compute vault went from ${units(v0, dec())} to ${qAmt(v1 ?? 0n)} and the escrow holds ${qAmt(esc0 ?? 0n)} (read back); qualifying generations from epoch ${String(acct?.minEpoch ?? "TBA")} on. ${termsNote}`)}</div>`;
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
      html`The payee's compute vault received ${qAmt((v1 ?? 0n) - v0)}${(v1 ?? 0n) - v0 === b.amount ? ", exactly the escrow" : ""}; status ${after?.status ?? "TBA"} (read back).`)}</div>`;
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
      html`${qAmt(v1 - v0)} back in the paying agent's compute vault (read back).`)}</div>`;
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
      if (!S.soul?.doc) return S.soul ? "The agent's soul is being written; it takes up to a minute." : "The agent's soul is written once the repository is checked (step 2).";
      if (M_ready() && !modelChoice()) return "Pick a model that can run.";
      return null;
    }
    if (i === 3) return null;
    if (i === 4) {
      if (!S.account) return "Connect a wallet (the Connect button above) to fund the launch.";
      depositBase(val("l_deposit"), dec());
      if (S.solUsd === null) return "Launch disabled: no SOL price.";
      // launch fronting (owner direction 2026-10-11): everything in SOL, from the built launch's cost lines
      const short = S.draft?.costs ? solShortfall(S.draft.costs, S.sol) : null;
      if (short) return `Launch disabled: ${short}.`;
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
  // every step is open for browsing (owner 2026-10-10: "i cant cycle through any of them");
  // Next and Review show what is still missing, and only the launch itself requires every step
  const far = STEPS.length - 1;
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
  const open = furthest();
  const why = step < STEPS.length - 1 ? stepProblem(step) : open < STEPS.length - 1 ? `Before launching, finish step ${open + 1} (${STEPS[open]}): ${stepProblem(open)}` : null;
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
      next.disabled = false;
      const w = foot.querySelector<HTMLElement>(".lz-why")!;
      w.textContent = why ?? "";
      w.hidden = !why;
    }
  }
  const conn = S.root.querySelector<HTMLElement>("#lz-conn");
  if (conn) {
    const want = S.account ? "" : "prompt";
    if (conn.dataset.mode !== want)
      // no connect banner (owner 2026-10-12): the header's Connect button and the Funding step's reason line say it
      conn.innerHTML = "";
    conn.dataset.mode = want;
  }
}

function go(i: number) {
  const prev = S.step;
  S.step = Math.max(0, Math.min(i, STEPS.length - 1));
  renderWizard();
  if (S.step !== prev) window.scrollTo({ top: 0 });
  if (S.step === STEPS.length - 1) void enterReview();
  // the soul is written without a click: when the Agent step (or a later one) opens with a checked repository
  if (S.step >= 2) soulAuto();
  // Funding shows the costs of the same built launch the Review step uses (launch fronting). The build starts one step
  // early, on Identity, so the total is usually there when Funding opens.
  if (S.step === STEPS.indexOf("Funding") || S.step === STEPS.indexOf("Funding") - 1) {
    renderFronting();
    if (!S.draft && !S.building && S.account && !S.sending && !S.launched && !stepProblemBefore(4)) void launchReview();
  }
}

/** Funding: the compact total and the one-line breakdown (apps/web/wallet/fronting.ts), from the built launch. */
function frontingHtml() {
  return fundingSummary(fundingView());
}
function renderFronting() {
  set("w-fronting", frontingHtml());
}

async function enterReview() {
  renderReview();
  if (S.launched || S.sending) return;
  // the launch is built once the steps before Funding are complete; until then Review lists what is missing
  if (!S.account || stepProblemBefore(4)) return;
  if (!S.draft && !S.building) await launchReview();
}

function renderReview() {
  const r = S.repo;
  const soul = S.soul?.doc ?? null;
  const m = entryOf(soul?.model ?? modelChoice());
  let links: CoinLinks = {};
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
  const row = (k: string, v: unknown, step: number) => html`<div class="lz-rr"><span class="eyebrow">${k}</span><span class="lz-rv">${v}</span><button type="button" class="lz-edit" data-act="lz-go" data-i="${String(step)}">Edit</button></div>`;
  set(
    "w-review",
    html`<div class="lz-review">
      ${row("Coin", html`<b>${namePrefix()}${val("l_name")}</b> <span class="dim">${val("l_symbol").toUpperCase()}</span>`, 0)}
      ${row("Description", (S.root?.querySelector<HTMLTextAreaElement>('[name="l_desc"]')?.value ?? "").trim() || html`<span class="faint">none</span>`, 0)}
      ${row("Image", S.image ? `${S.image.name}, ${Math.ceil(S.image.size / 1024)} KB, the coin's image and the agent's avatar, fixed at launch` : html`<span class="faint">none (generated pattern)</span>`, 0)}
      ${row("Links", linkList(links).length ? html`${COIN_LINK_KEYS.filter((k) => links[k]).map((k, i) => html`${i ? ", " : ""}<span class="dim">${{ twitter: "Twitter (X)", telegram: "Telegram", website: "Website" }[k]}</span> ${links[k]}`)} <span class="dim">fixed at launch</span>` : html`<span class="faint">none (the coin links to the agent's page)</span>`, 0)}
      ${row("Repository", r?.gh ? html`<a class="link" href="${r.gh.html_url}" target="_blank" rel="noopener">${r.gh.full_name}</a>, ${r.recipes?.length ? `${r.recipes.length} recipe${r.recipes.length === 1 ? "" : "s"} on Core` : "no recipe yet (setting up)"}` : "TBA", 1)}
      ${row("Soul", soul ? html`${soul.persona.name}, <span class="dim">${soul.persona.tagline}</span> <span class="wl-hash">${soulDigest(soul).slice(0, 16)}…</span>` : html`<span class="faint">none</span>`, 2)}
      ${row("Model", m ? html`${m.name} <span class="dim">${m.provider}, ${priceText(m)}</span>` : html`<span class="faint">network default</span>`, 2)}
      ${row("Banner", S.bannerFile ? `${S.bannerFile.name}, ${Math.ceil(S.bannerFile.size / 1024)} KB` : html`<span class="faint">none</span>`, 2)}
      ${row("Runtime", hosted ? "hosted, bound to the hosted runtime after the launch" : "self-hosted, you run the worker", 2)}
      ${row("GitHub identity", identity === "purchased" ? html`<b>A units account</b>` : val("l_token") ? "your token (bound after the launch)" : "your token, none pasted yet (add one from your Profile)", 3)}
      ${row("Model credits", dep === null ? "TBA" : html`${depositNote(val("l_deposit"))} <span class="dim">paid in SOL</span> ${rateNote(val("l_deposit"), dec())}`, 4)}
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
      const id = track.has("github") ? await fetch(`/identity/agents/${agent}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
      if (!track.has("github")) {
        /* no identity service on this instance: nothing to ask, no row */
      } else if (id) {
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
        // a bound, funded agent that cannot get a desktop: the runtime's own reason, not a bare spinner
        const wait = hosted ? desktopWaitOf(await fetch(`/api/agents/${agent}/spend`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) : null;
        mark("session", "wait", wait ? `Waiting for a desktop: ${wait}` : hosted ? "the runtime starts it once the agent is bound and a recipe is calibrated" : "starts when you run the worker");
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
  // the image is the coin's and the agent's avatar already (stored before the launch, coin-uri.ts); only the banner is left
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

// My agents leads the profile (APP-CONSOLIDATION.md amendment 2026-10-10 (2)): the agents this wallet
// launched or owns, as the same cards as /agents (avatar, soul, token price and change, what it is
// building, links), each with its credits under it: the compute vault read from chain, and the hosted
// runtime's spend report (vault in USD, burn per hour, runway, model, why it waits), then its status
// and Manage. A summary strip sums the credits. Figures nobody reports show TBA.
const spendRows = new Map<string, any | null>();
const usd = (n: number | null | undefined, d = 2) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}` : null);
const tbaOr = (v: string | null) => (v === null ? html`<span class="faint">TBA</span>` : html`${v}`);
function runwayText(h: number | null | undefined) {
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`;
}
function mineSummary(mine: AgentLaunch[]) {
  const rows = mine.map((l) => spendRows.get(l.agent)?.spend ?? null);
  const known = rows.filter((r) => r && typeof r.vault_usd === "number");
  const total = known.length ? known.reduce((a, r) => a + r.vault_usd, 0) : null;
  const burn = known.length ? known.reduce((a, r) => a + (r.burn_usd_per_h ?? 0), 0) : null;
  const working = mine.filter((l) => mineRows.get(l.mint)?.building?.live).length;
  return html`<div class="stats me-sum" style="--n:4">
    ${stat("Agents", String(mine.length), `${mine.filter((l) => l.awake).length} awake`)}
    ${stat("Working now", String(working), "in a live session")}
    ${stat("Credits", tbaOr(usd(total)), known.length < mine.length ? `${known.length} of ${mine.length} agents reported` : "in their compute vaults")}
    ${stat("Burn", tbaOr(burn === null ? null : `${usd(burn)}/h`), "model spend, last report")}
  </div>`;
}
function creditsHtml(l: AgentLaunch) {
  const sp = spendRows.get(l.agent);
  const r = sp?.spend ?? null;
  const rec = S.records.get(l.agent);
  const bound = l.hosted && !!rec?.signingKey && rec.signingKey !== l.agent;
  const waiting = r?.waiting ?? (sp?.provider_balance_low ? "provider balance low" : null);
  return html`<div class="me-cr">
      <div class="me-cr-st">${l.awake ? badge("awake", "good") : badge("asleep", "")} ${l.hosted ? (bound ? badge("bound", "good") : rec?.signingKey === null ? badge("key revoked", "bad") : badge("not bound", "warn")) : badge("self-hosted", "info")}${mineRows.get(l.mint)?.hidden ? badge("hidden from listings", "") : ""}${waiting ? badge(String(waiting), "warn") : ""}</div>
      <dl class="me-cr-k">
        <div><dt>Compute vault</dt><dd><b id="me-v-${l.agent}"><span class="faint">…</span></b>${r && typeof r.vault_usd === "number" ? html` <span class="faint">${usd(r.vault_usd)}</span>` : ""}</dd></div>
        <div><dt>Burn</dt><dd>${tbaOr(r && typeof r.burn_usd_per_h === "number" ? `${usd(r.burn_usd_per_h)}/h` : null)}</dd></div>
        <div><dt>Runway</dt><dd>${tbaOr(runwayText(r?.runway_h))}</dd></div>
        <div><dt>Model</dt><dd>${tbaOr(r?.model?.id ?? null)}</dd></div>
        <div><dt>GitHub</dt><dd id="me-gh-${l.agent}"><span class="faint">…</span></dd></div>
      </dl>
      <div class="me-cr-act">${btn("me-manage", S.manage === l.agent ? "Close" : "Manage", { data: { agent: l.agent }, primary: S.manage !== l.agent })}</div>
    </div>`;
}
function renderMine() {
  if (S.page !== "profile") return;
  if (S.launchesErr) return set("w-mine", html`<div class="panel-b">${S.launchesErr}</div>`);
  const mine = myAgents();
  set("me-stats", mineSummary(mine));
  if (!mine.length) return set("w-mine", html`<div class="panel-b dim">This wallet has launched no agent on ${netName()} yet. <a class="link" href="/launch">Launch one</a>.</div>`);
  injectBuildingStyle();
  const cards = mine.map((l) => {
    const t = mineRows.get(l.mint) ?? null;
    const m = S.metas.get(l.mint);
    const card = t
      ? agentCard(t).s
      : html`<article class="ag-card" data-agent="${l.agent}"><div class="ag-top"><a class="ag-face" href="/agents/${l.agent}/profile">${agentAvatar(l.agent, null, 44, "ag-av")}</a><div class="ag-who"><div class="ag-name"><a href="/agents/${l.agent}/profile">${(m?.name ?? short(l.mint)).replace(/^TEST /, "")}</a></div><p class="ag-tag"><span class="ag-faint">Reading its token…</span></p></div></div></article>`.s;
    return card.replace('<article class="ag-card', '<article class="me-ag ag-card').replace(/<\/article>\s*$/, `${creditsHtml(l).s}</article>`);
  });
  set("w-mine", html`<div class="ag-grid me-agents">${raw(cards.join(""))}</div>`);
  void fillMine(mine);
}

let mineSeq = 0;
async function fillMine(mine: AgentLaunch[]) {
  const seq = ++mineSeq;
  const missing = mine.filter((l) => !mineRows.has(l.mint) || !spendRows.has(l.agent));
  if (missing.length) {
    await Promise.all(
      missing.map(async (l) => {
        const [r, sp] = await Promise.all([
          mineRows.has(l.mint) ? mineRows.get(l.mint) : fetch(`/market/tokens/${l.mint}`, { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null),
          spendRows.has(l.agent) ? spendRows.get(l.agent) : fetch(`/api/agents/${l.agent}/spend`, { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null),
        ]);
        mineRows.set(l.mint, r ?? null);
        spendRows.set(l.agent, sp ?? null);
      }),
    );
    if (seq === mineSeq) return renderMine();
  }
  const vaults = await reader.tokenBalances(mine.map((l) => launchPdas.computeVault(l.agent))).catch(() => mine.map(() => null));
  mine.forEach((l, i) => set(`me-v-${l.agent}`, tl(vaults[i])));
  await Promise.all(
    mine.map(async (l) => {
      const id = hasIdentityService(P.cfg) ? await fetch(`/identity/agents/${l.agent}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
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
    </div>
    <div class="me-sub eyebrow">Signing key, owner and GitHub token</div>
    <div class="grid-2 me-b2"><div id="w-id"></div><details class="me-kit"><summary class="eyebrow">How rotation works</summary><div id="w-id-kit"></div></details></div>`.s;
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
    // dollars: the indexer's price_usd per token (null when it has no dollar price), times the balance
    const price = new Map<string, number>(((market?.tokens ?? []) as any[]).filter((t) => typeof t.price_usd === "number").map((t) => [t.mint, t.price_usd]));
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
          <td class="right"><span class="num" data-holding-usd="${h.v ?? ""}">${fmtUsd(h.v)}</span></td>
          <td class="right"><a class="wl-btn" href="/tokens/${h.mint}">Trade</a></td></tr>`)}
      </tbody></table></div>
      <div class="panel-b wl-fine">${complete ? html`Total <b class="num">${fmtUsd(total)}</b> at the indexer's last prices.` : "Some tokens have no US dollar price right now, so no total is shown."}</div>`,
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
    set("me-cover", html`<div class="pf-banner"></div>`);
    set("me-av", html`<span class="av pf-av me-av0"></span>`);
    set("me-sub", "");
    set("me-act", "");
    set("me-chips", "");
    set("w-conn", html`<div class="panel-b me-prompt"><div><div class="t1">Connect a wallet to see your profile</div><div class="dim">Your agents, holdings, follows, claims and bounties, read for the connected wallet only.</div></div>${btn("me-connect", "Connect", { primary: true })}</div>`);
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
          logSig(`faucet: ${qAmt(BigInt(j.amount))} to you`, j.signature, j.fee, true);
          S.faucetMsg = html`<div class="panel-b">${banner("info", html`Received ${qAmt(BigInt(j.amount))}: ${txLink(j.signature)}`)}</div>`;
        } else S.faucetMsg = html`<div class="panel-b">${errBox(j.message ?? `HTTP ${r.status}`)}</div>`;
        await refreshBalances();
        break;
      }
      case "launch-review":
        S.draft = null;
        if (stepProblemBefore(4)) renderFronting();
        else await launchReview();
        break;
      case "soul-generate":
        soulFor = null;
        await soulGenerate();
        renderWizard();
        break;
      case "soul-apply":
        soulApply();
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
let resimTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether a step before `i` still has a problem. */
const stepProblemBefore = (i: number) => Array.from({ length: i }, (_, k) => stepProblem(k)).some(Boolean);
function onInput(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.name === "l_repo" && ev.type === "input") {
    if (repoTimer) clearTimeout(repoTimer);
    S.repo = t.value.trim() ? { url: "", state: "checking", msg: "Checking GitHub…" } : null;
    renderWizard();
    repoTimer = setTimeout(checkRepo, 500);
  }
  if (t.name === "l_identity") set("w-custody", custodyText(t.value));
  // a new vibe drafts the soul again, once the field is left (not on every key)
  if (t.name === "s_vibe" && ev.type === "change") soulAuto();
  // the ticker is the launcher's own choice: it is never filled from the name (owner 2026-10-12)
  if (t.name?.startsWith("l_") && t.name !== "l_token") S.draft = null;
  if (t.name === "l_deposit") renderPrepay();
  // the launch is built again after a change (debounced): every figure comes from the built launch
  if (t.name?.startsWith("l_") && t.name !== "l_token" && S.page === "launch") {
    renderFronting();
    if (resimTimer) clearTimeout(resimTimer);
    if (S.step >= STEPS.indexOf("Funding") - 1 && S.account && !S.sending && !S.launched) resimTimer = setTimeout(() => void (!stepProblemBefore(4) ? launchReview() : undefined), 700);
  }
  if ((t.name === "l_provider" || t.name === "l_model") && onModelInput(t)) {
    set("w-models", modelsBody());
    if (S.soul?.doc) {
      S.soul.doc = withModel(S.soul.doc, modelChoice());
      renderSoul();
    }
  }
  if ((t.name === "l_image" || t.name === "l_banner") && ev.type === "change") void pickImage(t);
  if (t.dataset?.meUp && ev.type === "change") void profileUpload(t);
  if (S.page === "launch") renderWizard();
}

async function pickImage(t: HTMLInputElement) {
  const f = t.files?.[0] ?? null;
  if (t.name === "l_image") S.image = f;
  else S.bannerFile = f;
  const label = S.root?.querySelector<HTMLElement>(`[data-file="${t.name}"]`);
  if (label) label.textContent = f ? f.name : t.name === "l_image" ? "Coin image" : "Upload banner (optional)";
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

let solTimer: ReturnType<typeof setInterval> | null = null;
let rateTimer: ReturnType<typeof setInterval> | null = null;

function renderPrepay() {
  set("w-prepay", prepayHelp(val("l_deposit"), { decimals: dec() }));
}

let unsubSession: (() => void) | null = null;
let unsubBusy: (() => void) | null = null;

/** Shared start of both pages: listeners, the cluster gate, the session. */
async function boot(root: HTMLElement, page: "launch" | "profile", body: Raw) {
  S.root = root;
  S.page = page;
  initGithubIdentity({ root: () => S.root, wallet: () => S.wallet, account: () => S.account });
  root.innerHTML = body.s;
  // a readable line while chain reads are rate limited and being retried (never a raw RPC error)
  root.insertAdjacentHTML("afterbegin", '<div id="w-busy" class="wl-fine" role="status" aria-live="polite" hidden></div>');
  unsubBusy?.();
  unsubBusy = onRpcBusy((m) => {
    const el = S.root?.querySelector<HTMLElement>("#w-busy");
    if (!el) return;
    el.hidden = !m;
    el.textContent = m ?? "";
  });
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
  await loadUsd(); // the dollar price behind every $UNITS amount here (src/usd.ts): held 45 s, never throws
  try {
    S.cfg ??= await loadChainCfg();
    if (!S.cfg.state) throw new Error(isMainnet() ? "units is not deployed on mainnet yet (no mainnet state on this server)." : "This server has no devnet state (scripts/devnet/devnet.json).");
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
  void mountFeeRouteStep(root, root.querySelector<HTMLInputElement>('[name="l_repo"]')); // nothing unless a feature is on
  // a repository handed over in the address (the landing site's "Launch early" box: ?repo=owner/repo or a
  // GitHub URL) fills The work step, as if typed
  const handed = new URLSearchParams(location.search).get("repo")?.trim();
  const repoIn = S.root?.querySelector<HTMLInputElement>('[name="l_repo"]');
  const m = handed?.replace(/^(https?:\/\/)?(www\.)?(github\.com\/)?/i, "").replace(/\/+$/, "").match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/);
  if (m && repoIn && !repoIn.value) {
    repoIn.value = `https://github.com/${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
    repoIn.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (S.gate !== "ok") return;
  // the pump.fun venue registers its initial buy with launch fronting (pump-venue.ts)
  registerPumpInitialBuy({ lineMint, linePool, creatorFeeBps: () => S.lc?.pumpCreatorFeeBps ?? 0n, quoteSeed: () => NET.p.pump_quote_seed ?? "swap" });
  await Promise.all([loadNetwork(), loadPrepay(S.cfg!.state as any), loadModels().then(() => set("w-models", modelsBody()))]);
  const dep = S.root?.querySelector<HTMLInputElement>('[name="l_deposit"]');
  // credits in USD (owner direction 2026-10-11): Core's minimum typed in; the launcher may raise it
  if (dep && !dep.value && P.cfg) {
    dep.value = P.cfg.default_usd;
    dep.placeholder = P.cfg.min_usd;
  }
  renderPrepay();
  renderIdPrice();
  void loadSolPrice();
  if (solTimer) clearInterval(solTimer);
  solTimer = setInterval(() => (S.page === "launch" ? void loadSolPrice() : undefined), 30_000);
  // market rate: the price behind the credits is read again on the same beat; once a refused price is usable again the launch is built again
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = setInterval(() => (S.page === "launch" ? void tickRate().then((back) => (renderPrepay(), back && !S.draft && !S.sending && !S.launched && S.account && !stepProblemBefore(4) ? void launchReview() : undefined)) : undefined), 30_000);
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

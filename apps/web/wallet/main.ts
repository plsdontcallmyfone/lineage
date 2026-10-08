// Wallet page (M2, devnet only): connect a Wallet Standard wallet, launch an agent token, trade on
// an agent's curve and crank its fees, register and bond a verifier with a worker-held agent key,
// manage an agent's identity (rotate its signing key with the new key co-signing, revoke it, the
// two-step public owner transfer), claim epoch leaves, and open, release, refund or cancel bounties
// (C6: escrow from an agent's compute vault, released by a contribution proof into the payee's vault). Every figure is read from chain (or from Core for proofs); nothing here
// holds a user's key: the wallet signs, and the fresh keys a launch needs are WebCrypto keys made
// in this page. Loaded on demand as /assets/wallet.js (bundled with packages/chain's browser build).
import "../../../packages/chain/src/browser/buffer.ts";
import {
  ata,
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
} from "../../../packages/chain/src/browser/index.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { badge, banner, icon, kv, panel, stat } from "../src/ui.ts";
import { buildAndSimulate, loadChainCfg, parseUnits, reader, rpc, signAndSend, sol, units, devnetGate, type Built, type ChainCfg } from "./chain.ts";
import { connect, DEVNET_CHAIN, disconnect, discovered, legacyOnly, onChange, onWallets, startDiscovery, type StdAccount, type StdWallet } from "./standard.ts";

const T22 = TOKEN_2022_PROGRAM;
const W = "bun packages/worker/src/main.ts";
const CLASSES = ["rust", "solana", "zig", "cuda", "python", "go", "cpp"];

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
  metas: new Map<string, MintMeta | null>(),
  pools: new Map<string, DbcPoolView | null>(),
  decimals: new Map<string, number>(),
  sigs: [] as SigRow[],
  // launch
  repo: null as null | { url: string; state: "checking" | "ok" | "bad"; msg: string; gh?: any; lineage?: any; core?: "ok" | "down" },
  draft: null as null | { agent: WebKey; mint: WebKey; built: Built; args: any; ix: Ix },
  launchOut: null as Raw | null,
  launched: null as null | { agent: WebKey; mint: string; sig: string },
  busy: new Set<string>(),
  // trade
  sel: null as string | null,
  quote: null as null | { side: "buy" | "sell"; amountIn: bigint; out: bigint; built: Built; minOut: bigint },
  tradeOut: null as Raw | null,
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
  base === null || base === undefined ? html`<span class="faint">TBA</span>` : html`<span class="num">${units(base, dec(), min)}</span><span class="unit">tLINE</span>`;
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
// skeleton

function skeleton(): Raw {
  return html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Wallet ${badge("devnet only", "warn")} ${badge("TEST tokens", "warn")}</div>
      <h1>Launch, trade, verify and claim from your wallet</h1>
      <div class="ph-sub"><span>Your wallet signs every transaction; this page and its server never see a secret key. Every figure is read from Solana devnet at the moment shown, or from Core for epoch proofs.</span></div></div></div>
    <div id="w-gate"></div>
    <div class="grid-2">
      ${panel("Wallet", html`<div id="w-conn"><div class="panel-b dim">Looking for wallets…</div></div>`, { aside: html`<span id="w-cluster"></span>` })}
      ${panel("Programs on devnet", html`<div id="w-net"><div class="panel-b dim">Reading the registry and launch configs…</div></div>`, { note: html`Read from the <span class="num">Config</span> and <span class="num">LaunchConfig</span> accounts; admin-editable, so they are read on every load (SPEC 14).` })}
    </div>
    <div class="wl-tabs"><div class="seg" role="group" aria-label="Flow" data-tabs="wallet-flow">
      <button type="button" data-tab="launch" aria-pressed="true">Launch</button>
      <button type="button" data-tab="trade" aria-pressed="false">Trade and crank</button>
      <button type="button" data-tab="verify" aria-pressed="false">Verifier</button>
      <button type="button" data-tab="identity" aria-pressed="false">Identity</button>
      <button type="button" data-tab="claims" aria-pressed="false">Claims</button>
      <button type="button" data-tab="bounties" aria-pressed="false">Bounties</button>
    </div></div>
    <div data-pane="launch"><div class="grid-2">
      ${panel("Launch an agent token", launchForm(), { note: html`<span class="num">lineage_launch::launch_agent</span> on Meteora DBC, quote tLINE (TEST). Curve, fee and supply come from the DBC config on chain; launch values are TBA (SPEC 13.7, 20).` })}
      ${panel("Transaction", html`<div id="w-launch-out">${launchIdle()}</div>`)}
    </div></div>
    <div data-pane="trade" hidden><div class="grid-2">
      ${panel("Agent curves", html`<div id="w-agents"><div class="panel-b dim">Reading launches…</div></div>`, { aside: html`<span>AgentLaunch accounts</span>` })}
      ${panel("Trade on the curve", html`<div id="w-trade"><div class="panel-b dim">Pick an agent on the left.</div></div>`)}
    </div></div>
    <div data-pane="verify" hidden><div class="grid-2">
      ${panel("Register and bond a verifier", html`<div id="w-ver"></div>`)}
      ${panel("Worker kit", html`<div id="w-kit"></div>`, { note: html`The worker key is the agent's identity; the wallet is its owner. <span class="num">register</span> needs both signatures, so the key signs on the machine that holds it and only its public key is typed here.` })}
    </div></div>
    <div data-pane="identity" hidden><div class="grid-2">
      ${panel("Agent identity", html`<div id="w-id"></div>`, { note: html`Read from the registry <span class="num">Agent</span> record (v2). The agent id never changes; the signing key is the key that speaks for it in Core and on chain.` })}
      ${panel("How rotation works", html`<div id="w-id-kit"></div>`)}
    </div></div>
    <div data-pane="claims" hidden>
      ${panel("Claimable epoch leaves", html`<div id="w-claims"><div class="panel-b dim">Connect a wallet to look up its leaves.</div></div>`, { note: html`Leaves and proofs come from Core (<span class="num">GET /v1/epochs/:n/proofs/:agent</span>); each proof is checked against the payout root posted on chain before it is offered, and claim receipts are read from chain.` })}
    </div>
    <div data-pane="bounties" hidden><div class="grid-2">
      ${panel("Open a bounty", html`<div id="w-bopen"></div>`, { note: html`<span class="num">lineage_launch::open_bounty</span> escrows tLINE from an agent's compute vault. It is released only into the compute vault of an agent credited in an accepted generation that meets the condition, proven against the epoch's <span class="num">record_root</span> on chain (SPEC 14.7).` })}
      ${panel("Bounties on chain", html`<div id="w-blist"><div class="panel-b dim">Reading Bounty accounts…</div></div>`, { aside: html`<span>Bounty accounts</span>` })}
    </div></div>
    <div style="margin-top:16px">${panel("This session's transactions", html`<div id="w-sigs"></div>`, { note: html`Every signature links to Solana Explorer (devnet). Nothing is stored after you leave the page.` })}</div>`;
}

// ------------------------------------------------------------------------------------------------
// gate, wallet, balances, network

function renderGate() {
  const c = S.cfg;
  const cl = S.root?.querySelector("#w-cluster");
  if (cl) cl.innerHTML = c ? (c.devnet ? badge("devnet", "good", icon.check, `genesis ${c.genesis}`) : badge(c.cluster, "bad", icon.x)).s : "";
  if (S.gate === "checking") return set("w-gate", banner("info", "Checking the cluster…", "The RPC's genesis hash must be devnet's before anything is built."));
  if (S.gate !== "ok") return set("w-gate", banner("bad", "Refusing to build transactions", html`${S.gate} This milestone is devnet only.`));
  set(
    "w-gate",
    banner(
      "warn",
      html`Devnet only. Every transaction here is built for Solana devnet and nothing else.`,
      html`The RPC answers with devnet's genesis hash (${DEVNET_GENESIS.slice(0, 8)}…), checked again before every build. Any other cluster is refused. tLINE is the TEST mint ${addr(lineMint())} with a fixed supply and no value; agent tokens launched here are TEST tokens too.`,
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
  S.faucet = await fetch(`/chain/faucet?wallet=${a}`).then((r) => r.json()).catch(() => null);
  renderConn();
}

function renderConn() {
  const ws = discovered();
  if (!S.account) {
    const legacy = legacyOnly();
    set(
      "w-conn",
      html`<div class="panel-b">
        <div class="eyebrow" style="margin-bottom:8px">Connect (Wallet Standard)</div>
        <div class="wl-wallets">${ws.length
          ? ws.map((w) => html`<button type="button" class="wl-wallet" data-act="connect" data-name="${w.name}"><img src="${w.icon}" alt="" width="20" height="20"><span>${w.name}</span></button>`)
          : html`<div class="dim">No Wallet Standard wallet found in this browser. Install <a class="link" href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>, <a class="link" href="https://solflare.com" target="_blank" rel="noopener">Solflare</a> or <a class="link" href="https://backpack.app" target="_blank" rel="noopener">Backpack</a> and reload.</div>`}</div>
        ${legacy.length ? html`<div class="wl-why" style="margin-top:8px">${legacy.join(", ")} found only as a legacy window provider; update the extension to one that registers with the Wallet Standard.</div>` : ""}
        ${S.walletErr ? errBox(S.walletErr) : ""}
        <div class="wl-fine">Signature only: the page asks the wallet to sign each transaction you review, then sends it to devnet itself. No auto-approve, no session keys.</div>
      </div>`,
    );
    return;
  }
  const f = S.faucet;
  const devnetOk = !S.account.chains?.length || S.account.chains.includes(DEVNET_CHAIN);
  const next = f?.last && f?.per_wallet_hours ? f.last.at + f.per_wallet_hours * 3_600_000 : 0;
  const faucetBtn = !f?.enabled
    ? btn("faucet", "Get tLINE", { disabled: f?.reason ?? "faucet not funded" })
    : next > Date.now()
      ? btn("faucet", "Get tLINE", { disabled: `one drip per wallet every ${f.per_wallet_hours} h; next after ${new Date(next).toLocaleString()}` })
      : btn("faucet", html`Get ${units(BigInt(f.amount), dec())} tLINE`, { primary: true });
  set(
    "w-conn",
    html`<div class="stats wl-bal" style="--n:3">
        ${stat("Account", html`<span title="${S.account.address}">${short(S.account.address)}</span>`, html`${S.wallet!.name}${devnetOk ? "" : ", devnet not offered"}`, "sm")}
        ${stat("SOL", S.sol === null ? "TBA" : sol(S.sol), "devnet, for fees and rent", "sm")}
        ${stat("tLINE", S.line === null ? "TBA" : units(S.line, dec()), "TEST mint, Token-2022", "sm")}
      </div>
      ${devnetOk ? "" : html`<div class="panel-b">${banner("bad", "This wallet account does not offer solana:devnet", "Pick an account or wallet that supports devnet. Nothing will be built for it.")}</div>`}
      <div class="panel-b wl-row">
        ${faucetBtn}
        <a class="wl-btn" href="https://faucet.solana.com/?cluster=devnet" target="_blank" rel="noopener">Devnet SOL faucet ${icon.ext}</a>
        ${btn("refresh", "Refresh")}
        ${btn("disconnect", "Disconnect")}
      </div>
      <div class="panel-b wl-fine" style="padding-top:0">tLINE cannot be minted (its mint authority is revoked). The faucet is a devnet wallet of this server, ${f?.address ? addr(f.address) : "not set up"}, that transfers ${f?.amount ? units(BigInt(f.amount), dec()) : "TBA"} tLINE from the existing TEST supply, at most once per wallet every ${f?.per_wallet_hours ?? "TBA"} h and ${f?.per_hour ?? "TBA"} drips an hour; every drip is logged. It holds ${f?.line_base_units ? units(BigInt(f.line_base_units), dec()) : "TBA"} tLINE now. SOL comes from the public devnet faucet.</div>
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

function renderNet() {
  const r = S.reg, l = S.lc;
  if (!r || !l) return set("w-net", html`<div class="panel-b">${banner("bad", "Programs not initialized on this cluster", "The registry or launch config account does not exist.")}</div>`);
  const p = r.params;
  set(
    "w-net",
    html`<div class="params wl-params">
      <div><span class="k">register_burn</span><span class="v">${tl(p.registerBurn)}</span></div>
      <div><span class="k">min_bond</span><span class="v">${tl(p.minBond)}</span></div>
      <div><span class="k">bond_cap</span><span class="v">${tl(p.bondCap)}</span></div>
      <div><span class="k">unbond_cooldown</span><span class="v num">${String(p.unbondCooldownS)} s</span></div>
      <div><span class="k">agent_compute_bps</span><span class="v num">${l.agentComputeBps}</span></div>
      <div><span class="k">protocol_bps</span><span class="v num">${l.protocolBps}</span></div>
      <div><span class="k">reserve / pool bps</span><span class="v num">${p.reserveBps} / ${p.poolBps}</span></div>
      <div><span class="k">sleep / wake</span><span class="v">${tl(l.sleepThreshold)} / ${tl(l.wakeThreshold)}</span></div>
      <div><span class="k">migrates at</span><span class="v">${tl(l.migrationQuoteThreshold)}</span></div>
      <div><span class="k">epochs posted</span><span class="v num">${String(r.epochsPosted)}</span></div>
      <div><span class="k">tLINE supply</span><span class="v">${tl(S.supply)}</span></div>
      <div><span class="k">paused</span><span class="v">${r.paused || l.paused ? badge("paused", "bad") : badge("no", "good")}</span></div>
    </div>
    <div class="panel-b wl-fine">Registry ${addr(REGISTRY_PROGRAM_ID)} · launch ${addr(LAUNCH_PROGRAM_ID)} · DBC config ${addr(l.dbcConfig)} · admin ${addr(r.admin)}</div>`,
  );
}

// ------------------------------------------------------------------------------------------------
// launch (SPEC 13.7 to 13.9)

function launchForm(): Raw {
  return html`<form class="launch wl-form" data-wallet-form="launch" autocomplete="off">
    <div class="wl-2">
      <label><span class="eyebrow">Agent name</span><input name="l_name" maxlength="27" placeholder="minbpe speedups"><span class="wl-help">Token name on chain: "TEST " + this (32 bytes max).</span></label>
      <label><span class="eyebrow">Symbol</span><input name="l_symbol" maxlength="10" placeholder="TMBPE"><span class="wl-help">A to Z and 0 to 9, up to 10.</span></label>
    </div>
    <label><span class="eyebrow">Target repository</span><input name="l_repo" type="url" placeholder="https://github.com/owner/repo"><span class="wl-help" id="w-repo">Any public GitHub repository, as an https URL. Checked against the GitHub API and Core's lineages.</span></label>
    <div class="wl-2">
      <label><span class="eyebrow">Target class</span><select name="l_class">${CLASSES.map((c) => html`<option value="${c}">${c}</option>`)}</select><span class="wl-help">Recorded in the token metadata URI; AgentLaunch has no class field.</span></label>
      <fieldset><legend class="eyebrow">Runtime</legend>
        <label class="radio"><input type="radio" name="l_hosted" value="hosted" checked> <span><b>Hosted.</b> Compute paid from the agent's vault.</span></label>
        <label class="radio"><input type="radio" name="l_hosted" value="self"> <span><b>Self-hosted.</b> You run the worker with the agent key.</span></label>
      </fieldset>
    </div>
    <fieldset><legend class="eyebrow">GitHub identity (SPEC 13.9)</legend>
      <label class="radio"><input type="radio" name="l_identity" value="token" checked> <span><b>Own token.</b> A fine-grained token limited to the agent's forks is the recommended choice; any scope is accepted, and a full-scope token is a large liability for whoever holds it.</span></label>
      <label class="radio"><input type="radio" name="l_identity" value="purchased"> <span><b>Purchased account</b> from the operated pool. Price TBA, paid in $LINE to the treasury when the purchase flow ships.</span></label>
      <label class="radio"><input type="radio" name="l_identity" value="app"> <span><b>App identity.</b> lineage-app[bot] on the project's forks; always the fallback.</span></label>
    </fieldset>
    <div class="wl-custody" id="w-custody">${custodyText("token")}</div>
    <div class="wl-row">${btn("launch-review", "Review transaction", { primary: true })}</div>
  </form>`;
}

function custodyText(mode: string): Raw {
  if (mode === "token")
    return html`<label><span class="eyebrow">GitHub token</span><input type="password" disabled placeholder="Not collected on devnet"></label>
      <div class="wl-fine">On devnet in M2 the token is never collected or sent anywhere: this field is disabled. Only the mode (token) is recorded on chain. Custody when it ships with the hosted runtime: validated once with a GitHub API call (login, scopes, expiry), encrypted at rest under a key held only by the runtime's credential service, never in Core's database, logs or any API response, never inside a sandbox, used only to fork, push the agent's branches and open PRs on opted-in repos, rotatable and revocable from the agent page; a revoked token moves the agent to the app identity.</div>`;
  if (mode === "purchased") return html`<div class="wl-fine">Purchased accounts: price TBA. The purchase flow and credential storage ship with the hosted runtime; until then the agent uses the app identity. Only the mode (purchased) is recorded on chain.</div>`;
  return html`<div class="wl-fine">No credential is involved. Commits are pushed by the project's GitHub App with the agent id in a trailer.</div>`;
}

function launchIdle(): Raw {
  return html`<div class="panel-b"><div class="dim">Fill the form and press Review. The page builds <span class="num">launch_agent</span> with packages/chain, simulates it on devnet, and shows every account and the rent your wallet pays before you sign.</div>
    <ol class="wl-steps"><li>A fresh agent key and a fresh mint key are made in this page (WebCrypto Ed25519); both co-sign, as the program requires.</li><li>Your wallet signs as launcher and fee payer.</li><li>The page sends to devnet, waits for confirmation and reads the AgentLaunch, mint, DBC pool and compute vault back from chain.</li><li>You can download the agent key; the page keeps no copy once you leave.</li></ol></div>`;
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
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { accept: "application/vnd.github+json" } });
    if (r.status === 404) S.repo = { url, state: "bad", msg: "GitHub has no public repository at this URL (it does not exist or is private)." };
    else if (!r.ok) S.repo = { url, state: "bad", msg: `GitHub API answered HTTP ${r.status}${r.status === 403 ? " (rate limit for unauthenticated calls)" : ""}; try again later.` };
    else {
      const gh = await r.json();
      if (gh.private) S.repo = { url, state: "bad", msg: "The repository is private." };
      else {
        let lineage: any = null, core: "ok" | "down" = "ok";
        try {
          const ls = await fetch("/api/lineages").then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))));
          lineage = (ls as any[]).find((l) => canonicalUrl(String(l.repo)) === url && (l.status ?? "active") === "active") ?? null;
        } catch {
          core = "down";
        }
        S.repo = { url, state: "ok", msg: "", gh, lineage, core };
      }
    }
  } catch (e) {
    S.repo = { url, state: "bad", msg: `GitHub API did not answer (${(e as Error).message}).` };
  }
  renderRepo();
}

function renderRepo() {
  const r = S.repo;
  if (!r) return set("w-repo", "Any public GitHub repository, as an https URL. Checked against the GitHub API and Core's lineages.");
  if (r.state === "checking") return set("w-repo", html`<span class="dim">${r.msg}</span>`);
  if (r.state === "bad") return set("w-repo", html`<span class="mark warn">${icon.warn} ${r.msg}</span>`);
  const gh = r.gh;
  set(
    "w-repo",
    html`<span class="mark good">${icon.check} public on GitHub</span> <a class="link" href="${gh.html_url}" target="_blank" rel="noopener">${gh.full_name}</a>, default branch ${gh.default_branch}, ${gh.language ?? "language not reported"}. On chain as <span class="num">${r.url}</span>.
      ${r.core === "down"
        ? html`<div><span class="mark warn">${icon.warn} Core is not answering</span>: lineage status TBA.</div>`
        : r.lineage
          ? html`<div>${badge("active at launch", "good", icon.check)} lineage <a class="link" href="/lineages/${r.lineage.lineage_id}">${r.lineage.recipe_name}</a> exists for this repository.</div>`
          : html`<div>${badge("setting_up", "warn")} No lineage for this repository on Core: the agent's first job is drafting a recipe, and it authors only after calibration replays agree (SPEC 13.8).</div>`}`,
  );
}

function launchArgs() {
  const name = val("l_name");
  const symbol = val("l_symbol").toUpperCase();
  const cls = val("l_class") || "rust";
  const hosted = (S.root?.querySelector<HTMLInputElement>('input[name="l_hosted"]:checked')?.value ?? "hosted") === "hosted";
  const identity = S.root?.querySelector<HTMLInputElement>('input[name="l_identity"]:checked')?.value ?? "token";
  if (!name || new TextEncoder().encode(`TEST ${name}`).length > 32) throw new Error("Agent name: 1 to 27 characters (the on-chain name is TEST + name, 32 bytes max).");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol: 1 to 10 characters, A to Z and 0 to 9.");
  if (!S.repo || S.repo.state !== "ok") throw new Error("Target repository: enter a public GitHub https URL and wait for the check to pass.");
  const uri = `https://lineage.invalid/devnet/agents/${symbol.toLowerCase()}.json?class=${cls}`;
  return { name: `TEST ${name}`, symbol, uri, repoUrl: S.repo.url, identityMode: IDENTITY_MODE[identity as keyof typeof IDENTITY_MODE], hosted, cls, identity };
}

function labelFor(a: string, x: { agent?: string; mint?: string; pool?: string }): string {
  const L: Record<string, string> = {
    [me() ?? "-"]: "your wallet (launcher, fee payer)",
    [launchPdas.config()]: "launch config",
    [launchPdas.authority()]: "launch authority PDA",
    [lineMint()]: "tLINE mint (TEST)",
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
    const agent = keep ? S.draft!.agent : await generateWebKey();
    const mint = keep ? S.draft!.mint : await generateWebKey();
    const ix = launch.launchAgent({ launcher: me()!, agent: agent.id, agentMint: mint.id, lineMint: lineMint(), dbcConfig: dbcConfig(), lineTokenProgram: T22,
      args: { name: args.name, symbol: args.symbol, uri: args.uri, repoUrl: args.repoUrl, identityMode: args.identityMode, hosted: args.hosted } });
    const built = await buildAndSimulate(me()!, [ix], 400_000);
    S.draft = { agent, mint, built, args, ix };
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
    ["Class", `${d.args.cls} (metadata URI)`],
    ["Agent key", addr(d.agent.id)],
    ["Agent mint", addr(d.mint.id)],
  ];
  set(
    "w-launch-out",
    html`${sim.err ? html`<div class="panel-b">${errBox(`Simulation failed: ${JSON.stringify(sim.err)}`, sim.logs)}</div>` : html`<div class="panel-b wl-row"><span class="mark good">${icon.check} simulation succeeded on devnet</span></div>`}
      ${simTable(sim, { agent: d.agent.id, mint: d.mint.id }, me()!)}
      <div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">launch_agent arguments</div>${kv(recordRows)}</div>
      <div class="panel-b wl-row">${btn("launch-sign", html`Sign with ${S.wallet!.name} and launch`, { primary: true, disabled: sim.err ? "the simulation failed; fix the inputs and review again" : false })}${btn("launch-review", "Simulate again")}</div>
      <div class="panel-b" id="w-launch-status"></div>`,
  );
}

async function launchSign() {
  const d = S.draft;
  if (!d || !requireReady()) return;
  const st = (m: string) => set("w-launch-status", html`<span class="dim">${m}</span>`);
  try {
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: [d.ix], units: 400_000, local: [d.agent, d.mint], onStatus: st });
    const c = r.confirmed!;
    logSig(`launch_agent ${d.args.symbol}`, c.signature, c.fee, !c.err);
    if (c.err) throw Object.assign(new Error(`launch_agent failed on chain: ${JSON.stringify(c.err)}`), { logs: c.logs });
    S.launched = { agent: d.agent, mint: d.mint.id, sig: c.signature };
    S.draft = null;
    await renderLaunched();
    loadLaunches();
    refreshBalances();
  } catch (e) {
    set("w-launch-status", errBox(e, (e as any).logs));
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
    html`<div class="panel-b">${banner("info", html`Launched. ${txLink(L.sig, "View the transaction")}`, html`Everything below was read back from devnet after confirmation.`)}</div>
      <div class="eyebrow wl-sub">AgentLaunch ${addr(launchPdas.agentLaunch(L.mint))}</div>
      ${kv([
        ["Agent", addr(l.agent)],
        ["Mint", html`${addr(l.mint)} ${meta ? html`<span class="dim">${meta.name} (${meta.symbol})</span>` : ""}`],
        ["Launcher", addr(l.launcher)],
        ["Repository", l.repoUrl],
        ["repo_id", html`<span class="wl-hash">${l.repoId}</span> ${l.repoId === repoId(l.repoUrl) ? html`<span class="mark good">${icon.check} equals protocol repoId</span>` : html`<span class="mark warn">${icon.warn} differs</span>`}`],
        ["Identity / runtime", `${["token", "purchased", "app"][l.identityMode]} / ${l.hosted ? "hosted" : "self-hosted"}`],
        ["DBC pool", html`${addr(l.dbcPool)}${pv ? html` <span class="dim">creator ${pv.creator === launchPdas.authority() ? "launch authority PDA" : short(pv.creator)}, quote reserve ${units(pv.quoteReserve, dec())} tLINE</span>` : ""}`],
        ["Compute vault", html`${addr(launchPdas.computeVault(l.agent))} ${tl(vaultBal)}`],
        ["Awake", l.awake ? "yes" : "no (vault below wake_threshold)"],
        ["Created", when(l.createdAt)],
        ["Supply", mi ? html`${units(mi.supply, mi.decimals)} <span class="dim">agent tokens, ${mi.decimals} decimals, Token-2022</span>` : "TBA"],
        ["Metadata URI", meta?.uri ?? "TBA"],
        ["Registry record", rec ? html`kind ${rec.kind}, owner ${addr(rec.owner)}, hosted ${rec.hosted ? "yes" : "no"}` : "TBA"],
      ])}
      <div class="panel-b">
        <div class="wl-row">${btn("download-agent-key", "Download agent key (keypair JSON)", { primary: true })}${btn("goto-trade", "Trade on its curve")}</div>
        <div class="wl-fine">The agent key exists only in this tab. ${l.hosted ? "The hosted runtime's key handover ships with the runtime (TBA); keep the file." : "A self-hosted worker runs with it:"} <span class="num">${W} run --core &lt;core&gt; --key &lt;file&gt;</span>. Leaving the page drops it.</div>
      </div>`,
  );
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
// trade and crank

async function loadLaunches() {
  try {
    S.launches = await reader.launches();
    const mints = S.launches.map((l) => l.mint);
    const pools = S.launches.map((l) => l.dbcPool);
    const accs = await rpc.getMultipleAccounts([...mints, ...pools]);
    mints.forEach((m, i) => {
      S.metas.set(m, accs[i] ? decodeT22Metadata(accs[i]!.data) : null);
      if (accs[i]) S.decimals.set(m, decodeMint(accs[i]!.data).decimals);
    });
    pools.forEach((p, i) => S.pools.set(p, accs[mints.length + i] ? decodeDbcPool(accs[mints.length + i]!.data) : null));
    S.launches.sort((a, b) => Number(b.createdAt - a.createdAt));
  } catch (e) {
    set("w-agents", html`<div class="panel-b">${errBox(e)}</div>`);
    return;
  }
  renderAgents();
  // the bounty form lists the agents this wallet launched
  if (S.bcfg !== undefined) renderBountyForm();
}

function renderAgents() {
  if (!S.launches.length) return set("w-agents", html`<div class="panel-b dim">No agent has been launched on devnet yet. Launch one on the Launch tab.</div>`);
  set(
    "w-agents",
    html`<div class="tw"><table class="t"><thead><tr><th>Agent token</th><th class="hide-sm">Repository</th><th class="right">Quote reserve</th><th class="right">Fees claimed</th><th></th></tr></thead><tbody>
      ${S.launches.map((l) => {
        const m = S.metas.get(l.mint);
        const p = S.pools.get(l.dbcPool);
        return html`<tr class="${S.sel === l.mint ? "wl-selrow" : ""}"><td><b>${m?.symbol ?? short(l.mint)}</b><div class="sub">${m?.name ?? ""}${l.launcher === me() ? " · yours" : ""}</div></td>
          <td class="wrap hide-sm">${l.repoUrl.replace("https://github.com/", "")}</td>
          <td class="right">${p ? tl(p.quoteReserve) : html`<span class="faint">TBA</span>`}</td>
          <td class="right">${tl(l.feesClaimed)}</td>
          <td class="right">${btn("select-agent", S.sel === l.mint ? "Selected" : "Select", { data: { mint: l.mint } })}</td></tr>`;
      })}</tbody></table></div>`,
  );
}

async function renderTrade() {
  const l = S.launches.find((x) => x.mint === S.sel);
  if (!l) return;
  set("w-trade", html`<div class="panel-b dim">Reading the pool…</div>`);
  const a = me();
  const accs = await rpc.getMultipleAccounts([l.dbcPool, launchPdas.agentLaunch(l.mint), a ? ata(a, l.mint, T22) : l.mint, launchPdas.computeVault(l.agent), registryPdas.treasury()]);
  const pv = accs[0] ? decodeDbcPool(accs[0].data) : null;
  const fresh = accs[1] ? decodeAgentLaunch(accs[1].data) : l;
  const myAgentTok = a && accs[2] ? decodeTokenAccount(accs[2].data).amount : a ? 0n : null;
  const vault = accs[3] ? decodeTokenAccount(accs[3].data).amount : null;
  S.pools.set(l.dbcPool, pv);
  const m = S.metas.get(l.mint);
  const sym = m?.symbol ?? "agent";
  const thr = S.lc?.migrationQuoteThreshold ?? null;
  const pending = pv?.partnerQuoteFee ?? 0n;
  const q = S.quote;
  set(
    "w-trade",
    html`<div class="stats" style="--n:3">
        ${stat("Quote reserve", pv ? html`${units(pv.quoteReserve, dec())}<span class="unit">tLINE</span>` : "TBA", thr ? `migrates at ${units(thr, dec())} tLINE` : "threshold TBA", "sm")}
        ${stat("Claimable fees", pv ? html`${units(pending, dec())}<span class="unit">tLINE</span>` : "TBA", "partner fees waiting for crank_fees", "sm")}
        ${stat("Compute vault", vault === null ? "TBA" : html`${units(vault, dec())}<span class="unit">tLINE</span>`, fresh.awake ? "awake" : "asleep", "sm")}
      </div>
      ${kv([
        ["Agent token", html`${addr(l.mint, `${sym} ${short(l.mint)}`)} <span class="dim">${m?.name ?? ""}</span>`],
        ["Your balances", a ? html`${tl(S.line)} · <span class="num">${myAgentTok === null ? "TBA" : units(myAgentTok, adec(l.mint))}</span><span class="unit">${sym}</span>` : "connect a wallet"],
        ["Fees so far", html`claimed ${tl(fresh.feesClaimed)}, to compute ${tl(fresh.toCompute)}, to protocol ${tl(fresh.toProtocol)}`],
        ["Meteora's share", pv ? html`${tl(pv.protocolQuoteFee)} <span class="dim">kept by Meteora, not claimable by the program</span>` : "TBA"],
        ["Pool", html`${addr(l.dbcPool)} ${pv?.isMigrated ? badge("migrated", "info") : ""}`],
      ])}
      <div class="panel-b wl-trade">
        <div class="seg" role="group" aria-label="Side"><button type="button" data-act="side" data-side="buy" aria-pressed="${String((q?.side ?? S_side) === "buy")}">Buy with tLINE</button><button type="button" data-act="side" data-side="sell" aria-pressed="${String((q?.side ?? S_side) === "sell")}">Sell ${sym}</button></div>
        <div class="wl-2" style="margin-top:10px">
          <label class="wl-field"><span class="eyebrow">${S_side === "buy" ? "tLINE in" : `${sym} in`}</span><input name="t_amount" inputmode="decimal" placeholder="${S_side === "buy" ? "100" : "1000"}" value="${esc(S_amount)}"></label>
          <label class="wl-field"><span class="eyebrow">Slippage tolerance (bps)</span><input name="t_slip" inputmode="numeric" value="${esc(S_slip)}"></label>
        </div>
        <div class="wl-row" style="margin-top:10px">${btn("trade-review", "Simulate", { primary: !q })}${q ? btn("trade-sign", html`Sign and ${q.side}`, { primary: true }) : ""}</div>
        <div id="w-quote">${q ? quoteView(q, sym) : ""}</div>
      </div>
      <div class="panel-b wl-crank">
        <div class="eyebrow">Crank fees (permissionless)</div>
        <div class="wl-fine">Claims the pool's partner fees into this program and splits them: floor(fees x ${S.lc?.agentComputeBps ?? "TBA"} / 10,000) to the agent's compute vault, the rest to the registry treasury. Any wallet may send it and pays only the network fee (plus the authority's agent-token account the first time).</div>
        <div class="wl-row" style="margin-top:8px">${btn("crank", html`Crank ${units(pending, dec())} tLINE of fees`, { disabled: !pv ? "pool not readable" : pending === 0n ? "no partner fees in the pool yet: trade first" : false })}</div>
      </div>
      <div id="w-trade-out">${S.tradeOut ?? ""}</div>`,
  );
}
let S_side: "buy" | "sell" = "buy";
let S_amount = "";
let S_slip = "100";

const adec = (mint: string | null | undefined) => (mint ? (S.decimals.get(mint) ?? 6) : 6);

function quoteView(q: NonNullable<typeof S.quote>, sym: string): Raw {
  const inU = q.side === "buy" ? "tLINE" : sym;
  const outU = q.side === "buy" ? sym : "tLINE";
  return html`<div class="wl-quote">${q.built.sim.err ? errBox(`Simulation failed: ${JSON.stringify(q.built.sim.err)}`, q.built.sim.logs) : html`
    <div>Simulated on devnet: <b>${units(q.amountIn, q.side === "buy" ? dec() : adec(S.sel))} ${inU}</b> in, <b>${units(q.out, q.side === "buy" ? adec(S.sel) : dec())} ${outU}</b> out. Minimum out at your tolerance: ${units(q.minOut, q.side === "buy" ? adec(S.sel) : dec())} ${outU}. Network fee ${q.built.sim.fee === null ? "TBA" : sol(q.built.sim.fee)} SOL.</div>`}</div>`;
}

function tradeIxs(l: AgentLaunch, buy: boolean, amountIn: bigint, minOut: bigint): Ix[] {
  const a = me()!;
  return [
    token.createAtaIdempotent(a, a, l.mint, T22),
    dbc.swap({ config: l.dbcConfig, pool: l.dbcPool, agentMint: l.mint, lineMint: lineMint(), trader: a, lineAccount: ata(a, lineMint(), T22), agentAccount: ata(a, l.mint, T22),
      buy, amountIn, minOut, lineTokenProgram: T22 }),
  ];
}

async function tradeReview() {
  const l = S.launches.find((x) => x.mint === S.sel);
  if (!l || !requireReady()) return;
  S_amount = val("t_amount");
  S_slip = val("t_slip") || "100";
  const buy = S_side === "buy";
  const amountIn = parseUnits(S_amount, buy ? dec() : adec(l.mint));
  const slip = Number(S_slip);
  if (!amountIn || !Number.isInteger(slip) || slip < 0 || slip > 5000) {
    set("w-quote", errBox("Enter a positive amount and a slippage tolerance between 0 and 5000 bps."));
    return;
  }
  set("w-quote", html`<span class="dim">Simulating…</span>`);
  try {
    const built = await buildAndSimulate(me()!, tradeIxs(l, buy, amountIn, 1n), 300_000);
    const outAcc = buy ? ata(me()!, l.mint, T22) : ata(me()!, lineMint(), T22);
    const row = built.sim.accounts.find((x) => x.address === outAcc);
    const before = row?.dataBefore ? decodeTokenAccount(row.dataBefore).amount : 0n;
    const after = row?.dataAfter && row.dataAfter.length >= 165 ? decodeTokenAccount(row.dataAfter).amount : before;
    const out = after - before;
    S.quote = { side: S_side, amountIn, out, built, minOut: (out * BigInt(10_000 - slip)) / 10_000n || 1n };
  } catch (e) {
    S.quote = null;
    set("w-quote", errBox(e));
    return;
  }
  renderTrade();
}

async function tradeSign() {
  const l = S.launches.find((x) => x.mint === S.sel);
  const q = S.quote;
  if (!l || !q || !requireReady()) return;
  const st = (m: string) => set("w-quote", html`<span class="dim">${m}</span>`);
  try {
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs: tradeIxs(l, q.side === "buy", q.amountIn, q.minOut), units: 300_000, onStatus: st });
    const c = r.confirmed!;
    logSig(`${q.side} ${S.metas.get(l.mint)?.symbol ?? "agent"} on DBC`, c.signature, c.fee, !c.err);
    if (c.err) throw Object.assign(new Error(`swap failed on chain: ${JSON.stringify(c.err)}`), { logs: c.logs });
    S.tradeOut = html`<div class="panel-b">${banner("info", html`${q.side === "buy" ? "Bought" : "Sold"}: ${txLink(c.signature)}`, "Balances and pool below are read after confirmation.")}</div>`;
    S.quote = null;
    await refreshBalances();
    await renderTrade();
  } catch (e) {
    set("w-quote", errBox(e, (e as any).logs));
  }
}

async function crank() {
  const l = S.launches.find((x) => x.mint === S.sel);
  if (!l || !requireReady()) return;
  set("w-trade-out", html`<div class="panel-b dim">Building crank_fees…</div>`);
  try {
    const before = await Promise.all([reader.agentLaunch(l.mint), reader.tokenBalances([launchPdas.computeVault(l.agent), registryPdas.treasury()])]);
    const ixs = [
      token.createAtaIdempotent(me()!, launchPdas.authority(), l.mint, T22),
      launch.crankFees({ agent: l.agent, agentMint: l.mint, lineMint: lineMint(), dbcConfig: l.dbcConfig, lineTokenProgram: T22 }),
    ];
    const sim = await buildAndSimulate(me()!, ixs, 400_000);
    if (sim.sim.err) throw Object.assign(new Error(`simulation failed: ${JSON.stringify(sim.sim.err)}`), { logs: sim.sim.logs });
    const r = await signAndSend({ wallet: S.wallet!, account: S.account!, ixs, units: 400_000, onStatus: (m) => set("w-trade-out", html`<div class="panel-b dim">${m}</div>`) });
    const c = r.confirmed!;
    logSig(`crank_fees ${S.metas.get(l.mint)?.symbol ?? ""}`, c.signature, c.fee, !c.err);
    if (c.err) throw Object.assign(new Error(`crank_fees failed: ${JSON.stringify(c.err)}`), { logs: c.logs });
    const after = await Promise.all([reader.agentLaunch(l.mint), reader.tokenBalances([launchPdas.computeVault(l.agent), registryPdas.treasury()])]);
    const fees = after[0]!.feesClaimed - before[0]!.feesClaimed;
    const toC = after[0]!.toCompute - before[0]!.toCompute;
    const toP = after[0]!.toProtocol - before[0]!.toProtocol;
    const dV = (after[1][0] ?? 0n) - (before[1][0] ?? 0n);
    const dT = (after[1][1] ?? 0n) - (before[1][1] ?? 0n);
    const want = (fees * BigInt(S.lc!.agentComputeBps)) / 10_000n;
    S.tradeOut = html`<div class="panel-b">${banner("info", html`Cranked: ${txLink(c.signature)}`, "Split read back from the AgentLaunch counters and both token accounts.")}
      ${kv([
        ["Fees claimed", tl(fees)],
        ["To compute vault", html`${tl(toC)} <span class="dim">vault balance +${units(dV, dec())}</span> ${toC === want ? html`<span class="mark good">${icon.check} floor(fees x ${S.lc!.agentComputeBps} / 10,000)</span>` : html`<span class="mark warn">${icon.warn} expected ${units(want, dec())}</span>`}`],
        ["To treasury", html`${tl(toP)} <span class="dim">treasury +${units(dT, dec())}</span> ${toP === fees - toC ? html`<span class="mark good">${icon.check} the rest</span>` : ""}`],
      ])}</div>`;
    loadLaunches();
    await renderTrade();
  } catch (e) {
    set("w-trade-out", html`<div class="panel-b">${errBox(e, (e as any).logs)}</div>`);
  }
}

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
      <div class="wl-row" style="margin-top:10px">${btn("v-register", "Sign register as owner", { primary: true, disabled: !S.account ? "connect a wallet" : short0 ? `needs ${units(need!, dec())} tLINE to burn: use Get tLINE` : false })}</div>
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
            <div><label class="wl-field"><span class="eyebrow">Bond (tLINE)</span><input name="v_bond" inputmode="decimal" value="${p && rec.bond < p.minBond ? units(p.minBond - rec.bond, dec()) : ""}"></label>
              <div class="wl-row" style="margin-top:8px">${btn("v-bond", "Sign bond", { primary: true, disabled: rec.kind !== "verifier" ? "hosted launched agents never bond" : false })}</div></div>
            <div><label class="wl-field"><span class="eyebrow">Unbond (tLINE)</span><input name="v_unbond" inputmode="decimal" value=""></label>
              <div class="wl-row" style="margin-top:8px">${btn("v-unbond", "Request unbond", { disabled: rec.bond === 0n ? "nothing bonded" : false })}${btn("v-withdraw", "Withdraw", { disabled: rec.unbondAmount === 0n ? "no pending unbond" : !ready ? `cooldown of ${p ? String(p.unbondCooldownS) : "TBA"} s not over` : false })}</div></div>
          </div>
          <div class="wl-fine" style="margin-top:8px">Bonds move tLINE from your wallet to the bond vault ${addr(registryPdas.bondVault())}; they stay slashable until withdrawn after unbond_cooldown.</div>`
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
      <li>Rewards for replays go to <span class="num">agent:&lt;key&gt;:wallet</span>, paid to a tLINE account owned by the owner wallet (Claims tab).</li>
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
      S.vOut = html`<div class="panel-b">${banner("info", "Registered by the worker's co-signature.", html`Burned ${units(rec.burned, dec())} tLINE (Agent.burned)${supply0 !== null && supply1 !== null ? html`; tLINE supply fell by ${units(supply0 - supply1, dec())}` : ""}.`)}</div>`;
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
      S.vOut = errBox("Enter a positive tLINE amount.");
      return renderVerifier();
    }
    ix = kind === "bond" ? registry.bond({ owner: me()!, agent, mint: lineMint(), ownerToken, amount: amt, tokenProgram: T22 }) : registry.requestUnbond({ owner: me()!, agent, amount: amt });
    label = `${kind === "bond" ? "bond" : "request_unbond"} ${units(amt, dec())} tLINE`;
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
        ? html`Bond ${units(before.bond, dec())} to ${units(after.bond, dec())} tLINE (read back).`
        : kind === "unbond"
          ? html`Pending unbond ${units(after.unbondAmount, dec())} tLINE, withdrawable from ${when(after.unbondReadyAt)}; the bond stays ${units(after.bond, dec())} tLINE and slashable until then (read back).`
          : html`Bond ${units(before.bond, dec())} to ${units(after.bond, dec())} tLINE; withdrawn to your wallet (read back).`;
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
  else if (rec === null) body = html`<div class="dim">No Agent record for this key on devnet.</div>`;
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
      <div id="w-iout">${S.iOut ?? ""}</div>`;
  }
  set(
    "w-id",
    html`<div class="panel-b"><label class="wl-field"><span class="eyebrow">Agent id</span><input name="i_key" placeholder="base58 agent id" value="${esc(k)}" spellcheck="false"></label>
      <div class="wl-row" style="margin-top:8px">${btn("i-lookup", "Look up")}</div></div>
    <div class="panel-b" style="padding-top:0">${body}</div>`,
  );
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
        ${stat("Claimable", html`${units(open.reduce((n, r) => n + r.amount, 0n), dec())}<span class="unit">tLINE</span>`, `${open.length} unclaimed ${open.length === 1 ? "leaf" : "leaves"}`, "sm")}
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
    S.claimOut = html`<div class="panel-b">${banner("info", html`Claimed epoch ${r.epoch}: ${txLink(cf.signature)}`, html`${addr(destToken)} received ${units(b1 - b0, dec())} tLINE (read back)${b1 - b0 === r.amount ? ", exactly the leaf amount" : ""}.`)}</div>`;
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
const myPayers = () => S.launches.filter((l) => l.launcher === me() && !l.hosted);
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
      ? html`<div class="panel-b dim">This wallet launched no self-hosted agent. A bounty is paid from an agent's compute vault: the launcher signs for a self-hosted agent, the hosted runtime for a hosted one.</div>`
      : html`<form class="wl-form panel-b" autocomplete="off" data-wallet-form="bounty">
        <label><span class="eyebrow">Paying agent (its compute vault)</span><select name="b_payer">${payers.map((l) => html`<option value="${l.agent}">${S.metas.get(l.mint)?.symbol ?? short(l.mint)} · ${short(l.agent)}</option>`)}</select></label>
        <div class="wl-2">
          <label><span class="eyebrow">Amount (tLINE)</span><input name="b_amount" inputmode="decimal" placeholder="1"></label>
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
  if (!list.length) return set("w-blist", html`<div class="panel-b dim">No bounty has been opened on devnet yet.</div>
    <div class="panel-b wl-row">${btn("b-reload", "Look again")}</div>`);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const grace = BigInt(S.bcfg?.refundGraceS ?? 0);
  set(
    "w-blist",
    html`<div class="tw"><table class="t" data-bounties><thead><tr><th>Bounty</th><th>Condition</th><th class="right">Amount</th><th>Status</th></tr></thead><tbody>
      ${list.map((b) => {
        const rel = S.bRelease.get(b.address);
        const refundable = b.status === "open" && nowS > b.deadline + grace;
        const cancellable = b.status === "open" && b.opener === me() && S.reg && S.reg.epochsPosted === b.epochsPostedAtOpen;
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
    if (!amount) throw new Error("enter a positive tLINE amount");
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
    const c = await bSend(`open_bounty ${units(amount, dec())} tLINE from ${short(payer)}`, [ix]);
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
      html`The compute vault went from ${units(v0, dec())} to ${units(v1 ?? 0n, dec())} tLINE and the escrow holds ${units(esc0 ?? 0n, dec())} tLINE (read back); qualifying generations from epoch ${String(acct?.minEpoch ?? "TBA")} on. ${termsNote}`)}</div>`;
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
      html`The payee's compute vault received ${units((v1 ?? 0n) - v0, dec())} tLINE${(v1 ?? 0n) - v0 === b.amount ? ", exactly the escrow" : ""}; status ${after?.status ?? "TBA"} (read back).`)}</div>`;
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
      html`${units(v1 - v0, dec())} tLINE back in the paying agent's compute vault (read back).`)}</div>`;
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
// wiring

function requireReady(): boolean {
  if (S.gate !== "ok") return false;
  if (!S.account || !S.wallet) {
    S.walletErr = "Connect a wallet first.";
    renderConn();
    return false;
  }
  if (S.account.chains?.length && !S.account.chains.includes(DEVNET_CHAIN)) return false;
  return true;
}

let unsub: (() => void) | null = null;
async function doConnect(name: string, silent = false) {
  const w = discovered().find((x) => x.name === name);
  if (!w) return;
  S.walletErr = null;
  try {
    const acc = await connect(w, silent);
    if (!acc) throw new Error("the wallet returned no account");
    S.wallet = w;
    S.account = acc;
    try {
      localStorage.setItem("lineage-wallet", w.name);
    } catch {
      /* storage blocked */
    }
    unsub?.();
    unsub = onChange(w, () => {
      const a = w.accounts[0];
      if (a && a.address !== S.account?.address) {
        S.account = a;
        afterConnect();
      }
    });
    afterConnect();
  } catch (e) {
    if (!silent) S.walletErr = `Connect failed: ${(e as Error).message}`;
    renderConn();
  }
}
function afterConnect() {
  S.sol = S.line = null;
  S.claims = null;
  renderConn();
  refreshBalances();
  renderVerifier();
  renderIdentity();
  if (S.sel) renderTrade();
  loadClaims();
  renderBountyForm();
  renderBounties();
}

async function onClick(ev: Event) {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!b || (b as HTMLButtonElement).disabled) return;
  const act = b.dataset.act!;
  const key = act + (b.dataset.mint ?? b.dataset.i ?? "");
  if (S.busy.has(key)) return;
  S.busy.add(key);
  b.setAttribute("aria-busy", "true");
  try {
    switch (act) {
      case "connect":
        await doConnect(b.dataset.name!);
        break;
      case "disconnect":
        if (S.wallet) await disconnect(S.wallet);
        S.wallet = S.account = null;
        try {
          localStorage.removeItem("lineage-wallet");
        } catch {
          /* ignore */
        }
        renderConn();
        break;
      case "refresh":
        await Promise.all([refreshBalances(), loadNetwork(), loadLaunches()]);
        break;
      case "faucet": {
        S.faucetMsg = html`<div class="panel-b dim">Asking the faucet…</div>`;
        renderConn();
        const r = await fetch("/chain/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: me() }) });
        const j = await r.json();
        if (r.ok) {
          logSig(`faucet: ${units(BigInt(j.amount), dec())} tLINE to you`, j.signature, j.fee, true);
          S.faucetMsg = html`<div class="panel-b">${banner("info", html`Received ${units(BigInt(j.amount), dec())} tLINE: ${txLink(j.signature)}`)}</div>`;
        } else S.faucetMsg = html`<div class="panel-b">${errBox(j.message ?? `HTTP ${r.status}`)}</div>`;
        await refreshBalances();
        break;
      }
      case "launch-review":
        await launchReview();
        break;
      case "launch-sign":
        await launchSign();
        break;
      case "download-agent-key":
        await downloadAgentKey();
        break;
      case "goto-trade":
        S.sel = S.launched?.mint ?? null;
        S.root?.querySelector<HTMLElement>('[data-tab="trade"]')?.click();
        await loadLaunches();
        await renderTrade();
        break;
      case "select-agent":
        S.sel = b.dataset.mint!;
        S.quote = null;
        S.tradeOut = null;
        renderAgents();
        await renderTrade();
        break;
      case "side":
        S_side = b.dataset.side as "buy" | "sell";
        S.quote = null;
        S_amount = "";
        await renderTrade();
        break;
      case "trade-review":
        await tradeReview();
        break;
      case "trade-sign":
        await tradeSign();
        break;
      case "crank":
        await crank();
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
    }
  } finally {
    S.busy.delete(key);
    b.removeAttribute("aria-busy");
  }
}

let repoTimer: ReturnType<typeof setTimeout> | null = null;
function onInput(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.name === "l_repo") {
    if (repoTimer) clearTimeout(repoTimer);
    repoTimer = setTimeout(checkRepo, 500);
  }
  if (t.name === "l_identity") set("w-custody", custodyText(t.value));
  if (t.name === "l_name") {
    const sym = S.root?.querySelector<HTMLInputElement>('[name="l_symbol"]');
    if (sym && !sym.dataset.touched) sym.value = ("T" + t.value.toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(0, 10);
  }
  if (t.name === "l_symbol") t.dataset.touched = "1";
  if (t.name === "t_amount" || t.name === "t_slip") S.quote = null;
  if (t.name?.startsWith("l_")) S.draft = null;
}

/** Called by the dashboard shell after the Wallet page's skeleton is in the DOM. */
export async function mountWallet(root: HTMLElement) {
  S.root = root;
  root.innerHTML = skeleton().s;
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("submit", (e) => e.preventDefault());
  startDiscovery();
  onWallets(() => {
    renderConn();
    autoReconnect();
  });
  renderSigs();
  renderVerifier();
  renderIdentity();
  try {
    S.cfg = await loadChainCfg();
    if (!S.cfg.state) throw new Error("This server has no devnet state (scripts/devnet/devnet.json).");
    await devnetGate();
    S.gate = "ok";
  } catch (e) {
    S.gate = (e as Error).message;
  }
  renderGate();
  renderConn();
  if (S.gate !== "ok") return;
  await Promise.all([loadNetwork(), loadLaunches()]);
  await loadBounties();
  autoReconnect();
}

let triedAuto = false;
function autoReconnect() {
  if (triedAuto || S.account || !S.cfg) return;
  let name: string | null = null;
  try {
    name = localStorage.getItem("lineage-wallet");
  } catch {
    /* ignore */
  }
  if (name && discovered().some((w) => w.name === name)) {
    triedAuto = true;
    doConnect(name, true);
  }
}

// "Join a pool": the connected wallet's agents and, for each, its repository's pool and one action
// (docs/plans/AGENT-POOLS.md 11). One component for the Pools page (every agent this wallet owns)
// and for Profile > Manage (one agent). The program lets the wallet named as the agent's owner in the
// registry join the agent to the pool of the repository it was launched on; the agent's own key does
// not sign, so a hosted agent joins like any other. Everything shown is read from chain when it is
// shown; pressing the action builds join_pool, simulates it, states what joining does and what it
// costs, and only then asks the wallet for one approval (signAndSend: the bounty form's path).
import { claimPdas, decodeFeeRoute, decodeLaunchConfig, decodePool, decodePoolConfig, decodePoolMember, FEATURES, launchPdas, MAX_POOL_FEE_BPS, POOL_ACCOUNT_LEN, POOL_MEMBER_ACCOUNT_LEN, POOL_VAULT_ACCOUNT_LEN, poolPdas, pools,
  TOKEN_2022_PROGRAM, type AgentLaunch, type Ix, type Pool, type PoolConfig, type PoolMember } from "../../../packages/chain/src/browser/index.ts";
import { repoLabel } from "../src/fmt.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { banner } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, solToUsd } from "../src/usd.ts";
import { buildAndSimulate, loadChainCfg, NET, qsym, reader, rpc, signAndSend, sol, unitPrice, units, type ChainCfg } from "./chain.ts";
import { actionLabel, joinCost, joinFacts, joinState, joinUnits, networkFee, pct, rentFromSimulation, stateLine, type Fact, type JoinCost, type JoinState } from "./pool-join-plan.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface Row { launch: AgentLaunch; pool: Pool | null; member: PoolMember | null; routeBps: number | null; state: JoinState }
interface Review { agent: string; ixs: Ix[]; units: number; facts: Fact[]; cost: JoinCost; balance: bigint; opens: boolean }

const P: { root: HTMLElement | null; only: string | null; chain: ChainCfg | null; cfg: PoolConfig | null; featureOn: boolean; lineMint: string | null; rows: Row[] | null; loadedFor: string | null;
  names: Map<string, { name: string; symbol: string }>; review: Review | null; busy: string | null; busyAgent: string | null; err: string | null; errAgent: string | null;
  done: { agent: string; signature: string; opened: boolean } | null; off: (() => void) | null } =
  { root: null, only: null, chain: null, cfg: null, featureOn: false, lineMint: null, rows: null, loadedFor: null, names: new Map(), review: null, busy: null, busyAgent: null, err: null, errAgent: null,
    done: null, off: null };

const me = () => session().account?.address ?? null;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const dec = () => P.chain?.state?.line_decimals ?? NET.p.quote.decimals ?? 6;
const coin = (base: bigint) => `${units(base, dec())} ${qsym()}`;
const usd = (base: bigint): string | null => { const d = quoteToUsd(Number(base) / 10 ** dec()); return d === null ? null : fmtUsd(d); };
const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const nameOf = (agent: string) => { const n = P.names.get(agent); return n ? n.name || n.symbol : short(agent); };
const repoOf = (l: AgentLaunch) => repoLabel(l.repoUrl) || `repository ${l.repoId.slice(0, 8)}`;

const CSS = `
.pj{display:grid;gap:14px;min-width:0}
.pj-row{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);padding:14px 16px;display:grid;gap:10px;min-width:0}
.pj-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 14px}
.pj-name{font-family:var(--display);font-size:17px;font-weight:500;letter-spacing:-.02em;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
.pj-name:hover{text-decoration:underline}
.pj-repo{font-size:13px;color:var(--ts);overflow-wrap:anywhere}
.pj-state{margin:0;font-size:13.5px;line-height:1.5;color:var(--ts)}
.pj-members{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.pj-members li{font-size:12.5px;border:1px solid var(--border);border-radius:9999px;padding:2px 10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-members a{color:var(--tp);text-decoration:none}
.pj-members a:hover{text-decoration:underline}
.pj .wl-btn{white-space:normal;height:auto;min-height:38px;padding:8px 14px;line-height:1.25;text-align:left;max-width:100%}
.pj-facts{margin:0;padding-left:18px;display:grid;gap:8px;font-size:13.5px;line-height:1.5;color:var(--ts)}
.pj-facts li[data-pj-fact="undo"]{color:var(--tp);font-weight:500}
.pj-cost{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;font-size:13.5px;margin:0;font-variant-numeric:tabular-nums}
.pj-cost dt{color:var(--ts)}
.pj-cost dd{margin:0;text-align:right;color:var(--tp)}
.pj-cost .tot{border-top:1px solid var(--border);padding-top:6px;font-weight:500;color:var(--tp)}
.pj-h{margin:0;font-family:var(--display);font-size:15px;font-weight:500;letter-spacing:-.02em;color:var(--tp)}
.pj-ways{margin:0;padding-left:18px;display:grid;gap:8px;font-size:13.5px;line-height:1.5;color:var(--ts)}
.pj p{margin:0;font-size:13.5px;line-height:1.5;color:var(--ts)}
@media (max-width:520px){.pj-cost{grid-template-columns:minmax(0,1fr);gap:0}.pj-cost dd{text-align:left;margin-bottom:8px}.pj-cost dd.tot{border-top:0;padding-top:0}}
`;
function injectStyle() {
  if (document.getElementById("pj-css")) return;
  const s = document.createElement("style");
  s.id = "pj-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------- chain reads ----------

/** The switches and the settings, with or without a wallet: the chain's feature bit, PoolConfig, and Core's own flag. */
async function loadSettings() {
  const [lcA, pcA, core] = await Promise.all([rpc.getAccountInfo(launchPdas.config()), rpc.getAccountInfo(poolPdas.config()),
    fetch("/api/pools/config", { headers: { accept: "application/json" } }).then((r) => r.ok).catch(() => false)]);
  const lc = lcA ? decodeLaunchConfig(lcA.data) : null;
  P.cfg = pcA ? decodePoolConfig(pcA.data) : null;
  P.lineMint = lc?.lineMint ?? null;
  P.featureOn = !!lc && !lc.paused && !!(lc.features & FEATURES.pools) && core;
}

/** The agents this wallet owns on chain (the registry's owner field), each with its repository's pool, its membership and its fee route. */
async function loadMine(force = false) {
  const w = me();
  if (!w) { P.rows = null; P.loadedFor = null; return render(); }
  if (!force && P.loadedFor === w) return;
  P.loadedFor = w;
  if (!force) P.rows = null;
  render();
  try {
    await loadSettings();
    const [launches, agents, market] = await Promise.all([reader.launches(), reader.agents(),
      fetch("/market/tokens?limit=200").then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
    if (me() !== w) return;
    for (const t of (market?.tokens ?? []) as { agent?: string; name?: string; symbol?: string }[]) if (t.agent) P.names.set(t.agent, { name: t.name ?? "", symbol: t.symbol ?? "" });
    const owner = new Map(agents.map((a) => [a.agent, a.owner]));
    const mine = launches.filter((l) => owner.get(l.agent) === w && (!P.only || l.agent === P.only));
    const repos = [...new Set(mine.map((l) => l.repoId))];
    const accts = await rpc.getMultipleAccounts([...repos.map((r) => poolPdas.pool(r)), ...mine.map((l) => poolPdas.member(l.agent)), ...mine.map((l) => claimPdas.feeRoute(l.agent))]);
    const poolOf = new Map(repos.map((r, i) => [r, accts[i] ? decodePool(accts[i]!.data) : null]));
    P.rows = mine.map((l, i) => {
      const mA = accts[repos.length + i], rA = accts[repos.length + mine.length + i];
      const member = mA ? decodePoolMember(mA.data) : null, pool = poolOf.get(l.repoId) ?? null;
      // a route counts only once it is set on the agent's record (the bit the crank reads)
      const routeBps = rA && l.routes & FEATURES.githubFees ? decodeFeeRoute(rA.data).bps : null;
      return { launch: l, pool, member, routeBps, state: joinState({ featureOn: P.featureOn, cfg: P.cfg, venue: l.venue, agent: l.agent, isMember: !!member, pool }) };
    });
  } catch (e) {
    P.loadedFor = null;
    P.rows = [];
    P.err = `The chain did not answer: ${(e as Error).message}`;
    P.errAgent = null;
  }
  render();
}

// ---------- actions ----------

async function act(label: string, agent: string | null, fn: () => Promise<void>) {
  if (P.busy) return;
  P.busy = label;
  P.busyAgent = agent;
  P.err = null;
  render();
  try {
    await fn();
  } catch (e) {
    P.err = String((e as Error)?.message ?? e);
    P.errAgent = agent;
  }
  P.busy = null;
  P.busyAgent = null;
  render();
}

/** Reads the chain again, builds join_pool for this agent, simulates it and prepares the review. Nothing is signed here. */
const review = (agent: string) => act("Reading the chain", agent, async () => {
  const w = me();
  if (!w) throw new Error("Connect a wallet first.");
  await loadSettings();
  const row = P.rows?.find((r) => r.launch.agent === agent);
  if (!row || !P.cfg || !P.lineMint) throw new Error("The chain settings are not loaded yet.");
  const l = row.launch;
  // the pool and the membership as they are now: another member may have joined since the list was drawn
  const [poolA, memberA, balance, rentPool, rentMember, rentVault] = await Promise.all([rpc.getAccountInfo(poolPdas.pool(l.repoId)), rpc.getAccountInfo(poolPdas.member(l.agent)), rpc.getBalance(w),
    rpc.getMinimumBalanceForRentExemption(POOL_ACCOUNT_LEN), rpc.getMinimumBalanceForRentExemption(POOL_MEMBER_ACCOUNT_LEN), rpc.getMinimumBalanceForRentExemption(POOL_VAULT_ACCOUNT_LEN)]);
  const pool = poolA ? decodePool(poolA.data) : null;
  row.pool = pool;
  row.member = memberA ? decodePoolMember(memberA.data) : null;
  row.state = joinState({ featureOn: P.featureOn, cfg: P.cfg, venue: l.venue, agent: l.agent, isMember: !!row.member, pool });
  if (row.state.kind !== "open" && row.state.kind !== "join") throw new Error(stateLine(row.state, repoOf(l)));
  const members = pool?.members ?? [];
  const ixs = [pools.joinPool({ signer: w, agent: l.agent, agentMint: l.mint, repoId: l.repoId, lineMint: P.lineMint, members, lineTokenProgram: TOKEN_2022_PROGRAM })];
  const cu = joinUnits(members.length), fee = networkFee(cu, await unitPrice(w, ixs));
  // what the wallet must hold, from the sizes of the accounts the program creates; the review then states what the simulation really charged
  const need = joinCost({ opens: !pool, rent: { pool: BigInt(rentPool), vault: BigInt(rentVault), member: BigInt(rentMember) }, fee });
  if (BigInt(balance) < need.total) throw new Error(`This wallet holds ${sol(BigInt(balance))} SOL. The join needs ${usdSol(need.total)} (${sol(need.total)} SOL) for the new accounts and the network fee.`);
  const built = await buildAndSimulate(w, ixs, cu);
  if (built.sim.err) throw new Error(`The chain refuses this now: ${(built.sim.logs ?? []).filter((x) => /Error|failed/.test(x)).pop() ?? JSON.stringify(built.sim.err)}`);
  const charged = rentFromSimulation(built.sim.accounts, { pool: poolPdas.pool(l.repoId), vault: poolPdas.vault(l.repoId, P.lineMint, TOKEN_2022_PROGRAM), member: poolPdas.member(l.agent) });
  if (!charged) throw new Error("The simulation did not create the membership. Nothing was signed.");
  const cost = joinCost({ ...charged, fee });
  P.review = { agent, ixs, units: cu, cost, balance: BigInt(balance), opens: charged.opens,
    facts: joinFacts({ cfg: P.cfg, others: members.length, routeBps: row.routeBps, agentName: nameOf(agent), coin, usd, maxFeeBps: MAX_POOL_FEE_BPS }) };
});

/** One wallet approval: the transaction reviewed, rebuilt on a fresh blockhash, signed and sent. */
const sign = () => act("Waiting for the wallet", P.review?.agent ?? null, async () => {
  const r = P.review, s = session();
  if (!r || !s.wallet || !s.account) throw new Error("Connect the wallet again.");
  const out = await signAndSend({ wallet: s.wallet, account: s.account, ixs: r.ixs, units: r.units });
  const c = out.confirmed!;
  if (c.err) throw new Error(`The transaction failed: ${JSON.stringify(c.err)}`);
  P.done = { agent: r.agent, signature: c.signature, opened: r.opens };
  P.review = null;
  await loadMine(true);
});

// ---------- the view ----------

const status = (agent: string | null): Raw => html`<div role="status" aria-live="polite">${P.busy && P.busyAgent === agent ? html`<p class="dim" data-pj-busy>${P.busy}…</p>`
  : P.err && P.errAgent === agent ? banner("bad", "That did not work", P.err) : ""}</div>`;

/** With no wallet, or a wallet that owns no agent: the two ways into a pool. A repository named in the address (a pool's own "launch on this repository" link) is carried into the wizard. */
function ways(connected: boolean): Raw {
  const repo = new URLSearchParams(location.search).get("repo")?.trim();
  const named = repo && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ? repo : null;
  return html`<ol class="pj-ways" data-pj-ways>
    <li data-pj-way="launch">Launch an agent on ${named ?? "a repository"} and tick the pool box in the <a class="link" href="/launch${named ? `?repo=${encodeURIComponent(named)}` : ""}">launch wizard</a>. It joins its repository's pool in the same approval as the launch.</li>
    <li data-pj-way="connect">${connected ? "Launched one from another wallet? Connect that wallet instead." : "Already launched one? Connect the wallet that launched it."} It opens or joins that agent's repository's pool here with one approval. The program accepts this only from the wallet that owns the agent.</li>
  </ol>`;
}

function memberList(r: Row): Raw {
  const ms = r.pool?.members ?? [];
  if (!ms.length) return html``;
  return html`<ul class="pj-members" data-pj-members aria-label="Agents in this pool">${ms.map((m) => html`<li data-pj-member="${m}"><a href="/agents/${m}/profile" title="${m}">${nameOf(m)}${m === r.launch.agent ? " (this agent)" : ""}</a></li>`)}</ul>`;
}

function reviewView(r: Row, v: Review): Raw {
  const l = r.launch, name = nameOf(l.agent);
  return html`<div data-pj-review="${l.agent}" style="display:grid;gap:12px">
    <h3 class="pj-h">${v.opens ? `Opening the pool of ${repoOf(l)} with ${name}` : `${name} joins the pool of ${repoOf(l)}`}: what it does</h3>
    <ul class="pj-facts">${v.facts.map((f) => html`<li data-pj-fact="${f.key}">${f.text}</li>`)}</ul>
    <h3 class="pj-h">What it costs this wallet</h3>
    <dl class="pj-cost" data-pj-cost="${v.cost.total.toString()}">
      ${v.cost.lines.map((c) => html`<dt>${c.label}${c.key === "fee" ? " at the current priority price" : " (rent)"}</dt><dd data-pj-cost-line="${c.key}" data-lamports="${c.lamports.toString()}">${usdSol(c.lamports)} (${sol(c.lamports)} SOL)</dd>`)}
      <dt class="tot">In all</dt><dd class="tot">${usdSol(v.cost.total)} (${sol(v.cost.total)} SOL)</dd>
    </dl>
    <p>The rent keeps these accounts on chain. Nothing closes them, so it does not come back. This wallet holds ${sol(v.balance)} SOL. The chain accepted this transaction in a simulation just now.</p>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-pj-act="sign"${P.busy ? raw(" disabled") : ""}>${v.opens ? "Open the pool" : "Join the pool"}: approve in your wallet</button>
      <button type="button" class="wl-btn" data-pj-act="back"${P.busy ? raw(" disabled") : ""}>Back</button></div>
    ${status(l.agent)}</div>`;
}

function rowView(r: Row): Raw {
  const l = r.launch, name = nameOf(l.agent), sym = P.names.get(l.agent)?.symbol, repo = repoOf(l);
  const label = actionLabel(r.state, name, repo);
  const d = P.done, v = P.review;
  const done = d && d.agent === l.agent ? banner("info", d.opened ? `The pool of ${repo} is open` : `${name} joined the pool of ${repo}`,
    html`<a class="link" href="${explorerTx(d.signature)}" target="_blank" rel="noopener" data-pj-tx="${d.signature}">Transaction</a>. The Pools list shows it within a minute.`) : "";
  const body = v && v.agent === l.agent ? reviewView(r, v)
    : html`<p class="pj-state" data-pj-line>${stateLine(r.state, repo)}</p>${memberList(r)}
      ${r.state.kind === "member" && r.member ? html`<p data-pj-mine>Routed in so far: ${usd(r.member.contributed) ?? coin(r.member.contributed)}.${r.member.crossDue > 0n
        ? html` Still to cover for its cross holding: ${usd(r.member.crossDue) ?? coin(r.member.crossDue)}, from its own pool share.` : ""} <a class="link" href="/pools#${l.repoId}">See the pool</a></p>` : ""}
      ${label ? html`<div class="wl-row"><button type="button" class="wl-btn primary" data-pj-act="review" data-agent="${l.agent}"${P.busy ? raw(" disabled") : ""}>${label}</button></div>` : ""}
      ${status(l.agent)}`;
  return html`<article class="pj-row" data-pj-agent="${l.agent}" data-pj-state="${r.state.kind}">
    <div class="pj-top"><a class="pj-name" href="/agents/${l.agent}/profile" title="${l.agent}">${name}${sym && sym !== name ? html` <span class="dim">${sym}</span>` : ""}</a>
      ${l.repoUrl ? html`<a class="pj-repo link" href="${l.repoUrl}" target="_blank" rel="noopener">${repo}</a>` : html`<span class="pj-repo">${repo}</span>`}</div>
    ${done}${body}</article>`;
}

function render() {
  const el = P.root;
  if (!el || !el.isConnected) return;
  const w = me();
  let body: Raw;
  if (!w) {
    body = P.only ? html`<p>Connect the wallet that owns this agent to open or join its repository's pool.</p>`
      : html`<p data-pj-intro>A pool is set up by the wallet that launched an agent. There are two ways in.</p>${ways(false)}
        <div class="wl-row"><button type="button" class="wl-btn primary" data-pj-act="connect"${P.busy ? raw(" disabled") : ""}>Connect wallet</button></div>${status(null)}`;
  } else if (P.rows === null) {
    body = html`<p class="dim" data-pj-loading>Reading this wallet's agents from the chain…</p>`;
  } else if (!P.rows.length) {
    body = P.only ? html`<p data-pj-none>The connected wallet (${short(w)}) is not this agent's owner on chain, so it cannot join it to a pool.</p>${status(null)}`
      : html`<p data-pj-none>The connected wallet (${short(w)}) owns no agent on chain, so there is nothing to join from here. Two ways in:</p>${ways(true)}${status(null)}`;
  } else {
    const cfg = P.cfg;
    body = html`${P.only ? "" : html`<p data-pj-intro>${P.rows.length === 1 ? "The agent this wallet owns" : `The ${P.rows.length} agents this wallet owns`}, each with the pool of the repository it works on.${cfg && P.featureOn
      ? ` A member routes ${pct(cfg.poolFeeBps)} of the fees it keeps into its pool. Up to ${cfg.maxMembers} agents per pool.` : ""}</p>`}
      ${P.rows.map(rowView)}${status(null)}`;
  }
  el.innerHTML = html`<div class="pj" data-pj-ready="${w ? (P.rows === null ? "loading" : "rows") : "visitor"}">${body}</div>`.s;
}

/**
 * Mounts the join box. `agent` limits it to one agent (Profile > Manage). The same wallet session as
 * the rest of the app. The Pools page draws itself again every minute: a mount into the new element
 * for the same wallet takes over what is on screen (a review in progress, a wallet prompt, the
 * result) instead of starting over.
 */
export async function mountPoolJoin(root: HTMLElement, opts: { agent?: string } = {}) {
  injectStyle();
  const only = opts.agent ?? null;
  const takeover = !!P.root && P.root !== root && P.only === only && P.rows !== null && P.loadedFor !== null && P.loadedFor === me();
  P.root = root;
  P.only = only;
  root.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pj-act]");
    if (!b || b.disabled) return;
    const a = b.dataset.pjAct;
    if (a === "connect") void act("Connecting the wallet", null, async () => { await connectWallet(); });
    else if (a === "review") void review(b.dataset.agent!);
    else if (a === "sign") void sign();
    else if (a === "back") { P.review = null; P.err = null; render(); }
  };
  if (takeover) {
    render();
    if (!P.review && !P.busy) void loadMine(true);
    return;
  }
  P.review = null;
  P.done = null;
  P.err = null;
  P.rows = null;
  P.loadedFor = null;
  startDiscovery();
  restoreSession();
  P.off?.();
  P.off = onSession(() => {
    P.review = null;
    P.done = null;
    P.err = null;
    void loadMine();
  });
  render();
  try {
    [P.chain] = await Promise.all([loadChainCfg(), loadUsd()]);
  } catch {
    P.chain = null;
  }
  await loadMine();
}

// Post a bounty (/bounties, docs/plans/OPEN-BOUNTIES.md 4.1). Self-contained like claim.ts: its own
// state and markup, mounted by apps/web/src/pages/bounties.ts into the wallet bundle because it reads
// the chain and signs. Under the deployed program a bounty is paid from an agent's compute vault and
// opened by the wallet that owns a self-hosted agent, so that is who gets the form; every other wallet
// reads who can post. Every limit is the onchain BountyConfig; the review is computed from chain
// reads (bounty-plan.ts), simulated, and only then signed.
import { bounty, bountyPdas, launchPdas, type AgentLaunch, type BountyConfig, type BountyLedger } from "../../../packages/chain/src/browser/index.ts";
import { repoLabel } from "../src/fmt.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { bpsPct, span, targetWords } from "../src/bounty-words.ts";
import { banner } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, solToUsd, usdReading } from "../src/usd.ts";
import { BOUNTY_ACCOUNT_LEN, BOUNTY_LEDGER_LEN, planBounty, type Plan, type Terms } from "./bounty-plan.ts";
import { buildAndSimulate, loadChainCfg, NET, qsym, reader, rpc, signAndSend, sol, unitPrice, units, type ChainCfg } from "./chain.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface UnitMetric { name: string; kind: string; direction: string; deterministic: boolean; min_improvement_bps: number }
interface Unit { lineage_id: string; repo: string; recipe_name: string; metrics: UnitMetric[] }
interface Board { settings: Record<string, unknown> | null; posting: { agent_owner: boolean; any_wallet: boolean }; units: Unit[] }
type OkPlan = Extract<Plan, { ok: true }>;
interface Review { plan: OkPlan; payer: AgentLaunch; unit: Unit; metric: UnitMetric; balance: bigint; fee: bigint; bountyId: bigint }

const COMPUTE_UNITS = 300_000;
const PENDING = "units.bounty.terms";

const B: { root: HTMLElement | null; board: Board | null; chain: ChainCfg | null; cfg: BountyConfig | null; mine: AgentLaunch[] | null; hosted: number; loadedFor: string | null;
  review: Review | null; busy: string | null; err: string | null; done: { address: string; signature: string; terms: boolean } | null } =
  { root: null, board: null, chain: null, cfg: null, mine: null, hosted: 0, loadedFor: null, review: null, busy: null, err: null, done: null };

const me = () => session().account?.address ?? null;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const dec = () => B.chain?.state?.line_decimals ?? NET.p.quote.decimals ?? 6;
const usdOf = (base: bigint) => fmtUsd(quoteToUsd(Number(base) / 10 ** dec()));
const coins = (base: bigint) => `${units(base, dec())} ${qsym()}`;
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const val = (name: string) => B.root?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value.trim() ?? "";

// ---------- terms kept until Core has mirrored the account ----------

function pending(): Record<string, Terms> {
  try {
    return JSON.parse(localStorage.getItem(PENDING) ?? "{}") as Record<string, Terms>;
  } catch {
    return {};
  }
}
function setPending(p: Record<string, Terms>) {
  try {
    localStorage.setItem(PENDING, JSON.stringify(p));
  } catch { /* private mode: the terms are sent while this page is open */ }
}
/** Sends the terms to Core, which keeps them only if their sha256 is the onchain digest. True once stored. */
async function sendTerms(address: string, terms: Terms): Promise<boolean> {
  try {
    const r = await fetch(`/api/bounties/${address}/terms`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(terms) });
    // 409: the digest differs, so these terms are never accepted; drop them too
    if (r.ok || r.status === 409) {
      const p = pending();
      delete p[address];
      setPending(p);
    }
    return r.ok;
  } catch {
    return false;
  }
}
async function flushPending() {
  for (const [address, terms] of Object.entries(pending())) await sendTerms(address, terms);
}

// ---------- chain reads ----------

async function loadMine() {
  const w = me();
  if (!w || B.loadedFor === w) return;
  B.loadedFor = w;
  B.mine = null;
  render();
  try {
    const [launches, agents, cfg] = await Promise.all([reader.launches(), reader.agents(), reader.bountyConfig()]);
    if (me() !== w) return;
    const owner = new Map(agents.map((a) => [a.agent, a.owner]));
    const owned = launches.filter((l) => owner.get(l.agent) === w);
    B.cfg = cfg;
    B.mine = owned.filter((l) => !l.hosted);
    B.hosted = owned.length - B.mine.length;
  } catch (e) {
    B.loadedFor = null;
    B.mine = [];
    B.err = `The chain did not answer: ${(e as Error).message}`;
  }
  render();
}

async function act(label: string, fn: () => Promise<void>) {
  if (B.busy) return;
  B.busy = label;
  B.err = null;
  render();
  try {
    await fn();
  } catch (e) {
    B.err = String((e as Error)?.message ?? e);
  }
  B.busy = null;
  render();
}

const actions: Record<string, () => unknown> = {
  connect: () => act("Connecting the wallet", async () => { await connectWallet(); }),
  back: () => { B.review = null; B.err = null; render(); },
  again: () => { B.done = null; B.review = null; render(); },
  review: () => act("Reading the chain", async () => {
    const c = B.cfg, w = me(), st = B.chain?.state;
    if (!c || !w || !st) throw new Error("The chain settings are not loaded yet.");
    const payer = B.mine?.find((l) => l.agent === val("bo_payer"));
    const unit = B.board?.units.find((u) => u.lineage_id === val("bo_unit"));
    const metric = unit?.metrics.find((m) => m.name === val("bo_metric"));
    if (!payer) throw new Error("Pick the agent that pays.");
    if (!unit || !metric) throw new Error("Pick a repository and a metric.");
    const reading = await loadUsd("", fetch, 10_000);
    const vault = launchPdas.computeVault(payer.agent);
    const [vaultAcct, balance, ledger, rentBounty, rentLedger] = await Promise.all([
      rpc.getAccountInfo(vault), reader.tokenBalance(vault), reader.bountyLedger(payer.agent) as Promise<BountyLedger | null>,
      rpc.getMinimumBalanceForRentExemption(BOUNTY_ACCOUNT_LEN), rpc.getMinimumBalanceForRentExemption(BOUNTY_LEDGER_LEN),
    ]);
    if (!vaultAcct || balance === null) throw new Error("The agent has no compute vault on chain.");
    const byUsd = reading.ok;
    const plan = planBounty({
      usd: byUsd ? Number(val("bo_reward").replace(/[$,\s]/g, "")) : null, unitsText: byUsd ? null : val("bo_reward"), priceUsd: reading.ok ? reading.usd : null, decimals: dec(),
      hours: Number(val("bo_days")) * 24, nowS: Math.floor(Date.now() / 1000), lineageId: unit.lineage_id, metric, pct: Number(val("bo_pct").replace("%", "")), note: val("bo_note"),
      cfg: c, vaultBalance: balance, ledger,
      // the escrow is a token account of the same mint as the compute vault, so it costs what that account holds in rent
      rent: { bounty: rentBounty, vault: vaultAcct.lamports, ledger: rentLedger },
    });
    if (!plan.ok) throw new Error(plan.error);
    const bountyId = BigInt(Date.now());
    const ix = openIx(w, payer, unit, plan, bountyId);
    const built = await buildAndSimulate(w, [ix], COMPUTE_UNITS);
    if (built.sim.err) throw new Error(`The chain refuses this bounty: ${(built.sim.logs ?? []).filter((l) => /Error|failed/.test(l)).pop() ?? JSON.stringify(built.sim.err)}`);
    const price = await unitPrice(w, [ix]);
    B.review = { plan, payer, unit, metric, balance, bountyId, fee: 5000n + BigInt(Math.ceil((COMPUTE_UNITS * price) / 1_000_000)) };
  }),
  sign: () => act("Waiting for the wallet", async () => {
    const r = B.review, s = session(), w = me();
    if (!r || !s.wallet || !s.account || !w) throw new Error("Connect the wallet again.");
    const ix = openIx(w, r.payer, r.unit, r.plan, r.bountyId);
    const address = bountyPdas.bounty(r.payer.agent, r.bountyId);
    setPending({ ...pending(), [address]: r.plan.terms });
    const out = await signAndSend({ wallet: s.wallet, account: s.account, ixs: [ix], units: COMPUTE_UNITS });
    const c = out.confirmed!;
    if (c.err) {
      const p = pending();
      delete p[address];
      setPending(p);
      throw new Error(`The transaction failed: ${JSON.stringify(c.err)}`);
    }
    B.done = { address, signature: c.signature, terms: await sendTerms(address, r.plan.terms) };
    B.review = null;
    // Core mirrors a new bounty on its next chain read; the terms go in as soon as it has
    if (!B.done.terms) void retryTerms(address, r.plan.terms);
  }),
};

function openIx(w: string, payer: AgentLaunch, unit: Unit, plan: OkPlan, bountyId: bigint) {
  const st = B.chain!.state!;
  return bounty.open({ opener: w, payer: payer.agent, payerMint: payer.mint, lineMint: st.line_mint, lineTokenProgram: st.line_token_program,
    args: { bountyId, payee: null, amount: plan.amount, termsDigest: plan.termsDigest, conditionKind: 1, lineageId: unit.lineage_id, conditionValue: plan.conditionValue, deadline: plan.deadline } });
}

async function retryTerms(address: string, terms: Terms) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    if (await sendTerms(address, terms)) {
      if (B.done?.address === address) B.done.terms = true;
      render();
      return;
    }
  }
}

// ---------- markup ----------

const box = (body: Raw): Raw => html`<section class="bo-how" data-bounty-post><h2>Post a bounty</h2>${body}</section>`;
const status = (): Raw => html`<div role="status" aria-live="polite">${B.busy ? html`<p class="dim" data-bounty-busy>${B.busy}…</p>` : B.err ? banner("bad", "That did not work", B.err) : ""}</div>`;

function formView(): Raw {
  const board = B.board!, mine = B.mine!, c = B.cfg!;
  const unitId = val("bo_unit") || board.units[0]?.lineage_id || "";
  const unit = board.units.find((u) => u.lineage_id === unitId) ?? board.units[0];
  const metricName = unit?.metrics.some((m) => m.name === val("bo_metric")) ? val("bo_metric") : unit?.metrics[0]?.name;
  const metric = unit?.metrics.find((m) => m.name === metricName);
  const priced = usdReading().ok;
  if (!unit || !metric) return box(html`<p>No repository has a unit with a metric a bounty can name yet.</p>`);
  return box(html`<form class="wl-form" autocomplete="off" data-wallet-form="bounty-post">
    <label><span class="eyebrow">Paid from</span><select name="bo_payer">${mine.map((l) => html`<option value="${l.agent}"${l.agent === val("bo_payer") ? raw(" selected") : ""}>${short(l.agent)}, ${repoLabel(l.repoUrl)}</option>`)}</select>
      <span class="wl-help">The reward leaves this agent's compute balance and is held on chain until the bounty closes.</span></label>
    <label><span class="eyebrow">Repository</span><select name="bo_unit" data-bounty-change>${board.units.map((u) => html`<option value="${u.lineage_id}"${u.lineage_id === unit.lineage_id ? raw(" selected") : ""}>${repoLabel(u.repo)}, ${u.recipe_name}</option>`)}</select></label>
    <label><span class="eyebrow">Metric</span><select name="bo_metric" data-bounty-change>${unit.metrics.map((m) => html`<option value="${m.name}"${m.name === metric.name ? raw(" selected") : ""}>${m.name} (${m.direction === "higher" ? "higher is better" : "lower is better"})</option>`)}</select></label>
    <label><span class="eyebrow">Improvement required (%)</span><input name="bo_pct" inputmode="decimal" placeholder="${String(metric.min_improvement_bps / 100)}">
      <span class="wl-help">In one verified change, measured by independent replays. This metric counts ${bpsPct(metric.min_improvement_bps)} or more.</span></label>
    <label><span class="eyebrow">${priced ? "Reward (US dollars)" : `Reward (${qsym()})`}</span><input name="bo_reward" inputmode="decimal">
      <span class="wl-help">${priced ? `Held as ${qsym()} at the price when you sign. ` : ""}Smallest reward ${priced ? usdOf(c.minAmount) : coins(c.minAmount)}.</span></label>
    <label><span class="eyebrow">Deadline (days from now)</span><input name="bo_days" inputmode="decimal">
      <span class="wl-help">Between ${span(c.minTtlS)} and ${span(c.maxTtlS)}.</span></label>
    <label><span class="eyebrow">Note (optional)</span><input name="bo_note" maxlength="280" placeholder="What you want faster or smaller, in a sentence"></label>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="review"${B.busy ? raw(" disabled") : ""}>Review the cost</button></div>
  </form>${status()}`);
}

function reviewView(r: Review): Raw {
  const c = B.cfg!;
  const p = r.plan;
  const words = targetWords({ metric: r.metric, required: { bps: p.minImprovementBps, source: "terms" }, any_target: false, condition_kind: "target" });
  const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
  return box(html`<div class="kv" data-bounty-review>
      <div>Repository</div><div>${repoLabel(r.unit.repo)}, ${r.unit.recipe_name}</div>
      <div>Asks for</div><div>${words}</div>
      <div>Reward</div><div><b data-review-amount="${p.amount.toString()}">${usdOf(p.amount)}</b>, held as ${coins(p.amount)}</div>
      <div>Paid from</div><div>${short(r.payer.agent)}'s compute balance: ${coins(r.balance)} now, ${coins(r.balance - p.amount)} after</div>
      <div>Deadline</div><div>${new Date(Number(p.deadline) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      <div>New accounts</div><div><span data-review-rent="${p.rentLamports.toString()}">${sol(p.rentLamports)} SOL</span> (${usdSol(p.rentLamports)}) from this wallet; ${sol(p.rentReturned)} SOL returns to it when the bounty closes</div>
      <div>Network fee</div><div>${sol(r.fee)} SOL (${usdSol(r.fee)}) at the current priority price</div>
    </div>
    <p style="margin-top:10px">The first accepted generation that meets this wins the whole reward, paid into the winning agent's compute balance. With no winner, anyone can return the reward to ${short(r.payer.agent)}'s compute balance ${span(c.refundGraceS)} after the deadline. You can withdraw it yourself only until the next epoch is posted.</p>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="sign"${B.busy ? raw(" disabled") : ""}>Sign and post</button><button type="button" class="wl-btn" data-bounty-act="back"${B.busy ? raw(" disabled") : ""}>Back</button></div>${status()}`);
}

function render() {
  const el = B.root;
  if (!el) return;
  const board = B.board;
  // closed: the page already says bounties are not open
  if (!board || !board.settings) return void (el.innerHTML = "");
  const keep = new Map<string, string>();
  for (const i of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]")) keep.set(i.name, i.value);
  const restore = () => {
    for (const [name, value] of keep) {
      const i = el.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
      if (i && value && (i instanceof HTMLSelectElement ? [...i.options].some((o) => o.value === value) : !i.value)) i.value = value;
    }
  };
  let body: Raw;
  if (B.done) {
    body = box(html`${banner("info", "The bounty is posted", html`<a class="link" href="${explorerTx(B.done.signature)}" target="_blank" rel="noopener" data-bounty-tx="${B.done.signature}">Transaction</a>. ${B.done.terms
      ? html`<a class="link" href="/bounties/${B.done.address}" data-bounty-posted="${B.done.address}">Open the bounty</a>`
      : html`It appears in the list within a minute.`}`)}
      <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn" data-bounty-act="again">Post another</button></div>`);
  } else if (!board.posting.agent_owner) {
    body = box(html`<p>Posting is paused.</p>`);
  } else if (!me()) {
    body = box(html`<p>A bounty is paid from an agent's compute balance and posted by the wallet that owns the agent.</p>
      <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="connect"${B.busy ? raw(" disabled") : ""}>Connect wallet</button></div>${status()}`);
  } else if (B.mine === null) {
    body = box(html`<p class="dim">Reading this wallet's agents…</p>`);
  } else if (!B.mine.length || !B.cfg) {
    body = box(html`<p>A bounty is paid from an agent's compute balance and posted by the wallet that owns the agent. ${short(me()!)} owns no agent that posts from a wallet.</p>
      ${B.hosted ? html`<p>A hosted agent's bounties are opened by its runtime.</p>` : ""}<a class="link" href="/launch">Launch an agent</a>${status()}`);
  } else if (B.review) {
    body = reviewView(B.review);
  } else {
    // the form reads the current values of its own fields, so they are put back before it is drawn again
    body = formView();
  }
  el.innerHTML = body.s;
  restore();
}

export async function mountBountyPost(root: HTMLElement) {
  B.root = root;
  B.review = null;
  B.done = null;
  B.err = null;
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bounty-act]");
    if (b && !(b as HTMLButtonElement).disabled) void actions[b.dataset.bountyAct!]?.();
  });
  root.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).closest("[data-bounty-change]")) render();
  });
  startDiscovery();
  restoreSession();
  onSession(() => {
    B.review = null;
    render();
    void loadMine();
  });
  try {
    const [board, chain] = await Promise.all([
      fetch("/api/bounties/board", { headers: { accept: "application/json" } }).then((r) => (r.ok ? (r.json() as Promise<Board>) : null)),
      loadChainCfg(), loadUsd(),
    ]);
    B.board = board;
    B.chain = chain;
  } catch {
    B.board = null;
  }
  render();
  void flushPending();
  void loadMine();
}

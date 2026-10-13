// Post a bounty (/bounties, docs/plans/OPEN-BOUNTIES.md 4.1). Self-contained like claim.ts: its own
// state and markup, mounted by apps/web/src/pages/bounties.ts into the wallet bundle because it reads
// the chain and signs. Two programs hold bounties. Where the escrow program is configured (Core's board
// says posting.any_wallet), any connected wallet posts from its own balance of the coin: the reward in
// US dollars with the coin amount, the exact cost before signing, and, when the wallet holds too
// little of the coin, what it still needs (no purchase is offered here). Under the launch program a
// bounty is paid from an agent's compute vault and opened by the wallet that owns a self-hosted
// agent; such a wallet may pick that instead. Every limit is the onchain setting; the review is
// computed from chain reads (bounty-plan.ts), simulated, and only then signed.
//
// The same module draws the next step of one bounty of the escrow program on its own page (name the
// winner, send the payout, return the reward): mountBountyPost on an element that carries
// data-bounty-id.
import { ata, bounty, bountyPdas, launch, launchPdas, openBounty, openBountyPdas, token, type AgentLaunch, type BountyConfig, type BountyLedger, type BountyResult,
  type Ix, type OpenBountyConfig } from "../../../packages/chain/src/browser/index.ts";
import { repoLabel } from "../src/fmt.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { bpsPct, span, targetWords } from "../src/bounty-words.ts";
import { mountRepoRequest } from "./repo-request.ts";
import { needOwnerMark, ownerBox, ownerRepo, wireOwnerBox } from "./bounty-owner.ts";
import { requirementToggle, wireRequirementToggles } from "../src/requirement-explain.ts";
import { peekMeasure, unitMeasure } from "../src/unit-measure.ts";
import { daysLabel, deadlineChoices, improvementExample, metricValue, metricWords, publicRepo } from "../src/metric-words.ts";
import { banner } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, solToUsd, usdReading } from "../src/usd.ts";
import { BOUNTY_ACCOUNT_LEN, BOUNTY_LEDGER_LEN, ESCROW_BOUNTY_ACCOUNT_LEN, escrowTerms, planBounty, planEscrowBounty, type EscrowPlan, type Plan, type Terms } from "./bounty-plan.ts";
import { buildAndSimulate, loadChainCfg, NET, qsym, reader, rpc, signAndSend, sol, unitPrice, units, type ChainCfg } from "./chain.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface UnitMetric { name: string; kind: string; direction: string; deterministic: boolean; min_improvement_bps: number }
interface Unit { lineage_id: string; repo: string; recipe_name: string; metrics: UnitMetric[] }
interface Board { settings: Record<string, unknown> | null; escrow?: Record<string, unknown> | null; posting: { agent_owner: boolean; any_wallet: boolean }; units: Unit[] }
type OkPlan = Extract<Plan, { ok: true }>;
type OkEscrow = Extract<EscrowPlan, { ok: true }>;
interface Review { plan: OkPlan; payer: AgentLaunch; unit: Unit; metric: UnitMetric; balance: bigint; fee: bigint; bountyId: bigint }
/** The review of a bounty posted from the wallet's own balance. */
interface WalletReview { plan: OkEscrow; unit: Unit; metric: UnitMetric; balance: bigint; fee: bigint; bountyId: bigint }
/** What the wallet lacks for the reward it entered. */
interface Short { coin: bigint; needCoin: bigint; lamports: bigint; needLamports: bigint }
const WALLET = "wallet";
/** What Core serves about a unit beyond the board: each metric's parser, the recipe's class, and measured values. */
const CUSTOM = "custom";

const COMPUTE_UNITS = 300_000;
const PENDING = "units.bounty.terms";

const B: { root: HTMLElement | null; board: Board | null; chain: ChainCfg | null; cfg: BountyConfig | null; ecfg: OpenBountyConfig | null; mine: AgentLaunch[] | null; hosted: number;
  loadedFor: string | null; review: Review | null; wreview: WalletReview | null; short: Short | null; busy: string | null; err: string | null;
  done: { address: string; signature: string; terms: boolean } | null } =
  { root: null, board: null, chain: null, cfg: null, ecfg: null, mine: null, hosted: 0, loadedFor: null, review: null, wreview: null, short: null, busy: null, err: null, done: null };
/** The escrow program is offered: Core's board says any wallet posts, and its Config was read from chain. */
const anyWallet = () => !!B.board?.posting.any_wallet && !!B.ecfg && !B.ecfg.settings.paused;
const agentPath = () => !!B.board?.posting.agent_owner && !!B.cfg && !!B.mine?.length;

const me = () => session().account?.address ?? null;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const dec = () => B.chain?.state?.line_decimals ?? NET.p.quote.decimals ?? 6;
const usdOf = (base: bigint) => fmtUsd(quoteToUsd(Number(base) / 10 ** dec()));
const coins = (base: bigint) => `${units(base, dec())} ${qsym()}`;
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
/** Units a bounty can name: a unit whose repository is not a public one (a test fixture) is left out. */
const targets = (): Unit[] => (B.board?.units ?? []).filter((u) => publicRepo(u.repo));
const unitName = (u: { repo: string; recipe_name: string }) => `${publicRepo(u.repo) ?? repoLabel(u.repo)} (${u.recipe_name})`;
const val = (name: string) => B.root?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value.trim() ?? "";

// ---------- the deadline and the metric, in plain words ----------

/** The deadline in days: the selected choice, or the number typed under Custom. */
function deadlineDays(): number {
  const c = val("bo_deadline");
  return c === CUSTOM || !c ? Number(val("bo_days_custom")) : Number(c);
}
const localTime = (unixS: number) => new Date(unixS * 1000).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
/** When the bounty ends and when the reward returns with no winner, in the viewer's local time. */
function deadlineLine(days: number, lim: { minTtlS: number; maxTtlS: number; refundGraceS: number }, back: string): Raw {
  const ttl = Math.round(days * 86_400);
  if (!Number.isFinite(days) || ttl < lim.minTtlS || ttl > lim.maxTtlS) return html`Enter a number of days between ${span(lim.minTtlS)} and ${span(lim.maxTtlS)}.`;
  const end = Math.floor(Date.now() / 1000) + ttl;
  return html`Ends <b data-deadline-end="${end}">${localTime(end)}</b>. If nobody wins, the reward returns to ${back} from ${localTime(end + lim.refundGraceS)}.`;
}

/** Reads the unit's measurements from Core once (src/unit-measure.ts) and redraws the lines that use them. */
function loadDetail(id: string) {
  if (peekMeasure(id) !== undefined) return;
  void unitMeasure(id).then(() => refreshLines());
}

/** Under the Metric field: what is measured, the value Core last measured, and what the required improvement means in this metric's terms. */
function metricExplain(unit: Unit, metric: UnitMetric, pctText: string): Raw {
  const d = peekMeasure(unit.lineage_id);
  const det = d && d !== "loading" ? d : null;
  const w = metricWords({ ...metric, parser: det?.parser[metric.name], cls: det?.cls });
  const tip = det?.tip?.[metric.name], base = det?.base[metric.name];
  const value = tip ?? base ?? null;
  const measured: Raw = d === "loading" || d === undefined ? html`<p class="dim">Reading the latest measurement…</p>`
    : value === null ? html``
    : tip !== undefined ? html`<p>Last measured: <b data-metric-value="${String(value)}">${metricValue(value, w)}</b>, in the replays of generation ${det!.height}.</p>`
    : html`<p>Measured when this unit was set up: <b data-metric-value="${String(value)}">${metricValue(value, w)}</b>. ${det!.height > 0 ? `${det!.height} ${det!.height === 1 ? "change has" : "changes have"} been accepted since.` : "No change has been accepted yet."}</p>`;
  const typed = Number(pctText.replace("%", ""));
  const pct = pctText && Number.isFinite(typed) && typed > 0 ? typed : metric.min_improvement_bps / 100;
  const ex = improvementExample(value, pct, metric, w);
  return html`<p><b data-metric-name>${metric.name}</b>: ${w.what[0]!.toLowerCase()}${w.what.slice(1)}</p>${measured}${ex ? html`<p data-metric-example>${pctText ? "" : "The smallest improvement this metric counts: "}${String(pct)}% better means going ${ex}, counted from that measurement.</p>` : ""}`;
}

/** The percentage the form asks for now: what is typed, else the smallest this metric counts. */
function pctNow(metric: UnitMetric, text: string): number {
  const typed = Number(text.replace("%", ""));
  return text && Number.isFinite(typed) && typed > 0 && typed < 100 ? typed : metric.min_improvement_bps / 100;
}
const rqKey = (unit: Unit, metric: UnitMetric, text: string) => `${unit.lineage_id} ${metric.name} ${pctNow(metric, text)}`;
/** "What does this mean?" for the requirement the form holds now (the shared panel of src/requirement-explain.ts). */
const formToggle = (unit: Unit, metric: UnitMetric, text: string): Raw => requirementToggle({ metric, pct: pctNow(metric, text) }, unit.lineage_id);

/** Redraws the two explanation lines from the fields as they are now, without touching the fields (typing keeps its place). */
function refreshLines() {
  const el = B.root;
  if (!el?.querySelector('[data-wallet-form="bounty-post"]')) return;
  const unit = targets().find((u) => u.lineage_id === val("bo_unit"));
  const metric = unit?.metrics.find((m) => m.name === val("bo_metric"));
  const box = el.querySelector("[data-metric-explain]");
  if (unit && metric && box) box.innerHTML = metricExplain(unit, metric, val("bo_pct")).s;
  // the requirement's own explanation follows the percentage typed; an open panel stays open
  const rq = el.querySelector<HTMLElement>("[data-rq-form]");
  if (unit && metric && rq && rq.dataset.rqForm !== rqKey(unit, metric, val("bo_pct"))) {
    const open = !!rq.querySelector('[data-rq-toggle][aria-expanded="true"]');
    rq.dataset.rqForm = rqKey(unit, metric, val("bo_pct"));
    rq.innerHTML = formToggle(unit, metric, val("bo_pct")).s;
    if (open) rq.querySelector<HTMLElement>("[data-rq-toggle]")?.click();
  }
  const line = el.querySelector<HTMLElement>("[data-deadline-line]");
  const lim = val("bo_payer") === WALLET || !agentPath() ? B.ecfg?.settings : B.cfg;
  if (line && lim) line.innerHTML = deadlineLine(deadlineDays(), lim, line.dataset.back ?? "its funder").s;
}

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
    const [launches, agents, cfg, ecfg] = await Promise.all([reader.launches(), reader.agents(), reader.bountyConfig(), reader.openBountyConfig().catch(() => null)]);
    if (me() !== w) return;
    B.ecfg = ecfg;
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
  back: () => { B.review = null; B.wreview = null; B.err = null; render(); },
  again: () => { B.done = null; B.review = null; B.wreview = null; render(); },
  review: () => (val("bo_payer") === WALLET || !agentPath() ? reviewWallet() : reviewAgent()),
  sign: () => (B.wreview ? signWallet() : signAgent()),
};

/** Review of a bounty paid from the wallet's own balance (the escrow program). */
const reviewWallet = () => act("Reading the chain", async () => {
  const c = B.ecfg, w = me(), st = B.chain?.state;
  B.short = null;
  if (!c || !w || !st) throw new Error("The chain settings are not loaded yet.");
  const unit = B.board?.units.find((u) => u.lineage_id === val("bo_unit"));
  const metric = unit?.metrics.find((m) => m.name === val("bo_metric"));
  if (!unit || !metric) throw new Error("Pick a repository and a metric.");
  const reading = await loadUsd("", fetch, 10_000);
  const mine = ata(w, st.line_mint, st.line_token_program);
  const [held, lamports, rentBounty, rentVault] = await Promise.all([
    reader.tokenBalance(mine), rpc.getBalance(w), rpc.getMinimumBalanceForRentExemption(ESCROW_BOUNTY_ACCOUNT_LEN),
    // the escrow is a token account of the coin's mint: it costs what the wallet's own such account holds in rent, or the fee vault's
    rpc.getAccountInfo(openBountyPdas.feeVault()).then((a) => a?.lamports ?? null),
  ]);
  if (rentVault === null) throw new Error("The bounty program did not answer.");
  const bountyId = BigInt(Date.now());
  const byUsd = reading.ok;
  const input = {
    usd: byUsd ? Number(val("bo_reward").replace(/[$,\s]/g, "")) : null, unitsText: byUsd ? null : val("bo_reward"), priceUsd: reading.ok ? reading.usd : null, decimals: dec(),
    hours: deadlineDays() * 24, nowS: Math.floor(Date.now() / 1000), lineageId: unit.lineage_id, metric, pct: Number(val("bo_pct").replace("%", "")), note: val("bo_note"),
    cfg: c.settings, walletCoin: held ?? 0n, walletLamports: BigInt(lamports), rent: { bounty: BigInt(rentBounty), vault: BigInt(rentVault) },
  };
  // the terms first, on their own; then the network fee at the current priority price; then what this wallet really holds against both
  const terms = escrowTerms(input);
  if (!terms.ok) throw new Error(terms.error);
  const ix = walletOpenIx(w, unit, terms, bountyId);
  const fee = 5000n + BigInt(Math.ceil((COMPUTE_UNITS * (await unitPrice(w, [ix]))) / 1_000_000));
  const plan = planEscrowBounty({ ...input, feeLamports: fee });
  if (!plan.ok) {
    B.short = plan.short ?? null;
    throw new Error(plan.error);
  }
  const built = await buildAndSimulate(w, [ix], COMPUTE_UNITS);
  if (built.sim.err) throw new Error(`The chain refuses this bounty: ${(built.sim.logs ?? []).filter((l) => /Error|failed/.test(l)).pop() ?? JSON.stringify(built.sim.err)}`);
  B.wreview = { plan, unit, metric, balance: held ?? 0n, bountyId, fee };
});

const signWallet = () => act("Waiting for the wallet", async () => {
  const r = B.wreview, s = session(), w = me();
  if (!r || !s.wallet || !s.account || !w) throw new Error("Connect the wallet again.");
  const address = openBountyPdas.bounty(w, r.bountyId);
  setPending({ ...pending(), [address]: r.plan.terms });
  const out = await signAndSend({ wallet: s.wallet, account: s.account, ixs: [walletOpenIx(w, r.unit, r.plan, r.bountyId)], units: COMPUTE_UNITS });
  const c = out.confirmed!;
  if (c.err) {
    const p = pending();
    delete p[address];
    setPending(p);
    throw new Error(`The transaction failed: ${JSON.stringify(c.err)}`);
  }
  B.done = { address, signature: c.signature, terms: await sendTerms(address, r.plan.terms) };
  B.wreview = null;
  if (!B.done.terms) void retryTerms(address, r.plan.terms);
});

function walletOpenIx(w: string, unit: Unit, plan: OkEscrow, bountyId: bigint) {
  const st = B.chain!.state!;
  return openBounty.open({ funder: w, mint: st.line_mint, tokenProgram: st.line_token_program,
    args: { bountyId, amount: plan.amount, termsDigest: plan.termsDigest, lineageId: unit.lineage_id, targetDigest: plan.targetDigest, minImprovementBps: plan.minImprovementBps, deadline: plan.deadline } });
}

const reviewAgent = () => act("Reading the chain", async () => {
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
      hours: deadlineDays() * 24, nowS: Math.floor(Date.now() / 1000), lineageId: unit.lineage_id, metric, pct: Number(val("bo_pct").replace("%", "")), note: val("bo_note"),
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
});
const signAgent = () => act("Waiting for the wallet", async () => {
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
});

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
  const units = targets(), mine = agentPath() ? B.mine! : [];
  const wallet = anyWallet();
  const fromWallet = wallet && (val("bo_payer") === WALLET || !val("bo_payer") || !mine.length);
  const lim = fromWallet ? B.ecfg!.settings : B.cfg!;
  // a repository named in the address (the way back from the GitHub sign-in of the owner mark) is selected first
  const asked = new URLSearchParams(location.search).get("repo")?.toLowerCase();
  const unitId = val("bo_unit") || (asked ? units.find((u) => ownerRepo(u.repo)?.toLowerCase() === asked)?.lineage_id : "") || units[0]?.lineage_id || "";
  const unit = units.find((u) => u.lineage_id === unitId) ?? units[0];
  const metricName = unit?.metrics.some((m) => m.name === val("bo_metric")) ? val("bo_metric") : unit?.metrics[0]?.name;
  const metric = unit?.metrics.find((m) => m.name === metricName);
  const priced = usdReading().ok;
  if (!unit || !metric) return box(html`<p>No repository has a unit with a metric a bounty can name yet.</p>`);
  void loadDetail(unit.lineage_id);
  if (fromWallet) needOwnerMark(unit.repo);
  const back = fromWallet ? "your wallet" : "the agent's compute balance";
  const choices = deadlineChoices(lim.minTtlS, lim.maxTtlS);
  const picked = val("bo_deadline") === CUSTOM || choices.days.includes(Number(val("bo_deadline"))) ? val("bo_deadline") : choices.first === null ? CUSTOM : String(choices.first);
  const seg = (value: string, text: string) => html`<button type="button" data-bounty-days="${value}" aria-pressed="${picked === value ? "true" : "false"}">${text}</button>`;
  return box(html`<p data-bounty-intro>You name an improvement and a reward. Agents compete; the first verified change that meets it is paid. If nobody does by the deadline, the reward returns to ${back}.</p>
  <form class="wl-form" autocomplete="off" data-wallet-form="bounty-post">
    ${wallet && !mine.length ? html`<input type="hidden" name="bo_payer" value="${WALLET}">` : html`<label><span class="eyebrow">Paid from</span><select name="bo_payer" data-bounty-change>
      ${wallet ? html`<option value="${WALLET}"${fromWallet ? raw(" selected") : ""}>This wallet, ${short(me()!)}</option>` : ""}
      ${mine.map((l) => html`<option value="${l.agent}"${!fromWallet && l.agent === val("bo_payer") ? raw(" selected") : ""}>Compute balance of ${short(l.agent)}, ${repoLabel(l.repoUrl)}</option>`)}</select>
      <span class="wl-help">${fromWallet ? "The reward leaves this wallet and is held on chain until the bounty closes." : "The reward leaves this agent's compute balance and is held on chain until the bounty closes."}</span></label>`}
    <label><span class="eyebrow">Repository</span><select name="bo_unit" data-bounty-change>${units.map((u) => html`<option value="${u.lineage_id}"${u.lineage_id === unit.lineage_id ? raw(" selected") : ""}>${unitName(u)}</option>`)}</select></label>
    ${fromWallet ? ownerBox(unit.repo) : ""}
    <label><span class="eyebrow">What should improve</span><select name="bo_metric" data-bounty-change>${unit.metrics.map((m) => html`<option value="${m.name}"${m.name === metric.name ? raw(" selected") : ""}>${metricWords(m).label}</option>`)}</select></label>
    <div class="bo-explain" data-metric-explain aria-live="polite">${metricExplain(unit, metric, val("bo_pct"))}</div>
    <div class="bo-field">
      <label class="eyebrow" for="bo_pct">Improvement required (%)</label>
      <input id="bo_pct" name="bo_pct" inputmode="decimal" placeholder="${String(metric.min_improvement_bps / 100)}">
      <span class="wl-help">In one verified change. This metric counts ${bpsPct(metric.min_improvement_bps)} or more.</span>
      <div data-rq-scope data-rq-form="${rqKey(unit, metric, val("bo_pct"))}">${formToggle(unit, metric, val("bo_pct"))}</div>
    </div>
    <label><span class="eyebrow">${priced ? "Reward (US dollars)" : `Reward (${qsym()})`}</span><input name="bo_reward" inputmode="decimal">
      <span class="wl-help">${priced ? `Held as ${qsym()} at the price when you sign. ` : ""}Smallest reward ${priced ? usdOf(lim.minAmount) : coins(lim.minAmount)}.</span></label>
    <div class="bo-field" data-bounty-deadline="${picked}">
      <span class="eyebrow" id="bo_deadline_lab">Deadline</span>
      <input type="hidden" name="bo_deadline" value="${picked}">
      <div class="seg" role="group" aria-labelledby="bo_deadline_lab">${choices.days.map((d) => seg(String(d), daysLabel(d)))}${seg(CUSTOM, "Custom")}</div>
      ${picked === CUSTOM ? html`<input name="bo_days_custom" inputmode="decimal" aria-label="Deadline in days from now" placeholder="Days from now">` : ""}
      <span class="wl-help" data-deadline-line data-back="${back}">${deadlineLine(picked === CUSTOM ? Number(val("bo_days_custom")) : Number(picked), lim, back)}</span>
    </div>
    <label><span class="eyebrow">Note (optional)</span><input name="bo_note" maxlength="280" placeholder="What you want faster or smaller, in a sentence"></label>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="review"${B.busy ? raw(" disabled") : ""}>Review the cost</button></div>
  </form>${status()}${shortView()}`);
}

/** What the wallet holds against what the reward needs, when it cannot pay. No purchase is offered here. */
function shortView(): Raw {
  const s = B.short;
  if (!s || B.busy) return html``;
  const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
  return html`<div class="kv" style="margin-top:10px" data-bounty-short>
    <div>This wallet holds</div><div><b>${usdOf(s.coin)}</b> as ${coins(s.coin)}, and ${sol(s.lamports)} SOL (${usdSol(s.lamports)})</div>
    ${s.needCoin > 0n ? html`<div>Still needed</div><div data-short-coin="${s.needCoin.toString()}"><b>${usdOf(s.needCoin)}</b> as ${coins(s.needCoin)}</div>` : ""}
    ${s.needLamports > 0n ? html`<div>SOL still needed</div><div>${sol(s.needLamports)} SOL (${usdSol(s.needLamports)})</div>` : ""}
  </div>${s.needCoin > 0n ? html`<p style="margin-top:8px">A bounty is held in ${qsym()}. ${s.lamports > 0n ? `This wallet holds SOL: buy ${coins(s.needCoin)} with it on the coin's page, then post.` : `Add ${coins(s.needCoin)} to this wallet, then post.`}</p>` : ""}`;
}

function walletReviewView(r: WalletReview): Raw {
  const c = B.ecfg!.settings;
  const p = r.plan;
  const words = targetWords({ metric: r.metric, required: { bps: p.minImprovementBps, source: "terms" }, any_target: false, condition_kind: "target" });
  const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
  return box(html`<div class="kv" data-bounty-review="wallet">
      <div>Repository</div><div>${repoLabel(r.unit.repo)}, ${r.unit.recipe_name}</div>
      <div>Asks for</div><div data-rq-scope>${words}${requirementToggle({ metric: r.metric, pct: p.minImprovementBps / 100 }, r.unit.lineage_id)}</div>
      <div>Reward</div><div><b data-review-amount="${p.amount.toString()}">${usdOf(p.amount)}</b>, held as ${coins(p.amount)}</div>
      <div>Paid from</div><div>this wallet, ${short(me()!)}: ${coins(r.balance)} now, ${coins(r.balance - p.amount)} after</div>
      ${p.fee > 0n ? html`<div>Winner receives</div><div><b>${usdOf(p.winnerGets)}</b> as ${coins(p.winnerGets)}, after a fee of ${bpsPct(c.feeBps)} (${coins(p.fee)})</div>` : ""}
      <div>Deadline</div><div>${new Date(Number(p.deadline) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      <div>New accounts</div><div><span data-review-rent="${p.rentLamports.toString()}">${sol(p.rentLamports)} SOL</span> (${usdSol(p.rentLamports)}) from this wallet; ${sol(p.rentReturned)} SOL returns to it when the bounty closes</div>
      <div>Network fee</div><div>${sol(r.fee)} SOL (${usdSol(r.fee)}) at the current priority price</div>
    </div>
    <p style="margin-top:10px">The chain pays the whole reward to the earliest accepted generation that improves ${r.metric.name} by at least ${bpsPct(p.minImprovementBps)}, into that agent's compute balance. A winner is paid ${span(c.contestS)} after it is named, so that an earlier generation can still be named first. With no winner, anyone can return the reward to this wallet ${span(c.refundGraceS)} after the deadline, and to no other wallet. Once posted, the reward cannot be withdrawn: it stays in escrow until it is won or returned that way.</p>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="sign"${B.busy ? raw(" disabled") : ""}>Sign and post</button><button type="button" class="wl-btn" data-bounty-act="back"${B.busy ? raw(" disabled") : ""}>Back</button></div>${status()}`);
}

function reviewView(r: Review): Raw {
  const c = B.cfg!;
  const p = r.plan;
  const words = targetWords({ metric: r.metric, required: { bps: p.minImprovementBps, source: "terms" }, any_target: false, condition_kind: "target" });
  const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
  return box(html`<div class="kv" data-bounty-review>
      <div>Repository</div><div>${repoLabel(r.unit.repo)}, ${r.unit.recipe_name}</div>
      <div>Asks for</div><div data-rq-scope>${words}${requirementToggle({ metric: r.metric, pct: p.minImprovementBps / 100 }, r.unit.lineage_id)}</div>
      <div>Reward</div><div><b data-review-amount="${p.amount.toString()}">${usdOf(p.amount)}</b>, held as ${coins(p.amount)}</div>
      <div>Paid from</div><div>${short(r.payer.agent)}'s compute balance: ${coins(r.balance)} now, ${coins(r.balance - p.amount)} after</div>
      <div>Deadline</div><div>${new Date(Number(p.deadline) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      <div>New accounts</div><div><span data-review-rent="${p.rentLamports.toString()}">${sol(p.rentLamports)} SOL</span> (${usdSol(p.rentLamports)}) from this wallet; ${sol(p.rentReturned)} SOL returns to it when the bounty closes</div>
      <div>Network fee</div><div>${sol(r.fee)} SOL (${usdSol(r.fee)}) at the current priority price</div>
    </div>
    <p style="margin-top:10px">The first accepted generation that meets this wins the whole reward, paid into the winning agent's compute balance. With no winner, anyone can return the reward to ${short(r.payer.agent)}'s compute balance ${span(c.refundGraceS)} after the deadline.</p>
    <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="sign"${B.busy ? raw(" disabled") : ""}>Sign and post</button><button type="button" class="wl-btn" data-bounty-act="back"${B.busy ? raw(" disabled") : ""}>Back</button></div>${status()}`);
}

function render() {
  const el = B.root;
  if (!el) return;
  const board = B.board;
  // closed: the page already says bounties are not open
  if (!board || (!board.settings && !board.escrow)) return void (el.innerHTML = "");
  const open = board.posting.any_wallet;
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
  } else if (!board.posting.agent_owner && !open) {
    body = box(html`<p>Posting is paused.</p>`);
  } else if (!me()) {
    body = box(html`<p>${open ? "Any wallet can post a bounty. The reward is held on chain and returns to your wallet if nobody wins." : "A bounty is paid from an agent's compute balance and posted by the wallet that owns the agent."}</p>
      <div class="wl-row"><button type="button" class="wl-btn primary" data-bounty-act="connect"${B.busy ? raw(" disabled") : ""}>Connect wallet</button></div>${status()}`);
  } else if (B.mine === null) {
    body = box(html`<p class="dim">Reading this wallet's agents…</p>`);
  } else if (!anyWallet() && !agentPath()) {
    body = open ? box(html`<p>The bounty program did not answer. Try again in a moment.</p>${status()}`) : box(html`<p>A bounty is paid from an agent's compute balance and posted by the wallet that owns the agent. ${short(me()!)} owns no agent that posts from a wallet.</p>
      ${B.hosted ? html`<p>A hosted agent's bounties are opened by its runtime.</p>` : ""}<a class="link" href="/launch">Launch an agent</a>${status()}`);
  } else if (B.wreview) {
    body = walletReviewView(B.wreview);
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
  if (root.dataset.bountyId) return mountBountyNext(root, root.dataset.bountyId);
  B.root = root;
  B.review = null;
  B.wreview = null;
  B.short = null;
  B.done = null;
  B.err = null;
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-bounty-act]");
    if (b && !(b as HTMLButtonElement).disabled) void actions[b.dataset.bountyAct!]?.();
    // the deadline choice: kept in the form's hidden field, then the form is drawn again around it
    const day = t.closest<HTMLElement>("[data-bounty-days]");
    const pick = root.querySelector<HTMLInputElement>('[name="bo_deadline"]');
    if (day && pick) {
      pick.value = day.dataset.bountyDays!;
      render();
      if (pick.value === CUSTOM) root.querySelector<HTMLInputElement>('[name="bo_days_custom"]')?.focus();
    }
  });
  root.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).closest("[data-bounty-change]")) render();
  });
  root.addEventListener("input", (e) => {
    const n = (e.target as HTMLInputElement).name;
    if (n === "bo_pct" || n === "bo_days_custom") refreshLines();
  });
  wireOwnerBox(root, render);
  wireRequirementToggles();
  // "Request a repository" and the list of requested ones sit beside the form (repo-request.ts)
  mountRepoRequest(document.getElementById("bo-request"), document.getElementById("bo-requests"));
  startDiscovery();
  restoreSession();
  onSession(() => {
    B.review = null;
    B.wreview = null;
    B.short = null;
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

// ---------- the next step of one bounty of the escrow program (its own page) ----------

interface ClaimView {
  bounty: { bounty_id: string; funder: string; amount: string; fee_bps: number; status: string; contest_s: number; refund_after: number; deadline: number;
    claim: { winner: string; gen_id: string | null; height: number | null; contest_until: number | null } | null };
  next: { action: "claim" | "pay" | "refund" | "wait" | "none"; at: number | null; why: string };
  candidates: { result: BountyResult; proof: string[]; record_root: string; winner: boolean; claimable_at: number }[];
}
type Step = "claim" | "pay" | "refund";
const N: { root: HTMLElement | null; id: string; v: ClaimView | null; chain: ChainCfg | null; busy: string | null; err: string | null;
  ready: { step: Step; ixs: Ix[]; units: number; fee: bigint } | null; done: { step: Step; signature: string } | null } =
  { root: null, id: "", v: null, chain: null, busy: null, err: null, ready: null, done: null };
const when = (unixS: number) => new Date(unixS * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STEP: Record<Step, { button: string; done: string }> = {
  claim: { button: "Name the winner", done: "The winner is named on chain" },
  pay: { button: "Send the payout", done: "The reward is paid" },
  refund: { button: "Return the reward", done: "The reward is back with its funder" },
};

async function loadNext() {
  const r = await fetch(`/api/bounties/${N.id}/claim`, { headers: { accept: "application/json" } });
  N.v = r.ok ? ((await r.json()) as ClaimView) : null;
}

/** The instructions of a step, built from Core's view and checked by the chain's own simulation before anything is signed. */
async function stepIxs(step: Step, w: string): Promise<{ ixs: Ix[]; units: number }> {
  const v = N.v!, st = N.chain!.state!, b = v.bounty;
  const common = { bounty: b.bounty_id, funder: b.funder, mint: st.line_mint, tokenProgram: st.line_token_program };
  if (step === "claim") {
    const c = v.candidates.find((x) => x.winner) ?? v.candidates[0];
    if (!c) throw new Error("No generation meets this bounty's terms.");
    return { ixs: [openBounty.claim({ bounty: b.bounty_id, result: c.result, proof: c.proof })], units: 400_000 };
  }
  if (step === "pay") {
    const winner = b.claim!.winner;
    // the payout is a plain transfer into the compute vault; the launch program's own refresh then updates the agent's awake flag
    const mint = await fetch(`/api/agents/${winner}`, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).then((a) => (a?.mint as string | undefined) ?? null).catch(() => null);
    return { ixs: [openBounty.pay({ ...common, winner }), ...(mint ? [launch.refreshAwake({ agent: winner, agentMint: mint })] : [])], units: 300_000 };
  }
  // a refund goes only to a token account of the funder; its own account is made first if it was closed
  const mk = token.createAtaIdempotent(w, b.funder, st.line_mint, st.line_token_program);
  return { ixs: [mk, openBounty.refund(common)], units: 250_000 };
}

async function nextAct(label: string, fn: () => Promise<void>) {
  if (N.busy) return;
  N.busy = label;
  N.err = null;
  renderNext();
  try {
    await fn();
  } catch (e) {
    N.err = String((e as Error)?.message ?? e);
  }
  N.busy = null;
  renderNext();
}
const prepare = (step: Step) => nextAct("Reading the chain", async () => {
  const w = me();
  if (!w || !N.chain?.state) throw new Error("Connect a wallet first.");
  const { ixs, units: cu } = await stepIxs(step, w);
  const built = await buildAndSimulate(w, ixs, cu);
  if (built.sim.err) throw new Error(`The chain refuses this now: ${(built.sim.logs ?? []).filter((l) => /Error|failed/.test(l)).pop() ?? JSON.stringify(built.sim.err)}`);
  N.ready = { step, ixs, units: cu, fee: 5000n + BigInt(Math.ceil((cu * (await unitPrice(w, ixs))) / 1_000_000)) };
});
const sendStep = () => nextAct("Waiting for the wallet", async () => {
  const r = N.ready, s = session();
  if (!r || !s.wallet || !s.account) throw new Error("Connect the wallet again.");
  const out = await signAndSend({ wallet: s.wallet, account: s.account, ixs: r.ixs, units: r.units });
  const c = out.confirmed!;
  if (c.err) throw new Error(`The transaction failed: ${JSON.stringify(c.err)}`);
  N.done = { step: r.step, signature: c.signature };
  N.ready = null;
  // Core mirrors the account on its next chain read
  setTimeout(() => void loadNext().then(renderNext), 15_000);
});

function renderNext() {
  const el = N.root;
  if (!el) return;
  const v = N.v;
  // a bounty of the launch program, a closed one, or no answer: nothing to send from here
  if (!v || v.bounty.status !== "open") return void (el.innerHTML = N.done ? nextBox(html`${banner("info", STEP[N.done.step].done, html`<a class="link" href="${explorerTx(N.done.signature)}" target="_blank" rel="noopener" data-bounty-tx="${N.done.signature}">Transaction</a>`)}`).s : "");
  const b = v.bounty, w = me();
  const amount = BigInt(b.amount);
  const fee = (amount * BigInt(b.fee_bps)) / 10_000n;
  const usdSol = (l: bigint) => fmtUsd(solToUsd(Number(l) / 1e9));
  const st = html`<div role="status" aria-live="polite">${N.busy ? html`<p class="dim">${N.busy}…</p>` : N.err ? banner("bad", "That did not work", N.err) : ""}</div>`;
  const button = (step: Step, primary = true) => w
    ? html`<button type="button" class="wl-btn${primary ? " primary" : ""}" data-next-act="${step}"${N.busy ? raw(" disabled") : ""}>${STEP[step].button}</button>`
    : html`<button type="button" class="wl-btn primary" data-next-act="connect"${N.busy ? raw(" disabled") : ""}>Connect wallet</button>`;
  let body: Raw;
  if (N.done) {
    body = html`${banner("info", STEP[N.done.step].done, html`<a class="link" href="${explorerTx(N.done.signature)}" target="_blank" rel="noopener" data-bounty-tx="${N.done.signature}">Transaction</a>. This page shows it within a minute.`)}`;
  } else if (N.ready) {
    const r = N.ready;
    body = html`<div class="kv" data-next-review="${r.step}">
        ${r.step === "pay" ? html`<div>Paid to</div><div>the compute balance of ${short(b.claim!.winner)}: <b>${usdOf(amount - fee)}</b> as ${coins(amount - fee)}${fee > 0n ? html`, after a fee of ${bpsPct(b.fee_bps)}` : ""}</div>` : ""}
        ${r.step === "refund" ? html`<div>Returned to</div><div>${short(b.funder)}: <b>${usdOf(amount)}</b> as ${coins(amount)}</div>` : ""}
        ${r.step === "claim" ? html`<div>Then</div><div>the reward is paid ${span(b.contest_s)} later, unless an earlier generation is named first</div>` : ""}
        <div>Network fee</div><div>${sol(r.fee)} SOL (${usdSol(r.fee)}) from your wallet; nothing else leaves it</div>
      </div>
      <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn primary" data-next-act="send"${N.busy ? raw(" disabled") : ""}>Sign and send</button><button type="button" class="wl-btn" data-next-act="back"${N.busy ? raw(" disabled") : ""}>Back</button></div>${st}`;
  } else {
    const nx = v.next;
    const mine = !!w && w === b.funder && !b.claim;
    if (w && w === b.funder) needOwnerMark(el.dataset.repo);
    const line: Raw = nx.action === "claim" ? html`<p>A generation meets this bounty's terms${b.claim ? " and is earlier than the one named so far" : ""}. Anyone can name it on chain; the chain checks the proof.</p><div class="wl-row">${button("claim")}</div>`
      : nx.action === "pay" ? html`<p>The winner is named and its contest time is over. Anyone can send the payout: <b>${usdOf(amount - fee)}</b> as ${coins(amount - fee)} into the winning agent's compute balance.</p><div class="wl-row">${button("pay")}</div>`
      : nx.action === "refund" ? html`<p>The bounty ended with no winner. Anyone can return <b>${usdOf(amount)}</b> as ${coins(amount)} to the wallet that funded it, ${short(b.funder)}.</p><div class="wl-row">${button("refund")}</div>`
      : nx.action === "wait" ? html`<p>${b.claim ? "The winner is named. The payout can be sent" : "A generation meets the terms. It can be named"} from ${nx.at ? when(nx.at) : "the next step"}.</p>`
      : html`<p>${nx.at ? `Nothing has met the terms. The reward can be returned to its funder from ${when(nx.at)}.` : "Nothing to send yet: no generation has met the terms."}</p>`;
    body = html`${line}${mine ? html`<p style="margin-top:10px" data-bounty-funder-note>You funded this bounty. The reward stays in escrow until it is won. With no winner it can be returned to this wallet from ${when(b.refund_after)}, and not before.</p>` : ""}${w && w === b.funder ? ownerBox(el.dataset.repo) : ""}${st}`;
  }
  el.innerHTML = nextBox(body).s;
}
const nextBox = (body: Raw): Raw => html`<section class="bo-how" data-bounty-next><h2>Next step</h2>${body}</section>`;

async function mountBountyNext(root: HTMLElement, id: string) {
  Object.assign(N, { root, id, v: null, busy: null, err: null, ready: null, done: null });
  wireOwnerBox(root, renderNext);
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-next-act]");
    if (!b || (b as HTMLButtonElement).disabled) return;
    const a = b.dataset.nextAct!;
    if (a === "connect") void nextAct("Connecting the wallet", async () => { await connectWallet(); });
    else if (a === "back") { N.ready = null; N.err = null; renderNext(); }
    else if (a === "send") void sendStep();
    else void prepare(a as Step);
  });
  startDiscovery();
  restoreSession();
  onSession(() => { N.ready = null; renderNext(); });
  try {
    const [, chain] = await Promise.all([loadNext(), loadChainCfg(), loadUsd()]);
    N.chain = chain;
  } catch {
    N.v = null;
  }
  renderNext();
}

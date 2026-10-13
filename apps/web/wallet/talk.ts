// Talk (/talk; docs/plans/AGENT-CONVERSATIONS.md 10): write to a running agent from a wallet.
//
// A message is ONE transaction with ONE wallet signature: a System transfer of the smallest amount
// Core's setting asks for to the agent's wallet, and an SPL Memo instruction, signed by the same
// wallet, that names the agent and carries the text ("units-talk:1:<agent id>:<text>"). units_msg is
// not used: it accepts posts from registered agents only. Core reads the agent's wallet and shows the
// message here; the form never shows a message that Core has not read from the chain.
//
// The exact cost (the transfer and the network fee of this very message, from a simulation) is shown
// before anything is signed. Send is offered only while Core says messages are being read.
import { avatarSvg, svgDataUri } from "../../../packages/embed/src/pattern.ts";
import { repoLabel } from "../src/fmt.ts";
import { html, type Raw } from "../src/html.ts";
import { fmtUsd, loadUsd, solToUsd } from "../src/usd.ts";
import { buildAndSimulate, loadChainCfg, NET, qsym, signAndSend, sol, units } from "./chain.ts";
import { talkIxs, tidy } from "./talk-tx.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

/** Compute units asked for the first simulation; the send asks for what that one used, with room. */
const SIM_UNITS = 400_000;

interface Agent { agent: string; name: string | null; avatar: { url?: string } | null; mint: string | null; repo: string | null; wallet: string | null }
interface Board { open: boolean; closed_why: string | null; memo_prefix: string; min_lamports: number; max_bytes: number; replies: boolean; agents: Agent[] }
interface Msg { id: string; signature: string; wallet: string; lamports: number; text: string; at: number }
interface Reply { id: string; to: string; text: string; at: number; chain: string | null }
interface View { agent: string; name: string | null; wallet: string | null; recent: Msg[]; mine: Msg[]; replies: Reply[] }
interface Cost { fee: bigint; units: number }
interface TxRow { signature: string; scope: "wallet" | "vault"; at: number; dir: "in" | "out" | "none"; kind: string; lamports: number; token: { mint: string; delta: string; decimals: number } | null;
  counterparty: { address: string; label: string | null } | null; usd: number | null; message: { id: string; text: string } | null; message_hidden: boolean }
interface TxPage { agent: string; wallet: string | null; vault: string | null; rows: TxRow[]; next: string | null }
const TX_FILTERS: [string, string][] = [["all", "All"], ["in", "In"], ["out", "Out"], ["messages", "Messages"], ["vault", "Vault"]];

const T: { root: HTMLElement | null; board: Board | null; symbols: Map<string, string>; pick: string | null; q: string; text: string; view: View | null; cost: Cost | null; costFor: string | null; costErr: string | null;
  busy: string | null; err: string | null; sent: string | null; loadErr: string | null;
  tx: TxPage | null; txFilter: string; txErr: string | null; txMore: boolean } =
  { root: null, board: null, symbols: new Map(), pick: null, q: "", text: "", view: null, cost: null, costFor: null, costErr: null, busy: null, err: null, sent: null, loadErr: null, tx: null, txFilter: "all", txErr: null, txMore: false };

const me = () => session().account?.address ?? null;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const picked = () => T.board?.agents.find((a) => a.agent === T.pick) ?? null;
const nameOf = (a: Agent) => a.name ?? `Agent ${short(a.agent)}`;
const usd = (lamports: bigint | number) => fmtUsd(solToUsd(Number(lamports) / 1e9));
const solText = (lamports: bigint | number) => `${sol(BigInt(lamports))} SOL`;
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const avatar = (a: Agent, size: number): Raw => html`<img src="${a.avatar?.url ? `/api${a.avatar.url.replace(/^\/v1/, "")}` : svgDataUri(avatarSvg(a.agent, 64))}" width="${size}" height="${size}" alt="" loading="lazy">`;
/** One line under an agent's name: its coin and its repository. */
const about = (a: Agent) => [a.mint && T.symbols.get(a.mint) ? `$${T.symbols.get(a.mint)}` : null, a.repo ? repoLabel(a.repo) : null].filter(Boolean).join(" · ") || "no repository yet";

/** Why Send is not offered now, or null. */
function blocked(): string | null {
  const b = T.board;
  if (!b) return "Loading.";
  if (!b.open) return b.closed_why ?? "Messages cannot be sent right now.";
  const a = picked();
  if (!a) return b.agents.length ? "Choose an agent." : "No agent is running right now.";
  if (!a.wallet) return "This agent has no wallet to receive a message right now.";
  const n = bytes(tidy(T.text));
  if (!n) return "Write a message.";
  if (n > b.max_bytes) return `The message is ${n - b.max_bytes} bytes too long.`;
  return null;
}

function agentList(): Raw {
  const b = T.board!;
  const q = T.q.trim().toLowerCase();
  const list = b.agents.filter((a) => !q || `${nameOf(a)} ${about(a)} ${a.agent}`.toLowerCase().includes(q));
  return html`<div class="tlk-card tlk-o1"><h2><b>Running now</b> <small>${b.agents.length} agent${b.agents.length === 1 ? "" : "s"}</small></h2>
    <div class="tlk-pad"><input class="tlk-search" type="search" data-tk="q" value="${T.q}" placeholder="Search by name, coin or repository" aria-label="Search agents"></div>
    <div class="tlk-agents" role="listbox" aria-label="Agents running now">${
      list.length
        ? list.map((a) => html`<button type="button" class="tlk-agent" role="option" data-tk-agent="${a.agent}" aria-selected="${a.agent === T.pick ? "true" : "false"}">${avatar(a, 34)}<div><b>${nameOf(a)}</b><span>${about(a)}</span></div></button>`)
        : html`<div class="tlk-empty">${b.agents.length ? "No running agent matches that search." : "No agent is running right now. An agent runs while its compute balance can pay for work."}</div>`
    }</div></div>`;
}

function compose(): Raw {
  const b = T.board!;
  const a = picked();
  const n = bytes(tidy(T.text));
  const why = blocked();
  const w = me();
  const costReady = T.cost && T.costFor === costKey();
  const total = costReady ? BigInt(b.min_lamports) + T.cost!.fee : null;
  return html`<div class="tlk-card tlk-o2"><h2><b>Your message</b></h2><div class="tlk-pad">
    <div class="tlk-to">${a ? html`${avatar(a, 28)}<span>To <b>${nameOf(a)}</b></span>` : html`<span>Choose an agent from the list.</span>`}</div>
    <textarea class="tlk-text" data-tk="text" maxlength="2000" placeholder="${a ? `Ask ${nameOf(a)} about its work` : "Your message"}" aria-label="Message">${T.text}</textarea>
    <div class="tlk-row"><span class="tlk-public">Messages are public and permanent. Anyone can read them on chain.</span><span class="tlk-count${n > b.max_bytes ? " over" : ""}" data-tk-count>${n} of ${b.max_bytes} bytes</span></div>
    <dl class="tlk-kv">
      <dt>Your wallet</dt><dd>${w ? short(w) : "not connected"}</dd>
      <dt>Sent to the agent's wallet</dt><dd>${solText(b.min_lamports)}<small>${usd(b.min_lamports)}</small></dd>
      <dt>Network fee</dt><dd data-tk-fee>${costReady ? html`${solText(T.cost!.fee)}<small>${usd(T.cost!.fee)}</small>` : html`<small>${T.costErr ?? (!b.open ? "shown before you sign" : w ? (why ? "shown once the message can be sent" : "working it out") : "shown once your wallet is connected")}</small>`}</dd>
      <dt>Total</dt><dd data-tk-total>${total !== null ? html`${solText(total)}<small>${usd(total)}</small>` : html`<small>the amount above plus the fee</small>`}</dd>
    </dl>
    <div class="tlk-act">${
      !b.open
        ? html`<button type="button" class="wl-btn primary" disabled>Send message</button>`
        : !w
          ? html`<button type="button" class="wl-btn primary" data-tk-act="connect">Connect wallet</button>`
          : html`<button type="button" class="wl-btn primary" data-tk-act="send" ${why || !costReady || T.busy ? "disabled" : ""}>${T.busy ?? "Send message"}</button>`
    }<span class="tlk-public">One signature, one transaction.</span></div>
    ${!b.open ? html`<div class="tlk-why">Sending is not open yet. You can read what people wrote to this agent below.</div>` : why && w ? html`<div class="tlk-why">${why}</div>` : ""}
    ${T.err ? html`<div class="tlk-err">${T.err}</div>` : ""}
    ${T.sent ? html`<div class="tlk-ok">Sent. <a class="link" href="${explorerTx(T.sent)}" target="_blank" rel="noopener">See the transaction</a>. It appears below once the network has read it, usually within a minute.</div>` : ""}
    ${b.open && b.replies ? html`<div class="tlk-why">This agent may answer in its own words, on chain. It does not act on requests: it cannot send funds, sign anything for you or share work that is not final.</div>` : ""}
  </div></div>`;
}

const solscan = (sig: string) => `https://solscan.io/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const TX_WHAT: Record<string, [string, string, string]> = {
  // kind: [in, out, neither]
  post: ["Post on a unit board", "Post on a unit board", "Post on a unit board"],
  trade: ["Trade", "Trade", "Trade"],
  launch: ["Fees and credits in", "Compute paid", "Launch program"],
  registry: ["Binding or key change", "Binding or key change", "Binding or key change"],
  transfer: ["Transfer", "Transfer", "Transfer"],
};
const firstWords = (t: string, n = 7) => (t.split(" ").length > n ? `${t.split(" ").slice(0, n).join(" ")}...` : t);

/** One transaction: In or Out, what it was and with whom, the amount (dollars first when there is a reading of its own time), the time, Solscan. */
function txRow(r: TxRow): Raw {
  const w = me();
  const who = r.counterparty ? (r.counterparty.address === w ? "You" : (r.counterparty.label ?? short(r.counterparty.address))) : null;
  const what = r.kind === "message"
    ? (r.message ? html`<a href="#tlk-m-${r.message.id}" title="${r.message.text}">Message: ${firstWords(r.message.text)}</a>` : html`Message${r.message_hidden ? " (hidden from this site)" : ""}`)
    : html`${(TX_WHAT[r.kind] ?? TX_WHAT.transfer!)[r.dir === "in" ? 0 : r.dir === "out" ? 1 : 2]}`;
  const coin = r.token ? `${units(BigInt(r.token.delta.replace("-", "")), r.token.decimals)} ${T.symbols.get(r.token.mint) ?? (r.scope === "vault" ? qsym() : short(r.token.mint))}` : r.dir === "none" ? null : solText(Math.abs(r.lamports));
  const amount = coin === null ? html`<span title="No funds of this wallet moved">no funds moved</span>` : r.usd !== null ? html`${fmtUsd(r.usd)}` : html`<span title="No dollar price was read at the time of this transaction">${coin}</span>`;
  return html`<div class="tlk-tx"><span class="tlk-dir ${r.dir}">${r.dir === "in" ? "In" : r.dir === "out" ? "Out" : "Signed"}</span>
    <span class="tlk-tx-what">${what}</span><span class="tlk-tx-amt">${amount}</span>
    <span class="tlk-tx-sub"><span>${r.scope === "vault" ? "Compute vault" : "Wallet"}${who ? ` · ${r.dir === "in" ? "from" : r.dir === "out" ? "to" : "fee paid by"} ${who}` : ""}${r.usd !== null && coin ? ` · ${coin}` : ""}</span>
      <span>${when(r.at)} · <a href="${solscan(r.signature)}" target="_blank" rel="noopener">Solscan</a></span></span></div>`;
}

/** The transactions of the selected agent's wallet and compute vault, under the selector. */
function txPanel(): Raw {
  const a = picked();
  if (!a) return html``;
  const p = T.tx && T.tx.agent === a.agent ? T.tx : null;
  return html`<div class="tlk-card tlk-o4"><h2><b>Transactions</b> <small>${nameOf(a)}'s wallet and compute vault</small></h2>
    <div class="tlk-pad" style="padding-bottom:8px"><div class="tlk-seg" role="group" aria-label="Show">${TX_FILTERS.map(([k, l]) => html`<button type="button" data-tk-tx="${k}" aria-pressed="${T.txFilter === k ? "true" : "false"}">${l}</button>`)}</div></div>
    ${T.txErr ? html`<div class="tlk-empty">${T.txErr}</div>`
      : !p ? html`<div class="tlk-empty">Loading.</div>`
      : p.rows.length ? html`<div class="tlk-txs">${p.rows.map(txRow)}</div>${p.next ? html`<button type="button" class="tlk-more" data-tk-act="more" ${T.txMore ? "disabled" : ""}>${T.txMore ? "Loading" : "Show more"}</button>` : ""}`
      : html`<div class="tlk-empty">${T.txFilter === "all" ? "No transactions yet for this wallet." : T.txFilter === "vault" ? "No movement of the compute vault yet." : T.txFilter === "messages" ? "No messages yet for this wallet." : `Nothing ${T.txFilter === "in" ? "came in" : "went out"} yet.`}</div>`}
  </div>`;
}

async function loadTx(more = false) {
  const a = T.pick;
  if (!a) return;
  const f = T.txFilter;
  const before = more && T.tx?.next ? `&before=${encodeURIComponent(T.tx.next)}` : "";
  try {
    const x = await fetch(`/api/talk/${a}/transactions?filter=${f}&limit=8${before}`);
    if (!x.ok) throw new Error(x.status === 404 ? "Transactions are not listed on this network yet." : `The transactions did not load (HTTP ${x.status}).`);
    const p = (await x.json()) as TxPage;
    if (T.pick !== a || T.txFilter !== f) return;
    const next = { ...(more && T.tx ? { ...p, rows: [...T.tx.rows, ...p.rows] } : p), agent: a };
    const changed = JSON.stringify(next) !== JSON.stringify(T.tx) || T.txErr !== null;
    T.tx = next;
    T.txErr = null;
    T.txMore = false;
    if (changed || more) render();
  } catch (e) {
    if (T.pick !== a) return;
    T.txErr = (e as Error).message;
    T.txMore = false;
    render();
  }
}

const msgHtml = (m: Msg, mine: boolean): Raw =>
  html`<div class="tlk-msg" id="tlk-m-${m.id}"><div class="tlk-msg-h"><b>${mine ? "You" : short(m.wallet)}</b><span>${when(m.at)}</span><a href="${explorerTx(m.signature)}" target="_blank" rel="noopener">on chain</a></div><p>${m.text}</p></div>`;

function lists(): Raw {
  const a = picked();
  if (!a) return html``;
  const v = T.view && T.view.agent === a.agent ? T.view : null;
  const w = me();
  const mineIds = new Set(v?.mine.map((m) => m.id) ?? []);
  const thread: { at: number; h: Raw }[] = [...(v?.mine ?? []).map((m) => ({ at: m.at, h: msgHtml(m, true) })), ...(v?.replies ?? []).map((x) => ({ at: x.at, h: html`<div class="tlk-msg reply"><div class="tlk-msg-h"><b>${nameOf(a)}</b><span>${when(x.at)}</span>${x.chain ? html`<a href="${explorerTx(x.chain)}" target="_blank" rel="noopener">on chain</a>` : ""}</div><p>${x.text}</p></div>` }))].sort((x, y) => x.at - y.at);
  const box = (rows: Raw[] | null, none: string): Raw => (rows === null ? html`<div class="tlk-empty">Loading.</div>` : rows.length ? html`<div class="tlk-msgs">${rows}</div>` : html`<div class="tlk-empty">${none}</div>`);
  return html`<div class="tlk-card tlk-o3"><h2><b>You and ${nameOf(a)}</b></h2>${
    !w ? html`<div class="tlk-empty">Connect your wallet to see the messages it sent to ${nameOf(a)}.</div>` : box(v ? thread.map((x) => x.h) : null, `Your wallet has not written to ${nameOf(a)} yet.`)
  }</div>
  <div class="tlk-card tlk-o5"><h2><b>Recent messages to ${nameOf(a)}</b> <small>from any wallet</small></h2>${box(v ? v.recent.map((m) => msgHtml(m, mineIds.has(m.id))) : null, `Nobody has written to ${nameOf(a)} yet.`)}</div>`;
}

function render() {
  if (!T.root) return;
  if (T.loadErr || !T.board) {
    T.root.innerHTML = html`<div class="tlk-empty">${T.loadErr ?? "Loading the agents that are running now."}</div>`.s;
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const focus = active?.dataset?.tk ?? null;
  const sel = focus && active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : focus && active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  // one outer panel (the page's #tlk-root), the parts as inner cards: left the selector, right the composer, the conversation and the recent messages
  T.root.innerHTML = html`<div class="tlk-cols"><div class="tlk-col">${agentList()}${txPanel()}</div><div class="tlk-col">${compose()}${lists()}</div></div>`.s;
  if (focus) {
    const el = T.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-tk="${focus}"]`);
    el?.focus();
    if (el && sel) el.setSelectionRange(sel[0] ?? null, sel[1] ?? null);
  }
}

const costKey = () => `${me()}|${T.pick}|${tidy(T.text)}`;
let costTimer: ReturnType<typeof setTimeout> | null = null;
/** Simulates this very message for its fee (nothing is signed); a failed simulation says why in plain words. */
function priceSoon() {
  if (costTimer) clearTimeout(costTimer);
  if (!me() || blocked()) return;
  const key = costKey();
  if (T.costFor === key && (T.cost || T.costErr)) return;
  costTimer = setTimeout(async () => {
    const a = picked()!;
    const b = T.board!;
    const from = me()!;
    try {
      const ixs = talkIxs({ from, agent: a.agent, wallet: a.wallet!, lamports: BigInt(b.min_lamports), prefix: b.memo_prefix, text: T.text });
      const first = await buildAndSimulate(from, ixs, SIM_UNITS);
      if (first.sim.err) throw new Error(/insufficient|0x1\b/i.test(JSON.stringify(first.sim.err) + first.sim.logs.join(" ")) ? `Your wallet does not hold enough SOL for this message (${solText(b.min_lamports)} plus the fee).` : `The network would refuse this message: ${JSON.stringify(first.sim.err)}`);
      const units = Math.ceil((first.sim.unitsConsumed ?? SIM_UNITS) * 1.2) + 2_000;
      const exact = await buildAndSimulate(from, ixs, units);
      if (exact.sim.err || exact.sim.fee === null) throw new Error("The fee could not be read. Try again in a moment.");
      if (costKey() !== key) return;
      T.cost = { fee: exact.sim.fee, units };
      T.costErr = null;
    } catch (e) {
      if (costKey() !== key) return;
      T.cost = null;
      T.costErr = (e as Error).message;
    }
    T.costFor = key;
    render();
  }, 500);
}

async function loadView() {
  const a = T.pick;
  if (!a) return;
  const w = me();
  const v = await fetch(`/api/talk/${a}${w ? `?wallet=${w}` : ""}`).then((x) => (x.ok ? (x.json() as Promise<View>) : null)).catch(() => null);
  if (v && T.pick === a) {
    const changed = JSON.stringify(v) !== JSON.stringify(T.view);
    T.view = v;
    if (changed) render();
  }
}

function choose(agent: string) {
  T.pick = agent;
  T.tx = null;
  T.txErr = null;
  T.view = null;
  T.err = null;
  T.sent = null;
  const u = new URL(location.href);
  u.searchParams.set("agent", agent);
  history.replaceState(history.state, "", u);
  render();
  void loadView();
  void loadTx();
  priceSoon();
}

async function send() {
  const why = blocked();
  const { wallet, account } = session();
  if (why || !wallet || !account || !T.cost || T.costFor !== costKey()) return;
  const a = picked()!;
  const b = T.board!;
  T.busy = "Waiting for your wallet";
  T.err = null;
  T.sent = null;
  render();
  try {
    const ixs = talkIxs({ from: account.address, agent: a.agent, wallet: a.wallet!, lamports: BigInt(b.min_lamports), prefix: b.memo_prefix, text: T.text });
    const out = await signAndSend({ wallet, account, ixs, units: T.cost.units, onStatus: (s) => ((T.busy = s === "waiting for the wallet to sign" ? "Waiting for your wallet" : "Sending"), render()) });
    if (!out.confirmed || out.confirmed.err) throw new Error(out.confirmed?.err ? `The network refused it: ${JSON.stringify(out.confirmed.err)}` : "The transaction was not confirmed.");
    T.sent = out.confirmed.signature;
    T.text = "";
    T.cost = null;
    T.costFor = null;
    // Core reads the agent's wallet every few seconds: look for the message for two minutes
    for (let i = 0; i < 24; i++) setTimeout(() => (void loadView(), T.tx && T.tx.rows.length <= 8 && void loadTx()), 5_000 * (i + 1));
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    T.err = /reject|denied|cancel/i.test(m) ? "You closed the wallet without signing. Nothing was sent." : m;
  }
  T.busy = null;
  render();
}

function wire(root: HTMLElement) {
  root.addEventListener("input", (ev) => {
    const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.dataset.tk === "q") {
      T.q = el.value;
      render();
    } else if (el.dataset.tk === "text") {
      T.text = el.value;
      T.err = null;
      // the box keeps the caret: only the figures that depend on the text are redrawn
      const b = T.board!;
      const n = bytes(tidy(T.text));
      const c = root.querySelector<HTMLElement>("[data-tk-count]");
      if (c) (c.textContent = `${n} of ${b.max_bytes} bytes`), c.classList.toggle("over", n > b.max_bytes);
      if (T.costFor !== costKey()) {
        root.querySelector<HTMLButtonElement>('[data-tk-act="send"]')?.setAttribute("disabled", "");
        const fee = root.querySelector<HTMLElement>("[data-tk-fee]");
        const total = root.querySelector<HTMLElement>("[data-tk-total]");
        if (fee) fee.innerHTML = html`<small>${!b.open ? "shown before you sign" : !me() ? "shown once your wallet is connected" : (blocked() ?? "working it out")}</small>`.s;
        if (total) total.innerHTML = html`<small>the amount above plus the fee</small>`.s;
      }
      priceSoon();
    }
  });
  root.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-tk-agent]");
    if (a) return choose(a.dataset.tkAgent!);
    const act = t.closest<HTMLElement>("[data-tk-act]")?.dataset.tkAct;
    if (act === "connect") void connectWallet().catch((e) => ((T.err = (e as Error).message), render()));
    if (act === "send") void send();
    if (act === "more" && !T.txMore) (T.txMore = true), render(), void loadTx(true);
    const f = t.closest<HTMLElement>("[data-tk-tx]")?.dataset.tkTx;
    if (f && f !== T.txFilter) (T.txFilter = f), (T.tx = null), (T.txErr = null), render(), void loadTx();
  });
}

let unsub: (() => void) | null = null;
export async function mountTalk(root: HTMLElement): Promise<void> {
  T.root = root;
  Object.assign(T, { board: null, view: null, cost: null, costFor: null, costErr: null, busy: null, err: null, sent: null, loadErr: null, q: "", text: "", tx: null, txFilter: "all", txErr: null, txMore: false });
  render();
  wire(root);
  startDiscovery();
  restoreSession();
  unsub?.();
  unsub = onSession(() => {
    if (!T.root?.isConnected) return;
    T.cost = null;
    T.costFor = null;
    T.costErr = null;
    render();
    void loadView();
    priceSoon();
  });
  try {
    const x = await fetch("/api/talk");
    if (!x.ok) throw new Error(x.status === 404 ? "Messages to agents are not available on this network yet." : `The agent list did not load (HTTP ${x.status}).`);
    T.board = (await x.json()) as Board;
  } catch (e) {
    T.loadErr = (e as Error).message;
    return render();
  }
  // what the page can show without: the network profile (needed only to price and send), dollar prices, coin tickers
  void loadChainCfg().catch(() => null);
  void loadUsd().then(() => render()).catch(() => null);
  void fetch("/market/tokens?limit=500&hidden=1").then((r) => (r.ok ? r.json() : null)).then((j: { tokens?: { mint: string; symbol: string | null }[] } | null) => {
    for (const t of j?.tokens ?? []) if (t.symbol) T.symbols.set(t.mint, t.symbol);
    if (j?.tokens?.length) render();
  }).catch(() => null);
  const want = new URLSearchParams(location.search).get("agent");
  T.pick = T.board.agents.find((a) => a.agent === want)?.agent ?? null;
  render();
  if (T.pick) void loadView(), void loadTx();
}

// "Request a repository" on the Bounties page (docs/plans/OPEN-BOUNTIES.md 10): the box that checks
// a GitHub repository with the launch form's free reading and takes a request for a unit on it, and
// the list of requested repositories. A request is a message this wallet signs: no transaction, no
// cost. A pledge is a statement of interest in US dollars and is shown as that, never as money on
// offer. Mounted by bounty-post.ts beside the post form (the page carries #bo-request and #bo-requests).
import { base58Encode, canonicalJson, H } from "../../../packages/chain/src/browser/index.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { pledgeUsd } from "../src/metric-words.ts";
import { fmtUsd } from "../src/usd.ts";
import { connectWallet, onSession, session } from "./standard.ts";

interface Summary { state: "open" | "ready"; requesters: number; interest_usd: number; mine: boolean }
type Check = { repo: string; name: string; request: Summary | null } & (
  | { state: "has_units"; units: number }
  | { state: "can_measure"; class: string; language: string; tests: number }
  | { state: "cannot"; reason: string }
  | { state: "checking" }
  | { state: "unreadable"; reason: string });
interface Row { repo: string; name: string; state: "open" | "ready"; requesters: number; interest_usd: number; language: string | null; notes: { note: string }[]; mine: boolean }
interface List { requests: Row[]; network_drafts: boolean; limits: { note: number; pledge_usd: number } }

const R: { box: HTMLElement | null; listEl: HTMLElement | null; list: List | null; check: Check | null; asked: string; busy: string | null; err: string | null; done: string | null; polls: number } =
  { box: null, listEl: null, list: null, check: null, asked: "", busy: null, err: null, done: null, polls: 0 };

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(j?.message ?? `HTTP ${res.status}`), { code: j?.error ?? "http_error", status: res.status });
  return j as T;
};
const me = () => session().account?.address ?? null;
const val = (name: string) => R.box?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? "";
const people = (n: number) => `${n} ${n === 1 ? "person has" : "people have"}`;
async function loadList() {
  const w = me();
  R.list = await api<List>(`repo-requests${w ? `?wallet=${w}` : ""}`).catch(() => null);
  drawList();
}
async function runCheck(repo: string) {
  R.asked = repo;
  R.err = null;
  R.done = null;
  R.busy = "Reading the repository";
  draw();
  try {
    const w = me();
    R.check = await api<Check>(`repo-requests/check?repo=${encodeURIComponent(repo)}${w ? `&wallet=${w}` : ""}`);
    // a reading that is still running answers "checking": ask again for up to a minute
    if (R.check.state === "checking" && R.polls++ < 20) return void setTimeout(() => { if (R.asked === repo) void runCheck(repo); }, 3000);
  } catch (e) {
    R.check = null;
    R.err = (e as { code?: string }).code === "bad_repo" ? "Enter a GitHub repository: owner/repo, or its address on github.com." : String((e as Error)?.message ?? e);
  }
  R.polls = 0;
  R.busy = null;
  draw();
}
async function send() {
  const c = R.check, w = me(), s = session();
  if (!c || c.state !== "can_measure") return;
  const pledge = pledgeUsd(val("rq_pledge"), R.list?.limits.pledge_usd);
  if (pledge === null) { R.err = "Enter the pledge as a number of US dollars, or leave it empty."; return draw(); }
  const note = val("rq_note");
  R.err = null;
  R.busy = "Waiting for the wallet to sign";
  draw();
  try {
    const f = s.wallet?.features?.["solana:signMessage"];
    if (!w || !s.wallet || !s.account) throw new Error("Connect a wallet first.");
    if (!f?.signMessage) throw new Error("This wallet cannot sign messages. Use a wallet with message signing.");
    const statement = { v: 1, kind: "units-repo-request", repo: c.repo, wallet: w, note, pledge_usd: pledge, created_at: Math.floor(Date.now() / 1000) };
    const out = await f.signMessage({ account: s.account, message: new TextEncoder().encode(H("units-repo-request-v1", canonicalJson(statement))) });
    const sig = base58Encode(new Uint8Array((Array.isArray(out) ? out[0] : out).signature));
    const r = await api<{ request: Summary }>("repo-requests", { statement, sig });
    R.check = { ...c, request: r.request };
    R.done = c.name;
    void loadList();
  } catch (e) {
    const code = (e as { code?: string }).code;
    R.err = code === "already_requested" ? "This wallet has already asked for this repository."
      : code === "too_many_requests" ? "This wallet has asked for as many repositories as one wallet may in a day. Try again tomorrow."
      : code === "has_units" ? "This repository can already be measured. Post a bounty on it."
      : String((e as Error)?.message ?? e);
  }
  R.busy = null;
  draw();
}

const ways = (name: string): Raw => html`<p data-request-ways>A repository gets its measurement when an agent is launched on it: the agent sets it up by itself before it starts work.
  <a class="link" href="/launch?repo=${encodeURIComponent(name)}" data-request-launch>Launch an agent on ${name}</a>${R.list?.network_drafts ? ". The network also sets up the most requested repositories, a few each day." : "."}</p>`;

function result(): Raw {
  const c = R.check;
  if (R.busy === "Reading the repository") return html`<p class="dim" data-request-state="checking">Reading the repository…</p>`;
  if (!c) return html``;
  const q = c.request;
  if (c.state === "has_units" || q?.state === "ready") return html`<div class="bo-explain" data-request-state="has_units"><p><b>${c.name}</b> can already be measured.</p>
    <p><a class="link" href="/bounties?repo=${encodeURIComponent(c.name)}" data-request-post>Post a bounty on ${c.name}</a></p></div>`;
  if (c.state === "cannot") return html`<div class="bo-explain" data-request-state="cannot"><p>Agents cannot work on <b>${c.name}</b> yet: ${c.reason}.</p><p>No request is taken for it.</p></div>`;
  if (c.state === "unreadable") return html`<div class="bo-explain" data-request-state="unreadable"><p><b>${c.name}</b> could not be read: ${c.reason}.</p></div>`;
  if (c.state === "checking") return html`<div class="bo-explain" data-request-state="slow"><p>Reading <b>${c.name}</b> is taking longer than usual. Check it again in a minute.</p></div>`;
  const w = me();
  const head = html`<div class="bo-explain" data-request-state="can_measure"><p>Agents can work on <b>${c.name}</b>: ${c.language}, with tests of its own (${c.tests} test ${c.tests === 1 ? "file" : "files"} found). It has no measurement yet.</p>
    ${q ? html`<p data-request-count>${people(q.requesters)} asked for it${q.interest_usd > 0 ? html`, with ${fmtUsd(q.interest_usd)} of stated interest` : ""}.</p>` : ""}</div>`;
  if (R.done || q?.mine) return html`${head}<p data-request-done><b>Your request for ${c.name} is recorded.</b> This page shows it as ready when a bounty can be posted on it.</p>${ways(c.name)}`;
  const dis = R.busy ? raw(" disabled") : "";
  return html`${head}
    <label><span class="eyebrow">What should improve (optional)</span><input name="rq_note" maxlength="${String(R.list?.limits.note ?? 280)}" placeholder="For example: faster parsing of large files"></label>
    <label><span class="eyebrow">About how much would you fund (US dollars, optional)</span><input name="rq_pledge" inputmode="decimal" placeholder="0">
      <span class="wl-help">A statement of interest: what you would put up as a reward once it can be measured. Nothing leaves your wallet and nothing is owed.</span></label>
    <div class="wl-row">${w ? html`<button type="button" class="wl-btn primary" data-request-act="send"${dis}>${q ? "Add my request" : "Sign the request"}</button>`
      : html`<button type="button" class="wl-btn primary" data-request-act="connect"${dis}>Connect wallet</button>`}</div>
    <span class="wl-help">A request is a message your wallet signs. No transaction, no cost.</span>`;
}

function draw() {
  const el = R.box;
  if (!el) return;
  const keep = new Map<string, string>();
  for (const i of el.querySelectorAll<HTMLInputElement>("[name]")) keep.set(i.name, i.value);
  el.innerHTML = html`<section class="bo-how" data-repo-request><h2>Request a repository</h2>
    <p>Want a bounty on a repository that is not in the list? Ask for it here.</p>
    <form class="wl-form" autocomplete="off" data-request-form>
      <label><span class="eyebrow">GitHub repository</span><input name="rq_repo" placeholder="owner/repo" autocapitalize="off" spellcheck="false"></label>
      <div class="wl-row"><button type="submit" class="wl-btn" data-request-act="check"${R.busy ? raw(" disabled") : ""}>Check it</button></div>
      ${result()}
      <div role="status" aria-live="polite">${R.busy && R.busy !== "Reading the repository" ? html`<p class="dim">${R.busy}…</p>` : R.err ? html`<p class="wl-help" data-request-err>${R.err}</p>` : ""}</div>
    </form></section>`.s;
  for (const [name, value] of keep) {
    const i = el.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (i && value && !i.value) i.value = value;
  }
}

function drawList() {
  const el = R.listEl;
  if (!el) return;
  const rows = R.list?.requests ?? [];
  if (!rows.length) return void (el.innerHTML = "");
  el.innerHTML = html`<section class="bo-sec" data-repo-requests><h2>Requested repositories</h2><div class="bo-reqs">${rows.map((r) => html`<div class="bo-req" data-request="${r.name}" data-request-row="${r.state}">
      <div class="min0"><a class="bo-repo" href="${r.repo}" target="_blank" rel="noopener">${r.name}</a>${r.language ? html`<span class="bo-repo">, ${r.language}</span>` : ""}
        ${r.notes[0] ? html`<div class="bo-note">${r.notes[0].note}</div>` : ""}</div>
      <div class="bo-req-n"><b data-request-n>${String(r.requesters)}</b><i>${r.requesters === 1 ? "request" : "requests"}</i></div>
      <div class="bo-req-n" title="What requesters say they would fund once it can be measured. Nothing is escrowed."><b data-request-interest="${String(r.interest_usd)}">${fmtUsd(r.interest_usd)}</b><i>stated interest</i></div>
      <div class="bo-req-a">${r.state === "ready"
        ? html`<a class="wl-btn primary" href="/bounties?repo=${encodeURIComponent(r.name)}" data-request-ready>Ready: post your bounty</a>`
        : html`${r.mine ? html`<span class="bo-req-mine" data-request-mine>You asked</span>` : html`<button type="button" class="wl-btn" data-request-plus="${r.name}" aria-label="Add my request for ${r.name}">+1</button>`}
          <a class="link" href="/launch?repo=${encodeURIComponent(r.name)}">Launch an agent on it</a>`}</div>
    </div>`)}</div>
    <p class="bo-req-foot">Stated interest is what requesters say they would fund. It is not escrowed and is not a reward on offer.</p></section>`.s;
}

/** Mounts the request box and the list; either element may be missing. */
export function mountRepoRequest(box: HTMLElement | null, listEl: HTMLElement | null) {
  if (!box) return;
  R.box = box;
  R.listEl = listEl;
  Object.assign(R, { check: null, asked: "", busy: null, err: null, done: null, polls: 0 });
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    const repo = val("rq_repo");
    if (repo && !R.busy) void runCheck(repo);
  });
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-request-act]");
    if (!b || b.disabled) return;
    if (b.dataset.requestAct === "send") void send();
    else if (b.dataset.requestAct === "connect") void connectWallet().catch((x) => { R.err = String((x as Error)?.message ?? x); draw(); });
  });
  listEl?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-request-plus]");
    if (!b) return;
    // "+1": the same check and the same signed request, for the repository of that row
    const input = box.querySelector<HTMLInputElement>('[name="rq_repo"]');
    if (input) input.value = b.dataset.requestPlus!;
    box.scrollIntoView({ block: "nearest" });
    void runCheck(b.dataset.requestPlus!);
  });
  onSession(() => {
    void loadList();
    if (R.asked && !R.busy) void runCheck(R.asked);
    else draw();
  });
  draw();
  void loadList();
}

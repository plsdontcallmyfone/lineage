// Claim (/claim): the owners of a repository claim the share of creator fees an agent working on it
// shares with them (docs/plans/GITHUB-FEE-CLAIMS.md, section 11). The escrow is keyed by the
// repository's numeric GitHub id and anyone GitHub says has admin on the repository can claim it.
// This file draws the claim card and the repository search's result into the two slots of the page
// shell (apps/web/src/pages/claim.ts) and is the only part that signs. The page proves nothing
// itself. Core asks GitHub who the visitor is and which repositories that receive fees they
// administer (the sign-in; for a personally owned repository also a public gist holding a statement
// this wallet signed) and signs an attestation; the program checks that attestation on chain and
// pays only the wallet it names. Nothing shows unless Core's `features.github_fee_claims` is on.
//
// One card (owner 2026-10-13): what it says and its one action come from claim-state.ts, a pure
// function of what is known. A claim is one press that runs to the end: when the connected wallet
// is not yet tied to this sign-in the wallet first signs the statement (a message, free), then the
// claim transaction. Those are the same two requests and the same checks as before; only the second
// press between them is gone.
import { ata, base58Decode, base58Encode, canonicalJson, claimMessage, claims, ed25519Ix, H, token, TOKEN_2022_PROGRAM, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { coins as coinText, injectWaitingStyle, repoAvatar, shareHref, type Waiting } from "../src/fees-waiting.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { icon } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd } from "../src/usd.ts";
import { loadChainCfg, NET, signAndSend } from "./chain.ts";
import { claimCard, claimError, claimPhases, HEADLINE, signinError, type CardRec, type CardView, type RowView } from "./claim-state.ts";
import { connectWallet, disconnectWallet, discovered, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface Providers { oauth: { provider: "github" | "mock"; scope?: string } | null; gist: boolean; attestor: string | null; network: string }
interface Repo { id: string; full_name: string; html_url: string; owner: { login: string; type: string; avatar_url: string | null } }
interface Sess { session: string; github_id: string; login: string; method: string; wallet: string | null; expires_at: number; repositories: Repo[] }
interface Recipient {
  github_id: string; repository: Repo | null; claimable_by_admins: boolean;
  escrow: { accrued: string; claimed: string; claimable: string; claim_seq: string; wallet: string | null; pending_wallet: { wallet: string; effective_at: number } | null } | null;
  agents: { agent: string; bps: number; accrued: string; set_at: number; pending_change: { effective_at: number; to_github_id: string } | null }[];
}
type Coded = Error & { code?: string; status?: number };

const KEY = "units.fee-claim.session";
const C: {
  root: HTMLElement | null; providers: Providers | null; off: "feature_off" | "unreachable" | null; sess: Sess | null; waiting: Waiting | null;
  recs: Map<string, Recipient | null>; lookup: Recipient | null; lookupErr: string | null; lookupName: string; lookupBusy: boolean;
  gist: { login: string; statement: unknown; sig: string; text: string } | null; gistOpen: boolean;
  /** what is running: `repo` when it is a claim, with the part it is in and how many wallet approvals it takes */
  busy: { repo: string | null; phase: "prove" | "claim" | null; prompts: 1 | 2; sent: boolean } | null;
  err: { text: string; detail: string | null; repo: string | null } | null; note: string | null;
  done: Map<string, { signature: string; amount: string; wallet: string }>; moved: Map<string, { signature: string; at: number }>;
  unsub: (() => void) | null;
} = { root: null, providers: null, off: null, sess: null, waiting: null, recs: new Map(), lookup: null, lookupErr: null, lookupName: "", lookupBusy: false, gist: null, gistOpen: false,
  busy: null, err: null, note: null, done: new Map(), moved: new Map(), unsub: null };

const coded = (code: string, message = code): Coded => Object.assign(new Error(message), { code });
const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw coded("network", String((e as Error)?.message ?? e));
  }
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(j?.message ?? `HTTP ${res.status}`), { code: j?.error ?? "http_error", status: res.status });
  return j as T;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
// money: an amount of the quote coin in dollars at the price Core holds (the one the tiles and the board use), else at the
// indexer's reading the page loaded (src/usd.ts), through the app's one formatter; the coin amount goes beside it
const dec = () => C.waiting?.usd?.decimals ?? NET.p.quote.decimals ?? 6;
const usdOf = (base: string | bigint): number | null => {
  const n = Number(BigInt(base)) / 10 ** dec();
  return C.waiting?.usd ? n * C.waiting.usd.quote_usd : quoteToUsd(n);
};
const usdText = (base: string | bigint) => fmtUsd(usdOf(base));
const coins = (base: string | bigint) => coinText(String(base), dec());
const repoName = (v: string) => v.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const me = () => session().account?.address ?? null;
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const TICK = raw('<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const DONE = raw('<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--bg)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>');

/** The statement the wallet signs (Core's feeClaimStatement) and the text `signMessage` shows. */
function statementFor(login: string, wallet: string) {
  const statement = { v: 1, kind: "units-fee-claim", github_login: login.toLowerCase(), wallet, created_at: Math.floor(Date.now() / 1000) };
  return { statement, digest: H("units-fee-claim-v1", canonicalJson(statement)) };
}
async function walletSign(text: string): Promise<string> {
  const s = session();
  const f = s.wallet?.features?.["solana:signMessage"];
  if (!s.wallet || !s.account || !f?.signMessage) throw coded("no_sign_message");
  const out = await f.signMessage({ account: s.account, message: new TextEncoder().encode(text) });
  const r = Array.isArray(out) ? out[0] : out;
  return base58Encode(new Uint8Array(r.signature));
}

function save(s: Sess | null) {
  C.sess = s;
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: the session lives for this page only */ }
}

/** What is held for every repository the session's account administers, as Core reads it. */
async function loadRecipients() {
  const repos = C.sess?.repositories ?? [];
  const got = await Promise.all(repos.map((r) => api<Recipient>(`fee-claims/recipients/${r.id}`).catch(() => null)));
  C.recs = new Map(repos.map((r, i) => [r.id, got[i] ?? null]));
}

async function lookupRepo(name: string) {
  C.lookup = null;
  C.lookupErr = null;
  C.lookupName = name;
  if (!REPO.test(name)) {
    C.lookupErr = claimError("bad_repository").text;
    return;
  }
  C.lookupBusy = true;
  render();
  try {
    C.lookup = await api<Recipient>(`fee-claims/recipients?repo=${encodeURIComponent(name)}`);
  } catch (e) {
    const c = (e as Coded).code;
    C.lookupErr = (e as Coded).status === 404 ? `GitHub has no public repository named ${name}.` : c === "github_unreachable" ? "GitHub did not answer. Try again." : c === "bad_repository" ? claimError(c).text : "The site did not answer. Try again.";
  }
  C.lookupBusy = false;
}

/** One thing at a time. A failure becomes a sentence (claim-state.ts); a sign-in that ran out is dropped so the card offers it again. */
async function act(repo: string | null, fn: () => Promise<void>, prompts: 1 | 2 = 1) {
  if (C.busy) return;
  C.busy = { repo, phase: null, prompts, sent: false };
  C.err = null;
  C.note = null;
  render();
  try {
    await fn();
  } catch (e) {
    const x = e as Coded;
    const name = repo ? C.sess?.repositories.find((r) => r.id === repo)?.full_name ?? null : null;
    const w = claimError(x?.code ?? null, String(x?.message ?? ""), name);
    // a failure this page has no sentence for keeps what was said, under the sentence
    const known = w.text !== claimError("?").text;
    C.err = { text: w.text, detail: known ? null : String(x?.message ?? e).slice(0, 180), repo };
    if (w.again) { save(null); C.recs = new Map(); }
  }
  C.busy = null;
  render();
}
const phase = (p: "prove" | "claim") => { if (C.busy) { C.busy.phase = p; C.busy.sent = false; render(); } };

// ------------------------------------------------------------------------------------------------
// actions

const signIn = (repo?: string) => act(null, async () => {
  const r = await api<{ url: string }>(`fee-claims/oauth/start?json=1${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`);
  location.href = r.url;
  await new Promise((r) => setTimeout(r, 8000)); // the page is leaving: the button stays busy while it does
});

const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  // the wallet connects the way it does everywhere on the site; with no wallet in this browser the header's Connect is the way in
  connect: () => {
    startDiscovery();
    const header = document.getElementById("cn-btn");
    if (!discovered().length && header) return void setTimeout(() => header.click(), 0);
    return act(null, async () => { if (!(await connectWallet())) throw coded("?", session().error ?? "The wallet did not connect."); });
  },
  // another wallet: the header's account menu, where the wallet is disconnected and another one connected
  "wallet-change": () => {
    const header = document.getElementById("cn-btn");
    if (header) setTimeout(() => header.click(), 0);
    else void disconnectWallet();
  },
  oauth: () => signIn(),
  // the sign-in with one repository named: Core asks GitHub about that repository by name
  "oauth-repo": (el) => signIn(el.dataset.repo ?? ""),
  retry: () => void boot(),
  reload: () => act(null, loadRecipients),
  signout: () => { save(null); C.recs = new Map(); C.gist = null; C.done = new Map(); C.moved = new Map(); C.note = null; C.err = null; render(); },
  "lookup-clear": () => {
    C.lookup = null; C.lookupErr = null; C.lookupName = "";
    const i = C.root?.querySelector<HTMLInputElement>('[name="cl_lookup"]');
    if (i) i.value = "";
    history.replaceState(null, "", location.pathname);
    render();
  },
  "gist-sign": () => act(null, async () => {
    const w = me();
    const login = C.root?.querySelector<HTMLInputElement>('[name="cl_login"]')?.value.trim().replace(/^@/, "") ?? "";
    if (!w) throw coded("no_wallet_connected");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) throw coded("bad_login");
    const { statement, digest } = statementFor(login, w);
    const sig = await walletSign(digest);
    const text = [`This gist proves that the GitHub account ${login.toLowerCase()} claims units fees with the Solana wallet ${w}.`, "", "```json", JSON.stringify({ statement, sig }), "```", ""].join("\n");
    C.gist = { login, statement, sig, text };
  }),
  "gist-copy": async () => {
    if (C.gist) await navigator.clipboard?.writeText(C.gist.text).catch(() => undefined);
    C.note = "Copied. Paste it into a new public gist.";
    render();
  },
  "gist-verify": () => act(null, async () => {
    const url = C.root?.querySelector<HTMLInputElement>('[name="cl_gist"]')?.value.trim() ?? "";
    save(await api<Sess>("fee-claims/proofs/gist", { gist_url: url }));
    await loadRecipients();
  }),
  lookup: () => runLookup(repoName(C.root?.querySelector<HTMLInputElement>('[name="cl_lookup"]')?.value ?? "")),
  // One press, to the end. The wallet that receives is the connected one: when this sign-in is not tied to it yet, the wallet
  // signs the statement and Core checks it (POST fee-claims/wallet), then Core's attestation and the claim transaction.
  claim: (el) => {
    const repo = el.dataset.repo ?? "";
    return act(repo, async () => {
      const s = session();
      if (!C.sess) throw coded("no_session");
      if (!s.wallet || !s.account) throw coded("no_wallet_connected");
      const w = s.account.address;
      if (C.sess.wallet !== w) {
        phase("prove");
        const { statement, digest } = statementFor(C.sess.login, w);
        const sig = await walletSign(digest);
        save(await api<Sess>("fee-claims/wallet", { session: C.sess.session, statement, sig }));
      }
      phase("claim");
      const a = await api<any>("fee-claims/attest", { session: C.sess!.session, repo_id: repo });
      // the attestation names the wallet Core tied to this sign-in: it has to be the one that is about to sign
      if (a.wallet !== w || session().account?.address !== w) throw coded("wrong_wallet");
      const ceiling = BigInt(a.ceiling);
      const msg = claimMessage({ githubId: BigInt(a.github_id), wallet: a.wallet, ceiling, claimSeq: BigInt(a.claim_seq), expiresAt: a.expires_at, program: a.program });
      const tp = a.line_token_program ?? TOKEN_2022_PROGRAM;
      const ixs: Ix[] = [
        token.createAtaIdempotent(a.wallet, a.wallet, a.line_mint, tp),
        ed25519Ix(a.attestor, base58Decode(a.signature), msg),
        claims.claimGithubFees({ wallet: a.wallet, walletToken: ata(a.wallet, a.line_mint, tp), githubId: BigInt(a.github_id), lineMint: a.line_mint, ceiling, expiresAt: a.expires_at, lineTokenProgram: tp }),
      ];
      const r = await signAndSend({ wallet: s.wallet, account: s.account, ixs, units: 200_000, onStatus: (t) => { if (C.busy && !/^waiting for the wallet/i.test(t) && !C.busy.sent) { C.busy.sent = true; render(); } } });
      if (!r.confirmed || r.confirmed.err) throw coded("tx_failed", r.confirmed?.signature ?? "");
      // earlier claims were paid to another wallet and this one's turn has not come: the transaction recorded the request and paid nothing
      const pend = C.recs.get(repo)?.escrow?.pending_wallet;
      const matured = !!pend && pend.wallet === w && Date.now() / 1000 >= pend.effective_at;
      if (a.rebind && !matured) C.moved.set(repo, { signature: r.confirmed.signature, at: Math.floor(Date.now() / 1000) + Number(a.rebind.delay_s) });
      else C.done.set(repo, { signature: r.confirmed.signature, amount: a.ceiling, wallet: w });
      await loadRecipients();
      C.root?.dispatchEvent(new CustomEvent("claim:changed")); // the shell reads the tiles and the board again
    }, C.sess?.wallet && C.sess.wallet === me() ? 1 : 2);
  },
};

/** The search: its result goes beside the card, the address names the repository, and the card's sign-in asks about it. */
async function runLookup(name: string, scroll = false) {
  if (C.busy) return;
  await lookupRepo(name);
  if (C.lookup) history.replaceState(null, "", `${location.pathname}?repo=${encodeURIComponent(C.lookup.repository?.full_name ?? name)}`);
  render();
  if (scroll) (C.root?.querySelector<HTMLElement>("[data-focus]") ?? C.root?.querySelector<HTMLElement>("[data-claim-card]"))?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

// ------------------------------------------------------------------------------------------------
// markup

const view = (): CardView => claimCard({
  providers: C.providers ? { oauth: !!C.providers.oauth, gist: C.providers.gist } : null, off: C.off,
  sess: C.sess ? { login: C.sess.login, method: C.sess.method, wallet: C.sess.wallet, repositories: C.sess.repositories.map((r) => ({ id: r.id, full_name: r.full_name })) } : null,
  connected: me(),
  recs: new Map([...C.recs].map(([id, r]): [string, CardRec] => [id, r ? { escrow: r.escrow, agents: r.agents.length } : null])),
  focus: C.lookup ? { full_name: C.lookup.repository?.full_name ?? C.lookupName, id: C.lookup.github_id, routed: C.lookup.claimable_by_admins } : null,
  done: new Set(C.done.keys()), now: Math.floor(Date.now() / 1000),
}, usdText);

const msg = (tone: "bad" | "warn" | "", t1: string | Raw, t2?: string | Raw | null): Raw => html`<div class="cl-msg ${tone}"${tone === "bad" ? raw(' role="alert" data-claim-err') : ""}><div><p>${t1}</p>${t2 ? html`<p>${t2}</p>` : ""}</div></div>`;
const off = () => (C.busy ? raw(" disabled") : "");

function agentsTable(r: Recipient): Raw {
  if (!r.agents.length) return html``;
  return html`<details class="cl-from"><summary><span>From ${String(r.agents.length)} agent${r.agents.length === 1 ? "" : "s"}</span></summary>
    <table><thead><tr><th>Agent</th><th class="right">Share of its fees</th><th class="right">Shared so far</th></tr></thead><tbody>
    ${r.agents.map((a) => html`<tr data-claim-agent="${a.agent}"><td><a class="link" href="/agents/${a.agent}/profile" title="${a.agent}">${short(a.agent)}</a></td>
      <td class="right num">${pct(a.bps)}</td><td class="right"><span class="num">${usdText(a.accrued)}</span> <span class="fw-coins dim num">${coins(a.accrued)}</span></td></tr>`)}
  </tbody></table></details>`;
}

/** The two parts of a running claim, the one in hand marked, with what the wallet is about to ask. */
function progress(): Raw {
  const b = C.busy!;
  const ps = claimPhases(b.prompts);
  const at = Math.max(0, ps.findIndex((p) => p.key === b.phase));
  const now = ps[at]!;
  return html`<div class="cl-prog" role="status" aria-live="polite" data-claim-busy data-claim-phase="${now.key}"><ol>
      ${ps.map((p, i) => html`<li data-s="${i < at ? "done" : i === at ? "now" : "todo"}"><span class="cl-dot">${i < at ? TICK : i === at ? "" : String(i + 1)}</span>${p.label}</li>`)}</ol>
    <p>${now.key === "claim" && b.sent ? "Sent. Waiting for the network to confirm it." : now.hint}</p></div>`;
}

function rowHtml(v: RowView): Raw {
  const repo = C.sess!.repositories.find((r) => r.id === v.id)!;
  const rec = C.recs.get(v.id) ?? null;
  const busy = C.busy?.repo === v.id;
  const done = C.done.get(v.id), moved = C.moved.get(v.id);
  const amt = v.state === "loading" ? html`<b>Reading</b>` : v.state === "error" ? html`<b>Could not be read</b><i><button type="button" class="cl-linkbtn" data-claim="reload"${off()}>Try again</button></i>`
    : v.claimable > 0n ? html`<b data-claimable="${String(v.claimable)}"><span class="num" title="${coins(v.claimable)}">${usdText(v.claimable)}</span></b><i>${coins(v.claimable)}</i>`
    : html`<b data-claimable="0">${v.state === "done" ? "Claimed" : "Nothing waiting"}</b>`;
  const meta = [rec?.agents.length ? "" : "No agent shares fees with it now", v.claimed > 0n ? `${usdText(v.claimed)} claimed so far` : ""].filter(Boolean).join(" · ");
  const err = C.err?.repo === v.id ? msg("bad", C.err.text, C.err.detail) : "";
  const x = busy ? progress()
    : done ? html`<div class="cl-ok" data-claim-done>${DONE}<div><p><b data-claimed="${done.amount}">${usdText(done.amount)}</b> arrived in <span title="${done.wallet}">${short(done.wallet)}</span>. <span class="dim num">${coins(done.amount)}</span></p>
        <p><a class="link" href="${explorerTx(done.signature)}" target="_blank" rel="noopener" data-claim-tx="${done.signature}">See the transaction ${icon.ext}</a> · The next fees arrive here as agents earn them.</p></div></div>`
    : moved ? msg("", `Recorded. Claims for ${v.full_name} move to this wallet on ${new Date(moved.at * 1000).toLocaleString()}. Claim again then.`, html`<a class="link" href="${explorerTx(moved.signature)}" target="_blank" rel="noopener">See the transaction ${icon.ext}</a>`)
    : v.state === "move" ? msg("warn", `Earlier claims for ${v.full_name} were paid to ${short(v.paidTo!)}.`, "Asking to move them to your wallet starts a waiting period. Until it ends that wallet can still claim, which cancels the move.")
    : v.state === "moving" ? msg("", `Claims for ${v.full_name} move to this wallet on ${new Date(v.movesAt! * 1000).toLocaleString()}.`, `Until then they are paid to ${short(v.paidTo!)}.`)
    : "";
  return html`<article class="cl-r" data-claim-balances="${v.id}" data-state="${v.state}"${v.focused ? raw(" data-focus") : ""}>
    <div class="cl-r-id">${repoAvatar(repo)}<div class="min0"><a class="cl-r-name" href="${shareHref(repo.full_name)}" data-claim-repo="${repo.id}">${repo.full_name}</a>
      <span class="cl-r-meta">${rec ? agentsTable(rec) : ""}${meta ? html`<span>${meta}</span>` : ""}</span></div></div>
    <div class="cl-r-amt">${amt}</div>
    ${v.button && !busy && !moved ? html`<button type="button" class="wl-btn${v.button.primary ? " primary" : ""}" data-claim="${v.button.action}" data-repo="${v.id}"${off()}>${v.button.label}</button>` : html`<span></span>`}
    <div class="cl-r-x">${err}${x}</div>
  </article>`;
}

/** The gist proof (a repository under a personal account), tucked behind one link; open by itself only where no sign-in is offered. */
function gistPanel(open: boolean): Raw {
  const w = me();
  return html`<details class="cl-gist"${open ? raw(" open") : ""}><summary>Another way to prove it</summary><div class="cl-gist-b">
    <p>For a repository under your own account, a public gist works without the sign-in: it shows which GitHub account is yours. An organisation's repository needs the sign-in.</p>
    ${!w ? html`<p>Connect the wallet the fees should go to first.</p><div class="wl-row"><button type="button" class="wl-btn" data-claim="connect"${off()}>Connect wallet</button></div>` : html`
      <label><span class="eyebrow">Your GitHub username</span><input name="cl_login" maxlength="39" placeholder="octocat" autocomplete="off" autocapitalize="off" spellcheck="false" value="${C.gist?.login ?? ""}"></label>
      <div class="wl-row"><button type="button" class="wl-btn" data-claim="gist-sign"${off()}>Sign with ${short(w)}</button></div>
      ${C.gist ? html`<p>Create a <a class="link" href="https://gist.github.com/" target="_blank" rel="noopener">new public gist</a> on that account with exactly this text, then paste its address below.</p>
        <textarea class="cl-proof" readonly rows="6" data-claim-gist-text>${C.gist.text}</textarea>
        <div class="wl-row"><button type="button" class="wl-btn" data-claim="gist-copy">${icon.copy} Copy</button></div>
        <label><span class="eyebrow">Gist address</span><input name="cl_gist" type="url" placeholder="https://gist.github.com/you/0123abcd…"></label>
        <div class="wl-row"><button type="button" class="wl-btn primary" data-claim="gist-verify"${off()}>Check the gist</button></div>` : ""}`}
  </div></details>`;
}

function cardHtml(): Raw {
  const v = view();
  const s = C.sess, w = me();
  const scopeNone = C.providers?.oauth?.scope === "";
  const steps = v.steps.length ? html`<ol class="cl-steps" aria-label="Steps">${v.steps.map((st, i) => html`<li data-step="${st.key}" data-s="${st.state}"${st.state === "now" ? raw(' aria-current="step"') : ""}><span class="cl-dot">${st.state === "done" ? TICK : String(i + 1)}</span>${st.label}</li>`)}</ol>` : "";
  const cardErr = C.err && (C.err.repo === null || !v.rows.some((r) => r.id === C.err!.repo)) ? msg("bad", C.err.text, C.err.detail) : "";
  const working = C.busy && C.busy.repo === null;
  const primary = v.primary ? html`<div class="cl-act"><button type="button" class="wl-btn primary" data-claim="${v.primary.action}"${v.primary.repo ? html` data-repo="${v.primary.repo}"` : ""}${working ? raw(' aria-busy="true"') : ""}${off()}>${v.primary.label}</button>
      ${working ? html`<span class="cl-fine" role="status" data-claim-busy>${v.primary.action === "connect" ? "Waiting for the wallet." : v.primary.action === "retry" ? "Asking again." : "Opening GitHub."}</span>` : ""}</div>` : "";
  const fine = v.key === "signed-out" ? html`<p class="cl-fine">GitHub tells this site who you are and which repositories you have admin on. ${scopeNone ? "The sign-in asks for no access to your code, and no token is kept." : "No token is kept."}</p>`
    : v.key === "ready" ? html`<p class="cl-fine" data-claim-prompts="${String(v.prompts)}">${v.prompts === 2 ? "A claim asks your wallet twice: a free signature that shows the wallet is yours, then the claim itself." : "A claim asks your wallet once."}</p>` : "";
  const who = s ? html`<div class="cl-who"><span>Signed in as <b data-claim-login>${s.login}</b><button type="button" class="cl-linkbtn" data-claim="signout"${off()}>Sign out</button></span>
      ${w ? html`<span>Fees go to <b title="${w}" data-claim-wallet="${w}" data-claim-proved="${s.wallet === w ? "1" : "0"}">${short(w)}</b><button type="button" class="cl-linkbtn" data-claim="wallet-change"${off()}>Change</button></span>` : ""}</div>` : "";
  return html`<section class="cl-card" data-claim-card data-claim-state="${v.key}">
    <div class="cl-card-h"><h2>${HEADLINE}</h2>${steps}</div>
    <div class="cl-card-b"><div class="cl-status">${cardErr}${C.note ? msg("", C.note) : ""}</div>
      <p class="cl-lead" data-claim-lead>${v.lead}</p>${primary}${fine}
      ${v.note && v.key !== "none" ? html`<div class="cl-msg warn" data-claim-note><div><p>${v.note}</p></div></div>` : ""}
      ${working && !v.primary ? html`<p class="cl-fine" role="status" data-claim-busy>Working.</p>` : ""}</div>
    ${who}
    ${v.rows.length ? html`<div class="cl-rows" data-claim-repos="${String(v.rows.length)}">${v.rows.map(rowHtml)}</div>` : ""}
    ${v.key === "none" ? html`<div class="cl-none" data-claim-none>${v.note ? html`<p class="cl-fine">${v.note}</p>` : ""}<div class="wl-row"><a class="link" href="/launch">Launch an agent with fees shared to its repository's owners</a></div></div>`
      : ""}
    ${!s && (v.key === "signed-out" || v.key === "gist-only") ? html`<div class="cl-card-f">${gistPanel(v.key === "gist-only" || C.gistOpen)}</div>` : ""}
    ${s && v.rows.length ? html`<div class="cl-card-f">Any one admin of a repository can claim everything waiting for it, to the wallet they connect. There is no deadline.</div>` : ""}
  </section>`;
}

/** What the search found: what waits, what was claimed, who shares, and the way on. */
function resultHtml(): Raw {
  const l = C.lookup;
  if (C.lookupBusy) return html`<section class="cl-result" data-claim-looking><div class="cl-result-b"><p role="status">Looking up ${C.lookupName}.</p></div></section>`;
  if (C.lookupErr) return html`<section class="cl-result"><div class="cl-result-b"><p data-claim-lookup-err>${C.lookupErr}</p></div></section>`;
  if (!l) return html``;
  const name = l.repository?.full_name ?? C.lookupName;
  const e = l.escrow;
  const waiting = l.claimable_by_admins && e ? BigInt(e.claimable) : 0n;
  const mine = !!C.sess?.repositories.some((r) => r.id === l.github_id);
  const shares = [...new Set(l.agents.map((a) => a.bps))];
  return html`<section class="cl-result" data-claim-lookup="${l.github_id}" data-routed="${l.claimable_by_admins ? "1" : "0"}">
    <div class="cl-result-h"><div class="cl-r-id">${l.repository ? repoAvatar(l.repository) : ""}<div class="min0">${l.repository ? html`<a class="cl-r-name" href="${l.repository.html_url}" target="_blank" rel="noopener">${name}</a>` : html`<span class="cl-r-name">${name}</span>`}</div></div>
      <span class="cl-pill${waiting > 0n ? " on" : ""}">${!l.claimable_by_admins ? "No fees shared" : waiting > 0n ? "Fees waiting" : "Nothing waiting"}</span></div>
    ${l.claimable_by_admins ? html`<div class="cl-figs">
        <div><span>Waiting</span><b data-claimable="${e?.claimable ?? "0"}"><span class="num">${usdText(waiting)}</span></b><i>${coins(waiting)}</i></div>
        <div><span>Claimed so far</span><b><span class="num">${usdText(e?.claimed ?? "0")}</span></b><i>${coins(e?.claimed ?? "0")}</i></div></div>
      <div class="cl-result-b"><p>${l.agents.length ? html`From ${String(l.agents.length)} agent${l.agents.length === 1 ? "" : "s"}: ${l.agents.slice(0, 6).map((a, i) => html`${i ? ", " : ""}<a class="link" href="/agents/${a.agent}/profile" title="${a.agent}">${short(a.agent)}</a>`)}${l.agents.length > 6 ? ` and ${l.agents.length - 6} more` : ""}${shares.length === 1 ? `, ${pct(shares[0]!)} of ${l.agents.length === 1 ? "its" : "their"} fees` : ""}.` : "No agent shares fees with it now."}
        ${mine ? " It is one of yours: claim it in your list." : " Only someone with admin on it can claim."}</p>
        <div class="wl-row">${!mine && C.sess && C.providers?.oauth ? html`<button type="button" class="wl-btn" data-claim="oauth-repo" data-repo="${name}"${off()}>Sign in again for this repository</button>` : ""}
          <a class="link" href="${shareHref(name)}" data-claim-share>Page to share</a><button type="button" class="cl-linkbtn" data-claim="lookup-clear">Clear</button></div></div>`
      : html`<div class="cl-result-b"><p>No agent shares fees with this repository, so there is nothing to claim for it.</p>
        <div class="wl-row"><a class="link" href="/launch?repo=${encodeURIComponent(name)}">Launch an agent on it</a><button type="button" class="cl-linkbtn" data-claim="lookup-clear">Clear</button></div></div>`}
  </section>`;
}

function render() {
  const el = C.root;
  if (!el) return;
  const card = el.querySelector<HTMLElement>('[data-cl-slot="card"]'), result = el.querySelector<HTMLElement>('[data-cl-slot="result"]');
  if (!card) return;
  const keep = new Map<string, string>();
  for (const i of card.querySelectorAll<HTMLInputElement>("input[name]")) keep.set(i.name, i.value);
  const d0 = card.querySelector<HTMLDetailsElement>("details.cl-gist");
  if (d0) C.gistOpen = d0.open;
  const from = new Set([...card.querySelectorAll<HTMLDetailsElement>(".cl-r details.cl-from[open]")].map((d) => d.closest<HTMLElement>("[data-claim-balances]")?.dataset.claimBalances));
  card.innerHTML = cardHtml().s;
  for (const [name, value] of keep) {
    const i = card.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (i) i.value = value; // what the visitor typed survives a repaint
  }
  for (const id of from) {
    const d = card.querySelector<HTMLDetailsElement>(`[data-claim-balances="${id}"] details.cl-from`);
    if (d) d.open = true;
  }
  if (result) result.innerHTML = resultHtml().s;
}

/** Asks what the site offers, restores a sign-in and reads what waits; `retry` runs it again after the site did not answer. */
async function boot() {
  C.off = null;
  C.providers = null;
  render();
  try {
    if (NET.p.features?.github_fee_claims !== true) throw coded("feature_off");
    C.providers = await api<Providers>("fee-claims/providers");
  } catch (e) {
    C.off = (e as Coded).code === "feature_off" ? "feature_off" : "unreachable";
    render();
    return;
  }
  // a sign-in that came back without one says why (the address carries the code), then the address is cleaned
  const failed = /[#&]signin_error=([A-Za-z0-9_]+)/.exec(location.hash);
  if (failed) {
    C.err = { text: signinError(failed[1]!), detail: null, repo: null };
    history.replaceState(null, "", location.pathname + location.search);
  }
  // a session handed back by the sign-in (URL fragment), else the one this tab kept
  const m = /[#&]session=([A-Za-z0-9_.-]+)/.exec(location.hash);
  let token: string | null = m ? m[1]! : null;
  if (m) history.replaceState(null, "", location.pathname + location.search);
  if (!token) {
    try {
      token = (JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Sess | null)?.session ?? null;
    } catch {
      token = null;
    }
  }
  if (token) {
    try {
      const s = await api<Omit<Sess, "session">>(`fee-claims/session?session=${token}`);
      save({ ...s, session: token });
      render();
      await loadRecipients();
    } catch (e) {
      save(null);
      // the sign-in this tab kept has run out: say so only when the visitor just came back from GitHub
      if (m) C.err = { text: claimError((e as Coded).code ?? null).text, detail: null, repo: null };
    }
  }
  // a repository named in the address (a Claim button elsewhere, or the way back from a sign-in for one repository): shown at once
  const named = repoName(new URLSearchParams(location.search).get("repo") ?? "");
  if (named) {
    const i = C.root?.querySelector<HTMLInputElement>('[name="cl_lookup"]');
    if (i && !i.value) i.value = named;
    await lookupRepo(named);
  }
  render();
}

export async function mountClaim(root: HTMLElement, opts: { waiting?: Waiting | null } = {}) {
  injectWaitingStyle();
  C.root = root;
  C.waiting = opts.waiting ?? null;
  C.err = C.note = C.busy = null;
  C.done = new Map();
  C.moved = new Map();
  C.lookup = null;
  C.lookupErr = null;
  C.lookupName = "";
  await loadChainCfg().catch(() => undefined);
  await loadUsd(); // the dollar price behind an amount when Core named none: held 45 s, never throws
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // a Claim button of the board is this page's own: the repository opens here instead of loading the page again
    const go = t.closest<HTMLAnchorElement>("a[data-fees-claim]");
    if (go && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      const name = repoName(new URL(go.href, location.href).searchParams.get("repo") ?? "");
      if (name) {
        e.preventDefault();
        const i = root.querySelector<HTMLInputElement>('[name="cl_lookup"]');
        if (i) i.value = name;
        void runLookup(name, true);
      }
      return;
    }
    const b = t.closest<HTMLElement>("[data-claim]");
    if (b && !(b as HTMLButtonElement).disabled && b.dataset.claim !== "lookup") void actions[b.dataset.claim!]?.(b);
  });
  root.addEventListener("submit", (e) => {
    if (!(e.target as HTMLElement).closest("[data-claim-search]")) return;
    e.preventDefault();
    void actions.lookup!(root);
  });
  startDiscovery();
  restoreSession();
  C.unsub?.();
  C.unsub = onSession(() => render());
  await boot();
}

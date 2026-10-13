// Claim (/claim): a GitHub user claims the creator fees an agent's launcher routed to their account
// (docs/plans/GITHUB-FEE-CLAIMS.md). Self-contained: its own state, its own markup, mounted by
// apps/web/src/pages/claim.ts into the wallet bundle. The page proves nothing itself. Core checks
// the GitHub account (OAuth, or a public gist holding a statement this wallet signed) and signs an
// attestation; the program checks that attestation on chain and pays only the wallet it names.
// Nothing shows unless Core's `features.github_fee_claims` is on.
import { ata, base58Decode, base58Encode, canonicalJson, claimMessage, claims, ed25519Ix, H, token, TOKEN_2022_PROGRAM, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { banner, icon, kv, panel, stat } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, usdWhy } from "../src/usd.ts";
import { loadChainCfg, NET, qsym, signAndSend, units } from "./chain.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface Providers { oauth: { provider: "github" | "mock" } | null; gist: boolean; attestor: string | null; network: string }
interface Sess { session: string; github_id: string; login: string; method: string; wallet: string | null; expires_at: number }
interface Recipient {
  github_id: string; login: string | null; avatar_url: string | null;
  escrow: { accrued: string; claimed: string; claimable: string; claim_seq: string; wallet: string | null; pending_wallet: { wallet: string; effective_at: number } | null } | null;
  agents: { agent: string; bps: number; accrued: string; set_at: number; pending_change: { effective_at: number; to_github_id: string } | null }[];
}

const KEY = "units.fee-claim.session";
const C: { root: HTMLElement | null; providers: Providers | null; off: string | null; sess: Sess | null; rec: Recipient | null; lookup: Recipient | null; lookupErr: string | null;
  gist: { login: string; statement: unknown; sig: string; text: string } | null; busy: string | null; err: string | null; done: { signature: string; amount: string } | null; note: string | null } =
  { root: null, providers: null, off: null, sess: null, rec: null, lookup: null, lookupErr: null, gist: null, busy: null, err: null, done: null, note: null };

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(j?.message ?? `HTTP ${res.status}`), { code: j?.error ?? "http_error", status: res.status });
  return j as T;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const dec = () => NET.p.quote.decimals ?? 6;
// money: the escrow's amount in the quote coin at the indexer's dollar price, through the app's one
// formatter (src/usd.ts); the exact coin amount stays in the title
const usdText = (base: string | bigint) => fmtUsd(quoteToUsd(Number(BigInt(base)) / 10 ** dec()));
const amount = (base: string | bigint | null | undefined): Raw => (base === null || base === undefined ? html`<span class="faint">TBA</span>`
  : html`<span class="num" title="${units(BigInt(base), dec())} ${qsym()}${usdWhy() ? `. ${usdWhy()}` : ""}">${usdText(base)}</span>`);
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${NET.p.explorer_cluster ? `?cluster=${NET.p.explorer_cluster}` : ""}`;
const me = () => session().account?.address ?? null;

/** The statement the wallet signs (Core's feeClaimStatement) and the text `signMessage` shows. */
function statementFor(login: string, wallet: string) {
  const statement = { v: 1, kind: "units-fee-claim", github_login: login.toLowerCase(), wallet, created_at: Math.floor(Date.now() / 1000) };
  return { statement, digest: H("units-fee-claim-v1", canonicalJson(statement)) };
}
async function walletSign(text: string): Promise<string> {
  const s = session();
  const f = s.wallet?.features?.["solana:signMessage"];
  if (!s.wallet || !s.account || !f?.signMessage) throw new Error("This wallet cannot sign messages. Use a wallet with message signing to bind it.");
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

async function loadRecipient() {
  if (!C.sess) return;
  C.rec = await api<Recipient>(`fee-claims/recipients/${C.sess.github_id}`).catch(() => null);
}

async function act(label: string, fn: () => Promise<void>) {
  if (C.busy) return;
  C.busy = label;
  C.err = null;
  render();
  try {
    await fn();
  } catch (e) {
    C.err = String((e as Error)?.message ?? e);
  }
  C.busy = null;
  render();
}

// ------------------------------------------------------------------------------------------------
// actions

const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  connect: () => act("Connecting the wallet", async () => { await connectWallet(); }),
  oauth: () => act("Opening the sign-in", async () => {
    const r = await api<{ url: string }>("fee-claims/oauth/start?json=1");
    location.href = r.url;
  }),
  signout: () => { save(null); C.rec = null; C.gist = null; C.done = null; C.note = null; render(); },
  bind: () => act("Waiting for the wallet to sign the statement", async () => {
    const w = me();
    if (!C.sess || !w) throw new Error("Sign in and connect a wallet first.");
    const { statement, digest } = statementFor(C.sess.login, w);
    const sig = await walletSign(digest);
    save(await api<Sess>("fee-claims/wallet", { session: C.sess.session, statement, sig }));
    await loadRecipient();
  }),
  "gist-sign": () => act("Waiting for the wallet to sign the statement", async () => {
    const w = me();
    const login = C.root?.querySelector<HTMLInputElement>('[name="cl_login"]')?.value.trim().replace(/^@/, "") ?? "";
    if (!w) throw new Error("Connect a wallet first.");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) throw new Error("Type your GitHub username.");
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
  "gist-verify": () => act("Reading the gist from GitHub", async () => {
    const url = C.root?.querySelector<HTMLInputElement>('[name="cl_gist"]')?.value.trim() ?? "";
    save(await api<Sess>("fee-claims/proofs/gist", { gist_url: url }));
    await loadRecipient();
  }),
  lookup: () => act("Looking the account up", async () => {
    const login = C.root?.querySelector<HTMLInputElement>('[name="cl_lookup"]')?.value.trim().replace(/^@/, "") ?? "";
    C.lookup = null;
    C.lookupErr = null;
    try {
      C.lookup = await api<Recipient>(`fee-claims/recipients?login=${encodeURIComponent(login)}`);
    } catch (e) {
      C.lookupErr = (e as { status?: number }).status === 404 ? `No GitHub account named ${login}.` : String((e as Error).message);
    }
  }),
  claim: () => act("Asking Core for the attestation", async () => {
    const s = session();
    if (!C.sess?.wallet || !s.wallet || !s.account) throw new Error("Bind the connected wallet first.");
    if (s.account.address !== C.sess.wallet) throw new Error(`The connected wallet is not the one bound to this session (${short(C.sess.wallet)}).`);
    const a = await api<any>("fee-claims/attest", { session: C.sess.session });
    const ceiling = BigInt(a.ceiling);
    const msg = claimMessage({ githubId: BigInt(a.github_id), wallet: a.wallet, ceiling, claimSeq: BigInt(a.claim_seq), expiresAt: a.expires_at, program: a.program });
    const tp = a.line_token_program ?? TOKEN_2022_PROGRAM;
    const ixs: Ix[] = [
      token.createAtaIdempotent(a.wallet, a.wallet, a.line_mint, tp),
      ed25519Ix(a.attestor, base58Decode(a.signature), msg),
      claims.claimGithubFees({ wallet: a.wallet, walletToken: ata(a.wallet, a.line_mint, tp), githubId: BigInt(a.github_id), lineMint: a.line_mint, ceiling, expiresAt: a.expires_at, lineTokenProgram: tp }),
    ];
    const r = await signAndSend({ wallet: s.wallet, account: s.account, ixs, units: 200_000, onStatus: (t) => { C.busy = t; render(); } });
    if (!r.confirmed || r.confirmed.err) throw new Error(`The claim transaction failed${r.confirmed?.signature ? ` (${r.confirmed.signature})` : ""}.`);
    C.done = a.rebind ? null : { signature: r.confirmed.signature, amount: a.ceiling };
    C.note = a.rebind ? `This account's fees are pinned to ${short(a.rebind.pinned_wallet)}. Your request to move them to this wallet is recorded on chain and takes effect after ${a.rebind.delay_s} seconds; claim again then.` : null;
    await loadRecipient();
  }),
};

// ------------------------------------------------------------------------------------------------
// markup

function agentsTable(r: Recipient): Raw {
  if (!r.agents.length) return html`<div class="panel-b dim">No agent routes fees to this account right now.</div>`;
  return html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="right">Share of its fees</th><th class="right">Accrued</th></tr></thead><tbody>
    ${r.agents.map((a) => html`<tr data-claim-agent="${a.agent}"><td><a class="link" href="/agents/${a.agent}/profile" title="${a.agent}">${short(a.agent)}</a>${a.pending_change ? html` <span class="dim">changes ${new Date(a.pending_change.effective_at * 1000).toLocaleString()}</span>` : ""}</td>
      <td class="right num">${String(a.bps / 100)}%</td><td class="right num">${amount(a.accrued)}</td></tr>`)}
  </tbody></table></div>`;
}

function balances(r: Recipient): Raw {
  const e = r.escrow;
  return html`<div class="stats" style="--n:3" data-claim-balances>
    ${stat("Accrued", e ? amount(e.accrued) : "$0", "since the first route", "sm")}
    ${stat("Claimed", e ? amount(e.claimed) : "$0", e?.wallet ? html`to <span title="${e.wallet}">${short(e.wallet)}</span>` : "nothing yet", "sm")}
    ${stat("Claimable now", html`<span data-claimable="${e?.claimable ?? "0"}">${e ? amount(e.claimable) : "$0"}</span>`, `paid in ${qsym()}, read from the escrow on chain`, "sm")}
  </div>`;
}

function proofCard(): Raw {
  const p = C.providers!;
  if (C.sess) {
    return panel("1. Your GitHub account", html`<div class="panel-b">
      ${kv([["Account", html`<b data-claim-login>@${C.sess.login}</b> <span class="dim">id ${C.sess.github_id}</span>`], ["Proven by", C.sess.method === "gist" ? "a public gist" : C.sess.method === "mock" ? "the mock sign-in" : "GitHub sign-in"],
        ["Valid until", new Date(C.sess.expires_at * 1000).toLocaleTimeString()]])}
      <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn" data-claim="signout">Use another account</button></div></div>`);
  }
  const w = me();
  return panel("1. Prove your GitHub account", html`<div class="panel-b">
    ${p.oauth ? html`<div class="wl-row"><button type="button" class="wl-btn primary" data-claim="oauth">${icon.ext} Sign in with GitHub${p.oauth.provider === "mock" ? " (mock provider)" : ""}</button></div>
      <p class="wl-fine" style="margin:8px 0 14px">Read-only: the sign-in tells this site which account you are, nothing else. No token is stored.</p>` : ""}
    <details class="cl-gist"${p.oauth ? "" : raw(" open")}><summary>${p.oauth ? "Or prove it without signing in: a public gist" : "Prove it with a public gist"}</summary>
      ${!w ? html`<p class="wl-fine">Connect the wallet that should receive the fees first.</p><div class="wl-row"><button type="button" class="wl-btn primary" data-claim="connect">Connect wallet</button></div>` : html`
        <label style="margin-top:10px"><span class="eyebrow">Your GitHub username</span><input name="cl_login" maxlength="39" placeholder="octocat" value="${C.gist?.login ?? ""}"></label>
        <div class="wl-row" style="margin-top:8px"><button type="button" class="wl-btn" data-claim="gist-sign">Sign the statement with ${short(w)}</button></div>
        ${C.gist ? html`<p class="wl-fine" style="margin-top:10px">Create a <a class="link" href="https://gist.github.com/" target="_blank" rel="noopener">new public gist</a> on that account with exactly this text, then paste its address below.</p>
          <textarea class="cl-proof" readonly rows="6" data-claim-gist-text>${C.gist.text}</textarea>
          <div class="wl-row"><button type="button" class="wl-btn" data-claim="gist-copy">${icon.copy} Copy</button></div>
          <label style="margin-top:10px"><span class="eyebrow">Gist address</span><input name="cl_gist" type="url" placeholder="https://gist.github.com/you/0123abcd…"></label>
          <div class="wl-row" style="margin-top:8px"><button type="button" class="wl-btn primary" data-claim="gist-verify">Verify the gist</button></div>` : ""}`}
    </details></div>`);
}

function walletCard(): Raw {
  const w = me();
  const s = C.sess;
  if (!s) return panel("2. The wallet that receives the fees", html`<div class="panel-b dim">After step 1.</div>`);
  if (s.wallet) {
    const same = w === s.wallet;
    return panel("2. The wallet that receives the fees", html`<div class="panel-b">
      ${kv([["Bound wallet", html`<span title="${s.wallet}" data-claim-wallet="${s.wallet}">${short(s.wallet)}</span>`]])}
      ${same ? "" : banner("warn", "Another wallet is connected", `Connect ${short(s.wallet)} to claim, or bind the connected wallet instead.`)}
      ${!same && w ? html`<div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn" data-claim="bind">Bind ${short(w)} instead</button></div>` : ""}</div>`);
  }
  return panel("2. The wallet that receives the fees", html`<div class="panel-b">
    ${w ? html`<p class="wl-fine">Your wallet signs one line of text that says @${s.login} claims with ${short(w)}. It costs nothing and moves nothing.</p>
      <div class="wl-row"><button type="button" class="wl-btn primary" data-claim="bind">Sign with ${short(w)}</button></div>`
      : html`<div class="wl-row"><button type="button" class="wl-btn primary" data-claim="connect">Connect wallet</button></div>`}</div>`);
}

function claimCard(): Raw {
  const r = C.rec;
  if (!C.sess) return panel("3. Claim", html`<div class="panel-b dim">After steps 1 and 2.</div>`);
  if (!r) return panel("3. Claim", html`<div class="panel-b dim">Reading the escrow…</div>`);
  const e = r.escrow;
  const claimable = e ? BigInt(e.claimable) : 0n;
  const pinned = e?.wallet ?? null;
  const other = !!(pinned && C.sess.wallet && pinned !== C.sess.wallet);
  const ready = !!C.sess.wallet && me() === C.sess.wallet && (claimable > 0n || other);
  return panel("3. Claim", html`${balances(r)}${agentsTable(r)}<div class="panel-b">
    ${other ? banner("warn", `These fees are pinned to ${short(pinned!)}`, "The first claim pinned that wallet. Claiming with another one records a request on chain that takes effect after a delay; the pinned wallet can still claim meanwhile.") : ""}
    ${e?.pending_wallet ? banner("info", `A move to ${short(e.pending_wallet.wallet)} is pending`, `It takes effect ${new Date(e.pending_wallet.effective_at * 1000).toLocaleString()}.`) : ""}
    ${!e ? html`<p class="dim">No fees were ever routed to this account.</p>` : ""}
    ${C.done ? banner("info", html`Claimed <b class="num" data-claimed="${C.done.amount}">${amount(C.done.amount)}</b>`, html`<a class="link" href="${explorerTx(C.done.signature)}" target="_blank" rel="noopener" data-claim-tx="${C.done.signature}">Transaction ${short(C.done.signature)} ${icon.ext}</a>`) : ""}
    <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn primary" data-claim="claim"${ready && !C.busy ? "" : raw(" disabled")}>${other ? "Request the move to this wallet" : html`Claim ${claimable > 0n ? amount(claimable) : ""}`}</button></div>
    <p class="wl-fine" style="margin-top:8px">Fees that arrive after a claim stay in the escrow until the next one. There is no deadline.</p></div>`);
}

function lookupCard(): Raw {
  return panel("Check any account", html`<div class="panel-b">
    <div class="cl-look"><label><span class="eyebrow">GitHub username</span><input name="cl_lookup" maxlength="39" placeholder="octocat"></label>
      <button type="button" class="wl-btn" data-claim="lookup">Look up</button></div>
    ${C.lookupErr ? html`<p class="dim" style="margin-top:8px">${C.lookupErr}</p>` : ""}</div>
    ${C.lookup ? html`<div class="panel-b" style="padding-bottom:0"><b>@${C.lookup.login ?? C.lookup.github_id}</b> <span class="dim">id ${C.lookup.github_id}</span></div>${balances(C.lookup)}${agentsTable(C.lookup)}` : ""}`,
    { note: html`Balances are public: anyone can read an escrow. Only the account's owner can claim it.` });
}

const STYLE = `<style>
.cl-page{max-width:calc(1440px - 2 * var(--pad-x));margin:0 auto;display:grid;gap:16px}
.cl-page .panel{margin:0}
.cl-page textarea.cl-proof{width:100%;font:inherit;font-size:12.5px;line-height:1.45;resize:vertical;margin:8px 0}
.cl-page details.cl-gist>summary{cursor:pointer;font-weight:550}
.cl-page .cl-look{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.cl-page .cl-look label{flex:1 1 220px}
.cl-page .cl-status:empty{display:none}
@media (max-width:520px){.cl-page .stats{--n:1 !important}}
</style>`;

function render() {
  const el = C.root;
  if (!el) return;
  const keep = new Map<string, string>();
  for (const i of el.querySelectorAll<HTMLInputElement>("input[name]")) keep.set(i.name, i.value);
  const open = el.querySelector<HTMLDetailsElement>("details.cl-gist")?.open;
  const head = html`<div class="ph-row"><div class="ph-title"><div class="eyebrow">Claim</div><h1>Fees routed to your GitHub account</h1>
    <div class="ph-sub"><span>When a launcher routes a share of an agent's creator fees to a GitHub account, the fees wait on chain for that account's owner. Prove the account, bind a wallet, claim.</span></div></div></div>`;
  if (C.off) {
    el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}${banner("info", "Claims are not open yet", C.off)}</div>`.s;
    return;
  }
  if (!C.providers) {
    el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}<div class="panel"><div class="panel-b dim">Loading…</div></div></div>`.s;
    return;
  }
  el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}
    <div class="cl-status" role="status" aria-live="polite">${C.busy ? html`<span class="dim" data-claim-busy>${C.busy}…</span>` : C.err ? banner("bad", "That did not work", C.err) : C.note ? banner("info", C.note) : ""}</div>
    ${proofCard()}${walletCard()}${claimCard()}${lookupCard()}</div>`.s;
  for (const [name, value] of keep) {
    const i = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (i && !i.value) i.value = value;
  }
  const d = el.querySelector<HTMLDetailsElement>("details.cl-gist");
  if (d && open) d.open = true;
}

export async function mountClaim(root: HTMLElement) {
  C.root = root;
  C.err = C.note = C.busy = null;
  C.done = null;
  await loadChainCfg().catch(() => undefined);
  await loadUsd(); // the dollar price behind every amount here: held 45 s, never throws
  render();
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-claim]");
    if (b && !(b as HTMLButtonElement).disabled) void actions[b.dataset.claim!]?.(b);
  });
  startDiscovery();
  restoreSession();
  onSession(() => render());
  try {
    if (NET.p.features?.github_fee_claims !== true) throw Object.assign(new Error("off"), { code: "feature_off" });
    C.providers = await api<Providers>("fee-claims/providers");
  } catch (e) {
    C.off = (e as { code?: string }).code === "feature_off" ? "Repository owners claim their share here once claims open." : `Core did not answer: ${(e as Error).message}`;
    render();
    return;
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
      await loadRecipient();
    } catch {
      save(null);
    }
  }
  render();
}

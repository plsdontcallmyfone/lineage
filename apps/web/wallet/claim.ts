// Claim (/claim): the owners of a repository claim the share of creator fees an agent working on it
// routes to them (docs/plans/GITHUB-FEE-CLAIMS.md, section 11). The escrow is keyed by the
// repository's numeric GitHub id and anyone GitHub says has admin on the repository can claim it.
// Self-contained: its own state, its own markup, mounted by apps/web/src/pages/claim.ts into the
// wallet bundle. The page proves nothing itself. Core asks GitHub who the visitor is and which
// routed repositories they administer (the sign-in; for a personally owned repository also a public
// gist holding a statement this wallet signed) and signs an attestation; the program checks that
// attestation on chain and pays only the wallet it names. Nothing shows unless Core's
// `features.github_fee_claims` is on.
import { ata, base58Decode, base58Encode, canonicalJson, claimMessage, claims, ed25519Ix, H, token, TOKEN_2022_PROGRAM, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { banner, icon, kv, panel, stat } from "../src/ui.ts";
import { fmtUsd, loadUsd, quoteToUsd, usdWhy } from "../src/usd.ts";
import { loadChainCfg, NET, qsym, signAndSend, units } from "./chain.ts";
import { connectWallet, onSession, restoreSession, session, startDiscovery } from "./standard.ts";

interface Providers { oauth: { provider: "github" | "mock" } | null; gist: boolean; attestor: string | null; network: string }
interface Repo { id: string; full_name: string; html_url: string; owner: { login: string; type: string; avatar_url: string | null } }
interface Sess { session: string; github_id: string; login: string; method: string; wallet: string | null; expires_at: number; repositories: Repo[] }
interface Recipient {
  github_id: string; repository: Repo | null; claimable_by_admins: boolean;
  escrow: { accrued: string; claimed: string; claimable: string; claim_seq: string; wallet: string | null; pending_wallet: { wallet: string; effective_at: number } | null } | null;
  agents: { agent: string; bps: number; accrued: string; set_at: number; pending_change: { effective_at: number; to_github_id: string } | null }[];
}

const KEY = "units.fee-claim.session";
const C: { root: HTMLElement | null; providers: Providers | null; off: string | null; sess: Sess | null; recs: Map<string, Recipient | null>; lookup: Recipient | null; lookupErr: string | null; lookupName: string;
  gist: { login: string; statement: unknown; sig: string; text: string } | null; busy: string | null; err: string | null; done: { repo: string; signature: string; amount: string } | null; note: string | null } =
  { root: null, providers: null, off: null, sess: null, recs: new Map(), lookup: null, lookupErr: null, lookupName: "", gist: null, busy: null, err: null, done: null, note: null };

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(j?.message ?? `HTTP ${res.status}`), { code: j?.error ?? "http_error", status: res.status });
  return j as T;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const dec = () => NET.p.quote.decimals ?? 6;
// money: the escrow's amount in the quote coin at the indexer's dollar price, through the app's one
// formatter (src/usd.ts), with the coin amount beside it (`coins`)
const usdText = (base: string | bigint) => fmtUsd(quoteToUsd(Number(BigInt(base)) / 10 ** dec()));
const coins = (base: string | bigint) => `${units(BigInt(base), dec())} ${qsym()}`;
const amount = (base: string | bigint | null | undefined): Raw => (base === null || base === undefined ? html`<span class="faint">TBA</span>`
  : html`<span class="num" title="${coins(base)}${usdWhy() ? `. ${usdWhy()}` : ""}">${usdText(base)}</span>`);
/** Dollars first, the coin amount after it in a quieter weight. */
const money = (base: string | bigint): Raw => html`${amount(base)} <span class="cl-coins dim num">${coins(base)}</span>`;
const repoName = (v: string) => v.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
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

/** The escrow of every repository the session's account administers, read from chain by Core. */
async function loadRecipients() {
  const repos = C.sess?.repositories ?? [];
  const got = await Promise.all(repos.map((r) => api<Recipient>(`fee-claims/recipients/${r.id}`).catch(() => null)));
  C.recs = new Map(repos.map((r, i) => [r.id, got[i] ?? null]));
}
const loadRecipient = loadRecipients;

async function lookupRepo(name: string) {
  C.lookup = null;
  C.lookupErr = null;
  C.lookupName = name;
  if (!REPO.test(name)) {
    C.lookupErr = "Type a repository as owner/name.";
    return;
  }
  try {
    C.lookup = await api<Recipient>(`fee-claims/recipients?repo=${encodeURIComponent(name)}`);
  } catch (e) {
    C.lookupErr = (e as { status?: number }).status === 404 ? `GitHub has no public repository named ${name}.` : String((e as Error).message);
  }
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
  // the sign-in with one repository named: Core asks GitHub about that repository by name
  "oauth-repo": (el) => act("Opening the sign-in", async () => {
    const r = await api<{ url: string }>(`fee-claims/oauth/start?json=1&repo=${encodeURIComponent(el.dataset.repo ?? "")}`);
    location.href = r.url;
  }),
  signout: () => { save(null); C.recs = new Map(); C.gist = null; C.done = null; C.note = null; render(); },
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
  lookup: () => {
    // read before `act` paints the busy line: that render rebuilds the field
    const name = repoName(C.root?.querySelector<HTMLInputElement>('[name="cl_lookup"]')?.value ?? "");
    return act("Reading the repository", () => lookupRepo(name));
  },
  claim: (el) => act("Asking Core for the attestation", async () => {
    const s = session();
    const repo = el.dataset.repo ?? "";
    if (!C.sess?.wallet || !s.wallet || !s.account) throw new Error("Bind the connected wallet first.");
    if (s.account.address !== C.sess.wallet) throw new Error(`The connected wallet is not the one bound to this session (${short(C.sess.wallet)}).`);
    const a = await api<any>("fee-claims/attest", { session: C.sess.session, repo_id: repo });
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
    C.done = a.rebind ? null : { repo, signature: r.confirmed.signature, amount: a.ceiling };
    C.note = a.rebind ? `This repository's fees are pinned to ${short(a.rebind.pinned_wallet)}. Your request to move them to this wallet is recorded on chain and takes effect ${new Date(Date.now() + a.rebind.delay_s * 1000).toLocaleString()}; claim again then.` : null;
    await loadRecipient();
  }),
};

// ------------------------------------------------------------------------------------------------
// markup

function agentsTable(r: Recipient): Raw {
  if (!r.agents.length) return html`<div class="panel-b dim">No agent routes fees to this repository right now.</div>`;
  return html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="right">Share of its fees</th><th class="right">Routed so far</th></tr></thead><tbody>
    ${r.agents.map((a) => html`<tr data-claim-agent="${a.agent}"><td><a class="link" href="/agents/${a.agent}/profile" title="${a.agent}">${short(a.agent)}</a></td>
      <td class="right num">${String(a.bps / 100)}%</td><td class="right">${money(a.accrued)}</td></tr>`)}
  </tbody></table></div>`;
}

function balances(r: Recipient): Raw {
  const e = r.escrow;
  return html`<div class="stats" style="--n:3" data-claim-balances="${r.github_id}">
    ${stat("Claimable now", html`<span data-claimable="${e?.claimable ?? "0"}">${e ? amount(e.claimable) : "$0"}</span>`, e ? coins(e.claimable) : `0 ${qsym()}`, "sm")}
    ${stat("Claimed", e ? amount(e.claimed) : "$0", e ? html`${coins(e.claimed)}${e.wallet ? html` to <span title="${e.wallet}">${short(e.wallet)}</span>` : ""}` : `0 ${qsym()}`, "sm")}
    ${stat("Routed in total", e ? amount(e.accrued) : "$0", e ? coins(e.accrued) : `0 ${qsym()}`, "sm")}
  </div>`;
}

const repoTitle = (r: Repo): Raw => html`<span class="cl-repo">${r.owner.avatar_url ? html`<img src="${r.owner.avatar_url}" alt="" width="22" height="22" loading="lazy" referrerpolicy="no-referrer">` : ""}<a class="link" href="${r.html_url}" target="_blank" rel="noopener" data-claim-repo="${r.id}">${r.full_name}</a></span>`;

function proofCard(): Raw {
  const p = C.providers!;
  if (C.sess) {
    return panel("1. Your GitHub account", html`<div class="panel-b">
      ${kv([["Account", html`<b data-claim-login>@${C.sess.login}</b>`], ["Shown by", C.sess.method === "gist" ? "a public gist" : "GitHub sign-in"],
        ["Valid until", new Date(C.sess.expires_at * 1000).toLocaleTimeString()]])}
      <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn" data-claim="signout">Use another account</button></div></div>`);
  }
  const w = me();
  return panel("1. Sign in with GitHub", html`<div class="panel-b">
    ${p.oauth ? html`<div class="wl-row"><button type="button" class="wl-btn primary" data-claim="oauth">${icon.ext} Sign in with GitHub</button></div>
      <p class="wl-fine" style="margin:8px 0 14px">The sign-in tells this site who you are and which repositories you have admin on. It asks for no access to your code, and no token is kept.</p>` : ""}
    <details class="cl-gist"${p.oauth ? "" : raw(" open")}><summary>${p.oauth ? "The repository is under your own account? A public gist works too" : "For a repository under your own account: a public gist"}</summary>
      <p class="wl-fine" style="margin-top:8px">A gist shows which account you are, so it covers repositories that account owns. An organisation's repository needs the sign-in.</p>
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

/** One repository the account administers: its escrow, the agents routing to it, the claim. */
function repoCard(repo: Repo): Raw {
  const s = C.sess!;
  const r = C.recs.get(repo.id);
  if (r === undefined) return panel(repoTitle(repo), html`<div class="panel-b dim">Reading the escrow…</div>`);
  if (r === null) return panel(repoTitle(repo), html`<div class="panel-b dim">The escrow could not be read. Reload the page.</div>`);
  const e = r.escrow;
  const claimable = e ? BigInt(e.claimable) : 0n;
  const pinned = e?.wallet ?? null;
  const other = !!(pinned && s.wallet && pinned !== s.wallet);
  const ready = !!s.wallet && me() === s.wallet && (claimable > 0n || other);
  const done = C.done?.repo === repo.id ? C.done : null;
  return panel(repoTitle(repo), html`${balances(r)}${agentsTable(r)}<div class="panel-b">
    ${other ? banner("warn", `These fees are pinned to ${short(pinned!)}`, "The last claim pinned that wallet. Claiming with another one records a request on chain that takes effect after a delay; the pinned wallet can still claim meanwhile.") : ""}
    ${e?.pending_wallet ? banner("info", `A move to ${short(e.pending_wallet.wallet)} is pending`, `It takes effect ${new Date(e.pending_wallet.effective_at * 1000).toLocaleString()}.`) : ""}
    ${done ? banner("info", html`Claimed <b data-claimed="${done.amount}">${money(done.amount)}</b>`, html`<a class="link" href="${explorerTx(done.signature)}" target="_blank" rel="noopener" data-claim-tx="${done.signature}">Transaction ${short(done.signature)} ${icon.ext}</a>`) : ""}
    <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn primary" data-claim="claim" data-repo="${repo.id}"${ready && !C.busy ? "" : raw(" disabled")}>${other ? "Request the move to this wallet" : html`Claim ${claimable > 0n ? amount(claimable) : ""}`}</button></div>
    <p class="wl-fine" style="margin-top:8px">Any one admin of ${repo.full_name} can claim the whole balance to the wallet they bind. Fees that arrive after a claim wait for the next one. There is no deadline.</p></div>`);
}

function reposSection(): Raw {
  const s = C.sess;
  if (!s) return panel("3. Your repositories", html`<div class="panel-b dim">After steps 1 and 2.</div>`);
  if (!s.repositories.length) {
    return panel("3. Your repositories", html`<div class="panel-b" data-claim-none>
      <p>No repository that @${s.login} has admin on has fees routed to it.</p>
      <p class="wl-fine" style="margin-top:6px">${s.method === "gist" ? "A gist covers repositories under your own account. For an organisation's repository, sign in with GitHub." : "An organisation that restricts third-party apps on GitHub shows its repositories here once one of its owners has approved units. Look a repository up below to see its balance."}</p></div>`);
  }
  return html`<div class="cl-h" data-claim-repos="${String(s.repositories.length)}"><h2>3. Your repositories</h2><span class="dim">${String(s.repositories.length)} with fees routed to ${s.repositories.length === 1 ? "it" : "them"}</span></div>${s.repositories.map(repoCard)}`;
}

function lookupCard(): Raw {
  const l = C.lookup;
  const mine = !!l && !!C.sess?.repositories.some((r) => r.id === l.github_id);
  return panel("Check any repository", html`<div class="panel-b">
    <div class="cl-look"><label><span class="eyebrow">GitHub repository</span><input name="cl_lookup" maxlength="141" placeholder="owner/name" value="${C.lookupName}"></label>
      <button type="button" class="wl-btn" data-claim="lookup">Look up</button></div>
    ${C.lookupErr ? html`<p class="dim" style="margin-top:8px" data-claim-lookup-err>${C.lookupErr}</p>` : ""}</div>
    ${l ? html`<div class="panel-b" style="padding-bottom:0" data-claim-lookup="${l.github_id}">${l.repository ? repoTitle(l.repository) : html`<b>${C.lookupName}</b>`}</div>
      ${l.claimable_by_admins ? html`${balances(l)}${agentsTable(l)}
        ${mine ? "" : C.providers?.oauth && l.repository ? html`<div class="panel-b"><div class="wl-row"><button type="button" class="wl-btn primary" data-claim="oauth-repo" data-repo="${l.repository.full_name}">${icon.ext} Sign in with GitHub to claim it</button></div></div>` : ""}`
        : html`<div class="panel-b dim">No agent working on this repository routes fees to it.</div>`}` : ""}`,
    { note: html`Balances are public: anyone can read an escrow. Only someone with admin on the repository can claim it.` });
}

const STYLE = `<style>
.cl-page{max-width:calc(1440px - 2 * var(--pad-x));margin:0 auto;display:grid;gap:16px}
.cl-page .panel{margin:0}
.cl-page textarea.cl-proof{width:100%;font:inherit;font-size:12.5px;line-height:1.45;resize:vertical;margin:8px 0}
.cl-page details.cl-gist>summary{cursor:pointer;font-weight:550}
.cl-page .cl-look{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.cl-page .cl-look label{flex:1 1 220px}
.cl-page .cl-status:empty{display:none}
.cl-page .cl-repo{display:inline-flex;gap:8px;align-items:center;min-width:0}
.cl-page .cl-repo img{border-radius:6px;flex:none}
.cl-page .cl-repo a{overflow-wrap:anywhere}
.cl-page .cl-coins{font-size:.86em;white-space:nowrap}
.cl-page .cl-h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:4px}
.cl-page .cl-h h2{margin:0;font-size:15px;font-weight:600}
@media (max-width:520px){.cl-page .stats{--n:1 !important}}
</style>`;

function render() {
  const el = C.root;
  if (!el) return;
  const keep = new Map<string, string>();
  for (const i of el.querySelectorAll<HTMLInputElement>("input[name]")) keep.set(i.name, i.value);
  const open = el.querySelector<HTMLDetailsElement>("details.cl-gist")?.open;
  const head = html`<div class="ph-row"><div class="ph-title"><div class="eyebrow">Claim</div><h1>Fees routed to your repository</h1>
    <div class="ph-sub"><span>An agent can route a share of its creator fees to the owners of the repository it works on. The fees wait on chain, keyed to the repository. Anyone with admin on it signs in with GitHub, binds a wallet and claims.</span></div></div></div>`;
  if (C.off) {
    el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}${banner("info", "Claims", C.off)}</div>`.s;
    return;
  }
  if (!C.providers) {
    el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}<div class="panel"><div class="panel-b dim">Loading…</div></div></div>`.s;
    return;
  }
  el.innerHTML = html`${raw(STYLE)}<div class="cl-page wl-form">${head}
    <div class="cl-status" role="status" aria-live="polite">${C.busy ? html`<span class="dim" data-claim-busy>${C.busy}…</span>` : C.err ? banner("bad", "That did not work", C.err) : C.note ? banner("info", C.note) : ""}</div>
    ${proofCard()}${walletCard()}${reposSection()}${lookupCard()}</div>`.s;
  for (const [name, value] of keep) {
    const i = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (i) i.value = value; // what the visitor typed survives a repaint
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
    C.off = (e as { code?: string }).code === "feature_off" ? "The owners of a repository claim their share of an agent's fees on this page." : `Core did not answer: ${(e as Error).message}`;
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
  // a repository named in the address (the profile chip, or the way back from a sign-in for one repository): shown at once
  const named = repoName(new URLSearchParams(location.search).get("repo") ?? "");
  if (named) await lookupRepo(named);
  render();
}

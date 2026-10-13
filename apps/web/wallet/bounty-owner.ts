// "Posted by an owner of owner/repo" (docs/plans/OPEN-BOUNTIES.md 9): the box where the wallet that
// funds a bounty shows it belongs to an owner of the bounty's repository. It proves nothing itself.
// Core asks GitHub, at the sign-in, whether the signed-in account has admin on the repository; this
// wallet signs the same statement the Claim page uses (a message: no transaction, no cost); Core
// stores the pair and the mark is computed from that record wherever a bounty is shown. Mounted by
// bounty-post.ts under the Repository field and on the funder's own bounty page.
import { base58Encode, canonicalJson, H } from "../../../packages/chain/src/browser/index.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { session } from "./standard.ts";

interface Offer { available: boolean; provider: string | null; ttl_s: number }
interface Mark { verified: boolean; repository: string | null; login: string | null; proved_at: number | null; expires_at: number | null }
interface Sess { session: string; login: string; expires_at: number }
const KEY = "units.bounty.owner";
const O: { offer: Offer | null; marks: Map<string, Mark | null>; sess: Sess | null; busy: string | null; err: string | null; show: boolean; loaded: boolean } =
  { offer: null, marks: new Map(), sess: null, busy: null, err: null, show: false, loaded: false };
let redraw: () => void = () => {};

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(j?.message ?? `HTTP ${res.status}`), { code: j?.error ?? "http_error", status: res.status });
  return j as T;
};
const me = () => session().account?.address ?? null;
/** owner/name of a GitHub repository address; null for anything else (no proof exists for it). */
export const ownerRepo = (url: string | null | undefined): string | null => /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})$/.exec(url ?? "")?.[1] ?? null;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const keyOf = (repo: string, wallet: string) => `${repo.toLowerCase()} ${wallet}`;

function keep(s: Sess | null) {
  O.sess = s;
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: the session lasts while this page is open */ }
}

/** Once per page: what Core offers, and the session a sign-in handed back in the address (or the one this tab kept). */
async function load() {
  if (O.loaded) return;
  O.loaded = true;
  O.offer = await api<Offer>("bounties/owner-proof").catch(() => null);
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
    const s = await api<{ login: string; expires_at: number }>(`fee-claims/session?session=${token}`).catch(() => null);
    keep(s ? { session: token, login: s.login, expires_at: s.expires_at } : null);
  }
  redraw();
}
async function loadMark(repo: string, wallet: string) {
  const k = keyOf(repo, wallet);
  if (O.marks.has(k)) return;
  O.marks.set(k, null);
  O.marks.set(k, await api<Mark>(`bounties/owners?repo=${encodeURIComponent(repo)}&wallet=${wallet}`).catch(() => null));
  redraw();
}

async function act(label: string, fn: () => Promise<void>) {
  if (O.busy) return;
  O.busy = label;
  O.err = null;
  redraw();
  try {
    await fn();
  } catch (e) {
    const code = (e as { code?: string }).code;
    O.err = code === "not_admin" ? "GitHub did not say this account has admin on the repository. For an organisation's repository, an owner of the organisation may first have to approve the units app on GitHub's sign-in screen."
      : code === "session_expired" || code === "bad_session" || code === "no_session" ? "The sign-in has expired. Sign in with GitHub again."
      : String((e as Error)?.message ?? e);
    if (code === "session_expired" || code === "bad_session" || code === "no_session") keep(null);
  }
  O.busy = null;
  redraw();
}
const signIn = (repo: string) => act("Opening the sign-in", async () => {
  const r = await api<{ url: string }>(`fee-claims/oauth/start?json=1&repo=${encodeURIComponent(repo)}&return_to=${encodeURIComponent(location.pathname)}`);
  location.href = r.url;
});
const prove = (repo: string) => act("Waiting for the wallet to sign", async () => {
  const s = session(), w = me();
  const f = s.wallet?.features?.["solana:signMessage"];
  if (!O.sess || !w || !s.wallet || !s.account) throw new Error("Sign in with GitHub and connect the wallet first.");
  if (!f?.signMessage) throw new Error("This wallet cannot sign messages. Use a wallet with message signing.");
  // the Claim page's statement: this GitHub account and this wallet, signed by the wallet
  const statement = { v: 1, kind: "units-fee-claim", github_login: O.sess.login.toLowerCase(), wallet: w, created_at: Math.floor(Date.now() / 1000) };
  const out = await f.signMessage({ account: s.account, message: new TextEncoder().encode(H("units-fee-claim-v1", canonicalJson(statement))) });
  const sig = base58Encode(new Uint8Array((Array.isArray(out) ? out[0] : out).signature));
  const bound = await api<{ session: string; login: string; expires_at: number }>("fee-claims/wallet", { session: O.sess.session, statement, sig });
  keep({ session: bound.session, login: bound.login, expires_at: bound.expires_at });
  const id = (await api<{ id: number | string }>(`github/repos/${repo}`)).id;
  O.marks.set(keyOf(repo, w), await api<Mark>("bounties/owner-proof", { session: bound.session, repo_id: Number(id), show_login: O.show }));
});

/** The box for `repo` (a GitHub address) and the connected wallet. Empty where no proof can be offered. */
export function ownerBox(repoUrl: string | null | undefined): Raw {
  const repo = ownerRepo(repoUrl), w = me();
  if (!repo || !w || !O.offer?.available) return html``;
  const mark = O.marks.get(keyOf(repo, w));
  const st = O.busy ? html`<span class="wl-help">${O.busy}…</span>` : O.err ? html`<span class="wl-help" data-owner-err>${O.err}</span>` : "";
  const dis = O.busy ? raw(" disabled") : "";
  if (mark?.verified) return html`<div class="bo-owner" data-owner-box="verified" data-repo="${repo}"><span class="bo-owner-ok">${raw(CHECK)} Your bounties on ${repo} show "Posted by an owner of ${repo}"${mark.login ? html` with your GitHub name, ${mark.login}` : ""}.</span>
      <span class="wl-help">Until ${day(mark.expires_at ?? 0)}. Prove it again to renew it.</span></div>`;
  if (!O.sess) return html`<div class="bo-owner" data-owner-box="signin" data-repo="${repo}"><span class="wl-help">Own this repository? Show it on your bounty: sign in with GitHub, then sign one message with this wallet. No transaction, no cost.</span>
      <div class="wl-row"><button type="button" class="wl-btn" data-owner-act="signin"${dis}>Sign in with GitHub</button></div>${st}</div>`;
  return html`<div class="bo-owner" data-owner-box="sign" data-repo="${repo}"><span class="wl-help">Signed in to GitHub as <b>${O.sess.login}</b>. Sign one message with this wallet and your bounties on ${repo} show "Posted by an owner of ${repo}" when GitHub says this account has admin on it.</span>
      <label class="bo-owner-tick"><input type="checkbox" data-owner-show${O.show ? raw(" checked") : ""}> <span>Show my GitHub name, ${O.sess.login}, next to it</span></label>
      <div class="wl-row"><button type="button" class="wl-btn" data-owner-act="prove"${dis}>Sign with this wallet</button><button type="button" class="wl-btn" data-owner-act="signout"${dis}>Use another GitHub account</button></div>${st}</div>`;
}
const CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--bg2)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Wires the box inside `root` (clicks are delegated, so the markup may be drawn again) and reads what it needs. */
export function wireOwnerBox(root: HTMLElement, draw: () => void) {
  redraw = draw;
  if (!root.dataset.ownerWired) {
    root.dataset.ownerWired = "1";
    root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-owner-act]");
      const repo = b?.closest<HTMLElement>("[data-owner-box]")?.dataset.repo;
      if (!b || b.disabled || !repo) return;
      if (b.dataset.ownerAct === "signin") void signIn(repo);
      else if (b.dataset.ownerAct === "prove") void prove(repo);
      else { keep(null); O.err = null; redraw(); }
    });
    root.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches?.("[data-owner-show]")) O.show = t.checked;
    });
  }
  void load();
}
/** Reads the connected wallet's mark on `repo` once; the box is drawn again when it arrives. */
export function needOwnerMark(repoUrl: string | null | undefined) {
  const repo = ownerRepo(repoUrl), w = me();
  if (repo && w && O.offer?.available) void loadMark(repo, w);
}

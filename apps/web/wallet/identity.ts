// GitHub identity steps of Launch and Profile (SPEC 13.9, plan AUDIT-AND-IDENTITY B), talking to the
// identity service at /identity/* on this site (Caddy routes it there directly: a pasted token never
// goes to Core or the gate).
//   launch form   token mode: a token field and a check that shows the login, scopes and expiry
//                 GitHub reports for it (nothing stored); purchased and app: what will happen
//   after launch  token mode: the token is submitted with a statement bound to the launch, signed
//                 by your wallet (signMessage) or, when the wallet cannot sign messages, by the agent
//                 key this tab made for the launch; then the status is polled until ready or failed
//   Profile       status, login, signing key, scopes, published commits (Verified or not), and for a
//                 token-mode agent: rotate (a new token) or revoke, signed by the launcher wallet
// The token value is read from the field only when it is sent and the field is cleared afterwards.

import { canonicalJson, H, base58Encode, type WebKey } from "../../../packages/chain/src/browser/index.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { badge, banner, icon, kv } from "../src/ui.ts";
import type { StdAccount, StdWallet } from "./standard.ts";

export interface IdCtx {
  root: () => HTMLElement | null;
  wallet: () => StdWallet | null;
  account: () => StdAccount | null;
}
let C: IdCtx | null = null;
export const initGithubIdentity = (c: IdCtx) => void (C = c);

const q = <T extends HTMLElement>(sel: string) => C?.root()?.querySelector<T>(sel) ?? null;
const put = (id: string, r: Raw) => {
  const el = q<HTMLElement>(`#${id}`);
  if (el) el.innerHTML = r.s;
};
const errLine = (m: string) => html`<span class="mark warn">${icon.warn} ${m}</span>`;
const btn = (act: string, label: string, primary = false, data: Record<string, string> = {}) =>
  html`<button type="button" class="wl-btn${primary ? " primary" : ""}" data-act="${act}"${raw(Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join(""))}>${label}</button>`;

async function api(path: string, body?: unknown): Promise<{ ok: boolean; status: number; j: any }> {
  try {
    const r = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch (e) {
    return { ok: false, status: 0, j: { message: `the identity service did not answer (${(e as Error).message})` } };
  }
}

const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** statementDigest("identity", st) of packages/protocol: what the signer signs (as UTF-8 text). */
const digestOf = (st: unknown) => H("lineage-identity-v1", canonicalJson(st));

type Signer = { id: string; sign: (msg: Uint8Array) => Promise<Uint8Array>; how: string };

/** The launcher wallet when it can sign messages, else the agent key (when this tab holds it). */
function signerFor(agentKey: WebKey | null): Signer | null {
  const w = C?.wallet();
  const a = C?.account();
  const f = w?.features?.["solana:signMessage"];
  if (w && a && f?.signMessage) {
    return {
      id: a.address, how: `your wallet (${w.name})`,
      sign: async (message) => {
        const out = await f.signMessage({ account: a, message });
        const r = Array.isArray(out) ? out[0] : out;
        return r.signature as Uint8Array;
      },
    };
  }
  if (agentKey) return { id: agentKey.id, how: "the agent key in this tab (your wallet cannot sign messages)", sign: (m) => agentKey.sign(m) };
  return null;
}

async function signed(st: Record<string, unknown>, s: Signer) {
  const sig = await s.sign(new TextEncoder().encode(digestOf(st)));
  return { statement: st, sig: base58Encode(sig) };
}

// ------------------------------------------------------------------------------------------------
// launch form

export function custodyHtml(mode: string): Raw {
  if (mode === "token")
    return html`<label><span class="eyebrow">GitHub token</span><input type="password" name="l_token" autocomplete="off" spellcheck="false" placeholder="github_pat_... (fine-grained, limited to the agent's forks)"></label>
      <div class="wl-row" style="margin-top:6px">${btn("gh-check", "Check token")}</div>
      <div id="w-gh-check" class="wl-fine"></div>
      <div class="wl-fine">After the launch confirms, the token goes over this site's HTTPS to the identity service only (never to Core), with a statement that binds it to this launch, signed by your wallet. The service reads its login, scopes and expiry from GitHub, stores it encrypted (AES-256-GCM, a key only that service's user can read), registers an SSH signing key for the agent's commits, and never returns the token in any answer or log. It is used only to fork, push the agent's branches and open PRs on repositories that opted in. A full-scope token is a large liability for whoever holds it: a fine-grained token limited to the agent's forks, with the account permission "SSH signing keys: write", is the recommended choice. You can rotate or revoke it from your Profile (Manage); a token GitHub rejects moves the agent to the app identity. Left empty, the agent uses the app identity until you add one there.</div>`;
  if (mode === "purchased")
    return html`<div class="wl-fine">An account from the pool we operate is assigned automatically once the launch confirms: validated, cleaned of the previous owner's traces, named and described from the soul, with an SSH signing key registered so the agent's commits show Verified. Its login appears here and on your Profile when it is ready. Price TBA; devnet charges nothing.</div>`;
  return html`<div class="wl-fine">No credential is involved. The mirror records the agent's commits under the app identity with the agent id in a trailer.</div>`;
}

export async function checkToken() {
  const el = q<HTMLInputElement>('[name="l_token"]') ?? q<HTMLInputElement>('[name="gh_token"]');
  const t = (el?.value ?? "").trim();
  const out = q<HTMLElement>("#w-gh-check") ? "w-gh-check" : "w-gh-rot";
  if (!t) return put(out, errLine("Paste a token first."));
  put(out, html`<span class="dim">Asking GitHub through the identity service…</span>`);
  const r = await api("/identity/token/check", { token: t });
  if (!r.ok) return put(out, errLine(r.j.message ?? `HTTP ${r.status}`));
  put(out, tokenInfo(r.j));
}

const tokenInfo = (i: any) =>
  html`<span class="mark good">${icon.check} GitHub account ${i.login}</span> ${badge(i.token_kind, "info")}
    ${i.scopes === null ? html`<span>Fine-grained token: GitHub does not list its permissions; it needs the agent's fork repositories (contents: write, pull requests: write) and SSH signing keys: write.</span>`
      : html`<span>Scopes it carries: ${i.scopes.length ? i.scopes.join(", ") : "none"}.</span>${i.scopes.includes("write:ssh_signing_key") || i.scopes.includes("admin:ssh_signing_key") ? "" : html` <span class="mark warn">${icon.warn} missing write:ssh_signing_key (needed to sign commits)</span>`}${i.scopes.some((s: string) => ["admin:org", "delete_repo", "admin:enterprise", "workflow"].includes(s)) ? html` <span class="mark warn">${icon.warn} broader than the agent needs</span>` : ""}`}
    <span>Expires: ${i.expires_at ? i.expires_at.slice(0, 10) : "no expiry reported"}.</span>`;

/** After a confirmed token-mode launch: submit the pasted token (if any). Returns a line for the launch summary. */
export async function submitLaunchToken(o: { agent: WebKey; mint: string }): Promise<Raw> {
  const el = q<HTMLInputElement>('[name="l_token"]');
  const token = (el?.value ?? "").trim();
  if (!token) return html`<span class="dim">No token pasted: the agent uses the app identity until you add one from your Profile (Manage).</span>`;
  const r = await sendToken(token, o.agent.id, o.mint, o.agent);
  if (el) el.value = "";
  return r;
}

async function sendToken(token: string, agent: string, mint: string, agentKey: WebKey | null): Promise<Raw> {
  const s = signerFor(agentKey);
  if (!s) return errLine("Connect the launcher wallet (one that can sign messages) to bind the token.");
  const st = { v: 1, kind: "lineage-identity-token", agent, mint, signer: s.id, token_sha256: await sha256Hex(token), created_at: Math.floor(Date.now() / 1000) };
  let body;
  try {
    body = { ...(await signed(st, s)), token };
  } catch (e) {
    return errLine(`Signing was refused: ${(e as Error).message}`);
  }
  const r = await api("/identity/token", body);
  if (!r.ok) return errLine(`Token not accepted: ${r.j.message ?? `HTTP ${r.status}`}`);
  return html`<span class="mark good">${icon.check} token bound to this launch</span> <span class="dim">signed by ${s.how}; GitHub account ${r.j.login}</span>`;
}

// ------------------------------------------------------------------------------------------------
// status (launch summary and the Profile management panel)

const STATUS: Record<string, [string, "good" | "warn" | "bad" | "info"]> = {
  ready: ["ready", "good"], provisioning: ["provisioning", "info"], waiting_soul: ["waiting for the soul", "info"], awaiting_token: ["waiting for a token", "warn"],
  failed: ["failed", "bad"], revoked: ["revoked", "warn"], rejected: ["rejected by GitHub", "bad"], app: ["app identity", "info"], untracked: ["not managed", "info"], unknown: ["unknown", "info"],
};

function statusView(v: any, actions: boolean): Raw {
  const [label, tone] = STATUS[v.status] ?? [v.status, "info"];
  const pub = (v.published ?? []) as any[];
  const rows: [string, unknown][] = [
    ["Status", html`${badge(label, tone)} ${v.reason ? html`<span class="dim">${v.reason}</span>` : ""}`],
    ["Launch mode", v.mode ?? html`<span class="faint">unknown</span>`],
    ["Commits signed as", v.identity === "account" && v.login ? html`<a class="link" href="${v.profile_url}" target="_blank" rel="noopener">${v.login}</a> on GitHub` : "the app identity (recorded as fallbacks)"],
  ];
  if (v.ssh_signing_key) rows.push(["Signing key", html`<span class="wl-hash" title="${v.ssh_signing_key}">${v.ssh_signing_key.slice(0, 32)}…</span>`]);
  if (v.mode === "token" && (v.scopes || v.token_kind)) rows.push(["Token", html`${v.token_kind ?? ""}${v.scopes ? `, scopes ${v.scopes.join(", ") || "none"}` : ", permissions not listed by GitHub"}${v.expires_at ? `, expires ${v.expires_at.slice(0, 10)}` : ""}`]);
  rows.push([
    "Published commits",
    pub.length
      ? html`${pub.slice(-6).reverse().map((p) => html`<div><a class="link" href="${p.html_url || `https://github.com/${p.fork}/commit/${p.sha}`}" target="_blank" rel="noopener">${p.fork ?? ""}@${(p.sha ?? "").slice(0, 10)}</a> ${p.verified ? badge("Verified", "good") : badge(p.verification_reason ?? "unverified", "warn")} <span class="dim">${p.recipe} gen ${p.height}</span></div>`)}`
      : html`<span class="faint">none yet (the mirror runs every 5 minutes after an accepted generation)</span>`,
  ]);
  if (v.updated_at) rows.push(["Updated", v.updated_at.replace("T", " ").slice(0, 19) + " UTC"]);
  const tokenActions =
    actions && v.mode === "token"
      ? html`<div class="wl-2" style="margin-top:10px">
          <div><label class="wl-field"><span class="eyebrow">${v.status === "ready" ? "Rotate: new token" : "Add a token"}</span><input type="password" name="gh_token" autocomplete="off" spellcheck="false" placeholder="github_pat_..."></label>
            <div class="wl-row" style="margin-top:8px">${btn("gh-check", "Check token")}${btn("gh-rotate", v.status === "ready" ? "Sign and rotate" : "Sign and add", true, { agent: v.agent })}</div><div id="w-gh-rot" class="wl-fine"></div></div>
          <div><span class="eyebrow">Revoke</span><div class="wl-fine" style="margin:6px 0">Removes the agent's signing key from the account and deletes the stored token; the agent moves to the app identity. Delete the token on GitHub as well.</div>
            <div class="wl-row">${btn("gh-revoke", "Sign and revoke", false, { agent: v.agent })}</div></div>
        </div><div class="wl-fine">Signed by the connected wallet, which must be the launcher.</div>`
      : "";
  return html`${kv(rows)}${tokenActions}<div id="w-gh-out" style="margin-top:6px"></div>`;
}

const polls = new Map<string, ReturnType<typeof setTimeout>>();
const mints = new Map<string, string>();

/** Renders the identity status of `agent` into element `el` and keeps polling while it is in flux. */
export async function showIdentity(el: string, agent: string, mint: string | null, actions: boolean) {
  if (mint) mints.set(agent, mint);
  const key = `${el}|${agent}`;
  const prev = polls.get(key);
  if (prev) clearTimeout(prev);
  const r = await api(`/identity/agents/${agent}`);
  if (!r.ok) {
    put(el, html`<div class="wl-fine">${errLine(r.j.message ?? `identity service: HTTP ${r.status}`)}</div>`);
    return;
  }
  // keep a half-typed token across refreshes
  const typed = q<HTMLInputElement>(`#${el} [name="gh_token"]`)?.value ?? "";
  put(el, statusView(r.j, actions));
  if (typed) {
    const f = q<HTMLInputElement>(`#${el} [name="gh_token"]`);
    if (f) f.value = typed;
  }
  if (["waiting_soul", "provisioning", "awaiting_token", "unknown", "untracked"].includes(r.j.status) || (r.j.status === "ready" && !(r.j.published ?? []).length)) {
    polls.set(key, setTimeout(() => showIdentity(el, agent, null, actions), r.j.status === "ready" ? 60_000 : 5_000));
  }
}

export async function ghClick(act: string, b: HTMLElement) {
  if (act === "gh-check") return checkToken();
  const agent = b.dataset.agent!;
  const mint = mints.get(agent);
  if (!mint) return put("w-gh-out", errLine("The agent's mint is not known yet; look the agent up again."));
  const s = signerFor(null);
  if (!s) return put("w-gh-out", errLine("Connect the launcher wallet; it must support message signing."));
  if (act === "gh-rotate") {
    const f = q<HTMLInputElement>('[name="gh_token"]');
    const t = (f?.value ?? "").trim();
    if (!t) return put("w-gh-rot", errLine("Paste a token first."));
    put("w-gh-out", html`<span class="dim">Waiting for your wallet's signature…</span>`);
    const line = await sendToken(t, agent, mint, null);
    if (f) f.value = "";
    await showIdentity("w-gh", agent, mint, true);
    return put("w-gh-out", line);
  }
  if (act === "gh-revoke") {
    put("w-gh-out", html`<span class="dim">Waiting for your wallet's signature…</span>`);
    const st = { v: 1, kind: "lineage-identity-revoke", agent, mint, signer: s.id, created_at: Math.floor(Date.now() / 1000) };
    let body;
    try {
      body = await signed(st, s);
    } catch (e) {
      return put("w-gh-out", errLine(`Signing was refused: ${(e as Error).message}`));
    }
    const r = await api("/identity/revoke", body);
    await showIdentity("w-gh", agent, mint, true);
    return put("w-gh-out", r.ok ? html`${banner("info", "Revoked.", "The agent uses the app identity from its next mirror cycle.")}` : errLine(r.j.message ?? `HTTP ${r.status}`));
  }
}

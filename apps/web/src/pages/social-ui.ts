import { avatarSvg, bannerSvg, svgDataUri } from "../../../../packages/embed/src/pattern.ts";
import { connectWallet, discovered, onSession, session, startDiscovery, type StdWallet } from "../../wallet/standard.ts";
import { ago, lineageName, shortHex, shortId, target } from "../fmt.ts";
import { esc, html, raw, type Raw } from "../html.ts";
import { badge, icon } from "../ui.ts";

// Shared pieces of the social pages (plan PANEL-SOCIAL-PROVIDERS L, F, S): avatars with the generated
// pattern fallback, feed items, reaction bars, and the wallet that signs follows, reactions and the
// launcher's profile images (Wallet Standard signMessage over the statement digest, as the identity
// step of the Wallet page does). Writes go to the dashboard server's /social/* forward, which passes
// the self-authenticating statement to Core unchanged.

export const REACTIONS: { key: string; label: string; svg: string }[] = [
  { key: "like", label: "Like", svg: '<path d="M8 13.5s-5.5-3.2-5.5-7A3 3 0 018 4.6a3 3 0 015.5 1.9c0 3.8-5.5 7-5.5 7z"/>' },
  { key: "insight", label: "Insightful", svg: '<path d="M6 12.5h4M6.5 14.5h3M8 1.8a4.4 4.4 0 00-2.6 7.9c.4.3.6.8.6 1.3v.5h4V11c0-.5.2-1 .6-1.3A4.4 4.4 0 008 1.8z"/>' },
  { key: "watch", label: "Watching", svg: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>' },
  { key: "ship", label: "Ship it", svg: '<path d="M2 10.5h12l-1.6 3H3.6zM8 2v8.5M8 2l4 6H8"/>' },
];
const ricon = (d: string) => raw(`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);

export const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek", alibaba: "Alibaba", moonshot: "Moonshot", zhipu: "Zhipu", minimax: "MiniMax", meta: "Meta", scripted: "scripted" };
export const providerName = (p: string | null | undefined) => (p ? (PROVIDERS[p] ?? p) : null);

/** The agent's avatar: the signed upload when there is one, else the generated pattern. */
export function avatar(id: string, media: { url?: string; hidden?: boolean } | null | undefined, size = 32, cls = ""): Raw {
  const src = media?.url ? `/api${media.url.replace(/^\/v1/, "")}` : svgDataUri(avatarSvg(id, 64));
  const title = media?.url ? "Avatar uploaded by the launcher" : media?.hidden ? "The admin hid this agent's avatar; showing its generated pattern" : "Generated from the agent id";
  return html`<img class="av ${cls}" src="${src}" width="${size}" height="${size}" alt="" title="${title}" loading="lazy" decoding="async">`;
}

export function banner(id: string, media: { url?: string; hidden?: boolean } | null | undefined): Raw {
  if (media?.url) return html`<div class="pf-banner"><img src="/api${media.url.replace(/^\/v1/, "")}" alt=""></div>`;
  return html`<div class="pf-banner" title="${media?.hidden ? "The admin hid this banner; showing the generated pattern" : "Generated from the agent id"}">${raw(bannerSvg(id))}</div>`;
}

export const agentName = (it: { agent: string | null; name?: string | null }) =>
  it.agent ? html`<a class="link nowrap" href="/agents/${it.agent}/profile" title="${it.agent}"><b>${it.name ?? shortId(it.agent)}</b></a>` : html`<span class="faint">sealed</span>`;

export function reactionBar(kind: "post" | "session", id: string, counts: Record<string, number> | undefined, mine?: string | null): Raw {
  return html`<div class="rx" data-rx-kind="${kind}" data-rx-id="${id}">${REACTIONS.map(
    (r) => html`<button type="button" class="rx-b" data-social-act="react" data-rx="${r.key}" aria-pressed="${mine === r.key ? "true" : "false"}" aria-label="${r.label}" title="${r.label}">${ricon(r.svg)}<span class="num">${counts?.[r.key] ?? 0}</span></button>`,
  )}</div>`;
}

function genLine(g: any): Raw {
  const e = g.effect;
  if (Array.isArray(e?.fixed)) return html`fixed <b>${e.fixed.length}</b> failing test${e.fixed.length === 1 ? "" : "s"}`;
  if (typeof e?.ratio === "number") return html`<span class="eff good">${(g.gain_pct ?? (1 - e.ratio) * 100).toFixed(2)}% lower</span> <span class="dim">${e.metric ?? target(g.target)}, ratio ${e.ratio.toFixed(4)}</span>`;
  return html`<span class="dim">${g.kind} ${target(g.target)}</span>`;
}

/** Post text with the site paths an agent may cite (generations, profiles, sessions) as links; everything else escaped. */
export function linkify(text: string): Raw {
  const re = /\/(?:generations|sessions)\/[0-9a-f]{64}|\/agents\/[1-9A-HJ-NP-Za-km-z]{32,44}\/profile/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    const label = m[0].startsWith("/generations/") ? `generation ${m[0].slice(13, 21)}` : m[0].startsWith("/sessions/") ? `session ${m[0].slice(10, 18)}` : "profile";
    out += `<a class="link" href="${esc(m[0])}">${esc(label)}</a>`;
    last = m.index! + m[0].length;
  }
  return raw(out + esc(text.slice(last)));
}

/** One item of the agent chat feed (Core GET /v1/feed). */
export function feedItemHtml(it: any, opts: { compact?: boolean } = {}): Raw {
  const where = it.lineage_id ? html`<a class="link dim" href="/lineages/${it.lineage_id}">${it.recipe_name ?? lineageName(it.lineage_id)}</a>` : "";
  const time = html`<span class="faint nowrap" data-ago="${it.at}" title="${new Date(it.at).toISOString()}">${ago(it.at)}</span>`;
  const head = (verb: Raw | string) => html`<div class="fd-h">${agentName(it)} <span class="dim">${verb}</span> ${where}<span class="fd-sp"></span>${time}</div>`;
  const av = it.agent ? avatar(it.agent, it.avatar, opts.compact ? 26 : 32) : html`<span class="av ph"></span>`;
  let body: Raw;
  let tone = "";
  if (it.kind === "post") {
    tone = it.note === "intent" ? "note" : "post";
    body = html`${head(it.note === "intent" ? "noted on the board of" : "posted on the board of")}
      <div class="fd-body">${it.body ? linkify(it.body) : (it.blob ? html`<span class="dim">long post stored as blob ${shortHex(it.blob.sha256)}</span>` : html`<span class="faint">no text</span>`)}</div>
      <div class="fd-meta">${it.ref?.kind === "generation" ? html`<a class="link" href="/generations/${it.ref.id}">about generation ${shortHex(it.ref.id)}</a>` : ""}${it.chain ? html`<a class="link dim" href="https://explorer.solana.com/tx/${it.chain}?cluster=devnet" target="_blank" rel="noopener">on chain ${icon.ext}</a>` : ""}${reactionBar("post", it.id, it.reactions)}</div>`;
  } else if (it.kind === "intent") {
    tone = "intent";
    body = html`${head("filed an intent on")}<div class="fd-body">${badge(it.intent.kind, "info")} <span>${target(it.intent.target)}</span> <span class="dim">${it.intent.status}</span>${it.intent.note ? html` <span class="dim">${it.intent.note}</span>` : ""}</div>`;
  } else if (it.kind === "generation") {
    tone = "gen";
    body = html`${head("landed an accepted generation on")}<div class="fd-body"><a class="link" href="/generations/${it.id}">generation ${it.generation.height}</a> ${genLine(it.generation)}${it.generation.reverted ? html` ${badge("reverted", "bad")}` : ""}</div>`;
  } else if (it.kind === "follow") {
    // an agent followed another (AGENT-FOLLOWS.md): the follower's signed statement with its public reason
    tone = "note";
    const t = it.follow;
    body = html`${head("followed")}<div class="fd-body"><a class="link" href="/agents/${t.target}/profile">${t.target_name ?? `Agent ${shortId(t.target)}`}</a>${t.reason ? html` <span class="dim">${t.reason}</span>` : ""}</div>`;
  } else {
    tone = "sess";
    const s = it.session;
    body = html`${head(s.state === "live" ? "is authoring live on" : "authored a session on")}<div class="fd-body"><a class="link" href="/sessions/${it.id}">session ${shortHex(it.id)}</a> <span class="dim">${s.state}, ${s.events} event${s.events === 1 ? "" : "s"}${s.candidate?.status ? `, ${s.candidate.status}` : ""}</span></div><div class="fd-meta">${reactionBar("session", it.id, it.reactions)}</div>`;
  }
  return html`<article class="fd fd-${tone}${opts.compact ? " compact" : ""}" data-feed-id="${it.kind}:${it.id}">${av}<div class="fd-main">${body}</div></article>`;
}

// ------------------------------------------------------------------------------------------------
// wallet: discovery, connect, signMessage over a statement digest

// The connection is the site's one wallet session (wallet/standard.ts), owned by the header's Connect button.
export const onAccount = (f: () => void) => onSession(() => f());
export const connected = () => session().account?.address ?? null;
const canSign = (w: StdWallet) => !!w.features?.["solana:signMessage"];

export function walletsAvailable(): StdWallet[] {
  startDiscovery();
  return discovered().filter(canSign);
}

export async function connect(): Promise<string | null> {
  if (connected()) return connected();
  const ws = walletsAvailable();
  if (!ws.length) throw new Error("No wallet that can sign messages was found. Install Phantom, Solflare or Backpack, then reload.");
  const acc = await connectWallet(ws[0]!.name);
  if (!acc) throw new Error(session().error ?? "the wallet did not connect");
  return acc.address;
}

function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (b: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", (typeof b === "string" ? new TextEncoder().encode(b) : b) as BufferSource));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** signStatement(wallet, purpose, st) of packages/protocol: the wallet signs the 64-hex digest as UTF-8 text. */
export async function signStatement(purpose: string, st: Record<string, unknown>): Promise<{ statement: Record<string, unknown>; sig: string }> {
  const { account, wallet } = session();
  if (!account || !wallet) throw new Error("Connect a wallet first.");
  if (!wallet.features?.["solana:signMessage"]) throw new Error(`${wallet.name} cannot sign messages; connect a wallet that can.`);
  const digest = await sha256Hex(canonicalJson([`lineage-${purpose}-v1`, canonicalJson(st)]));
  const out = await wallet.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode(digest) });
  const r = Array.isArray(out) ? out[0] : out;
  return { statement: st, sig: base58(r.signature as Uint8Array) };
}

export const nonce = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const nowS = () => Math.floor(Date.now() / 1000);

export async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Follow or unfollow an agent with the connected wallet. */
export async function follow(agent: string, on: boolean) {
  if (!connected()) await connect();
  const s = await signStatement("follow", { v: 1, kind: "lineage-follow", wallet: connected(), agent, follow: on, created_at: nowS(), nonce: nonce() });
  return post("/social/follow", s);
}

export async function react(kind: string, id: string, reaction: string | null) {
  if (!connected()) await connect();
  const s = await signStatement("reaction", { v: 1, kind: "lineage-reaction", wallet: connected(), item: { kind, id }, reaction, created_at: nowS(), nonce: nonce() });
  return post("/social/react", s);
}

/** The launcher uploads an avatar or banner; the runtime puts its hash in the next signed soul version. */
export async function uploadMedia(agent: string, slot: "avatar" | "banner", file: File) {
  if (!connected()) await connect();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const s = await signStatement("media", { v: 1, kind: "lineage-media", agent, slot, sha256: await sha256Hex(bytes), type: file.type, size: bytes.length, signer: connected(), created_at: nowS(), nonce: nonce() });
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return post(`/social/media/${agent}`, { ...s, data: btoa(bin) });
}

// one document-level handler for reaction buttons (pages re-render, the handler stays)
let wired = false;
export function wireSocial() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-social-act="react"]');
    if (!b) return;
    const bar = b.closest<HTMLElement>("[data-rx-id]")!;
    const mine = b.getAttribute("aria-pressed") === "true";
    b.disabled = true;
    try {
      const r = await react(bar.dataset.rxKind!, bar.dataset.rxId!, mine ? null : b.dataset.rx!);
      bar.outerHTML = reactionBar(bar.dataset.rxKind as "post", bar.dataset.rxId!, r.counts, r.reaction).s;
    } catch (e) {
      b.disabled = false;
      toast((e as Error).message);
    }
  });
}

export function toast(m: string) {
  let t = document.getElementById("sx-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "sx-toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = m;
  t.hidden = false;
  setTimeout(() => (t!.hidden = true), 4000);
}

export const esc_ = esc;

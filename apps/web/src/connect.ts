import { connectWallet, disconnectWallet, discovered, legacyOnly, onSession, onWallets, rememberedWallet, restoreSession, session, startDiscovery } from "../wallet/standard.ts";
import { agentAvatar, identicon } from "./building.ts";
import { esc, html } from "./html.ts";
import { icon } from "./ui.ts";

// The header's Connect button (docs/plans/APP-CONSOLIDATION.md, amendment 2026-10-10 (2)): Wallet
// Standard (Phantom, Solflare, Backpack) through wallet/standard.ts, whose session every page shares.
// Disconnected, it connects the only wallet at once or offers a menu of the wallets found; connected,
// it becomes a profile icon (the avatar of the first agent the wallet launched, else the wallet's
// identicon) with a menu: My profile, Copy address, Disconnect. The choice persists across pages and
// reloads (a silent reconnect on load). Nothing here signs anything.

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function connectHtml() {
  return html`<div class="cn" id="cn"><button type="button" class="cn-btn" id="cn-btn" aria-haspopup="menu" aria-expanded="false">Connect</button><div class="cn-menu" id="cn-menu" role="menu" hidden></div></div>`;
}

let root: HTMLElement | null = null;

// Privy (owner, 2026-10-10): Connect opens Privy's login modal, loaded on demand (/assets/privy.js,
// a React island; apps/web/privy/main.tsx). A visitor who logged in with Privy before is restored
// silently on load. If the island cannot load, the Wallet Standard menu below is the fallback.
type PrivyMod = { startPrivy: (open: boolean) => Promise<unknown> };
let privy: Promise<PrivyMod> | null = null;
const PRIVY_URL = "/assets/privy.js"; // through a variable, so the bundler leaves the import to the browser
const loadPrivy = () => (privy ??= import(/* @vite-ignore */ PRIVY_URL) as Promise<PrivyMod>);
async function openPrivy(): Promise<boolean> {
  try {
    const b = root?.querySelector<HTMLElement>("#cn-btn");
    if (b && !session().account) b.textContent = "Opening…";
    await (await loadPrivy()).startPrivy(true);
    paint(); // the modal is up; the button goes back to its label
    return true;
  } catch {
    paint();
    return false;
  }
}
/** The wallet's first launched agent (market indexer, launcher=), for the profile icon. */
const firstAgent = new Map<string, { agent: string; avatar: string | null; name: string | null } | null>();
async function loadFirstAgent(address: string) {
  if (firstAgent.has(address)) return;
  firstAgent.set(address, null);
  try {
    const r = await fetch(`/market/tokens?launcher=${address}&sort=newest&limit=200`, { headers: { accept: "application/json" } });
    const j = r.ok ? await r.json() : null;
    const ts: any[] = Array.isArray(j?.tokens) ? j.tokens : [];
    const t = ts.sort((a, b) => a.created_at - b.created_at)[0];
    if (t) firstAgent.set(address, { agent: t.agent, avatar: t.avatar ?? null, name: t.agent_name ?? null });
    paint();
  } catch {
    /* the identicon stays */
  }
}

export function wireConnect(el: HTMLElement) {
  root = el;
  startDiscovery();
  onSession(paint);
  onWallets(paint);
  if (rememberedWallet() === "privy") void loadPrivy().then((m) => m.startPrivy(false)).catch(() => {});
  else restoreSession();
  paint();
  el.addEventListener("click", onClick);
  document.addEventListener("click", (ev) => {
    if (root && !root.contains(ev.target as Node)) setMenu(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") setMenu(false);
  });
}

function setMenu(on: boolean) {
  const m = root?.querySelector<HTMLElement>("#cn-menu");
  const b = root?.querySelector<HTMLElement>("#cn-btn");
  if (!m || !b) return;
  if (on) menu();
  m.hidden = !on;
  b.setAttribute("aria-expanded", String(on));
}

function paint() {
  const b = root?.querySelector<HTMLElement>("#cn-btn");
  if (!b) return;
  const s = session();
  if (s.account) {
    const addr = s.account.address;
    void loadFirstAgent(addr);
    const ag = firstAgent.get(addr);
    b.innerHTML = (ag ? agentAvatar(ag.agent, ag.avatar, 28, "cn-av") : html`<img class="av cn-av" src="${identicon(addr)}" width="28" height="28" alt="">`).s;
    b.classList.add("on");
    b.setAttribute("aria-label", `Account menu, ${short(addr)}`);
    b.title = `${s.wallet?.name ?? "Wallet"} ${addr}`;
  } else {
    b.textContent = s.restoring ? "Connecting…" : "Connect";
    b.classList.remove("on");
    b.removeAttribute("aria-label");
    b.title = "Connect a wallet or sign in with email (Privy, devnet)";
  }
  const m = root?.querySelector<HTMLElement>("#cn-menu");
  if (m && !m.hidden) menu();
}

function menu() {
  const m = root?.querySelector<HTMLElement>("#cn-menu");
  if (!m) return;
  const s = session();
  if (s.account) {
    m.innerHTML = html`<div class="cn-who"><span class="eyebrow">${s.wallet?.name ?? "Wallet"}, devnet</span><span class="num" title="${s.account.address}">${short(s.account.address)}</span></div>
      <a role="menuitem" href="/profile" data-cn="profile">${icon.agent} My profile</a>
      <button type="button" role="menuitem" data-cn="copy">${icon.copy} Copy address</button>
      <button type="button" role="menuitem" data-cn="disconnect">${icon.x} Disconnect</button>`.s;
    return;
  }
  const ws = discovered();
  const legacy = legacyOnly();
  m.innerHTML = html`<div class="cn-who"><span class="eyebrow">Connect a wallet</span><span class="dim">Wallet Standard, devnet only</span></div>
    ${ws.length
      ? ws.map((w) => html`<button type="button" role="menuitem" data-cn="connect" data-name="${w.name}"><img src="${w.icon}" alt="" width="16" height="16"> ${w.name}</button>`)
      : html`<div class="cn-none">No Wallet Standard wallet in this browser. Install <a class="link" href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>, <a class="link" href="https://solflare.com" target="_blank" rel="noopener">Solflare</a> or <a class="link" href="https://backpack.app" target="_blank" rel="noopener">Backpack</a> and reload.</div>`}
    ${legacy.length ? html`<div class="cn-none">${legacy.join(", ")} found only as a legacy provider; update the extension.</div>` : ""}
    ${s.error ? html`<div class="cn-none cn-err">${esc(s.error)}</div>` : ""}`.s;
}

async function onClick(ev: Event) {
  const t = ev.target as HTMLElement;
  if (t.closest("#cn-btn")) {
    const s = session();
    // disconnected: Privy's modal; the Wallet Standard menu only if Privy did not load
    if (!s.account && (await openPrivy())) return;
    const ws = discovered();
    // one wallet and nothing connected: connect at once, no menu
    if (!s.account && ws.length === 1) {
      const acc = await connectWallet(ws[0]!.name);
      if (!acc) setMenu(true);
      return;
    }
    const m = root?.querySelector<HTMLElement>("#cn-menu");
    setMenu(!!m?.hidden);
    return;
  }
  const item = t.closest<HTMLElement>("[data-cn]");
  if (!item) return;
  const act = item.dataset.cn;
  if (act === "connect") {
    const acc = await connectWallet(item.dataset.name);
    if (acc) setMenu(false);
    else menu();
  } else if (act === "copy") {
    const a = session().account?.address;
    if (a) await navigator.clipboard?.writeText(a).catch(() => {});
    item.innerHTML = html`${icon.check} Copied`.s;
    setTimeout(() => setMenu(false), 700);
  } else if (act === "disconnect") {
    await disconnectWallet();
    setMenu(false);
  } else if (act === "profile") setMenu(false);
}

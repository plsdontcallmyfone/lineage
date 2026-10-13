// The "finish setting up" bar (owner 2026-10-13, docs/plans/SEAMLESS-BIND.md): on every page, a wallet
// that launched a hosted agent which is still not bound sees one slim bar above the navigation, and one
// press opens a small popup that binds it. The app bundle (apps/web/src/setup-bar.ts) asks the hosted
// runtime which of this wallet's agents wait (one cheap read) and loads this module only when there are
// some; here each is checked against the chain, named, and bound with the same routine as the launched
// screen and Profile > Manage (bind.ts finishBind: the wallet's reconnect, a wallet's own guard
// instructions and the runtime's co-signature are all handled there).
import { html } from "../src/html.ts";
import { icon } from "../src/ui.ts";
import { bindProblem, finishBind } from "./bind.ts";
import { loadChainCfg, reader } from "./chain.ts";
import { session } from "./standard.ts";

export interface SetupAgent { agent: string; new_key: string; mint: string | null }
interface Row extends SetupAgent { name: string; coin: string | null; state: "waiting" | "busy" | "done"; note: string }

const DISMISS_KEY = "units-setup-dismissed";
/** Dismissed for this browser session only: it comes back on the next visit while something is unbound. */
export const setupDismissed = (wallet: string): boolean => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === wallet;
  } catch {
    return false;
  }
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const getJson = (url: string) => fetch(url, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

/** The bar's words: one agent by name, several by count. */
export const setupLabel = (names: string[]): string => (names.length === 1 ? `Finish setting up ${names[0]}` : `${names.length} agents need setup`);

export async function mountSetupBar(el: HTMLElement, o: { wallet: string; agents: SetupAgent[] }): Promise<void> {
  await loadChainCfg().catch(() => undefined);
  // the runtime's list is its own state, which trails the chain by a pass: only what the chain agrees is unbound and this wallet's is shown
  const rows: Row[] = [];
  await Promise.all(o.agents.map(async (a) => {
    const rec = await reader.agent(a.agent).catch(() => null);
    if (!rec || !rec.hosted || rec.owner !== o.wallet || rec.signingKey === a.new_key) return;
    const [p, t] = await Promise.all([getJson(`/api/agents/${a.agent}/profile`), a.mint ? getJson(`/market/tokens/${a.mint}`) : null]);
    rows.push({ ...a, name: String(p?.soul?.name ?? t?.name ?? short(a.agent)), coin: t?.symbol ? String(t.symbol) : null, state: "waiting", note: "" });
  }));
  rows.sort((a, b) => o.agents.findIndex((x) => x.agent === a.agent) - o.agents.findIndex((x) => x.agent === b.agent));
  let modal: HTMLElement | null = null;
  const left = () => rows.filter((r) => r.state !== "done");
  const close = () => {
    modal?.remove();
    modal = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !rows.some((r) => r.state === "busy")) close();
  };
  const paintBar = () => {
    const l = left();
    const show = l.length > 0 && session().account?.address === o.wallet && !setupDismissed(o.wallet);
    el.hidden = !show;
    el.innerHTML = show
      ? html`<div class="sb" role="status"><span class="sb-ic">${icon.warn}</span><span class="sb-t">${l.length === 1 ? "An agent you launched is not working yet." : "Agents you launched are not working yet."}</span>
          <button type="button" class="sb-go" data-sb="open">${setupLabel(l.map((r) => r.name))}</button><button type="button" class="sb-x" data-sb="dismiss" aria-label="Hide until the next visit">${icon.x}</button></div>`.s
      : "";
  };
  const paintModal = () => {
    if (!modal) return;
    const l = rows;
    const all = left().length === 0;
    modal.innerHTML = html`<div class="sb-modal" role="dialog" aria-modal="true" aria-labelledby="sb-h">
        <div class="sb-mh"><h2 id="sb-h">${all ? "Setup finished" : "Finish setup"}</h2><button type="button" class="sb-x" data-sb="close" aria-label="Close">${icon.x}</button></div>
        <p class="sb-p">One signature from your wallet lets the hosted runtime start working for ${l.length === 1 ? "this agent" : "each of these agents"}. Nothing else changes and it costs only the network fee.</p>
        ${l.map((r) => html`<div class="sb-row" data-agent="${r.agent}" data-state="${r.state}">
            <div class="sb-who"><b>${r.name}</b><span class="dim">${r.coin ? `$${r.coin}` : "its coin"} · <a class="link" href="/agents/${r.agent}/profile">${short(r.agent)}</a></span></div>
            ${r.state === "done" ? html`<span class="mark good">${icon.check} bound</span>` : html`<button type="button" class="wl-btn primary" data-sb="bind" data-agent="${r.agent}"${r.state === "busy" ? " disabled aria-busy=\"true\"" : ""}>Bind</button>`}
            <div class="sb-note" data-sb-note>${r.note}</div>
          </div>`)}
      </div>`.s;
  };
  const bind = async (r: Row) => {
    if (r.state !== "waiting") return;
    r.state = "busy";
    r.note = "Waiting for the wallet.";
    paintModal();
    const say = (line: string) => {
      r.note = line;
      const n = modal?.querySelector<HTMLElement>(`.sb-row[data-agent="${r.agent}"] [data-sb-note]`);
      if (n) n.textContent = line;
    };
    try {
      const s = session();
      await finishBind({ agent: r.agent, wallet: s.wallet, account: s.account, say, tries: 3 });
      r.state = "done";
      r.note = "The hosted runtime now holds its signing key. It starts working on the runtime's next pass.";
    } catch (e) {
      r.state = "waiting";
      r.note = bindProblem(e);
    }
    paintModal();
    paintBar();
    // everything is bound: the popup closes itself and the bar is gone
    if (!left().length) setTimeout(close, 1800);
  };
  const open = () => {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "sb-ov";
    modal.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>("[data-sb]");
      if (b?.dataset.sb === "bind") void bind(rows.find((r) => r.agent === b.dataset.agent)!);
      else if ((b?.dataset.sb === "close" || t === modal) && !rows.some((r) => r.state === "busy")) close();
    });
    document.body.appendChild(modal);
    document.addEventListener("keydown", onKey);
    paintModal();
    modal.querySelector<HTMLElement>('[data-sb="bind"]')?.focus();
  };
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sb]");
    if (b?.dataset.sb === "open") open();
    else if (b?.dataset.sb === "dismiss") {
      try {
        sessionStorage.setItem(DISMISS_KEY, o.wallet);
      } catch {}
      paintBar();
    }
  };
  paintBar();
}

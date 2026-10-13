// The "finish setting up" bar above the navigation (owner 2026-10-13, docs/plans/SEAMLESS-BIND.md).
// Shown only to a connected wallet that launched a hosted agent which is still not bound; everyone
// else gets an empty hidden element, one small request when a wallet connects, and no wallet bundle.
// The bar and its popup live in the wallet bundle (apps/web/wallet/setup-bar.ts).
import { connected, onAccount } from "./pages/social-ui.ts";

export function wireSetupBar(el: HTMLElement) {
  let seq = 0;
  let last: string | null | undefined;
  const check = async () => {
    const w = connected();
    if (w === last) return;
    last = w;
    const my = ++seq;
    el.hidden = true;
    el.innerHTML = "";
    if (!w) return;
    try {
      if (sessionStorage.getItem("units-setup-dismissed") === w) return;
    } catch {}
    // the hosted runtime's own list of this wallet's agents that wait for their bind: one read, however many agents exist
    const r = await fetch(`/runtime/unbound/${w}`, { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const agents = Array.isArray(r?.agents) ? r.agents : [];
    if (my !== seq || !agents.length) return;
    const url = "/assets/wallet.js";
    const m = await import(/* @vite-ignore */ url).catch(() => null);
    if (my !== seq || !m?.mountSetupBar) return;
    await m.mountSetupBar(el, { wallet: w, agents }).catch(() => undefined);
  };
  onAccount(() => void check());
  void check();
}

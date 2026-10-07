import { html } from "../html.ts";
import type { Page } from "./types.ts";

// Wallet (M2, devnet only). The page's code is a separate bundle (/assets/wallet.js, built from
// apps/web/wallet with packages/chain's browser build) loaded only here, so the dashboard bundle
// stays free of transaction code. It keeps its own state and never re-renders from the shell.

export async function walletPage(): Promise<Page> {
  return {
    title: "Wallet",
    body: html`<div id="wallet-root"><div class="panel"><div class="panel-b dim">Loading the wallet module…</div></div></div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#wallet-root");
      if (!el) return;
      const url = "/assets/wallet.js";
      try {
        const m = await import(url);
        await m.mountWallet(el);
      } catch (e) {
        el.innerHTML = html`<div class="panel errorbox"><h1>The wallet module did not load</h1><p>${String((e as Error)?.message ?? e)}</p></div>`.s;
      }
    },
  };
}

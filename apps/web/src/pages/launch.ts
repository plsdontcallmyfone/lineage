import { html } from "../html.ts";
import type { Page } from "./types.ts";

// Launch (/launch) and Profile (/profile) run in the wallet bundle (/assets/wallet.js, apps/web/wallet
// with packages/chain's browser build), loaded on demand so the dashboard bundle carries no
// transaction code. Each keeps its own state and never re-renders from the shell.

export function walletModulePage(title: string, fn: "mountLaunch" | "mountProfile"): Page {
  return {
    title,
    body: html`<div id="wallet-root"><div class="panel"><div class="panel-b dim">Loading the wallet module…</div></div></div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#wallet-root");
      if (!el) return;
      const url = "/assets/wallet.js";
      try {
        const m = await import(/* @vite-ignore */ url);
        await m[fn](el);
      } catch (e) {
        el.innerHTML = html`<div class="panel errorbox"><h1>The wallet module did not load</h1><p>${String((e as Error)?.message ?? e)}</p></div>`.s;
      }
    },
  };
}

export async function launchPage(): Promise<Page> {
  return walletModulePage("Launch", "mountLaunch");
}

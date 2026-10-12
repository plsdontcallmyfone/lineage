import { html } from "../html.ts";
import { checkDeployment, staleTab, untilLive } from "../opening.ts";
import type { Page } from "./types.ts";

// Launch (/launch) and Profile (/profile) run in the wallet bundle (/assets/wallet.js, apps/web/wallet
// with packages/chain's browser build), loaded on demand so the dashboard bundle carries no
// transaction code. Each keeps its own state and never re-renders from the shell.

// a path the bundler cannot resolve at build time: the wallet bundle is a file of its own
const WALLET_JS = ["", "assets", "wallet.js"].join("/");
const loadWallet = (): Promise<any> => import(/* @vite-ignore */ WALLET_JS);

const LOADING = html`<div class="panel"><div class="panel-b dim">Loading the wallet module…</div></div>`;

async function mountWallet(el: HTMLElement, fn: "mountLaunch" | "mountProfile", loaded?: Promise<any>) {
  try {
    const m = await (loaded ?? loadWallet());
    await m[fn](el);
  } catch (e) {
    el.innerHTML = html`<div class="panel errorbox"><h1>The wallet module did not load</h1><p>${String((e as Error)?.message ?? e)}</p></div>`.s;
  }
}

export function walletModulePage(title: string, fn: "mountLaunch" | "mountProfile"): Page {
  return {
    title,
    body: html`<div id="wallet-root">${LOADING}</div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#wallet-root");
      if (!el) return;
      await mountWallet(el, fn);
    },
  };
}

/** Shown on Launch while the deployment is being opened (src/opening.ts); the wizard replaces it by itself. */
export const OPENING_TITLE = "Launches open in a moment.";
export const OPENING_LINE = "The network is starting. This page switches by itself.";
const openingPanel = () => html`
  <div class="lz-page">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Launch</div>
      <h1>Launch an agent</h1>
      <div class="ph-sub"><span>A token for an agent that works on a public repository. Its work is judged by independent replays.</span></div></div></div>
    <section class="panel lz-opening" id="lz-opening" role="status" aria-live="polite">
      <i class="lz-opening-dot" aria-hidden="true"></i>
      <div class="t1">${OPENING_TITLE}</div>
      <div>${OPENING_LINE}</div>
    </section>
  </div>`;

/** The registry program the wizard was last mounted under in this tab (opening.ts staleTab). */
let mountedRegistry: string | null = null;

export async function launchPage(): Promise<Page> {
  return {
    title: "Launch",
    body: html`<div id="wallet-root">${LOADING}</div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#wallet-root");
      if (!el) return;
      // the wallet bundle loads while the one check runs
      const loaded = loadWallet();
      loaded.catch(() => undefined);
      let c = await checkDeployment();
      if (!el.isConnected) return;
      if (c.state === "opening") {
        el.innerHTML = openingPanel().s;
        const live = await untilLive(() => el.isConnected);
        if (!live) return;
        c = { state: "live", registry: live.registry };
        el.innerHTML = LOADING.s;
      }
      // this tab holds an earlier deployment's addresses: load again rather than build against them
      if (staleTab(mountedRegistry, c.registry)) return location.reload();
      mountedRegistry = c.registry ?? mountedRegistry;
      await mountWallet(el, "mountLaunch", loaded);
    },
  };
}

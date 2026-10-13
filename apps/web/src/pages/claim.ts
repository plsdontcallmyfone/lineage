import { html } from "../html.ts";
import type { Page } from "./types.ts";

// Claim (/claim): fees an agent routes to the repository it works on, claimed by anyone with admin
// on that repository (docs/plans/GITHUB-FEE-CLAIMS.md, section 11). The page itself lives in the wallet bundle
// (apps/web/wallet/claim.ts, loaded on demand like Launch and Profile) because it signs a message and
// sends a transaction. While Core's `features.github_fee_claims` is off it shows what the page is for and nothing to do.

export async function claimPage(): Promise<Page> {
  return {
    title: "Claim",
    body: html`<div id="claim-root"><div class="panel"><div class="panel-b dim">Loading the claim page…</div></div></div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#claim-root");
      if (!el) return;
      const url = "/assets/wallet.js";
      try {
        const m = await import(/* @vite-ignore */ url);
        await m.mountClaim(el);
      } catch (e) {
        el.innerHTML = html`<div class="panel errorbox"><h1>The claim page did not load</h1><p>${String((e as Error)?.message ?? e)}</p></div>`.s;
      }
    },
  };
}

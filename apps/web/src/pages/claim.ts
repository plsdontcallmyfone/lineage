import { html } from "../html.ts";
import type { Page } from "./types.ts";

// Claim (/claim): fees a launcher routed to a GitHub account, claimed by that account's owner
// (docs/plans/GITHUB-FEE-CLAIMS.md). The page itself lives in the wallet bundle
// (apps/web/wallet/claim.ts, loaded on demand like Launch and Profile) because it signs a message and
// sends a transaction. While Core's `features.github_fee_claims` is off it says claims are not open.

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

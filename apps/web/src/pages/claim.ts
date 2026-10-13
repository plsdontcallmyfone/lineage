import { getOptional } from "../api.ts";
import { claimHow, injectWaitingStyle, loadWaiting, oneShare, waitingList, waitingStats, type Waiting } from "../fees-waiting.ts";
import { html } from "../html.ts";
import { wireRequirementToggles } from "../requirement-explain.ts";
import type { Page } from "./types.ts";

// Claim (/claim): fees an agent shares with the repository it works on, claimed by anyone with admin
// on that repository (docs/plans/GITHUB-FEE-CLAIMS.md, section 11). One page, drawn in two parts.
// This shell is everything that needs no wallet: the heading with the repository search, the four
// tiles, the board of repositories with fees waiting and "How this works", all from Core's public
// GET /v1/fee-claims/waiting. The claim card and the search's result live in the wallet bundle
// (apps/web/wallet/claim.ts, loaded on demand like Launch and Profile) because they sign a message and
// send a transaction; they are mounted into the two slots below. While Core's
// `features.github_fee_claims` is off the card says what the page is for and nothing else shows.

interface Providers { oauth: { provider: string; scope?: string } | null }

/** The parts of the page that are redrawn from a fresh reading while the card keeps its state. */
function fill(root: HTMLElement, w: Waiting | null) {
  const stats = root.querySelector<HTMLElement>("#claim-stats"), board = root.querySelector<HTMLElement>("#claim-waiting");
  if (stats) stats.innerHTML = waitingStats(w).s;
  if (board) board.innerHTML = waitingList(w).s;
}

export async function claimPage(): Promise<Page> {
  injectWaitingStyle();
  const [waiting, providers] = await Promise.all([loadWaiting(), getOptional<Providers>("fee-claims/providers").catch(() => null)]);
  const scope = providers?.oauth ? (typeof providers.oauth.scope === "string" ? providers.oauth.scope : null) : null;
  return {
    title: "Claim",
    body: html`<div id="claim-root" class="cl-page" data-claim-page>
      <div class="ph-row"><div class="ph-title"><div class="eyebrow">Claim</div><h1>Claim</h1>
        <div class="ph-sub"><span>Agents share part of their fees with the owners of the repository they work on. If you have admin on it, that money is yours to claim.</span></div></div>
        ${waiting ? html`<form class="cl-search" role="search" data-claim-search><label class="eyebrow" for="cl-lookup">Check any repository</label>
          <div class="cl-search-row"><input id="cl-lookup" name="cl_lookup" maxlength="141" placeholder="owner/name" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
            <button type="submit" class="wl-btn" data-claim="lookup">Check</button></div></form>` : ""}</div>
      <div id="claim-stats" class="cl-slot">${waitingStats(waiting)}</div>
      <div class="cl-cols">
        <div class="cl-main">
          <div class="cl-slot" data-cl-slot="card"><section class="cl-card" data-claim-card data-claim-state="loading"><div class="cl-card-h"><h2>Claim fees for your repository</h2></div><div class="cl-card-b"><p class="cl-lead">Checking what is waiting.</p></div></section></div>
          <div id="claim-waiting" class="cl-waiting cl-slot">${waitingList(waiting)}</div>
        </div>
        <aside class="cl-side"><div class="cl-slot" data-cl-slot="result" aria-live="polite"></div>${waiting ? claimHow({ scope, share: oneShare(waiting) }) : ""}</aside>
      </div></div>`,
    mount: async (root) => {
      const el = root.querySelector<HTMLElement>("#claim-root");
      if (!el) return;
      wireRequirementToggles();
      // the tiles and the board follow the chain while the page is open (Core holds a reading for 30 s); the card keeps its own state
      const timer = setInterval(() => {
        if (!el.isConnected) return clearInterval(timer);
        if (document.visibilityState === "visible") void loadWaiting().then((w) => { if (w && el.isConnected) fill(el, w); });
      }, 60_000);
      // a claim made on this page changes them at once on chain; Core's reading follows within its 30 s
      el.addEventListener("claim:changed", () => { for (const ms of [1_500, 32_000]) setTimeout(() => { if (el.isConnected) void loadWaiting().then((w) => { if (w && el.isConnected) fill(el, w); }); }, ms); });
      const url = "/assets/wallet.js";
      try {
        const m = await import(/* @vite-ignore */ url);
        await m.mountClaim(el, { waiting });
      } catch (e) {
        const slot = el.querySelector<HTMLElement>('[data-cl-slot="card"]');
        if (slot) slot.innerHTML = html`<section class="cl-card" data-claim-card data-claim-state="failed"><div class="cl-card-h"><h2>Claim fees for your repository</h2></div>
          <div class="cl-card-b"><div class="cl-msg bad" role="alert"><div><p>The claim card did not load. Reload the page to try again.</p><p>${String((e as Error)?.message ?? e)}</p></div></div></div></section>`.s;
      }
    },
  };
}

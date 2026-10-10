// Markup of the two wallet pages (docs/plans/APP-CONSOLIDATION.md). Pure templates: the state and
// every action live in main.ts, which fills the elements by id.
//
// Launch is a stepped wizard in the Stags pattern (step nav clickable up to the furthest valid step,
// one card per step with Back and Next and validation before Next, a final Review step). All six
// cards stay in the DOM and only the current one is shown, so every field keeps its value across
// steps and the launch code reads them by name as before.
import { html, raw, type Raw } from "../src/html.ts";
import { icon, panel } from "../src/ui.ts";
import { custodyHtml } from "./identity.ts";
import { modelFieldset } from "./models.ts";
import { prepayFieldset } from "./prepay.ts";
import { allocationFieldset } from "./trading.ts";

export const STEPS = ["The coin", "The work", "The agent", "Identity", "Funding", "Review"] as const;
export const CLASSES = ["rust", "solana", "zig", "cuda", "python", "go", "cpp"];

export const stepNav = (current: number, furthest: number): Raw =>
  html`<div class="lz-nav" role="tablist" aria-label="Launch steps">${STEPS.map((label, i) => {
    const reach = i <= furthest;
    return html`<button type="button" role="tab" class="lz-step${i === current ? " on" : ""}${i < current ? " done" : ""}" data-act="lz-go" data-i="${String(i)}" aria-selected="${String(i === current)}"${reach ? "" : raw(' disabled aria-disabled="true"')}><span class="lz-dot"></span><span class="lz-n">${String(i + 1)}</span><span class="lz-l">${label}</span></button>`;
  })}</div>`;

const card = (i: number, title: string, sub: Raw | string, body: Raw) =>
  html`<section class="panel lz-card" data-step="${String(i)}"${i ? raw(" hidden") : ""}>
    <div class="panel-h"><h2><span class="lz-cn">${String(i + 1)}</span> ${title}</h2></div>
    <div class="panel-b lz-b"><p class="lz-sub">${sub}</p>${body}</div>
  </section>`;

export function launchSkeleton(): Raw {
  return html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Launch</div>
      <h1>Launch an agent</h1>
      <div class="ph-sub"><span>A token for an agent that works on a public repository. Its work is judged by independent replays. Devnet, TEST tokens.</span></div></div></div>
    <div id="w-gate"></div>
    <div id="lz-conn"></div>
    <div id="lz-nav">${stepNav(0, 0)}</div>
    <form class="wl-form lz-form" data-wallet-form="launch" autocomplete="off">
      ${card(0, "The coin", "What people see: the token's name and ticker, a short description, its image and optional links.", html`
        <div class="wl-2">
          <label><span class="eyebrow">Name</span><input name="l_name" maxlength="27" placeholder="minbpe speedups"><span class="wl-help">Token name on chain: "TEST " + this (32 bytes max).</span></label>
          <label><span class="eyebrow">Ticker</span><input name="l_symbol" maxlength="10" placeholder="TMBPE"><span class="wl-help">A to Z and 0 to 9, up to 10.</span></label>
        </div>
        <label><span class="eyebrow">Description</span><textarea name="l_desc" maxlength="700" rows="3" placeholder="What this agent is for, in a sentence or two."></textarea><span class="wl-help">Shown on the agent's profile as "From the launcher"; it is also part of the soul seed the agent key signs.</span></label>
        <div class="lz-img">
          <div class="lz-prev" id="lz-prev" aria-hidden="true"><span>${icon.agent}</span></div>
          <label class="lz-file"><span class="eyebrow">Image</span><input type="file" name="l_image" accept="image/png,image/jpeg,image/webp"><span class="wl-help" id="lz-img-help">PNG, JPEG or WebP, at most 256 KB. Your wallet signs it after the launch and it becomes the agent's avatar; without one the avatar is a pattern generated from the agent key.</span></label>
        </div>
        <label><span class="eyebrow">Links (optional)</span><textarea name="l_links" rows="2" maxlength="400" placeholder="https://example.com, one per line, up to 3"></textarea><span class="wl-help">https links, kept with the description.</span></label>`)}
      ${card(1, "The work", "The public GitHub repository the agent improves. What it can improve is what a recipe on Core can measure.", html`
        <label><span class="eyebrow">GitHub repository</span><input name="l_repo" type="url" placeholder="https://github.com/owner/repo"><span class="wl-help" id="w-repo">Any public GitHub repository, as an https URL. Checked against the GitHub API and Core's lineages.</span></label>
        <div id="w-work"></div>
        <label><span class="eyebrow">Target class</span><select name="l_class">${CLASSES.map((c) => html`<option value="${c}">${c}</option>`)}</select><span class="wl-help" id="w-class-help">Recorded in the token metadata URI; set from the recipe when one exists.</span></label>`)}
      ${card(2, "The agent", "Its soul, its face, the model it runs and how it trades.", html`
        <fieldset><legend class="eyebrow">Soul (SPEC 14.8)</legend>
          <div class="wl-fine" style="margin-bottom:8px">A short seed; Claude expands it into the agent's soul (voice, taste, values, how it collaborates). You review and edit it before launching. Its sha256 is committed on chain with <span class="num">set_profile</span>. The soul shapes how the agent works and writes; it never changes what is accepted.</div>
          <div class="wl-2">
            <label><span class="eyebrow">Vibe</span><input name="s_vibe" maxlength="200" placeholder="patient, precise, quietly funny"></label>
            <label><span class="eyebrow">Specialty</span><input name="s_specialty" maxlength="200" placeholder="tokenizer hot paths: fewer allocations, same bytes out"></label>
          </div>
          <label><span class="eyebrow">Values</span><input name="s_values" maxlength="400" placeholder="measure twice, small diffs, credit the finder"><span class="wl-help">Comma separated, 1 to 6.</span></label>
          <div id="w-temp"></div>
          <div class="wl-row" style="margin-top:8px"><button type="button" class="wl-btn primary" data-act="soul-generate">Generate soul</button></div>
          <div id="w-soul"></div>
        </fieldset>
        <fieldset><legend class="eyebrow">Avatar and banner</legend>
          <div class="lz-av" id="lz-av"></div>
          <label class="lz-file"><span class="eyebrow">Banner (optional)</span><input type="file" name="l_banner" accept="image/png,image/jpeg,image/webp"><span class="wl-help">At most 1 MB; signed and uploaded after the launch, like the image.</span></label>
        </fieldset>
        ${modelFieldset()}
        <fieldset><legend class="eyebrow">Runtime</legend>
          <label class="radio"><input type="radio" name="l_hosted" value="hosted" checked> <span><b>Hosted.</b> The hosted runtime runs it, paid from the agent's compute vault.</span></label>
          <label class="radio"><input type="radio" name="l_hosted" value="self"> <span><b>Self-hosted.</b> You run the worker with the agent key.</span></label>
        </fieldset>`)}
      ${card(3, "Identity", "The GitHub account the agent's commits are signed as (SPEC 13.9).", html`
        <fieldset><legend class="eyebrow">GitHub account</legend>
          <label class="radio"><input type="radio" name="l_identity" value="purchased" checked> <span><b>Purchased account</b> from the pool we operate, set up automatically after launch. Price TBA; devnet charges nothing.</span></label>
          <label class="radio"><input type="radio" name="l_identity" value="token"> <span><b>Your own token.</b> Checked against GitHub before launch, with the scopes it carries shown. A fine-grained token limited to the agent's forks is the recommended choice.</span></label>
          <label class="radio"><input type="radio" name="l_identity" value="app"> <span><b>App identity.</b> lineage-app[bot] on the project's forks; commits are recorded, not pushed under an account.</span></label>
        </fieldset>
        <div class="wl-custody" id="w-custody">${custodyHtml("purchased")}</div>`)}
      ${card(4, "Funding", "Prepaid credits wake the agent at once; a trading allocation is optional.", html`
        ${prepayFieldset()}
        ${allocationFieldset()}
        <fieldset><legend class="eyebrow">Launch parameters (on chain)</legend><div id="w-fees" class="wl-fine">Reading the launch config…</div></fieldset>`)}
      ${card(5, "Review", "Every choice, then one launch. Your wallet signs; the agent and mint keys are made in this page.", html`
        <div id="w-review"></div>
        <div id="w-launch-out"></div>
        <div id="w-launch-steps"></div>`)}
    </form>
    <div class="lz-foot" id="lz-foot"></div>
    <div style="margin-top:16px">${panel("This session's transactions", html`<div id="w-sigs"></div>`, { note: html`Every signature links to Solana Explorer (devnet). Nothing is stored after you leave the page.` })}</div>`;
}

export function profileSkeleton(): Raw {
  return html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Profile</div>
      <h1 id="me-h">Your wallet</h1>
      <div class="ph-sub"><span>Only the connected wallet's own view: its balances, the agents it launched, what it holds and follows, and what it can claim. Devnet, TEST tokens.</span></div></div></div>
    <div id="w-gate"></div>
    <div id="me-body">
      <section class="panel" id="me-head"><div id="w-conn"><div class="panel-b dim">Reading the wallet…</div></div></section>
      <div id="me-signed" hidden>
        ${panel("My agents", html`<div id="w-mine"><div class="panel-b dim">Reading the launches…</div></div>`, { id: "agents", note: html`Read from the <span class="num">AgentLaunch</span> and registry <span class="num">Agent</span> accounts on devnet, the identity service and Core.` })}
        <section class="panel" id="me-manage" hidden></section>
        ${panel("My holdings", html`<div id="w-hold"><div class="panel-b dim">Reading token accounts…</div></div>`, { id: "holdings", note: html`Balances read from chain; value at the market indexer's last price in tLINE.` })}
        ${panel("Following", html`<div id="w-follow"><div class="panel-b dim">Reading follows…</div></div>`, { id: "following" })}
        <section class="panel" id="me-claims" hidden>
          <div class="panel-h"><h2>Claims and bounties</h2></div>
          <div class="me-sub eyebrow">Claimable epoch leaves</div>
          <div id="w-claims"></div>
          <div class="me-sub eyebrow">Bounties</div>
          <div class="grid-2 me-b2"><div id="w-bopen"></div><div id="w-blist"></div></div>
        </section>
        <details class="panel me-ver" id="verifier"><summary class="panel-h"><h2>Run a verifier</h2><span class="aside dim">register a worker key, bond, unbond</span></summary>
          <div class="grid-2 me-b2"><div id="w-ver"></div><div id="w-kit"></div></div>
        </details>
        <div style="margin-top:16px">${panel("This session's transactions", html`<div id="w-sigs"></div>`, { note: html`Every signature links to Solana Explorer (devnet). Nothing is stored after you leave the page.` })}</div>
      </div>
    </div>`;
}

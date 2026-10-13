// Launch wizard, The work step: the GitHub fee route and the repository pool
// (docs/plans/GITHUB-FEE-CLAIMS.md 6, AGENT-POOLS.md 5). Self-contained: its own container
// (#w-fee-route, one line in pages.ts), its own state, and two instruction groups the wizard appends
// to the launch (one hunk in main.ts). Nothing renders and no instruction is added unless the
// feature is on both in Core (the lookup and claim routes exist) and on chain (the program's
// feature bit), so the wizard is unchanged while the features are off.
//
// The fee route (owner 2026-10-12, plan section 11): one tick, off until the launcher ticks it. The
// recipient is the repository the agent works on, keyed by the repository's numeric GitHub id, and
// the share is the one number in the chain's ClaimConfig. Nothing is typed and nothing is chosen;
// the rules are in fee-route-plan.ts.
import { canonicalUrl, claimPdas, claims, decodeClaimConfig, decodeLaunchConfig, decodePool, FEATURES, launchPdas, poolPdas, pools, repoId, TOKEN_2022_PROGRAM,
  type ClaimConfig, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { html } from "../src/html.ts";
import { NET, rpc } from "./chain.ts";
import { fixedShareBps, planFeeRoute, repoNameOf, tickText, type LookedUpRepo } from "./fee-route-plan.ts";

const F: { el: HTMLElement | null; github: boolean; pools: boolean; cfg: ClaimConfig | null; looked: LookedUpRepo | null; lookupErr: string | null;
  poolMembers: number | null; repo: string } = { el: null, github: false, pools: false, cfg: null, looked: null, lookupErr: null, poolMembers: null, repo: "" };

const q = <T extends HTMLElement>(sel: string) => F.el?.querySelector<T>(sel) ?? null;

/** Core resolves the repository in the field to its numeric id (the escrow key); a rename or a transfer keeps the id. */
async function lookup(repo: string) {
  const name = repoNameOf(repo);
  F.looked = null;
  F.lookupErr = null;
  paintRoute();
  if (!name) return;
  try {
    const res = await fetch(`/api/github/repos/${name.split("/").map(encodeURIComponent).join("/")}`, { headers: { accept: "application/json" } });
    const j = await res.json().catch(() => null);
    // a later value of the field may have replaced this lookup
    if (repoNameOf(F.repo) !== name) return;
    if (res.ok && typeof j?.id === "string" && typeof j?.full_name === "string") F.looked = { asked: name, id: j.id, full_name: j.full_name };
    else F.lookupErr = res.status === 404 ? "GitHub has no public repository at this address." : (j?.message ?? `GitHub lookup failed (HTTP ${res.status})`);
  } catch (e) {
    if (repoNameOf(F.repo) !== name) return;
    F.lookupErr = `GitHub lookup failed: ${(e as Error).message}`;
  }
  paintRoute();
}

/** The tick's sentence and its state: it can only be ticked once the repository in the field is confirmed. */
function paintRoute() {
  const bps = fixedShareBps(F.cfg);
  const text = q("#w-fee-text"), box = q<HTMLInputElement>('[name="l_fee_on"]'), note = q("#w-fee-note");
  if (!text || !box || bps === null) return;
  const ok = !!F.looked && F.looked.asked === repoNameOf(F.repo);
  text.textContent = tickText(bps, ok ? F.looked!.full_name : null);
  box.disabled = !ok;
  if (!ok) box.checked = false;
  box.dataset.feeRepo = ok ? F.looked!.id : "";
  if (note) note.textContent = F.lookupErr ?? "";
}

function suggest(repo: string) {
  if (repo === F.repo) return;
  F.repo = repo;
  if (F.github) void lookup(repo);
  void readPool(repo);
}

async function readPool(repo: string) {
  F.poolMembers = null;
  const out = q("#w-pool-note");
  if (!F.pools || !out) return;
  try {
    const a = await rpc.getAccountInfo(poolPdas.pool(repoId(canonicalUrl(repo))));
    F.poolMembers = a ? decodePool(a.data).members.length : 0;
  } catch {
    F.poolMembers = null;
  }
  if (repo !== F.repo) return;
  out.textContent = F.poolMembers === null ? "" : F.poolMembers === 0 ? "No agent has opened this repository's pool yet: yours would be its first member, and the pool starts working when a second agent joins."
    : `${F.poolMembers} agent${F.poolMembers === 1 ? " is" : "s are"} in this repository's pool.`;
}

/** Mounts the fields into #w-fee-route when a feature is on; `repoInput` is the wizard's repository field. */
export async function mountFeeRouteStep(root: HTMLElement, repoInput: HTMLInputElement | null): Promise<void> {
  F.el = root.querySelector<HTMLElement>("#w-fee-route");
  F.github = F.pools = false;
  F.looked = null;
  F.lookupErr = null;
  F.repo = "";
  if (!F.el) return;
  F.el.innerHTML = "";
  // the profile's flags first (config/profile.json `features`): off means no request is even made
  const want = NET.p.features ?? { agent_pools: false, github_fee_claims: false };
  if (!want.agent_pools && !want.github_fee_claims) return;
  // a failed read (the RPC proxy or Core busy for a moment) must not hide the step for the whole visit: retried
  for (let attempt = 0; ; attempt++) {
    try {
      const [lcA, ccA, core, corePools] = await Promise.all([rpc.getAccountInfo(launchPdas.config()), rpc.getAccountInfo(claimPdas.config()),
        fetch("/api/fee-claims/providers").then((r) => r.ok || r.status === 404 ? r.ok : Promise.reject(new Error(`HTTP ${r.status}`))),
        fetch("/api/pools/config").then((r) => r.ok || r.status === 404 ? r.ok : Promise.reject(new Error(`HTTP ${r.status}`)))]);
      const features = lcA ? decodeLaunchConfig(lcA.data).features : 0;
      F.cfg = ccA ? decodeClaimConfig(ccA.data) : null;
      F.github = want.github_fee_claims && !!(features & FEATURES.githubFees) && !!F.cfg && !F.cfg.paused && fixedShareBps(F.cfg) !== null && core;
      F.pools = want.agent_pools && !!(features & FEATURES.pools) && corePools;
      break;
    } catch {
      if (attempt >= 4 || !F.el.isConnected) return;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (!F.github && !F.pools) return;
  const bps = fixedShareBps(F.cfg);
  F.el.innerHTML = html`
    ${F.github && bps !== null ? html`<fieldset data-fee-route-field data-fee-bps="${String(bps)}"><legend class="eyebrow">Share fees with the repository's owners</legend>
      <label class="radio"><input type="checkbox" name="l_fee_on" disabled> <span id="w-fee-text">${tickText(bps, null)}</span></label>
      <span class="wl-help">Anyone with admin on the repository on GitHub can claim the share on the Claim page. The rest of the agent's fees pays for its compute. Once set, the share cannot be removed.</span>
      <span class="wl-fine" id="w-fee-note" style="color:var(--bad)"></span>
    </fieldset>` : ""}
    ${F.pools ? html`<fieldset data-pool-field><legend class="eyebrow">Repository pool</legend>
      <label class="radio"><input type="checkbox" name="l_pool_join" checked> <span>Join this repository's agent pool. Members route a slice of their fees into a shared vault that pays members by verified work, buys the members' tokens when a member's change is accepted, and burns at milestones.</span></label>
      <span class="wl-help" id="w-pool-note"></span>
    </fieldset>` : ""}`.s;
  repoInput?.addEventListener("input", () => suggest(repoInput.value.trim()));
  if (repoInput?.value) suggest(repoInput.value.trim());
}

/**
 * The instruction groups the launch appends after register_pump_launch: set_fee_route and join_pool,
 * both signed by the launcher (the agent's registry owner). Empty while the features are off or
 * unticked. Throws with a sentence the wizard shows when a ticked field is incomplete.
 */
export async function launchExtras(a: { launcher: string; agent: string; agentMint: string; lineMint: string; repoUrl: string }): Promise<{ feeRoute: Ix[]; pool: Ix[]; lines: string[]; creates: { feeRoute?: { escrow: string; vault: string }; pool?: { pool: string; vault: string } } }> {
  // `creates`: the shared accounts each group makes when they do not exist yet, for the launch's rent line (launch-costs.ts)
  const out = { feeRoute: [] as Ix[], pool: [] as Ix[], lines: [] as string[], creates: {} as { feeRoute?: { escrow: string; vault: string }; pool?: { pool: string; vault: string } } };
  if (!F.el) return out;
  // the route is built for the repository the launch itself names (a.repoUrl), never for a value read back from the page
  const plan = F.github ? planFeeRoute({ ticked: q<HTMLInputElement>('[name="l_fee_on"]')?.checked === true, cfg: F.cfg, repoUrl: a.repoUrl, looked: F.looked }) : null;
  if (plan) {
    out.feeRoute = [claims.setFeeRoute({ owner: a.launcher, agent: a.agent, agentMint: a.agentMint, lineMint: a.lineMint, githubId: plan.githubId, bps: plan.bps, lineTokenProgram: TOKEN_2022_PROGRAM })];
    out.creates.feeRoute = { escrow: claimPdas.escrow(plan.githubId), vault: claimPdas.vault(plan.githubId) };
    out.lines.push(plan.line);
  }
  if (F.pools && q<HTMLInputElement>('[name="l_pool_join"]')?.checked) {
    const id = repoId(canonicalUrl(a.repoUrl));
    const acc = await rpc.getAccountInfo(poolPdas.pool(id));
    const members = acc ? decodePool(acc.data).members : [];
    out.pool = [pools.joinPool({ signer: a.launcher, agent: a.agent, agentMint: a.agentMint, repoId: id, lineMint: a.lineMint, members, lineTokenProgram: TOKEN_2022_PROGRAM })];
    out.creates.pool = { pool: poolPdas.pool(id), vault: poolPdas.vault(id, a.lineMint, TOKEN_2022_PROGRAM) };
    out.lines.push(members.length ? `joins the repository pool (${members.length} member${members.length === 1 ? "" : "s"} already)` : "opens the repository pool");
  }
  const note = q("#w-fee-summary");
  if (note) note.textContent = out.lines.join("; ");
  return out;
}

// Launch wizard, The work step: the GitHub fee route and the repository pool
// (docs/plans/GITHUB-FEE-CLAIMS.md 6, AGENT-POOLS.md 5). Self-contained: its own container
// (#w-fee-route, one line in pages.ts), its own state, and two instruction groups the wizard appends
// to the launch (one hunk in main.ts). Nothing renders and no instruction is added unless the
// feature is on both in Core (the lookup and claim routes exist) and on chain (the program's
// feature bit), so the wizard is unchanged while the features are off.
import { canonicalUrl, claimPdas, claims, decodeClaimConfig, decodeLaunchConfig, decodePool, FEATURES, launchPdas, poolPdas, pools, repoId, TOKEN_2022_PROGRAM,
  type ClaimConfig, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { html } from "../src/html.ts";
import { NET, rpc } from "./chain.ts";

interface GhUser { id: number; login: string; name: string | null; avatar_url: string | null; type: string }
const F: { el: HTMLElement | null; github: boolean; pools: boolean; cfg: ClaimConfig | null; user: GhUser | null; lookupErr: string | null; touched: boolean; timer: ReturnType<typeof setTimeout> | null;
  poolMembers: number | null; repo: string } = { el: null, github: false, pools: false, cfg: null, user: null, lookupErr: null, touched: false, timer: null, poolMembers: null, repo: "" };

const q = <T extends HTMLElement>(sel: string) => F.el?.querySelector<T>(sel) ?? null;
const ownerOf = (repo: string) => /github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\//i.exec(repo + "/")?.[1] ?? null;
const pct = (bps: number) => Number((bps / 100).toFixed(2)).toString();

async function lookup(login: string) {
  F.user = null;
  F.lookupErr = null;
  if (!login) return paintUser();
  try {
    const res = await fetch(`/api/github/users/${encodeURIComponent(login)}`, { headers: { accept: "application/json" } });
    const j = await res.json().catch(() => null);
    if (res.ok) F.user = j as GhUser;
    else F.lookupErr = res.status === 404 ? `No GitHub account named ${login}.` : (j?.message ?? `lookup failed (HTTP ${res.status})`);
  } catch (e) {
    F.lookupErr = `lookup failed: ${(e as Error).message}`;
  }
  // a later keystroke may have replaced this lookup
  if ((q<HTMLInputElement>('[name="l_fee_login"]')?.value.trim().replace(/^@/, "") ?? "").toLowerCase() === login.toLowerCase()) paintUser();
}

function paintUser() {
  const out = q("#w-fee-user");
  if (!out) return;
  const u = F.user;
  out.innerHTML = (u
    ? html`<span class="fr-user" data-fee-user="${String(u.id)}">${u.avatar_url ? html`<img src="${u.avatar_url}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <span><b>@${u.login}</b>${u.name ? html` <span class="dim">${u.name}</span>` : ""}<br><span class="wl-fine">GitHub account id ${String(u.id)}${u.type === "Organization" ? ". An organisation cannot sign in or post a gist: pick a person who can claim." : ". Fees are keyed to this id, so a rename changes nothing."}</span></span></span>`
    : F.lookupErr ? html`<span class="wl-fine" style="color:var(--bad)">${F.lookupErr}</span>` : html`<span class="wl-fine">Type a GitHub username.</span>`).s;
}

function paintShare() {
  const v = Number(q<HTMLInputElement>('[name="l_fee_bps"]')?.value ?? 0);
  const out = q("#w-fee-pct");
  if (out) out.textContent = `${pct(v)}%`;
}

function suggest(repo: string) {
  F.repo = repo;
  const input = q<HTMLInputElement>('[name="l_fee_login"]');
  const owner = ownerOf(repo);
  if (input && owner && !F.touched && input.value !== owner) {
    input.value = owner;
    void lookup(owner);
  }
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
  F.user = null;
  F.touched = false;
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
      F.github = want.github_fee_claims && !!(features & FEATURES.githubFees) && !!F.cfg && !F.cfg.paused && core;
      F.pools = want.agent_pools && !!(features & FEATURES.pools) && corePools;
      break;
    } catch {
      if (attempt >= 4 || !F.el.isConnected) return;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (!F.github && !F.pools) return;
  const min = F.cfg?.minBps ?? 1000, max = F.cfg?.maxBps ?? 3000;
  F.el.innerHTML = html`<style>
      #w-fee-route .fr-user{display:flex;gap:10px;align-items:center;margin-top:8px}
      #w-fee-route .fr-user img{border-radius:50%;flex:none}
      #w-fee-route .fr-slide{display:flex;gap:12px;align-items:center}
      #w-fee-route .fr-slide input[type=range]{flex:1}
      #w-fee-route .fr-slide output{min-width:3.2em;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
    </style>
    ${F.github ? html`<fieldset data-fee-route-field><legend class="eyebrow">Share fees with a GitHub account</legend>
      <label class="radio"><input type="checkbox" name="l_fee_on" checked> <span>Route a share of this agent's creator fees to a GitHub account. The account's owner claims them on the Claim page; you can redirect future fees later, after a delay, and never take back what has accrued.</span></label>
      <div class="fr-slide" style="margin-top:10px"><span class="eyebrow">Share</span><input type="range" name="l_fee_bps" min="${String(min)}" max="${String(max)}" step="100" value="${String(min)}" aria-label="Share of the agent's fees"><output id="w-fee-pct">${pct(min)}%</output></div>
      <span class="wl-help">From ${pct(min)}% to ${pct(max)}% of what the agent keeps of its creator fees. The rest pays for its compute.</span>
      <label style="margin-top:10px"><span class="eyebrow">GitHub username</span><input name="l_fee_login" maxlength="39" placeholder="the repository's owner" autocomplete="off"></label>
      <div id="w-fee-user"><span class="wl-fine">Type a GitHub username.</span></div>
    </fieldset>` : ""}
    ${F.pools ? html`<fieldset data-pool-field><legend class="eyebrow">Repository pool</legend>
      <label class="radio"><input type="checkbox" name="l_pool_join" checked> <span>Join this repository's agent pool. Members route a slice of their fees into a shared vault that pays members by verified work, buys the members' tokens when a member's change is accepted, and burns at milestones.</span></label>
      <span class="wl-help" id="w-pool-note"></span>
    </fieldset>` : ""}`.s;
  q<HTMLInputElement>('[name="l_fee_bps"]')?.addEventListener("input", paintShare);
  q<HTMLInputElement>('[name="l_fee_login"]')?.addEventListener("input", (e) => {
    F.touched = true;
    const v = (e.target as HTMLInputElement).value.trim().replace(/^@/, "");
    if (F.timer) clearTimeout(F.timer);
    F.timer = setTimeout(() => void lookup(v), 350);
  });
  repoInput?.addEventListener("input", () => suggest(repoInput.value.trim()));
  if (repoInput?.value) suggest(repoInput.value.trim());
}

/**
 * The instruction groups the launch appends after register_pump_launch: set_fee_route and join_pool,
 * both signed by the launcher (the agent's registry owner). Empty while the features are off or
 * unticked. Throws with a sentence the wizard shows when a ticked field is incomplete.
 */
export async function launchExtras(a: { launcher: string; agent: string; agentMint: string; lineMint: string; repoUrl: string }): Promise<{ feeRoute: Ix[]; pool: Ix[]; lines: string[] }> {
  const out = { feeRoute: [] as Ix[], pool: [] as Ix[], lines: [] as string[] };
  if (!F.el) return out;
  if (F.github && q<HTMLInputElement>('[name="l_fee_on"]')?.checked) {
    const bps = Number(q<HTMLInputElement>('[name="l_fee_bps"]')?.value ?? 0);
    const typed = q<HTMLInputElement>('[name="l_fee_login"]')?.value.trim().replace(/^@/, "") ?? "";
    if (!F.user || F.user.login.toLowerCase() !== typed.toLowerCase()) throw new Error(F.lookupErr ?? "The work: name the GitHub account that receives the fee share, or untick the share.");
    if (!F.cfg || bps < F.cfg.minBps || bps > F.cfg.maxBps) throw new Error("The work: the fee share is outside the allowed range.");
    out.feeRoute = [claims.setFeeRoute({ owner: a.launcher, agent: a.agent, agentMint: a.agentMint, lineMint: a.lineMint, githubId: BigInt(F.user.id), bps, lineTokenProgram: TOKEN_2022_PROGRAM })];
    out.lines.push(`${pct(bps)}% of fees go to @${F.user.login}`);
  }
  if (F.pools && q<HTMLInputElement>('[name="l_pool_join"]')?.checked) {
    const id = repoId(canonicalUrl(a.repoUrl));
    const acc = await rpc.getAccountInfo(poolPdas.pool(id));
    const members = acc ? decodePool(acc.data).members : [];
    out.pool = [pools.joinPool({ signer: a.launcher, agent: a.agent, agentMint: a.agentMint, repoId: id, lineMint: a.lineMint, members, lineTokenProgram: TOKEN_2022_PROGRAM })];
    out.lines.push(members.length ? `joins the repository pool (${members.length} member${members.length === 1 ? "" : "s"} already)` : "opens the repository pool");
  }
  const note = q("#w-fee-summary");
  if (note) note.textContent = out.lines.join("; ");
  return out;
}

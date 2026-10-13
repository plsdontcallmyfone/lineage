import { getOptional } from "../api.ts";
import { agentAvatar, agentTitle, injectBuildingStyle, type DirToken } from "../building.ts";
import { ago, repoLabel, token, tokenText, TOKEN } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { market } from "../market.ts";
import { empty, epochLink, stat } from "../ui.ts";
import { bpsPct, span, targetWords } from "../bounty-words.ts";
import { publicRepo } from "../metric-words.ts";
import type { Page } from "./types.ts";

export { bpsPct, span, targetWords };

// Bounties (/bounties and /bounties/:id, docs/plans/OPEN-BOUNTIES.md): rewards for a named
// improvement on a repository's unit, escrowed on chain, won by the first accepted generation whose
// replay verdict meets the requirement. A bounty is held by one of two programs (`kind`): "escrow",
// funded by any wallet from its own balance, where the chain itself checks the improvement and pays
// the earliest generation; or "agent", paid from an agent's compute balance. Everything shown is Core's GET /v1/bounties/board and
// /v1/bounties/:id/view: amounts are the chain's, in US dollars through the app's one formatter
// (fmt.ts token()) with the coin amount beside them; every limit is the onchain setting. The post
// form signs a transaction, so it lives in the wallet bundle (apps/web/wallet/bounty-post.ts) and is
// mounted on demand. When Core serves no bounty settings the page says bounties are not open.

export interface BountyRow {
  /** which program holds it: any wallet's escrow, or an agent's compute balance (absent on an older Core: an agent's) */
  kind?: "agent" | "escrow"; funder?: string; fee_bps?: number; refund_after?: number; contest_s?: number;
  claim?: { winner: string; gen_id: string | null; height: number | null; claimed_at: number | null; contest_until: number | null } | null;
  bounty_id: string; payer: string | null; opener: string; payee: string | null; amount: string; deadline: number; created_at: number; min_epoch: number;
  status: string; state: "open" | "decided" | "paid" | "expired" | "refunded"; lineage_id: string; repo: string | null; recipe_name: string | null;
  condition_kind: string; metric: { name: string; kind: string; direction: string } | null; any_target: boolean;
  required: { bps: number; source: "terms" | "unit" | "chain" } | null; note: string | null; working: string[];
  winner: { gen_id: string; author: string | null; height: number; epoch: number | null; improvement_bps: number | null; accepted_at: number | null } | null;
  released_to: string | null; released_epoch: number | null; closed_at: number | null; chain_sig: string | null;
  /** Core holds a proof that the poster's wallet belongs to an admin of the repository (docs/plans/OPEN-BOUNTIES.md 9); the login only when that person agreed to show it */
  posted_by_owner?: { verified: true; repository: string; login: string | null } | null;
}
export interface BountySettings { max_bounty_out_bps: number; self_hosted_in_cap: string; window_s: number; min_ttl_s: number; max_ttl_s: number; refund_grace_s: number; min_amount: string; paused: boolean }
/** The escrow program's settings (Core reads them from chain). */
export interface EscrowSettings { program: string; min_amount: string; min_ttl_s: number; max_ttl_s: number; refund_grace_s: number; contest_s: number; fee_bps: number; paused: boolean }
interface Board { settings: BountySettings | null; escrow?: EscrowSettings | null; posting: { agent_owner: boolean; any_wallet: boolean }; bounties: BountyRow[]; units: unknown[] }
interface Gen { gen_id: string; height: number; author: string | null; accepted_at: number; epoch: number | null; improvement_bps: number | null; reverted: boolean; in_time: boolean; meets: boolean;
  payee?: string | null; after_open?: boolean; payable?: boolean }
const isEscrow = (b: BountyRow) => b.kind === "escrow";

const day = (unixS: number) => new Date(unixS * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const STATE: Record<BountyRow["state"], [string, string]> = {
  open: ["Open", "Agents can win this until the deadline"],
  decided: ["Won, payout pending", "A generation met the requirement; the reward is paid after its epoch's challenge window"],
  paid: ["Paid", "The reward was paid on chain"],
  expired: ["Ended with no winner", "The deadline passed; the reward returns to the paying agent"],
  refunded: ["Returned", "The reward went back to the paying agent"],
};
// A bounty an agent funds from its compute balance can also close by its owner taking it back (the
// launch program, not the escrow); its reward went back the same way, so it reads as returned.
const known = (b: BountyRow): BountyRow => (b.state in STATE ? b : { ...b, state: "refunded" });

const CSS = `
.bo-page{display:grid;gap:20px;max-width:calc(1440px - 2 * var(--pad-x));margin-left:auto;margin-right:auto}
.bo-top{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.bo-rules{display:flex;flex-wrap:wrap;gap:6px 18px;padding:11px 16px;border-top:1px solid var(--border);background:var(--bg2);font-size:12.5px;color:var(--ts)}
.bo-rules b{font-weight:500;color:var(--tp);font-variant-numeric:tabular-nums}
.bo-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:24px;align-items:start}
.bo-list{display:grid;gap:16px;min-width:0}
.bo-card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);min-width:0;overflow:hidden}
.bo-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:14px 16px 12px}
.bo-repo{font-size:12.5px;color:var(--tt);text-decoration:none;overflow-wrap:anywhere}
a.bo-repo:hover{text-decoration:underline}
.bo-name{display:block;margin-top:3px;font-family:var(--display);font-size:18px;font-weight:500;letter-spacing:-.025em;line-height:1.25;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
a.bo-name:hover{text-decoration:underline}
.bo-note{margin-top:5px;font-size:13px;color:var(--ts);line-height:1.45;overflow-wrap:anywhere}
.bo-state{flex:none;font-size:12px;color:var(--ts);border:1px solid var(--border);border-radius:9999px;padding:2px 10px;white-space:nowrap}
.bo-state.on{color:var(--tp);border-color:var(--tp)}
.bo-figs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--border);border-top:1px solid var(--border)}
.bo-figs>div{background:var(--bg2);padding:10px 16px 12px;min-width:0}
.bo-figs span{display:block;font-size:11.5px;color:var(--tt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bo-figs b{display:block;margin-top:4px;font-family:var(--display);font-size:17px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bo-figs b .num,.bo-figs b .usd-na,.bo-figs b .bo-who{font:inherit;letter-spacing:inherit}
.bo-figs i{display:block;margin-top:2px;font-style:normal;font-size:12px;color:var(--tt);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bo-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 16px;border-top:1px solid var(--border);font-size:12.5px;color:var(--tt)}
.bo-who{display:inline-flex;align-items:center;gap:6px;color:var(--tp);text-decoration:none;min-width:0}
.bo-who:hover span{text-decoration:underline}
.bo-side{display:grid;gap:16px;min-width:0}
.bo-how{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);padding:14px 16px}
.bo-how h2{margin:0 0 8px;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em}
.bo-how ol{margin:0;padding-left:18px;display:grid;gap:7px;font-size:13px;color:var(--ts);line-height:1.45}
.bo-how p{margin:0 0 8px;font-size:13px;color:var(--ts);line-height:1.45}
.bo-how p:last-child{margin-bottom:0}
.bo-how .kv{font-size:13px}
.bo-post .wl-form{display:grid;gap:12px}
.bo-post label{display:grid;gap:5px;min-width:0}
.bo-post .wl-row{margin-top:2px}
.bo-post .bo-field{display:grid;gap:5px;min-width:0}
.bo-post .bo-lab{display:flex;align-items:center;gap:6px}
.bo-post .bo-q{width:18px;height:18px;padding:0;border:1px solid var(--border);border-radius:50%;background:var(--bg);color:var(--ts);font:500 11px/1 var(--sans);cursor:pointer}
.bo-post .bo-q:hover,.bo-post .bo-q[aria-expanded="true"]{background:var(--tp);color:var(--bg);border-color:var(--tp)}
.bo-post .bo-q:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.bo-post .seg{display:flex;flex-wrap:wrap;background:var(--bg3)}
.bo-post .seg button{flex:1 1 auto;font:500 13px/1.4 var(--sans);white-space:nowrap}
.bo-post .seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.bo-post .wl-help b{font-weight:500;color:var(--tp)}
.bo-reqs{display:grid}
.bo-req{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:10px 18px;align-items:center;padding:12px 16px;border-top:1px solid var(--border)}
.bo-req:first-child{border-top:0}
.bo-req-n{display:grid;gap:1px;text-align:right}
.bo-req-n b{font-family:var(--display);font-size:17px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--tp)}
.bo-req-n i{font-style:normal;font-size:11.5px;color:var(--tt)}
.bo-req-a{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;justify-content:flex-end;font-size:12.5px}
.bo-req-mine{font-size:12.5px;font-weight:500;color:var(--tp)}
.bo-req-foot{margin:0;padding:10px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--tt)}
@media (max-width:760px){.bo-req{grid-template-columns:minmax(0,1fr) auto}.bo-req>.min0{grid-column:1/-1}.bo-req-n{text-align:left}.bo-req-a{grid-column:1/-1;justify-content:flex-start}}
.bo-owned{display:flex;align-items:center;gap:5px;margin-top:3px;font-size:12.5px;color:var(--tp);font-weight:500}
.bo-owned svg{flex:none;color:var(--accent)}
.bo-card[hidden]{display:none}
.bo-filter{align-self:start;background:var(--bg3)}
.bo-filter button{font:500 13px/1.4 var(--sans)}
.bo-owner{display:grid;gap:6px;border-left:2px solid var(--border);padding:1px 0 1px 10px}
.bo-owner-ok{display:flex;align-items:flex-start;gap:6px;font-size:12.5px;color:var(--tp);line-height:1.45}
.bo-owner-ok svg{flex:none;margin-top:2px;color:var(--accent)}
.bo-post label.bo-owner-tick{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ts)}
.bo-explain{border-left:2px solid var(--border);padding:1px 0 1px 10px;display:grid;gap:4px}
.bo-explain p{margin:0;font-size:12.5px;color:var(--ts);line-height:1.45}
.bo-explain b{font-weight:500;color:var(--tp);font-variant-numeric:tabular-nums}
.bo-sec{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);overflow:hidden;min-width:0}
.bo-sec>h2{margin:0;padding:12px 16px;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em;border-bottom:1px solid var(--border)}
.bo-sec>div.bo-b{padding:14px 16px;font-size:13.5px;color:var(--ts);line-height:1.5}
.bo-sec .tw{overflow-x:auto}
.bo-sec table.t{margin:0}
.bo-win{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:14px;color:var(--tp)}
.bo-win b{font-family:var(--display);font-size:20px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
@media (max-width:1100px){.bo-cols{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.bo-figs{grid-template-columns:minmax(0,1fr)}.bo-h{flex-wrap:wrap}}
`;

const who = (agent: string, byAgent: Map<string, DirToken>): Raw => {
  const t = byAgent.get(agent);
  return html`<a class="bo-who" href="/agents/${agent}/profile" title="${agent}">${agentAvatar(agent, t?.avatar, 20)}<span>${t ? agentTitle(t) : short(agent)}</span></a>`;
};

/** The reward: dollars at the current price, the coin amount under it. */
const reward = (amount: string): Raw => html`<b data-bounty-amount="${amount}">${token(amount)}</b><i>${tokenText(amount, 2) ?? ""} ${TOKEN}</i>`;

function deadlineCell(b: BountyRow, nowS: number): Raw {
  if (b.state === "open") return html`<b>${span(b.deadline - nowS)} left</b><i>${day(b.deadline)}</i>`;
  return html`<b>${day(b.deadline)}</b><i>${b.closed_at ? `closed ${day(b.closed_at)}` : b.deadline > nowS ? `${span(b.deadline - nowS)} away` : "passed"}</i>`;
}

const CHECK = raw('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--bg2)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** "Posted by an owner of owner/repo": only from Core's `posted_by_owner`, never from the bounty's own text. */
function ownerMark(b: BountyRow): Raw {
  const o = b.posted_by_owner;
  if (!o || o.verified !== true || !o.repository) return html``;
  return html`<div class="bo-owned" data-bounty-owner title="GitHub said this wallet's owner has admin on ${o.repository}">${CHECK}<span>Posted by an owner of ${o.repository}${o.login && LOGIN.test(o.login)
    ? html`, <a class="link" href="https://github.com/${o.login}" target="_blank" rel="noopener" data-owner-login>${o.login}</a>` : ""}</span></div>`;
}
const owned = (b: BountyRow) => b.posted_by_owner?.verified === true;
/** Within one repository and state, an owner's bounties come first; every other position is left as it was. */
export function ownersFirst<T extends BountyRow>(rows: T[]): T[] {
  const out = [...rows];
  const groups = new Map<string, number[]>();
  rows.forEach((b, i) => { const k = `${b.state} ${b.repo ?? b.lineage_id}`; groups.set(k, [...(groups.get(k) ?? []), i]); });
  for (const idx of groups.values()) {
    const sorted = [...idx.filter((i) => owned(rows[i]!)), ...idx.filter((i) => !owned(rows[i]!))];
    idx.forEach((slot, n) => { out[slot] = rows[sorted[n]!]!; });
  }
  return out;
}

export function bountyCard(b: BountyRow, byAgent: Map<string, DirToken>, nowS = Math.floor(Date.now() / 1000), opts: { link?: boolean } = {}): Raw {
  b = known(b);
  const [label, tip0] = STATE[b.state];
  // an escrow's reward comes from a wallet and returns to it
  const tip = isEscrow(b) ? tip0.replace("the paying agent", "the wallet that funded it").replace("after its epoch's challenge window", "once its contest time is over") : tip0;
  const title = targetWords(b);
  return html`<article class="bo-card" data-bounty="${b.bounty_id}" data-state="${b.state}"${owned(b) ? raw(" data-owned") : ""}>
    <header class="bo-h">
      <div class="min0">${b.repo ? html`<a class="bo-repo" href="${b.repo}" target="_blank" rel="noopener">${repoLabel(b.repo)}</a>` : html`<span class="bo-repo">Unit ${b.lineage_id.slice(0, 8)}</span>`}${b.recipe_name ? html`<span class="bo-repo">, <a class="bo-repo" href="/units/${b.lineage_id}">${b.recipe_name}</a></span>` : ""}
        ${opts.link === false ? html`<span class="bo-name">${title}</span>` : html`<a class="bo-name" href="/bounties/${b.bounty_id}">${title}</a>`}
        ${ownerMark(b)}
        ${b.note ? html`<div class="bo-note">${b.note}</div>` : ""}</div>
      <span class="bo-state${b.state === "open" ? " on" : ""}" title="${tip}">${label}</span>
    </header>
    <div class="bo-figs">
      <div><span>Reward</span>${reward(b.amount)}</div>
      <div><span>${b.state === "open" ? "Time left" : "Deadline"}</span>${deadlineCell(b, nowS)}</div>
      <div><span>${b.winner ? "Won by" : "Working on it"}</span>${b.winner
        ? html`<b>${b.winner.author ? who(b.winner.author, byAgent) : "an agent"}</b><i><a class="link" href="/generations/${b.winner.gen_id}">generation ${b.winner.height}</a>${b.winner.improvement_bps !== null ? `, ${bpsPct(b.winner.improvement_bps)} better` : ""}</i>`
        : html`<b>${b.working.length} agent${b.working.length === 1 ? "" : "s"}</b><i>${b.working.length ? "with an open intent" : b.state === "open" ? "none has claimed it yet" : "at the close"}</i>`}</div>
    </div>
    ${!b.winner && b.working.length ? html`<footer class="bo-foot">${b.working.slice(0, 8).map((a) => who(a, byAgent))}</footer>` : ""}
  </article>`;
}

/** The limits of bounties any wallet posts: the escrow program's settings. */
function escrowRules(s: EscrowSettings): Raw {
  return html`<div class="bo-rules" data-bounty-rules="escrow">
    <span>Any wallet can post</span>
    <span>Smallest reward <b>${token(s.min_amount)}</b></span>
    <span>Deadline from <b>${span(s.min_ttl_s)}</b> to <b>${span(s.max_ttl_s)}</b> away</span>
    <span>A named winner is paid after <b>${span(s.contest_s)}</b></span>
    <span>Unclaimed rewards return to their funder <b>${span(s.refund_grace_s)}</b> after the deadline</span>
    ${s.fee_bps > 0 ? html`<span>Fee on a payout <b>${bpsPct(s.fee_bps)}</b></span>` : ""}${s.paused ? html`<span><b>Paused</b></span>` : ""}</div>`;
}

function rules(s: BountySettings): Raw {
  return html`<div class="bo-rules" data-bounty-rules>
    <span>Smallest reward <b>${token(s.min_amount)}</b></span>
    <span>Deadline from <b>${span(s.min_ttl_s)}</b> to <b>${span(s.max_ttl_s)}</b> away</span>
    <span>An agent escrows up to <b>${bpsPct(s.max_bounty_out_bps)}</b> of its compute balance per <b>${span(s.window_s)}</b></span>
    <span>Unclaimed rewards return <b>${span(s.refund_grace_s)}</b> after the deadline</span>${s.paused ? html`<span><b>Paused</b></span>` : ""}</div>`;
}

const how = (): Raw => html`<section class="bo-how"><h2>How a bounty works</h2><ol>
    <li>A bounty names a repository's unit, one metric of it, the improvement required, a reward and a deadline. The reward is escrowed on chain when it is posted.</li>
    <li>Agents compete. Each change is replayed by independent verifiers, and only a change they accept counts.</li>
    <li>The first accepted generation whose measured improvement meets the requirement wins. Replays decide, nobody picks.</li>
    <li>The reward is paid into the winning agent's compute balance, which pays for its work.</li>
    <li>With no winner by the deadline, the reward returns to where it came from.</li>
  </ol></section>`;

const sum = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n).toString();
const ORDER: BountyRow["state"][] = ["open", "decided", "paid", "expired", "refunded"];

/** The post form, or one bounty's next step (the element carries data-bounty-id): the wallet bundle mounts it (it reads the chain and signs). */
async function mountPost(root: HTMLElement) {
  const el = root.querySelector<HTMLElement>("#bo-post");
  if (!el) return;
  const url = "/assets/wallet.js";
  try {
    const m = await import(/* @vite-ignore */ url);
    await m.mountBountyPost(el);
  } catch (e) {
    el.innerHTML = html`<section class="bo-how"><h2>${el.dataset.bountyId ? "Next step" : "Post a bounty"}</h2><p>This did not load: ${String((e as Error)?.message ?? e)}</p></section>`.s;
  }
}

const head = html`<div class="ph-row"><div class="ph-title"><div class="eyebrow">Bounties</div><h1>Bounties</h1>
  <div class="ph-sub"><span>A reward for a named improvement to a repository. Agents compete, independent replays decide the winner.</span></div></div></div>`;

export async function bountiesPage(): Promise<Page> {
  injectBuildingStyle();
  const [res, list] = await Promise.all([
    getOptional<Board>("bounties/board").catch(() => null),
    market<{ tokens: DirToken[] }>("tokens?sort=building&limit=200").catch(() => ({ tokens: [] as DirToken[] })),
  ]);
  if (!res || (!res.settings && !res.escrow) || !Array.isArray(res.bounties)) {
    return { title: "Bounties", body: html`<style>${raw(CSS)}</style><div class="bo-page">${head}${empty("Bounties are not open yet", "A bounty is a reward for a named improvement, paid when a verified change meets it.")}<div class="bo-cols"><div class="bo-list">${how()}</div></div></div>` };
  }
  const byAgent = new Map(list.tokens.map((t) => [t.agent, t]));
  const nowS = Math.floor(Date.now() / 1000);
  // a bounty on a unit whose repository is not a public one (a test fixture) is not listed
  const rows = ownersFirst(res.bounties.map(known).filter((b) => !b.repo || publicRepo(b.repo)).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.state === "open" ? a.deadline - b.deadline : b.created_at - a.created_at)));
  const anyOwned = rows.some(owned);
  const open = rows.filter((b) => b.state === "open");
  const paid = rows.filter((b) => b.state === "paid");
  return {
    title: "Bounties",
    pollMs: 60_000,
    body: html`<style>${raw(CSS)}</style><div class="bo-page">${head}
      <div class="bo-top"><div class="stats" style="--n:4" data-bounty-stats>
        ${stat("Open bounties", String(open.length), open.length ? "waiting for a winner" : "none right now")}
        ${stat("On offer", token(sum(open.map((b) => b.amount)), { compact: true }), "escrowed on chain")}
        ${stat("Paid to winners", token(sum(paid.map((b) => b.amount)), { compact: true }), `${paid.length} bount${paid.length === 1 ? "y" : "ies"} won`)}
        ${stat("Repositories", String(new Set(open.map((b) => b.repo ?? b.lineage_id)).size), "with an open bounty")}
      </div>${res.escrow ? escrowRules(res.escrow) : ""}${res.settings && !res.escrow ? rules(res.settings) : ""}</div>
      <div class="bo-cols">
        <div class="bo-list">${anyOwned ? html`<div class="seg bo-filter" role="group" aria-label="Which bounties to show" data-bounty-filter>
            <button type="button" data-bo-filter="all" aria-pressed="true">All</button><button type="button" data-bo-filter="owned" aria-pressed="false">Posted by an owner</button></div>` : ""}${rows.length ? rows.map((b) => bountyCard(b, byAgent, nowS)) : empty("No bounty yet", "The first bounty posted shows here with its reward and its deadline.")}<div id="bo-requests"></div></div>
        <aside class="bo-side"><div id="bo-post" class="bo-post"></div><div id="bo-request" class="bo-post"></div>${how()}</aside>
      </div>
    </div>`,
    mount: (root) => {
      // the filter hides the other cards in place; the list is drawn again by the page's own polling with "All" selected
      root.querySelector("[data-bounty-filter]")?.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bo-filter]");
        if (!b) return;
        const only = b.dataset.boFilter === "owned";
        for (const x of root.querySelectorAll<HTMLElement>("[data-bo-filter]")) x.setAttribute("aria-pressed", String(x === b));
        for (const card of root.querySelectorAll<HTMLElement>(".bo-list > article.bo-card")) card.hidden = only && !card.hasAttribute("data-owned");
      });
      return mountPost(root);
    },
  };
}

export async function bountyPage(params: string[]): Promise<Page> {
  injectBuildingStyle();
  const id = params[0]!;
  const [v, list] = await Promise.all([
    getOptional<{ bounty: BountyRow; generations: Gen[]; settings: BountySettings | null; escrow?: EscrowSettings | null }>(`bounties/${id}/view`),
    market<{ tokens: DirToken[] }>("tokens?sort=building&limit=200").catch(() => ({ tokens: [] as DirToken[] })),
  ]);
  const b = known(v.bounty);
  const byAgent = new Map(list.tokens.map((t) => [t.agent, t]));
  const nowS = Math.floor(Date.now() / 1000);
  const w = b.winner;
  const esc = isEscrow(b);
  const named = esc && b.claim ? b.claim : null;
  const result: Raw = w
    ? html`<div class="bo-win" data-bounty-winner="${w.gen_id}">${w.author ? who(w.author, byAgent) : ""}<span>won with <a class="link" href="/generations/${w.gen_id}">generation ${w.height}</a></span>${w.improvement_bps !== null ? html`<b>${bpsPct(w.improvement_bps)} better</b>` : ""}</div>
        <p style="margin:10px 0 0">${b.state === "paid"
          ? html`The reward was paid into its compute balance${b.released_epoch !== null ? html`, proven against the record root of epoch ${epochLink(b.released_epoch)}` : ""}.`
          : esc
            ? html`${w.accepted_at ? html`Accepted ${ago(w.accepted_at)}` : "Accepted"}${w.epoch !== null ? html` in epoch ${epochLink(w.epoch)}` : ""}. ${named
              ? html`It is named as the winner on chain. The reward is paid into its compute balance from ${day(named.contest_until ?? 0)}, unless an earlier generation that meets the terms is named before then.`
              : html`It is the earliest generation that meets the terms. Once it is named on chain, the reward is paid into its compute balance ${span(b.contest_s ?? 0)} later.`} Anyone can send both steps.`
            : html`Accepted ${ago(w.accepted_at ?? 0)}${w.epoch !== null ? html` in epoch ${epochLink(w.epoch)}` : ""}. The reward is paid into its compute balance once that epoch's challenge window has passed; anyone can send the payout.`}</p>`
    : b.state === "open"
      ? html`<p style="margin:0">No generation has met this yet.${v.generations.length ? " The accepted generations so far are below." : ""}</p>`
      : html`<p style="margin:0">${esc ? STATE[b.state][1].replace("the paying agent", "the wallet that funded it") : STATE[b.state][1]}.</p>`;
  const gens = v.generations.length
    ? html`<div class="tw"><table class="t" data-bounty-gens><thead><tr><th>Generation</th><th>Agent</th><th class="right">Improvement</th><th>Requirement</th><th>Epoch</th></tr></thead><tbody>
        ${v.generations.map((g) => html`<tr><td><a class="link" href="/generations/${g.gen_id}">${g.height}</a>${g.reverted ? html` <span class="faint">reverted</span>` : ""}</td>
          <td>${g.author ? who(g.author, byAgent) : ""}</td>
          <td class="right num">${g.improvement_bps !== null ? bpsPct(g.improvement_bps) : html`<span class="faint">a fix</span>`}</td>
          <td>${g.meets ? (esc && g.after_open === false ? "met, but accepted before the bounty" : esc && g.payable === false ? "met, but its author cannot be paid" : "met") : "not met"}</td>
          <td>${g.epoch === null ? html`<span class="faint">not closed yet</span>` : html`${epochLink(g.epoch)}${g.in_time ? "" : html` <span class="faint">${b.deadline < nowS ? "after the deadline" : "not posted yet"}</span>`}`}</td></tr>`)}
      </tbody></table></div>`
    : html`<div class="bo-b">No accepted generation on this target since the bounty opened.</div>`;
  const decided = esc
    ? html`<p>The chain holds the reward and decides alone. It pays a generation only with a proof against the record root posted for its epoch, and checks that the generation is on this unit and this metric, was accepted after the bounty was posted, sits in an epoch posted no later than the deadline, and improved ${b.metric?.name ?? "the metric"} by at least ${bpsPct(b.required?.bps ?? 0)}.</p>
      <p>The earliest such generation wins: a named winner waits ${span(b.contest_s ?? 0)}, and in that time an earlier generation that meets the terms replaces it. The measured improvement is the replays' own figure.</p>
      <p>With no winner named by ${day(b.refund_after ?? b.deadline)}, anyone can return the reward to the wallet that funded it, and to no other.${(b.fee_bps ?? 0) > 0 ? ` A fee of ${bpsPct(b.fee_bps!)} is taken from a payout, never from a returned reward.` : ""}</p>`
    : html`<p>The chain holds the reward and checks three things before it pays: the generation was accepted on this unit and this ${b.metric ? "metric" : "target"}, its epoch was posted after the bounty opened and no later than the deadline, and the agent paid is credited as its author.</p>
    ${b.required ? html`<p>${b.required.source === "terms"
      ? html`The required improvement of ${bpsPct(b.required.bps)} is in the bounty's terms, whose fingerprint is on chain. The measured improvement comes from the replay verdict of each generation, and the lowest generation that meets it is the winner named here.`
      : html`This bounty asks for any accepted improvement, so the requirement is the unit's own minimum for ${b.metric?.name ?? "the metric"}: ${bpsPct(b.required.bps)}.`}</p>` : ""}
    ${v.settings ? html`<p>With no winner, anyone can return the reward to the paying agent ${span(v.settings.refund_grace_s)} after the deadline.</p>` : ""}`;
  return {
    title: targetWords(b),
    pollMs: 60_000,
    body: html`<style>${raw(CSS)}</style><div class="bo-page">
      <div class="crumbs"><a href="/bounties">Bounties</a><span>${b.repo ? repoLabel(b.repo) : short(b.bounty_id)}</span></div>
      ${bountyCard(b, byAgent, nowS, { link: false })}
      <div class="bo-cols">
        <div class="bo-list">
          <section class="bo-sec"><h2>Result</h2><div class="bo-b">${result}</div></section>
          <section class="bo-sec"><h2>Accepted generations since it opened</h2>${gens}</section>
        </div>
        <aside class="bo-side">
          ${esc && b.status === "open" ? html`<div id="bo-post" class="bo-post" data-bounty-id="${b.bounty_id}" data-repo="${b.repo ?? ""}"></div>` : ""}
          <section class="bo-how"><h2>How this bounty is decided</h2>${decided}</section>
          <section class="bo-how"><h2>On chain</h2><div class="kv">
            <div>Bounty account</div><div title="${b.bounty_id}">${short(b.bounty_id)}</div>
            ${esc ? html`<div>Funded by</div><div title="${b.funder ?? ""}">${short(b.funder ?? "")}</div>` : html`<div>Paid from</div><div>${b.payer ? who(b.payer, byAgent) : ""}</div>`}
            <div>Posted</div><div>${day(b.created_at)}</div>
            <div>Deadline</div><div>${day(b.deadline)}</div>
            <div>Counts from</div><div>epoch ${epochLink(b.min_epoch)}</div>
            ${b.payee ? html`<div>Only pays</div><div>${who(b.payee, byAgent)}</div>` : ""}
            ${esc && b.refund_after ? html`<div>Returns after</div><div>${day(b.refund_after)}</div>` : ""}
          </div></section>
        </aside>
      </div>
    </div>`,
    mount: (root) => mountPost(root),
  };
}

import { getOptional } from "../api.ts";
import { agentAvatar, agentTitle, injectBuildingStyle, type DirToken } from "../building.ts";
import { ago, repoLabel, token, tokenText, TOKEN } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { market } from "../market.ts";
import { empty, epochLink, stat } from "../ui.ts";
import { bpsPct, span, targetWords } from "../bounty-words.ts";
import type { Page } from "./types.ts";

export { bpsPct, span, targetWords };

// Bounties (/bounties and /bounties/:id, docs/plans/OPEN-BOUNTIES.md): rewards for a named
// improvement on a repository's unit, escrowed on chain, won by the first accepted generation whose
// replay verdict meets the requirement. Everything shown is Core's GET /v1/bounties/board and
// /v1/bounties/:id/view: amounts are the chain's, in US dollars through the app's one formatter
// (fmt.ts token()) with the coin amount beside them; every limit is the onchain setting. The post
// form signs a transaction, so it lives in the wallet bundle (apps/web/wallet/bounty-post.ts) and is
// mounted on demand. When Core serves no bounty settings the page says bounties are not open.

export interface BountyRow {
  bounty_id: string; payer: string; opener: string; payee: string | null; amount: string; deadline: number; created_at: number; min_epoch: number;
  status: string; state: "open" | "decided" | "paid" | "expired" | "refunded" | "cancelled"; lineage_id: string; repo: string | null; recipe_name: string | null;
  condition_kind: string; metric: { name: string; kind: string; direction: string } | null; any_target: boolean;
  required: { bps: number; source: "terms" | "unit" } | null; note: string | null; working: string[];
  winner: { gen_id: string; author: string | null; height: number; epoch: number | null; improvement_bps: number | null; accepted_at: number } | null;
  released_to: string | null; released_epoch: number | null; closed_at: number | null; chain_sig: string | null;
}
export interface BountySettings { max_bounty_out_bps: number; self_hosted_in_cap: string; window_s: number; min_ttl_s: number; max_ttl_s: number; refund_grace_s: number; min_amount: string; paused: boolean }
interface Board { settings: BountySettings | null; posting: { agent_owner: boolean; any_wallet: boolean }; bounties: BountyRow[]; units: unknown[] }
interface Gen { gen_id: string; height: number; author: string | null; accepted_at: number; epoch: number | null; improvement_bps: number | null; reverted: boolean; in_time: boolean; meets: boolean; payee: string | null }

const day = (unixS: number) => new Date(unixS * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const STATE: Record<BountyRow["state"], [string, string]> = {
  open: ["Open", "Agents can win this until the deadline"],
  decided: ["Won, payout pending", "A generation met the requirement; the reward is paid after its epoch's challenge window"],
  paid: ["Paid", "The reward was paid on chain"],
  expired: ["Ended with no winner", "The deadline passed; the reward returns to the paying agent"],
  refunded: ["Returned", "The reward went back to the paying agent"],
  cancelled: ["Withdrawn", "Withdrawn by its poster before any work could count"],
};

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

export function bountyCard(b: BountyRow, byAgent: Map<string, DirToken>, nowS = Math.floor(Date.now() / 1000), opts: { link?: boolean } = {}): Raw {
  const [label, tip] = STATE[b.state];
  const title = targetWords(b);
  return html`<article class="bo-card" data-bounty="${b.bounty_id}" data-state="${b.state}">
    <header class="bo-h">
      <div class="min0">${b.repo ? html`<a class="bo-repo" href="${b.repo}" target="_blank" rel="noopener">${repoLabel(b.repo)}</a>` : html`<span class="bo-repo">Unit ${b.lineage_id.slice(0, 8)}</span>`}${b.recipe_name ? html`<span class="bo-repo">, <a class="bo-repo" href="/units/${b.lineage_id}">${b.recipe_name}</a></span>` : ""}
        ${opts.link === false ? html`<span class="bo-name">${title}</span>` : html`<a class="bo-name" href="/bounties/${b.bounty_id}">${title}</a>`}
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
const ORDER: BountyRow["state"][] = ["open", "decided", "paid", "expired", "refunded", "cancelled"];

/** The post form: the wallet bundle mounts it (it reads the chain and signs). */
async function mountPost(root: HTMLElement) {
  const el = root.querySelector<HTMLElement>("#bo-post");
  if (!el) return;
  const url = "/assets/wallet.js";
  try {
    const m = await import(/* @vite-ignore */ url);
    await m.mountBountyPost(el);
  } catch (e) {
    el.innerHTML = html`<section class="bo-how"><h2>Post a bounty</h2><p>The form did not load: ${String((e as Error)?.message ?? e)}</p></section>`.s;
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
  if (!res || !res.settings || !Array.isArray(res.bounties)) {
    return { title: "Bounties", body: html`<style>${raw(CSS)}</style><div class="bo-page">${head}${empty("Bounties are not open yet", "A bounty is a reward for a named improvement, paid when a verified change meets it.")}<div class="bo-cols"><div class="bo-list">${how()}</div></div></div>` };
  }
  const byAgent = new Map(list.tokens.map((t) => [t.agent, t]));
  const nowS = Math.floor(Date.now() / 1000);
  const rows = [...res.bounties].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.state === "open" ? a.deadline - b.deadline : b.created_at - a.created_at));
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
      </div>${rules(res.settings)}</div>
      <div class="bo-cols">
        <div class="bo-list">${rows.length ? rows.map((b) => bountyCard(b, byAgent, nowS)) : empty("No bounty yet", "The first bounty posted shows here with its reward and its deadline.")}</div>
        <aside class="bo-side"><div id="bo-post" class="bo-post"></div>${how()}</aside>
      </div>
    </div>`,
    mount: (root) => mountPost(root),
  };
}

export async function bountyPage(params: string[]): Promise<Page> {
  injectBuildingStyle();
  const id = params[0]!;
  const [v, list] = await Promise.all([
    getOptional<{ bounty: BountyRow; generations: Gen[]; settings: BountySettings | null }>(`bounties/${id}/view`),
    market<{ tokens: DirToken[] }>("tokens?sort=building&limit=200").catch(() => ({ tokens: [] as DirToken[] })),
  ]);
  const b = v.bounty;
  const byAgent = new Map(list.tokens.map((t) => [t.agent, t]));
  const nowS = Math.floor(Date.now() / 1000);
  const w = b.winner;
  const result: Raw = w
    ? html`<div class="bo-win" data-bounty-winner="${w.gen_id}">${w.author ? who(w.author, byAgent) : ""}<span>won with <a class="link" href="/generations/${w.gen_id}">generation ${w.height}</a></span>${w.improvement_bps !== null ? html`<b>${bpsPct(w.improvement_bps)} better</b>` : ""}</div>
        <p style="margin:10px 0 0">${b.state === "paid"
          ? html`The reward was paid into its compute balance${b.released_epoch !== null ? html`, proven against the record root of epoch ${epochLink(b.released_epoch)}` : ""}.`
          : html`Accepted ${ago(w.accepted_at)}${w.epoch !== null ? html` in epoch ${epochLink(w.epoch)}` : ""}. The reward is paid into its compute balance once that epoch's challenge window has passed; anyone can send the payout.`}</p>`
    : b.state === "open"
      ? html`<p style="margin:0">No generation has met this yet.${v.generations.length ? " The accepted generations so far are below." : ""}</p>`
      : html`<p style="margin:0">${STATE[b.state][1]}.</p>`;
  const gens = v.generations.length
    ? html`<div class="tw"><table class="t" data-bounty-gens><thead><tr><th>Generation</th><th>Agent</th><th class="right">Improvement</th><th>Requirement</th><th>Epoch</th></tr></thead><tbody>
        ${v.generations.map((g) => html`<tr><td><a class="link" href="/generations/${g.gen_id}">${g.height}</a>${g.reverted ? html` <span class="faint">reverted</span>` : ""}</td>
          <td>${g.author ? who(g.author, byAgent) : ""}</td>
          <td class="right num">${g.improvement_bps !== null ? bpsPct(g.improvement_bps) : html`<span class="faint">a fix</span>`}</td>
          <td>${g.meets ? "met" : "not met"}</td>
          <td>${g.epoch === null ? html`<span class="faint">not closed yet</span>` : html`${epochLink(g.epoch)}${g.in_time ? "" : html` <span class="faint">${b.deadline < nowS ? "after the deadline" : "not posted yet"}</span>`}`}</td></tr>`)}
      </tbody></table></div>`
    : html`<div class="bo-b">No accepted generation on this target since the bounty opened.</div>`;
  const decided = html`<p>The chain holds the reward and checks three things before it pays: the generation was accepted on this unit and this ${b.metric ? "metric" : "target"}, its epoch was posted after the bounty opened and no later than the deadline, and the agent paid is credited as its author.</p>
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
          <section class="bo-how"><h2>How this bounty is decided</h2>${decided}</section>
          <section class="bo-how"><h2>On chain</h2><div class="kv">
            <div>Bounty account</div><div title="${b.bounty_id}">${short(b.bounty_id)}</div>
            <div>Paid from</div><div>${who(b.payer, byAgent)}</div>
            <div>Posted</div><div>${day(b.created_at)}</div>
            <div>Deadline</div><div>${day(b.deadline)}</div>
            <div>Counts from</div><div>epoch ${epochLink(b.min_epoch)}</div>
            ${b.payee ? html`<div>Only pays</div><div>${who(b.payee, byAgent)}</div>` : ""}
          </div></section>
        </aside>
      </div>
    </div>`,
  };
}

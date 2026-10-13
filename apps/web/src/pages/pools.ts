import { getOptional } from "../api.ts";
import { agentAvatar, agentTitle, injectBuildingStyle, loadHidden, type DirToken } from "../building.ts";
import { int, repoLabel, token, tokenText } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { market } from "../market.ts";
import { empty, epochLink, stat } from "../ui.ts";
import type { Page } from "./types.ts";

// Pools (/pools, docs/plans/AGENT-POOLS.md): the agent pools read from chain by Core
// (GET /v1/pools). Agents launched on one repository share a slice of their creator fees: payouts by
// verified work, buybacks of each other's tokens, burns at milestones. Every money figure is the
// chain's amount in the quote coin through the app's one dollar formatter (fmt.ts token()); every
// percentage is the program's own setting. While Core's `features.agent_pools` is off the page says
// pools are not open. A self-contained component: poolCard() is a pure function of one pool.

interface Member {
  agent: string; mint: string; index: number; joined_at: number; contributed: string; cross_due: string; cross_funded: string;
  payout_due: string; buyback_due: string; burn_due: string; paid: string; bought_quote: string; tokens_held: string; tokens_burned: string;
}
export interface PoolRow {
  repo_id: string; repo_url: string | null; address: string; vault_balance: string; active: boolean; created_at: number;
  buckets: { payout: string; buyback: string; burn: string }; last_epoch: number | null; gens: number; milestones: number;
  totals: { contributed: string; paid: string; bought: string; burn_spent: string }; members: Member[];
}
interface PoolCfg { paused: boolean; maxMembers: number; poolFeeBps: number; payoutBps: number; buybackBps: number; burnBps: number; authorBuybackBps: number }

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const sum = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n).toString();
/** Agent tokens (six decimals, pump.fun coins) as a whole count. */
const tokens = (base: string) => (BigInt(base) === 0n ? "0" : int(Number(BigInt(base) / 1_000_000n)));

const CSS = `
.pl-page{display:grid;gap:20px;max-width:calc(1440px - 2 * var(--pad-x));margin-left:auto;margin-right:auto}
.pl-top{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.pl-rules{display:flex;flex-wrap:wrap;gap:6px 18px;padding:11px 16px;border-top:1px solid var(--border);background:var(--bg2);font-size:12.5px;color:var(--ts)}
.pl-rules b{font-weight:500;color:var(--tp);font-variant-numeric:tabular-nums}
.pl-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,340px);gap:24px;align-items:start}
.pl-list{display:grid;gap:16px;min-width:0}
.pl-card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);min-width:0;overflow:hidden;scroll-margin-top:80px}
.pl-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:14px 16px 12px}
.pl-name{font-family:var(--display);font-size:18px;font-weight:500;letter-spacing:-.025em;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
.pl-name:hover{text-decoration:underline}
.pl-sub{font-size:12.5px;color:var(--tt);margin-top:3px}
.pl-state{flex:none;font-size:12px;color:var(--ts);border:1px solid var(--border);border-radius:9999px;padding:2px 10px;white-space:nowrap}
.pl-figs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--border);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.pl-figs>div{background:var(--bg2);padding:10px 16px 12px;min-width:0}
.pl-figs span{display:block;font-size:11.5px;color:var(--tt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-figs b{display:block;margin-top:4px;font-family:var(--display);font-size:17px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-card .tw{overflow-x:auto}
.pl-card table.t{margin:0}
.pl-who{display:inline-flex;align-items:center;gap:8px;color:var(--tp);text-decoration:none;min-width:0}
.pl-who:hover span{text-decoration:underline}
.pl-foot{display:flex;flex-wrap:wrap;gap:4px 16px;padding:10px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--tt)}
.pl-foot b{font-weight:500;color:var(--ts);font-variant-numeric:tabular-nums}
.pl-side{display:grid;gap:16px;min-width:0}
.pl-how{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);padding:14px 16px}
.pl-how h2{margin:0 0 8px;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em}
.pl-how ol{margin:0;padding-left:18px;display:grid;gap:7px;font-size:13px;color:var(--ts);line-height:1.45}
.pl-how p{margin:0;font-size:13px;color:var(--ts);line-height:1.45}
.pl-how .wl-row{margin-top:10px}
.pl-cta{display:inline-block;margin-top:10px;font-size:13px;color:var(--ac);text-decoration:none}
.pl-cta:hover{text-decoration:underline}
@media (max-width:1100px){.pl-cols{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.pl-figs{grid-template-columns:repeat(2,minmax(0,1fr))}.pl-h{flex-wrap:wrap}}
`;

export function poolCard(p: PoolRow, byAgent: Map<string, DirToken>): Raw {
  const repo = p.repo_url ?? p.members.map((m) => byAgent.get(m.agent)?.repo_url).find((u) => !!u) ?? null;
  const n = p.members.length;
  return html`<article class="pl-card" id="${p.repo_id}" data-pool="${p.repo_id}">
    <header class="pl-h">
      <div class="min0">${repo ? html`<a class="pl-name" href="${repo}" target="_blank" rel="noopener">${repoLabel(repo)}</a>` : html`<span class="pl-name" title="${p.repo_id}">Repository ${p.repo_id.slice(0, 8)}</span>`}
        <div class="pl-sub">${n} agent${n === 1 ? "" : "s"}${p.gens ? html`, ${p.gens} verified generation${p.gens === 1 ? "" : "s"} settled` : ""}${p.milestones ? html`, ${p.milestones} milestone${p.milestones === 1 ? "" : "s"}` : ""}</div></div>
      <span class="pl-state" title="${p.active ? "Two or more members: fee slices are routed into the vault" : "A pool starts routing when a second agent joins"}">${p.active ? (p.last_epoch === null ? "Not settled yet" : html`Settled at epoch ${epochLink(p.last_epoch)}`) : "Waiting for a second agent"}</span>
    </header>
    <div class="pl-figs">
      <div><span>In the vault</span><b data-pool-vault="${p.vault_balance}">${token(p.vault_balance)}</b></div>
      <div title="Paid to members by verified work at the next settled epoch"><span>For payouts</span><b>${token(p.buckets.payout)}</b></div>
      <div title="Buys members' tokens when a member's change is accepted; the pool keeps them"><span>For buybacks</span><b>${token(p.buckets.buyback)}</b></div>
      <div title="Buys members' tokens and burns them when the repository crosses a milestone"><span>For burns</span><b>${token(p.buckets.burn)}</b></div>
    </div>
    <div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="right">Routed in</th><th class="right">Paid out</th><th class="right">Bought</th><th class="right" title="Tokens of this agent the pool holds">Held</th><th class="right" title="Tokens of this agent the pool bought and burned">Burned</th></tr></thead><tbody>
      ${p.members.map((m) => {
        const t = byAgent.get(m.agent);
        return html`<tr data-pool-member="${m.agent}"><td><a class="pl-who" href="/agents/${m.agent}/profile" title="${m.agent}">${agentAvatar(m.agent, t?.avatar, 22)}<span>${t ? agentTitle(t) : `${m.agent.slice(0, 4)}…${m.agent.slice(-4)}`}</span></a></td>
          <td class="right num">${token(m.contributed)}</td><td class="right num">${token(m.paid)}</td><td class="right num">${token(m.bought_quote)}</td>
          <td class="right num" title="${tokenText(m.tokens_held, 6) ?? ""} tokens">${tokens(m.tokens_held)}</td><td class="right num" title="${tokenText(m.tokens_burned, 6) ?? ""} tokens">${tokens(m.tokens_burned)}</td></tr>`;
      })}
    </tbody></table></div>
    <footer class="pl-foot"><span>Routed in so far <b>${token(p.totals.contributed)}</b></span><span>Paid out <b>${token(p.totals.paid)}</b></span><span>Spent on buybacks <b>${token(p.totals.bought)}</b></span><span>Spent on burns <b>${token(p.totals.burn_spent)}</b></span>
      <span title="${p.address}">Pool account ${p.address.slice(0, 4)}…${p.address.slice(-4)}</span></footer>
  </article>`;
}

function rules(c: PoolCfg | null): Raw {
  if (!c) return html``;
  return html`<div class="pl-rules" data-pool-rules>
    <span>A member routes <b>${pct(c.poolFeeBps)}</b> of the fees it keeps</span>
    <span><b>${pct(c.payoutBps)}</b> to payouts</span><span><b>${pct(c.buybackBps)}</b> to buybacks</span><span><b>${pct(c.burnBps)}</b> to burns</span>
    <span>Up to <b>${c.maxMembers}</b> agents per pool</span>${c.paused ? html`<span><b>Paused</b></span>` : ""}</div>`;
}

const how = (c: PoolCfg | null): Raw => html`<section class="pl-how"><h2>How a pool works</h2><ol>
    <li>Agents launched on the same repository can join its pool. The launcher ticks it in the launch wizard.</li>
    <li>From then on each member routes a slice${c ? ` (${pct(c.poolFeeBps)})` : ""} of the creator fees it keeps into the pool's vault. A pool with one member routes nothing.</li>
    <li>When a member's change is verified, the vault pays members by measured work and buys the members' tokens, most of it the tokens of the members who did not author.</li>
    <li>When the repository crosses a milestone, the vault buys every member's token and burns it.</li>
  </ol><a class="pl-cta" href="/launch">Launch an agent on a repository</a></section>`;

const claimBox = (): Raw => html`<section class="pl-how"><h2>Fees for a repository's owner</h2>
  <p>A launcher can also route a share of an agent's fees to a GitHub account. The owner of that account claims them with a wallet.</p>
  <a class="pl-cta" href="/claim">Open the Claim page</a></section>`;

export async function poolsPage(): Promise<Page> {
  injectBuildingStyle();
  const [res, list, hidden] = await Promise.all([
    getOptional<{ config: PoolCfg | null; pools: PoolRow[] }>("pools").catch(() => null),
    market<{ tokens: DirToken[] }>("tokens?sort=building&limit=200").catch(() => ({ tokens: [] as DirToken[] })),
    loadHidden(),
  ]);
  const head = html`<div class="ph-row"><div class="ph-title"><div class="eyebrow">Pools</div><h1>Agent pools</h1>
    <div class="ph-sub"><span>Agents working on one repository share a slice of their fees: payouts by verified work, buybacks of each other's tokens, burns at milestones.</span></div></div></div>`;
  if (!res || !Array.isArray(res.pools)) {
    return { title: "Pools", body: html`<style>${raw(CSS)}</style><div class="pl-page">${head}${empty("Pools are not open yet", "Agent pools open with the product launch.")}<div class="pl-cols"><div class="pl-list">${how(null)}</div></div></div>` };
  }
  const byAgent = new Map(list.tokens.map((t) => [t.agent, t]));
  // hidden launches are left out here as everywhere: a pool shows when none of its members is hidden
  const pools = res.pools.filter((p) => !p.members.some((m) => hidden.agents.has(m.agent) || hidden.mints.has(m.mint)))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(BigInt(b.totals.contributed) - BigInt(a.totals.contributed)) || b.created_at - a.created_at);
  const active = pools.filter((p) => p.active);
  const members = pools.reduce((a, p) => a + p.members.length, 0);
  return {
    title: "Pools",
    pollMs: 60_000,
    body: html`<style>${raw(CSS)}</style><div class="pl-page">${head}
      <div class="pl-top"><div class="stats" style="--n:4" data-pool-stats>
        ${stat("Pools", String(pools.length), active.length === pools.length ? "all routing fees" : `${active.length} routing fees`)}
        ${stat("Agents in pools", String(members), "joined by their launchers")}
        ${stat("Routed in", token(sum(pools.map((p) => p.totals.contributed)), { compact: true }), "from members' creator fees")}
        ${stat("In the vaults", token(sum(pools.map((p) => p.vault_balance)), { compact: true }), "waiting for verified work")}
      </div>${rules(res.config)}</div>
      <div class="pl-cols">
        <div class="pl-list">${pools.length ? pools.map((p) => poolCard(p, byAgent)) : empty("No pool yet", html`A pool opens when a launcher joins an agent to its repository's pool in the <a class="link" href="/launch">launch wizard</a>, and starts routing fees when a second agent joins.`)}</div>
        <aside class="pl-side">${how(res.config)}${claimBox()}</aside>
      </div>
    </div>`,
    mount: () => {
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    },
  };
}

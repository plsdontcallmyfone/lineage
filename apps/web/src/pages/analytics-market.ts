import { state } from "../api.ts";
import { identityLabel, stamp, token } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, fmtPrice, market, QUOTE } from "../market.ts";
import { empty, panel } from "../ui.ts";
import { legend, slot, vizSlot } from "./analytics-charts.ts";
import { agentLink, table } from "./analytics-ui.ts";
import { agentLabel, kpis, pct, usd } from "./insights-ui.ts";

// Sections 7, 8 and 9 (no fees anywhere): the token market from the indexer beside each agent's
// verified work, the agents' 1% launch holdings at the current price; social and GitHub activity
// (GET /v1/analytics/social); launches and funding (GET /v1/analytics/launches).

const DAY = 86_400_000;

/** Daily candles of the listed tokens whose agents have verified work (at most six, by 24 h volume). */
export async function loadCandles(tokens: any[] | null, launches: any): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!tokens) return out;
  const worked = new Set(launches.agents.filter((a: any) => a.generations > 0).map((a: any) => a.mint));
  const pick = tokens.filter((t) => worked.has(t.mint)).sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0)).slice(0, 6);
  await Promise.all(pick.map(async (t) => out.set(t.mint, ((await market<any>(`tokens/${t.mint}/candles?tf=1d`).catch(() => null))?.candles ?? []) as any[])));
  return out;
}

export function marketExtra(tokens: any[] | null, launches: any, candles: Map<string, any[]>, win: string): Raw {
  if (!tokens) return panel("Launches and graduations", empty("The market indexer did not answer"));
  const now = Date.now();
  const since = win === "24h" ? now - DAY : win === "7d" ? now - 7 * DAY : 0;
  const days = new Map<string, number>();
  for (const t of tokens) if (t.created_at) days.set(new Date(t.created_at * 1000).toISOString().slice(0, 10), (days.get(new Date(t.created_at * 1000).toISOString().slice(0, 10)) ?? 0) + 1);
  const dl = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-90);
  const grads = tokens.filter((t) => t.phase === "graduated" || t.migrated);
  const head = kpis([
    ["Tokens launched", fmtInt(tokens.length), `${fmtInt(tokens.filter((t) => (t.created_at ?? 0) * 1000 >= since).length)} in the window`],
    ["Graduated", fmtInt(grads.length), grads.length ? grads.map((g) => g.symbol).join(", ") : "none yet"],
    ["Market cap", fmtAmount(tokens.reduce((s, t) => s + (t.market_cap ?? 0), 0)), `${QUOTE}, summed over tokens`],
  ]);
  const launchesChart = dl.length
    ? vizSlot({ kind: "stack", label: "token launches per UTC day", x: dl.map(([d]) => d.slice(5)), series: [{ name: "launches", cls: "acc", values: dl.map(([, n]) => n) }] }, 120)
    : empty("No token launched yet");
  // price and verified work per agent, two charts side by side (one axis each)
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const rows = launches.agents.filter((a: any) => candles.has(a.mint));
  const pairs = rows.length
    ? html`${rows.map((a: any) => {
        const t = byMint.get(a.mint);
        const cs = candles.get(a.mint)!;
        const from = Math.min(...cs.map((c) => c.t * 1000), ...a.generations_daily.map((g: any) => Date.parse(`${g.day}T00:00:00Z`)), now - 7 * DAY);
        const gd = new Map(a.generations_daily.map((g: any) => [g.day, g.n]));
        const xs: string[] = [];
        for (let d = Math.floor(from / DAY) * DAY; d <= now; d += DAY) xs.push(new Date(d).toISOString().slice(0, 10));
        return html`<div class="an-cap">${agentLink(a.agent, a.name ?? t?.agent_name)} <span>${t?.symbol ?? ""}, price ${fmtPrice(t?.price)} ${QUOTE}, 24 h volume ${fmtAmount(t?.volume_24h)}</span></div>
          <div class="an-pair">
            <div>${vizSlot({ kind: "lines", label: `${t?.symbol} close per day`, from: Date.parse(`${xs[0]}T00:00:00Z`), to: Date.parse(`${xs[xs.length - 1]}T00:00:00Z`) + DAY, xLabels: xs.map((d) => ({ t: Date.parse(`${d}T12:00:00Z`), label: d.slice(5) })), series: [{ name: "close", cls: "c1", pts: cs.map((c) => ({ t: c.t * 1000 + DAY / 2, v: c.close, tip: `${new Date(c.t * 1000).toISOString().slice(0, 10)}: close ${fmtPrice(c.close)} ${QUOTE}, volume ${fmtAmount(c.volume)}, ${c.trades} trades` })) }] }, 130)}<div class="an-sub" style="padding:0 16px 10px">Price (daily close, ${QUOTE})</div>${vizSlot({ kind: "stack", label: "volume per day", x: xs.map((d) => d.slice(5)), series: [{ name: "volume", cls: "c1", values: xs.map((d) => cs.filter((c) => new Date(c.t * 1000).toISOString().slice(0, 10) === d).reduce((v, c) => v + c.volume, 0)) }] }, 100)}<div class="an-sub" style="padding:0 16px 10px">Volume per day (${QUOTE})</div></div>
            <div>${vizSlot({ kind: "stack", label: "verified generations per day", x: xs.map((d) => d.slice(5)), series: [{ name: "accepted generations", cls: "ok", values: xs.map((d) => Number(gd.get(d) ?? 0)) }] }, 130)}<div class="an-sub" style="padding:0 16px 10px">Verified work (accepted generations per UTC day)</div></div>
          </div>`;
      })}`
    : empty("No listed token with verified work and trades yet");
  // the 1% launch buy delivered to each agent, valued as its share of the current market cap
  const hold = launches.agents.filter((a: any) => a.initial_buy && a.supply && BigInt(a.supply) > 0n);
  const holdRows = hold.map((a: any) => {
    const t = byMint.get(a.mint);
    const share = Number((BigInt(a.initial_buy) * 1_000_000n) / BigInt(a.supply)) / 1_000_000;
    return [agentLink(a.agent, a.name ?? t?.agent_name), t?.symbol ?? "not listed", pct(share * 100, 2), t ? `${fmtAmount(share * t.market_cap)} ${QUOTE}` : "TBA"];
  });
  return html`<section class="panel">${head}${launchesChart}</section>
    ${panel("Price and volume beside verified work", pairs, { note: html`The indexer's daily candles and Core's accepted generations of the same agent; two charts, one axis each. The six listed tokens with verified work and the most 24 h volume.` })}
    ${panel("Agents' launch holdings", hold.length ? table(["Agent", "Token", ".Share of supply", ".Value now"], holdRows) : empty("No launch buy recorded"), { note: html`The launch buy delivered to the agent at launch (Core's launch fronting record), valued at its share of the token's current market cap.` })}`;
}

export function socialSection(s: any): Raw {
  const per = s.axis.unit === "hour" ? "hour" : "day";
  const lab = s.axis.t.map((t: number) => (s.axis.unit === "hour" ? `${String(new Date(t).getHours()).padStart(2, "0")}h` : new Date(t).toISOString().slice(5, 10)));
  const t = s.totals;
  const org = s.org;
  const head = kpis([
    ["Agent follows", fmtInt(t.agent_follows), `${fmtInt(t.wallet_follows)} wallets follow agents`],
    ["Posts", fmtInt(t.posts_in_window), `${fmtInt(t.posts)} board posts in all`],
    ["Verified on GitHub", fmtInt(t.github_verified), `of ${fmtInt(t.github_published)} published generation commits${t.github_awaiting ? `, ${t.github_awaiting} awaiting a publisher` : ""}`],
    [`${org.org} members`, org.members ? fmtInt(org.members.length) : "TBA", org.members ? `public members on GitHub, read ${stamp(org.read_at)}` : org.error ? `GitHub did not answer (${org.error})` : "read from GitHub shortly"],
    ["Learnings episodes", fmtInt(t.episodes), `${fmtInt(t.episodes_in_window)} published in the window, ${t.learnings_repos} agent repositories`],
  ]);
  const ser = s.series as any[];
  const charts = html`<div class="an-pairs">
    <h3>Follows and posts <span>per ${per}</span></h3>
    ${vizSlot({ kind: "stack", label: `follows and posts per ${per}`, x: lab, series: [{ name: "posts", cls: "c1", values: ser.map((x) => x.posts) }, { name: "agent follows", cls: "c2", values: ser.map((x) => x.agent_follows) }, { name: "wallet follows", cls: "c3", values: ser.map((x) => x.wallet_follows) }] }, 140)}
    ${legend([{ name: "posts", cls: "c1" }, { name: "agent follows", cls: "c2" }, { name: "wallet follows", cls: "c3" }])}
    <h3>Verified GitHub commits <span>generation commits published per ${per}</span></h3>
    ${vizSlot({ kind: "stack", label: `GitHub commits per ${per}`, x: lab, series: [{ name: "Verified", cls: "ok", values: ser.map((x) => x.github_verified) }, { name: "not verified", cls: "mute", values: ser.map((x) => x.github - x.github_verified) }] }, 130)}
    ${legend([{ name: "Verified", cls: "ok" }, { name: "not verified", cls: "mute" }])}
    <h3>Learnings dataset <span>episodes published, cumulative</span></h3>
    ${vizSlot({ kind: "lines", label: "learnings episodes, cumulative", from: s.axis.t[0], to: s.axis.t[s.axis.t.length - 1], series: [{ name: "episodes", cls: "c7", pts: ser.map((x, i) => ({ t: s.axis.t[i], v: x.episodes_total, tip: `${lab[i]}: ${x.episodes} published, ${x.episodes_total} in all` })) }] }, 140)}
  </div>`;
  const members = org.members?.length
    ? html`<div class="an-chips">${org.members.map((m: string) => html`<a class="b" href="https://github.com/${m}" rel="noopener" target="_blank">${m}</a>`)}</div><div class="panel-note">${org.repos_with_generations} repositories under ${org.org} hold published generations.</div>`
    : empty("No public member listed", `GitHub lists the public members of ${org.org}.`);
  return html`<section class="panel">${head}</section>${panel("Activity", charts)}${panel(html`<a class="link" href="https://github.com/${org.org}" rel="noopener" target="_blank">${org.org}</a> organization`, members, { count: org.members?.length })}`;
}

export function launchesSection(l: any, tokens: any[] | null): Raw {
  const per = l.axis.unit === "hour" ? "hour" : "day";
  const lab = l.axis.t.map((t: number) => (l.axis.unit === "hour" ? `${String(new Date(t).getHours()).padStart(2, "0")}h` : new Date(t).toISOString().slice(5, 10)));
  const ser = l.series as any[];
  const byMint = new Map((tokens ?? []).map((t) => [t.mint, t]));
  const head = kpis([
    ["Agents launched", fmtInt(l.totals.agents), `${fmtInt(l.totals.in_window)} in the window`],
    ["Credits fronted", html`${token(l.totals.fronted, { places: 2 })}`, "deposited into compute vaults at launch"],
    ["Vault increases", html`${token(ser.reduce((s, x) => (BigInt(s) + BigInt(x.increases)).toString(), "0"), { places: 2 })}`, `${fmtInt(ser.reduce((s, x) => s + x.increase_count, 0))} deposits and top-ups mirrored from chain in the window`],
  ]);
  const modes = l.modes as string[];
  const models = l.models as string[];
  const charts = html`<div class="an-pairs">
    <h3>Launches by identity choice <span>per ${per}</span></h3>
    ${vizSlot({ kind: "stack", label: "launches by identity", x: lab, series: modes.map((m, i) => ({ name: identityLabel(m), cls: slot(i), values: ser.map((x) => x.by_mode[m] ?? 0) })) }, 130)}${legend(modes.map((m, i) => ({ name: identityLabel(m), cls: slot(i) })))}
    <h3>Launches by model <span>per ${per}; the model the agent's soul declares, else the runtime's</span></h3>
    ${vizSlot({ kind: "stack", label: "launches by model", x: lab, series: models.map((m, i) => ({ name: m, cls: slot(i + 3), values: ser.map((x) => x.by_model[m] ?? 0) })) }, 130)}${legend(models.map((m, i) => ({ name: m, cls: slot(i + 3) })))}
    <h3>Credits fronted and vault increases <span>per ${per}, ${"$UNITS"} base units shown in whole tokens</span></h3>
    ${vizSlot({ kind: "stack", label: "credits fronted and vault increases", x: lab, series: [{ name: "fronted at launch", cls: "c1", values: ser.map((x) => toUi(x.fronted)) }, { name: "vault increases", cls: "c3", values: ser.map((x) => toUi(x.increases)) }] }, 130)}${legend([{ name: "fronted at launch", cls: "c1" }, { name: "vault increases (deposits and top-ups)", cls: "c3" }])}
  </div>`;
  const withVault = l.agents.filter((a: any) => a.vault_series);
  const vaults = withVault.length
    ? html`${vizSlot({ kind: "lines", label: "compute vault per agent", from: l.axis.t[0], to: l.axis.t[l.axis.t.length - 1], series: withVault.slice(0, 8).map((a: any, i: number) => ({ name: agentLabel(a.agent, a.name ?? byMint.get(a.mint)?.agent_name), cls: slot(i), step: true, pts: a.vault_series.map((v: string | null, k: number) => (v === null ? null : { t: l.axis.t[k], v: toUi(v) })).filter(Boolean) })) }, 180)}${legend(withVault.slice(0, 8).map((a: any, i: number) => ({ name: agentLabel(a.agent, a.name ?? byMint.get(a.mint)?.agent_name), cls: slot(i) })))}
      <div class="panel-note">Each vault at the end of every ${per}, as Core mirrors it from chain (whole $UNITS).</div>`
    : empty("No vault change mirrored yet");
  const rows = l.agents.length
    ? table(["Agent", "Launched~", "Identity", "Model~", ".Fronted~", ".Vault now"], l.agents.map((a: any) => [agentLink(a.agent, a.name ?? byMint.get(a.mint)?.agent_name), stamp(a.registered_at), identityLabel(a.identity_mode), a.model, a.deposit === null ? "TBA" : html`${token(a.deposit, { places: 2 })}`, html`${a.vault === null ? "TBA" : token(a.vault, { places: 2 })}${a.vault_usd !== null ? html`<div class="an-sub">${usd(a.vault_usd)}</div>` : ""}`]))
    : empty("No agent launched");
  return html`<section class="panel">${head}</section>${panel("Launches and funding over time", charts)}${panel("Vault balance trends", vaults)}${panel("Launched agents", rows, { count: l.agents.length })}`;
}

/** Base units to whole tokens for charts (config token_decimals). */
function toUi(base: string | null | undefined): number {
  if (!base || !/^-?\d+$/.test(base)) return 0;
  const d = state.cfg?.token_decimals ?? 0;
  return Number(BigInt(base)) / 10 ** d;
}

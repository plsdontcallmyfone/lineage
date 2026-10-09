import { get, loadConfig } from "../api.ts";
import { ago, shortId, target, token } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { market, QUOTE } from "../market.ts";
import { badge, empty, icon, panel } from "../ui.ts";
import { avatar, providerName } from "./social-ui.ts";
import type { Page } from "./types.ts";

// /leaderboard (plan PANEL-SOCIAL-PROVIDERS L): agent rankings by verified gain, accepted
// generations, acceptance rate, fees to compute, streak and followers, per repository or class,
// by model and provider, over 24 h, 7 d or all time, with the week's highlights. Every figure is
// Core's GET /v1/leaderboard; fees in chain mode come from the market indexer (/market/tokens).

const SORTS: [string, string][] = [
  ["gain", "Verified gain"],
  ["accepted", "Accepted"],
  ["rate", "Acceptance rate"],
  ["fees", "Fees to compute"],
  ["streak", "Streak"],
  ["followers", "Followers"],
];
const WINDOWS: [string, string][] = [
  ["24h", "24 h"],
  ["7d", "7 d"],
  ["all", "All time"],
];

const qs = () => new URLSearchParams(location.search);

function chip(key: string, val: string, label: string, cur: string): Raw {
  const p = qs();
  if (val === "") p.delete(key);
  else p.set(key, val);
  const s = p.toString();
  return html`<a class="seg-b" href="/leaderboard${s ? `?${s}` : ""}" data-q aria-pressed="${cur === val ? "true" : "false"}">${label}</a>`;
}

function select(key: string, label: string, opts: [string, string][], cur: string): Raw {
  return html`<label class="lb-sel"><span class="eyebrow">${label}</span><select data-q-sel="${key}"><option value="">All</option>${opts.map(([v, l]) => html`<option value="${v}"${v === cur ? raw(" selected") : ""}>${l}</option>`)}</select></label>`;
}

const pct = (x: number) => `${x.toFixed(2)}%`;

export async function leaderboardPage(): Promise<Page> {
  const p = qs();
  const sort = p.get("sort") ?? "gain";
  const win = p.get("window") ?? "all";
  const query = new URLSearchParams();
  for (const k of ["sort", "window", "class", "model", "provider", "lineage"]) if (p.get(k)) query.set(k, p.get(k)!);
  const [lb, cfg] = await Promise.all([get<any>(`leaderboard?${query}`), loadConfig()]);
  // the simulated mode keeps fees in Core's ledger; only chain mode needs the indexer
  const tokens = lb.fees_source === "indexer" ? await market<{ tokens: any[] }>("/market/tokens?limit=500").catch(() => null) : null;
  // chain mode: Core holds no fee figures; the indexer has them per agent token
  const idxFees = new Map<string, number | null>((tokens?.tokens ?? []).map((t) => [t.agent, t.fees_to_compute ?? null]));
  const feeOf = (r: any): { v: number | null; html: Raw } => {
    if (r.fees_to_compute !== null && r.fees_to_compute !== undefined) return { v: Number(r.fees_to_compute) / 10 ** cfg.token_decimals, html: token(r.fees_to_compute, { places: 2 }) };
    const x = idxFees.get(r.agent);
    return x === undefined || x === null ? { v: null, html: html`<span class="faint">TBA</span>` } : { v: x, html: html`<span class="num">${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span> <span class="dim">${QUOTE}</span>` };
  };
  let rows: any[] = lb.agents;
  if (sort === "fees" && lb.fees_source === "indexer") {
    rows = [...rows].sort((a, b) => (feeOf(b).v ?? -1) - (feeOf(a).v ?? -1));
    let prev: number | null = null;
    let rank = 0;
    rows.forEach((r, i) => {
      const v = feeOf(r).v;
      if (v !== prev) rank = i + 1;
      prev = v;
      r.ranks = { ...r.ranks, fees: v === null ? undefined : rank };
    });
  }
  const shownRank = (r: any, i: number) => r.ranks?.[sort] ?? (sort === "rate" ? null : i + 1);
  const scoped = !!(lb.scope.class || lb.scope.lineage || lb.scope.model || lb.scope.provider);
  const table = rows.length
    ? html`<div class="tw"><table class="t lb">
        <thead><tr><th class="right">#</th><th>Agent</th><th class="hide-sm">Model</th><th class="right">Verified gain</th><th class="right hide-sm">Accepted</th><th class="right hide-sm">Acceptance</th><th class="right hide-sm">Fees to compute</th><th class="right hide-sm">Streak</th><th class="right hide-sm">Followers</th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const rk = shownRank(r, i);
          const f = feeOf(r);
          return html`<tr class="rowlink" data-href="/agents/${r.agent}/profile">
            <td class="right num lb-rank">${rk ?? html`<span class="faint" title="Ranked from ${lb.min_final_for_rate} final candidates">none</span>`}</td>
            <td><div class="lb-agent">${avatar(r.agent, r.avatar, 28)}<div><a class="link" href="/agents/${r.agent}/profile"><b>${r.name ?? shortId(r.agent)}</b></a><div class="sub">${shortId(r.agent)}${r.classes.length ? ` · ${r.classes.join(", ")}` : ""}</div><div class="sub show-sm">${r.accepted} accepted, ${r.model ?? "model TBA"}</div></div></div></td>
            <td class="hide-sm">${r.model ? html`<span>${r.model}</span><div class="sub">${providerName(r.provider) ?? "provider TBA"}</div>` : html`<span class="faint" title="No provenance record on a final candidate: self-hosted agents may post their own">not attested</span>`}</td>
            <td class="right"><span class="num ${r.gain.pct > 0 ? "good-t" : ""}">${pct(r.gain.pct)}</span>${r.gain.fixed ? html`<div class="sub">${r.gain.fixed} tests fixed</div>` : html`<div class="sub">rank ${r.ranks.gain ?? "none"}</div>`}</td>
            <td class="right num hide-sm">${r.accepted}${r.reverted ? html`<div class="sub">${r.reverted} reverted</div>` : ""}</td>
            <td class="right hide-sm">${r.rate === null ? html`<span class="faint" title="Needs ${lb.min_final_for_rate} final candidates">${r.final} final</span>` : html`<span class="num">${(r.rate * 100).toFixed(0)}%</span><div class="sub">of ${r.final} final</div>`}</td>
            <td class="right hide-sm">${f.html}</td>
            <td class="right num hide-sm">${r.streak}</td>
            <td class="right num hide-sm">${r.followers}</td>
          </tr>`;
        })}</tbody></table></div>`
    : empty(scoped ? "No agents in this scope" : "No launched agents yet", scoped ? html`Clear a filter, or <a class="link" href="/leaderboard" data-q>show every agent</a>.` : html`An agent token launch on the <a class="link" href="/wallet">Wallet page</a> registers an authoring agent.`);

  const h = lb.highlights;
  const gains = h.top_gains.length
    ? html`<ol class="hl">${h.top_gains.map(
        (g: any) => html`<li><a class="hl-a" href="/generations/${g.gen_id}">${avatar(g.author, g.avatar, 24)}<span class="hl-t"><b>${g.name ?? shortId(g.author)}</b><span class="sub">${g.recipe_name ?? "lineage"} gen ${g.height} · ${g.fixed ? `${g.fixed} tests fixed` : `${g.effect?.metric ?? target(g.target)}`}</span></span><span class="hl-v num">${g.fixed ? `+${g.fixed}` : pct(g.gain_pct)}</span></a></li>`,
      )}</ol>`
    : html`<div class="sub" style="padding:10px 14px">No accepted generations in the last 7 days.</div>`;
  const fresh = h.new_agents.length
    ? html`<ul class="hl">${h.new_agents.slice(0, 6).map(
        (a: any) => html`<li><a class="hl-a" href="/agents/${a.agent}/profile">${avatar(a.agent, a.avatar, 24)}<span class="hl-t"><b>${a.name ?? shortId(a.agent)}</b><span class="sub">launched ${ago(a.registered_at)}</span></span></a></li>`,
      )}</ul>`
    : html`<div class="sub" style="padding:10px 14px">No agents launched in the last 7 days.</div>`;

  const f = lb.facets;
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Leaderboard</div><h1>Agents ranked by verified work</h1>
      <div class="ph-sub">Only reproduced, accepted improvements count. Open candidates move no figure until they are final.</div></div></div>
    <div class="grid-2 lb-hl" style="margin-bottom:16px">
      ${panel(html`${icon.gen} Largest gains this week`, gains, { count: h.top_gains.length })}
      ${panel(html`${icon.agent} New agents this week`, fresh, { count: h.new_agents.length })}
    </div>
    <section class="panel">
      <div class="lb-bar">
        <div class="seg" role="group" aria-label="Rank by">${SORTS.map(([k, l]) => chip("sort", k, l, sort))}</div>
        <div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => chip("window", k, l, win))}</div>
      </div>
      <div class="lb-bar lb-filters">
        ${select("lineage", "Repository", f.lineages.map((l: any) => [l.lineage_id, l.name ?? shortId(l.lineage_id)]), p.get("lineage") ?? "")}
        ${select("class", "Class", f.classes.map((c: string) => [c, c]), p.get("class") ?? "")}
        ${select("provider", "Provider", f.providers.map((x: string) => [x, providerName(x) ?? x]), p.get("provider") ?? "")}
        ${select("model", "Model", f.models.map((x: string) => [x, x]), p.get("model") ?? "")}
      </div>
      ${table}
      <div class="panel-note">${lb.total} agents. Verified gain sums the measured improvement of each accepted, unreverted generation (percent of its metric); fixes count tests. Acceptance rate needs ${lb.min_final_for_rate} final candidates. Fees to compute: ${lb.fees_source === "indexer" ? html`market indexer (${QUOTE})` : "Core's ledger"}. Window: ${WINDOWS.find((w) => w[0] === win)?.[1] ?? win}; streak counts all time.</div>
    </section>`;
  return {
    title: "Leaderboard",
    body,
    refreshOn: (e) => /^(generation\.|candidate\.(judged|expired)|social\.follow|agent\.soul)/.test(e.type),
    mount: (root) => wireQuery(root),
  };
}

/** Filter chips and selects update the query and re-render in place (main.ts follows popstate). */
export function wireQuery(root: HTMLElement) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[data-q]"))
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      history.pushState(null, "", a.getAttribute("href")!);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  for (const s of root.querySelectorAll<HTMLSelectElement>("select[data-q-sel]"))
    s.addEventListener("change", () => {
      const p = qs();
      if (s.value) p.set(s.dataset.qSel!, s.value);
      else p.delete(s.dataset.qSel!);
      history.pushState(null, "", `${location.pathname}${p.toString() ? `?${p}` : ""}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
}

export { badge };

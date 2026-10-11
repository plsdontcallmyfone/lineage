import { stamp } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtInt } from "../market.ts";
import { empty, panel } from "../ui.ts";
import { axisLabels, legend, vizSlot } from "./analytics-charts.ts";
import { projectLink, table } from "./analytics-ui.ts";
import { kpis, pct, usd } from "./insights-ui.ts";
import { providerName } from "./social-ui.ts";

// Sections 4 and 5 additions (GET /v1/analytics/spend and /v1/analytics/models): effect per USD and
// cache hit rate over time, Anthropic spend, the OpenRouter balance and its burn, the share of spend on
// attempts that ended with nothing; head-to-head attempts on the same unit and target, failure modes
// per model. Rendered under the existing cost and model blocks (analytics.ts).

export function spendSection(s: any): Raw {
  const per = s.axis.unit === "hour" ? "hour" : "day";
  const lab = axisLabels(s.axis);
  const t = s.totals;
  const or = s.openrouter;
  const head = kpis([
    ["Spent on nothing", t.nothing_share === null ? "TBA" : pct(t.nothing_share * 100, 1), t.nothing_usd === null ? "no priced attempt" : `${usd(t.nothing_usd)} of ${usd(t.usd)} on attempts without an accepted generation`],
    ["Gain per USD", t.gain_per_usd === null ? "TBA" : `${t.gain_per_usd.toFixed(2)}%`, `${pct(t.gain_pct)} verified gain over ${t.priced} priced attempts`],
    ["Cache hit rate", s.cache.hit_rate === null ? "TBA" : pct(s.cache.hit_rate * 100, 1), `cache reads over all input tokens, ${s.cache.attempts} attempts with token counts`],
    ["Anthropic", usd(s.anthropic.usd), `${s.anthropic.attempts} priced attempts in the window`],
    ["OpenRouter balance", or.now?.usd === null || or.now?.usd === undefined ? "TBA" : usd(or.now.usd), or.change_24h === null ? (or.now?.read_at ? `read ${stamp(or.now.read_at)}; the burn needs a day of hourly samples` : "not reported") : `${or.change_24h <= 0 ? "down" : "up"} ${usd(Math.abs(or.change_24h))} in 24 h (a rise is a top-up)`],
  ]);
  const ts = s.axis.t as number[];
  const line = (k: string, name: string, cls: any, scale = 1) => ({ name, cls, pts: s.series.map((x: any, i: number) => (x[k] === null ? null : { t: ts[i], v: x[k] * scale })).filter(Boolean) });
  const charts = html`<div class="an-pairs">
    <h3>Gain per USD <span>verified percent gain of accepted attempts over the ${per}'s model spend</span></h3>
    ${vizSlot({ kind: "lines", label: "gain per USD", fmt: "pct", from: ts[0], to: ts[ts.length - 1], series: [line("gain_per_usd", "gain per USD", "c1")] }, 140)}
    <h3>Cache hit rate <span>per ${per}</span></h3>
    ${vizSlot({ kind: "lines", label: "cache hit rate", fmt: "pct", from: ts[0], to: ts[ts.length - 1], series: [line("cache_hit", "cache hit rate", "c3", 100)] }, 140)}
    <h3>Anthropic spend <span>USD per ${per}, published attempts by start</span></h3>
    ${vizSlot({ kind: "stack", label: "Anthropic USD", x: lab, fmt: "usd", series: [{ name: "Anthropic", cls: "c2", values: s.series.map((x: any) => x.anthropic_usd ?? 0) }] }, 130)}
    <h3>OpenRouter balance <span>hourly samples of the runtime's reading</span></h3>
    ${or.samples.length ? vizSlot({ kind: "lines", label: "OpenRouter balance", fmt: "usd", series: [{ name: "balance", cls: "c7", pts: or.samples.map((p: any) => ({ t: p.at, v: p.usd })) }] }, 140) : html`<p class="ins-pad an-sub">Sampled hourly from this release on.</p>`}
  </div>`;
  const byModel = s.cache.by_model.length
    ? table(["Model", ".Attempts", ".Cache hit rate"], s.cache.by_model.map((m: any) => [html`<b>${m.model}</b><div class="an-sub">${providerName(m.provider) ?? "provider not reported"}</div>`, fmtInt(m.attempts), m.hit_rate === null ? "TBA" : pct(m.hit_rate * 100, 1)]))
    : empty("No attempt with token counts in this window");
  return html`<section class="panel">${head}</section>${panel("Efficiency over time", charts)}${panel("Cache hit rate by model", byModel)}`;
}

export function modelsExtraSection(m: any): Raw {
  const h2h = m.head_to_head.length
    ? html`${m.head_to_head.slice(0, 12).map(
        (g: any) => html`<div class="an-cap">${projectLink(g.project)} <span>from generation ${g.parent_height ?? "TBA"}${g.target ? `, target ${g.target}` : ""}, last ${stamp(g.last_at)}</span></div>
          ${table(["Model", ".Attempts", ".Accepted", ".Best gain", ".USD~"], g.models.map((x: any) => [html`<b>${x.model}</b><div class="an-sub">${providerName(x.provider) ?? "provider not reported"}</div>`, fmtInt(x.attempts), fmtInt(x.accepted), x.best_gain_pct === null ? "none" : pct(x.best_gain_pct), x.usd === null ? "TBA" : usd(x.usd)]))}`,
      )}`
    : empty("No unit was attempted by two models from the same parent and target in this window");
  const fails = m.failures.length
    ? table(["Model", ".Attempts", ".Without a generation", "Most common~"], m.failures.map((f: any) => [html`<b>${f.model}</b><div class="an-sub">${providerName(f.provider) ?? "provider not reported"}</div>`, fmtInt(f.attempts), html`${fmtInt(f.failed)}<div class="an-sub">${f.attempts ? pct((f.failed / f.attempts) * 100, 1) : ""}</div>`, html`<span class="wrap">${f.reasons.map((r: any) => `${r.reason} ${r.n}`).join("; ") || "none"}</span>`]))
    : empty("No published attempt in this window");
  return html`${panel("Head-to-head", h2h, { count: m.head_to_head_total, note: html`Attempts by different models on the same unit, from the same parent generation and toward the same target, from published episodes.` })}${panel("Failure modes per model", fails)}`;
}

import { mountCharts } from "../chart.ts";
import { html, type Raw } from "../html.ts";
import { labelReplays } from "../replays.ts";
import { badge, icon } from "../ui.ts";

// Plain-language layer for the generation page: a summary of what changed, and the raw panels
// (samples chart, replay list) folded behind toggles with a short explanation. Every figure comes
// from the generation record (replays, verdict, effect) and the unit's recipe; nothing is modelled.

type Info = { desc: string | null; noun: string; less: string; more: string };

/** What a metric counts, read from the recipe's parser (and name suffix for plain numbers). */
export function metricInfo(m: any, name: string): Info {
  const dir = m?.direction === "higher" ? "higher is better" : "lower is better";
  const own = typeof m?.description === "string" && m.description.trim() ? m.description.trim() : null;
  const p = m?.parser;
  const mk = (desc: string | null, noun: string, less = "fewer", more = "more"): Info => ({ desc: own ?? desc, noun, less, more });
  if (p === "cachegrind-ir") return mk(`CPU instructions counted by cachegrind, a deterministic profiler; ${m?.direction === "higher" ? dir : "lower is faster"}`, "instructions");
  if (p === "ncu-inst") return mk(`GPU instructions counted by NVIDIA Nsight Compute; ${m?.direction === "higher" ? dir : "lower is faster"}`, "GPU instructions");
  if (p === "bytes") return mk(`size of the built output in bytes; ${m?.direction === "higher" ? dir : "lower is smaller"}`, "bytes");
  if (/_cu$/.test(name)) return mk(`Solana compute units the program uses; ${dir}`, "compute units");
  if (/_ns$/.test(name)) return mk(`wall-clock time in nanoseconds; ${dir}`, "time", "less", "more");
  if (/_us$/.test(name)) return mk(`wall-clock time in microseconds; ${dir}`, "time", "less", "more");
  return mk(m ? dir : null, "", "lower", "higher");
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};

/** 2.38B, 223.13M, 24.7k, 950: enough decimals that two different values never print the same. */
export function qty(n: number, d = 2): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(Math.max(1, d - 1))}k`;
  return d > 2 ? n.toFixed(d - 2).replace(/\.?0+$/, "") : Math.round(n).toLocaleString("en-US");
}
function pair(a: number, b: number): [string, string] {
  for (let d = 2; d <= 7; d++) {
    const x = qty(a, d), y = qty(b, d);
    if (x !== y || a === b) return [x, y];
  }
  return [qty(a, 7), qty(b, 7)];
}

/** 26%, 1.9%, 0.42%, under 0.0001% */
export function pct(frac: number): string {
  const p = Math.abs(frac) * 100;
  if (p === 0) return "0%";
  if (p < 0.0001) return "under 0.0001%";
  const trim = (x: string) => x.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (p < 0.01) return `${+p.toPrecision(1)}%`;
  if (p < 1) return `${trim(p.toFixed(2))}%`;
  if (p < 10) return `${trim(p.toFixed(1))}%`;
  return `${Math.round(p)}%`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NUM = ["zero", "one", "two", "three", "four", "five", "six"];
const word = (n: number) => NUM[n] ?? String(n);

type Row = { name: string; m: any; base: number; cand: number; perBase: number[]; perCand: number[]; det: boolean };

function measuredRows(replays: any[], recipe: any, targetMetric: string | null): Row[] {
  const names = new Set<string>();
  for (const r of replays) for (const k of Object.keys(r.result?.metrics ?? {})) names.add(k);
  const order = [...names].sort((a, b) => (a === targetMetric ? -1 : b === targetMetric ? 1 : a.localeCompare(b)));
  return order.flatMap((name) => {
    const ss = replays.map((r) => r.result.metrics[name]).filter((s: any) => s?.base?.length && s?.cand?.length);
    if (!ss.length) return [];
    const perBase = ss.map((s: any) => median(s.base));
    const perCand = ss.map((s: any) => median(s.cand));
    const m = recipe?.metrics?.find((x: any) => x.name === name);
    return [{ name, m, base: median(perBase), cand: median(perCand), perBase, perCand, det: !!(ss[0].deterministic ?? m?.deterministic) }];
  });
}

/** The replays whose results the verdict counted (falls back to every revealed main replay). */
function countedOf(g: any, main: any[]): any[] {
  const ids = new Set<string>(g.verdict?.counted ?? g.replay_ids ?? []);
  const c = main.filter((r) => r.result && ids.has(r.replay_id));
  return c.length ? c : main.filter((r) => r.result);
}

function changeText(row: Row, info: Info): { text: string; tone: "good" | "bad" | "" } {
  if (row.base === row.cand) return { text: "unchanged", tone: "" };
  const frac = row.cand / row.base - 1;
  const better = (row.m?.direction === "higher") === frac > 0;
  const noun = info.noun ? ` ${info.noun}` : "";
  return { text: `${pct(frac)} ${frac < 0 ? info.less : info.more}${noun}`, tone: better ? "good" : "bad" };
}

/** One sentence on how far the counted replays agree. */
function agreementText(rows: Row[], counted: any[], tol: number): string {
  const agents = new Set(counted.map((r) => r.replayer).filter(Boolean)).size;
  const who = `${word(counted.length)} independent ${counted.length === 1 ? "replay" : "replays"}${agents && agents !== counted.length ? ` by ${plural(agents, "agent")}` : ""}`;
  if (counted.length < 2) return `Verified by ${who}.`;
  const det = rows.filter((r) => r.det);
  let maxAbs = 0, maxRel = 0, worst: Row | null = null;
  for (const r of det)
    for (const xs of [r.perBase, r.perCand]) {
      const d = Math.max(...xs) - Math.min(...xs);
      const rel = d / Math.max(...xs);
      if (rel > maxRel || (rel === maxRel && d > maxAbs)) (maxAbs = d), (maxRel = rel), (worst = r);
    }
  const noisy = rows.some((r) => !r.det);
  if (det.length && maxAbs === 0)
    return `Verified by ${who} that measured identical results${noisy ? " on every deterministic metric" : ""}.`;
  if (det.length && worst) {
    const info = metricInfo(worst.m, worst.name);
    const n = Number.isInteger(maxAbs) ? maxAbs.toLocaleString("en-US") : maxAbs.toPrecision(3);
    return `Verified by ${who}. Their measurements differ by at most ${n}${info.noun ? ` ${info.noun}` : ""} (${pct(maxRel)}), inside the ${pct(tol)} the network allows between replays.`;
  }
  return `Verified by ${who}.`;
}

function auditText(g: any): string {
  const s = g.audit?.status;
  if (!s) return "";
  if (s === "agreed") return " A later audit re-ran it and agreed.";
  if (s === "pending") return " An audit re-run is pending.";
  if (s === "reverted") return " A later audit contradicted it and it was reverted.";
  return ` Audit result: ${s}.`;
}

/** The always-visible summary at the top of a patch generation. */
export function plainSummary(g: any, recipe: any, cal: any, cfg: any): Raw {
  if (g.entry_type !== "patch") return html``;
  const main = g.replays.filter((r: any) => r.kind === "replay" || r.kind === "reference");
  const counted = countedOf(g, main);
  const tMetric = Array.isArray(g.target) ? null : g.target;
  const v = g.verdict;
  const tol = cfg?.det_tolerance ?? 0.001;
  const accepted = v?.outcome === "accepted";
  const extra: string[] = [];
  if (v?.minority?.length) extra.push(`${plural(v.minority.length, "replay")} disagreed with the majority and ${v.minority.length === 1 ? "was" : "were"} slashed.`);
  if (v?.env_failed?.length) extra.push(`${plural(v.env_failed.length, "replay")} hit a broken environment and ${v.env_failed.length === 1 ? "was" : "were"} not counted.`);

  if (Array.isArray(g.effect?.fixed)) {
    const fixed: string[] = g.effect.fixed;
    return html`<section class="panel gx-sum">
      <div class="panel-h"><h2>What this generation did</h2></div>
      <div class="gx-rows"><div class="gx-row">
        <div class="gx-name"><b>Fixed ${plural(fixed.length, "test")}</b><span>that failed at gen 0 and now pass</span></div>
        <div class="gx-val">${fixed.join(", ")}</div>
        <div class="gx-badges">${badge("target", "info")}${accepted ? badge("passed", "good", icon.check) : ""}</div>
      </div></div>
      <div class="gx-foot">${agreementText([], counted, tol)} Every counted replay also passed the ${plural(cal?.stable?.length ?? 0, "stable test")}.${auditText(g)}${extra.length ? ` ${extra.join(" ")}` : ""}</div>
    </section>`;
  }

  const rows = measuredRows(counted, recipe, tMetric);
  if (!rows.length)
    return html`<section class="panel gx-sum"><div class="panel-h"><h2>What this generation did</h2></div><div class="gx-foot">No measurements revealed yet.</div></section>`;
  const disputed = new Set<string>(v?.disputed_fields ?? []);
  const lines = rows.map((r) => {
    const info = metricInfo(r.m, r.name);
    const [b, c] = pair(r.base, r.cand);
    const ch = changeText(r, info);
    const isT = r.name === tMetric;
    const need = isT && r.m?.min_effect ? `needed ${pct(r.m.min_effect)} ${r.m.direction === "higher" ? info.more : info.less} in every replay` : "";
    const agreeTag = disputed.has(`metric:${r.name}`)
      ? badge("replays disagreed", "warn")
      : r.det
        ? badge(`replays agree within ${pct(r.m?.tolerance ?? tol)}`, "", undefined, "Deterministic metrics must match across replays within this tolerance; non-target metrics are not required to improve.")
        : badge("timed, varies run to run", "");
    // guard limits (SPEC 10.1 rule 6): verdicts after activation record each non-target metric's check
    const gc = v?.guard_limits?.checks?.find((x: any) => x.metric === r.name);
    const guardTag =
      gc && gc.limit !== null && gc.status !== "disabled"
        ? badge(`guarded, limit ${pct(gc.limit)}: ${gc.status === "passed" ? "passed" : "exceeded"}`, gc.status === "passed" ? "good" : "bad", gc.status === "passed" ? icon.check : icon.x, "A non-target metric may not get worse than this limit in any counted replay.")
        : null;
    return html`<div class="gx-row${isT ? " t" : ""}">
      <div class="gx-name"><b>${r.name}</b>${info.desc ? html`<span>${info.desc}</span>` : ""}</div>
      <div class="gx-val"><span class="num">${b}</span><span class="gx-arr" aria-label="to">→</span><span class="num">${c}</span><span class="gx-ch ${ch.tone}">${ch.text}</span></div>
      <div class="gx-badges">${
        isT
          ? html`${badge("target", "info")}${accepted ? badge("passed", "good", icon.check, need || undefined) : v ? badge(v.outcome, "bad", icon.x) : ""}`
          : html`${guardTag ?? badge("not judged", "", undefined, "Only the target metric decides the verdict; other metrics are measured and shown for context.")}${agreeTag}`
      }</div>
    </div>`;
  });
  const t = rows.find((r) => r.name === tMetric);
  const needLine = t?.m?.min_effect ? ` To be accepted, ${t.name} had to ${t.m.direction === "higher" ? "rise" : "drop"} by at least ${pct(t.m.min_effect)} in every replay, and the code had to pass every stable test${recipe?.equivalence ? " and produce the same output as before" : ""}.` : "";
  return html`<section class="panel gx-sum">
    <div class="panel-h"><h2>What this generation did</h2><div class="aside"><span>before → after</span></div></div>
    <div class="gx-rows">${lines}</div>
    <div class="gx-foot">${agreementText(rows, counted, tol)}${needLine}${auditText(g)}${extra.length ? ` ${extra.join(" ")}` : ""}</div>
  </section>`;
}

/** The "Measured samples" chart folded behind a toggle, with what its parts mean above it. */
export function rawMeasurements(g: any, recipe: any, cfg: any, sp: Raw | null, asp: Raw | null): Raw {
  if (!sp && !asp) return html``;
  const main = g.replays.filter((r: any) => r.kind === "replay" || r.kind === "reference");
  const withRes = main.filter((r: any) => r.result?.metrics);
  const labels = labelReplays(main);
  const ls = withRes.map((r: any) => labels.get(r.replay_id)).filter(Boolean) as string[];
  const tMetric = Array.isArray(g.target) ? null : g.target;
  const rows = measuredRows(withRes, recipe, tMetric);
  const tol = cfg?.det_tolerance ?? 0.001;
  const parsers = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.m?.parser ?? (/_cu$/.test(r.name) ? "cu" : /_(ns|us)$/.test(r.name) ? "time" : "other");
    parsers.set(key, [...(parsers.get(key) ?? []), r.name]);
  }
  const ex = (names: string[]) => (names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.join(" and "));
  const kinds: Raw[] = [];
  for (const [p, names] of parsers) {
    const lower = rows.find((r) => r.name === names[0])?.m?.direction !== "higher";
    if (p === "cachegrind-ir") kinds.push(html`<li><b>${ex(names)}</b>: CPU instructions the benchmark runs, counted by cachegrind, a deterministic profiler. ${lower ? "Lower means less work, so faster." : ""}</li>`);
    else if (p === "ncu-inst") kinds.push(html`<li><b>${ex(names)}</b>: GPU instructions the kernel runs, counted by NVIDIA Nsight Compute. ${lower ? "Lower is faster." : ""}</li>`);
    else if (p === "bytes") kinds.push(html`<li><b>${ex(names)}</b>: size of the built output in bytes. ${lower ? "Lower is smaller." : ""}</li>`);
    else if (p === "cu" || (p === "number" && names.every((n) => /_cu$/.test(n)))) kinds.push(html`<li><b>${ex(names)}</b>: Solana compute units the program uses for one call. ${lower ? "Lower is cheaper." : ""}</li>`);
    else if (p === "time" || names.every((n) => /_(ns|us)$/.test(n))) kinds.push(html`<li><b>${ex(names)}</b>: wall-clock time of one run. It varies from run to run, so each replay times several runs and Core compares medians with a 95% confidence interval.</li>`);
  }
  const det = rows.length > 0 && rows.every((r) => r.det);
  let maxAbs = 0;
  for (const r of rows) for (const xs of [r.perBase, r.perCand]) maxAbs = Math.max(maxAbs, Math.max(...xs) - Math.min(...xs));
  const identical = det && maxAbs === 0;
  const t = rows.find((r) => r.name === tMetric);
  const tInfo = t ? metricInfo(t.m, t.name) : null;
  const rl = ls.length ? (ls.length === 1 ? ls[0] : `${ls.slice(0, -1).join(", ")} and ${ls[ls.length - 1]}`) : "r1, r2";
  const explain = html`<div class="gx-explain">
    <ul>
      <li><b>parent</b> is the code before this change; <b>candidate</b> is the code after it.</li>
      <li><b>${rl}</b> ${ls.length === 1 ? "is an independent verifier replay" : "are independent verifier replays"}: agents other than the author rebuilt both versions in the same pinned sandbox and measured each one, so every replay has a parent row and a candidate row.</li>
      ${kinds}
      ${
        det
          ? html`<li>These counters are deterministic: measuring the same code again gives the same number, so each row is a single dot and the replays line up ${identical ? "exactly" : html`(here they differ by at most ${Number.isInteger(maxAbs) ? maxAbs.toLocaleString("en-US") : maxAbs.toPrecision(3)}${tInfo?.noun ? ` ${tInfo.noun}` : ""}, inside the ${pct(tol)} the network allows)`}.</li>`
          : ""
      }
      ${t ? html`<li>The target is <b>${t.name}</b>${t.m?.min_effect ? html`: the candidate had to be at least ${pct(t.m.min_effect)} ${t.m.direction === "higher" ? "higher" : "lower"} than the parent in every replay` : ""}. ${g.verdict?.guard_limits ? "The other metrics are guarded: none may get worse than its limit in any replay." : "The other metrics are measured for context and do not decide the verdict."}</li>` : ""}
      <li>Each dot is one measurement and the tick is the median. On the axis, k, M and G mean thousand, million and billion.</li>
    </ul>
  </div>`;
  const nm = rows.length;
  return html`<section class="panel gx-fold">
    <details data-gx-charts>
      <summary><span class="gx-st">Measured samples</span><span class="gx-sl">${plural(nm, "metric")}, ${plural(ls.length, "replay")}, parent and candidate</span><span class="gx-tg"><span class="o">Show the raw measurements</span><span class="c">Hide the raw measurements</span></span></summary>
      ${explain}
      ${sp ?? ""}
      ${asp ?? ""}
    </details>
  </section>`;
}

/** The replay list folded behind a toggle, with one line saying what the replays found. */
export function replaysFold(replays: any[], cal: any, list: Raw, title = "Replays"): Raw {
  if (!replays.length) return list;
  const revealed = replays.filter((r) => r.result);
  const counted = replays.filter((r) => r.role === "counted");
  const agents = new Set(revealed.map((r) => r.replayer).filter(Boolean)).size;
  const all = (f: (r: any) => boolean) => revealed.length > 0 && revealed.every(f);
  const stable = cal?.stable?.length ?? 0;
  const facts: string[] = [];
  if (all((r) => r.result.apply === "ok")) facts.push("the patch applied");
  if (all((r) => r.result.build?.base === "ok" && r.result.build?.cand === "ok")) facts.push("both versions built");
  if (all((r) => !(r.result.tests?.cand_fail ?? []).some((t: string) => (cal?.stable ?? []).includes(t))) && stable) facts.push(`the candidate passed all ${stable} stable tests`);
  if (all((r) => r.result.equivalence && r.result.equivalence.base_digest === r.result.equivalence.cand_digest)) facts.push("its output matched the parent on seeded inputs");
  const head = revealed.length
    ? `${plural(revealed.length, "replay")}${agents ? ` by ${plural(agents, "agent")}` : ""}${counted.length ? `, ${counted.length === revealed.length ? (revealed.length === 1 ? "" : revealed.length === 2 ? "both " : "all ") : `${counted.length} `}counted` : ""}`
    : `${plural(replays.length, "replay")} assigned, none revealed yet`;
  const line = facts.length ? `${head}: ${facts.slice(0, -1).join(", ")}${facts.length > 1 ? " and " : ""}${facts[facts.length - 1]}${revealed.length === 1 ? "" : " in every one"}.` : `${head}.`;
  return html`<section class="panel gx-fold">
    <details>
      <summary><span class="gx-st">${title}</span><span class="gx-sl">${line}</span>${(() => { const what = title === "Replays" ? "replay" : title.toLowerCase().replace(/s$/, ""); return html`<span class="gx-tg"><span class="o">Show ${what} details</span><span class="c">Hide ${what} details</span></span>`; })()}</summary>
      ${list}
    </details>
  </section>`;
}

/** Charts inside a closed toggle have no width at render; draw them when it opens. */
export function mountExplain(root: HTMLElement) {
  for (const d of root.querySelectorAll<HTMLDetailsElement>("details[data-gx-charts]")) d.addEventListener("toggle", () => d.open && mountCharts(d));
}

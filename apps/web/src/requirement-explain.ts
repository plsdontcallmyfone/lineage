import { html, raw, type Raw } from "./html.ts";
import { improvementExample, metricValue, metricWords, type MetricFacts } from "./metric-words.ts";
import { peekMeasure, unitMeasure, type UnitMeasure } from "./unit-measure.ts";

// "What does this mean?" beside a bounty's requirement (owner 2026-10-13: "explain what the 10% really
// means"). One component for every place a requirement is read: a board card, the bounty's page, the
// post form and its review. The panel is built from the bounty's own metric and percentage and from
// what Core measured on the unit; a sentence that needs a figure Core did not serve is left out.
//
// The rule it states, as Core and the escrow program apply it (packages/core/src/records.ts
// improvementBps, core.ts acceptance, onchain/programs/units-bounty claim):
//   - the percentage is the improvement of ONE accepted change over its parent, the unit's best code
//     at the moment that change is verified (its replay verdict; the least favourable reading where
//     runs differ). It is not a total over several changes, not measured against the repository as it
//     was when the bounty was posted, and not recomputed when the claim is sent;
//   - a change still waiting when another one is accepted is verified again on top of the new best,
//     so the target moves with the unit's best;
//   - only a change accepted after the bounty was posted, and before its deadline, counts.

export interface Requirement {
  metric: MetricFacts;
  /** the required improvement, in percent */
  pct: number;
  /** owner/repo and the unit's name, for the worked example of the general panel */
  unit?: string | null;
}
export interface Explained { what: string; now: string | null; win: string; one: string; moving: string; who: string; tests: string; not: string }

const pctText = (p: number) => `${Number.isInteger(p) ? p : +p.toFixed(2)}%`;
const when = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The sentences of the panel. `m`: what Core measured on the unit, or null when it is not known. */
export function explainRequirement(r: Requirement, m: UnitMeasure | null): Explained {
  const facts: MetricFacts = { ...r.metric, parser: m?.parser[r.metric.name] ?? r.metric.parser, cls: m?.cls ?? r.metric.cls, deterministic: m?.deterministic[r.metric.name] ?? r.metric.deterministic };
  const w = metricWords(facts);
  const higher = facts.direction === "higher";
  const tip = m?.tip?.[facts.name], base = m?.base[facts.name];
  const value = tip ?? base ?? null;
  const p = pctText(r.pct);
  const now = value === null || !m ? null
    : tip !== undefined
      ? `Where it stands: ${metricValue(value, w)} on the unit's best code, measured in the replays of generation ${m.height}${m.tipAt ? `, accepted ${when(m.tipAt)}` : ""}.`
      : `Where it stands: ${metricValue(value, w)}, measured when the unit was set up${m.createdAt ? ` on ${when(m.createdAt)}` : ""}${m.height > 0 ? `; ${m.height} ${m.height === 1 ? "change has" : "changes have"} been accepted since` : "; no change has been accepted yet"}.`;
  const ex = improvementExample(value, r.pct, facts, w);
  const win = ex ? `What wins: one verified change that brings it ${ex}, which is ${p} better.`
    : `What wins: one verified change that makes this number at least ${p} ${higher ? "higher" : "lower"}.`;
  const thing = w.sort === "bytes" ? "size" : w.sort === "compute_units" ? "compute unit count" : "benchmark";
  const not = w.sort === "instructions" || w.sort === "time" ? `What it does not mean: not ${p} faster on your machine by the clock, and not the whole project being ${p} faster. Only this benchmark of this metric.`
    : w.sort === "bytes" ? `What it does not mean: not everything the project ships being ${p} smaller. Only the size of this one built file.`
    : w.sort === "compute_units" ? `What it does not mean: not the fee of a transaction, and not every path of the program. Only the compute units this one path uses.`
    : `What it does not mean: not the whole project being ${p} better. Only this one metric.`;
  return {
    what: `What is measured: ${w.what[0]!.toLowerCase()}${w.what.slice(1)}`,
    now,
    win,
    one: `It is one change, measured against the unit's best code at the moment that change is verified. It is not the total of several smaller changes, and it is not compared with the repository as it was when the bounty was posted.`,
    moving: `If another change is accepted first, the unit's best moves: every change still waiting is verified again on top of it, and the ${p} is counted from the new best. Only a change accepted after the bounty was posted, and before its deadline, counts.`,
    who: `Who measures: independent verifiers replay the change in a sandbox and run the same ${thing === "benchmark" ? "benchmark" : "measurement"} every time. Their results have to agree${facts.deterministic ? "" : ", and where runs differ the least favourable reading is the one that counts"}.`,
    tests: `The repository's own tests must still pass${m?.equivalence ? ", and the code must produce the same output as before" : ""}.`,
    not,
  };
}

/** The panel's inside: the sentences in order, the ones without their figure left out. */
export function panelBody(r: Requirement, m: UnitMeasure | null, loading = false): Raw {
  const e = explainRequirement(r, m);
  const rows: [string, string | null][] = [["what", e.what], ["now", e.now], ["win", e.win], ["one", e.one], ["moving", e.moving], ["who", e.who], ["tests", e.tests], ["not", e.not]];
  return html`${rows.filter(([, t]) => t).map(([k, t]) => html`<p data-rq-line="${k}">${t!}</p>`)}${loading ? html`<p class="dim" data-rq-line="loading">Reading the latest measurement…</p>` : ""}`;
}

let seq = 0;
/**
 * The toggle and its panel, closed. `unitId`: the unit whose measurements the panel reads from Core when it is first
 * opened. `general`: the board's own "How improvement is measured", with one worked example.
 */
export function requirementToggle(r: Requirement, unitId: string | null, opts: { general?: boolean; label?: string } = {}): Raw {
  const id = `rq-${++seq}-${Math.random().toString(36).slice(2, 7)}`;
  const data = JSON.stringify({ r, unitId, general: !!opts.general });
  const known = unitId ? peekMeasure(unitId) : null;
  return html`<div class="rq" data-rq><button type="button" class="rq-btn" aria-expanded="false" aria-controls="${id}" data-rq-toggle data-rq-data="${data}">${opts.label ?? "What does this mean?"}</button>
    <div class="rq-panel" id="${id}" role="region" aria-label="${opts.label ?? "What this requirement means"}" hidden>${body(r, known && known !== "loading" ? known : null, !!opts.general, false)}</div></div>`;
}
function body(r: Requirement, m: UnitMeasure | null, general: boolean, loading: boolean): Raw {
  if (!general) return panelBody(r, m, loading);
  return html`<p data-rq-line="general">Every bounty asks for one metric of one unit to get better by a percentage. A metric is a number measured by running the unit's own benchmark: for example how many CPU instructions a task takes, or how many bytes a built file has.</p>
    ${r.unit ? html`<p data-rq-line="example"><b>An example from a unit that is live now:</b> ${r.unit}, ${metricWords(r.metric).label}, asked to get ${pctText(r.pct)} better.</p>` : ""}${panelBody(r, m, loading)}`;
}

/** Opens or closes one panel; opening closes any other panel of the same card, and reads the unit's measurements once. */
function toggle(btn: HTMLElement) {
  const panel = document.getElementById(btn.getAttribute("aria-controls") ?? "");
  if (!panel) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  if (open) {
    const scope = btn.closest("[data-rq-scope]") ?? document;
    for (const other of scope.querySelectorAll<HTMLElement>('[data-rq-toggle][aria-expanded="true"]')) if (other !== btn) toggle(other);
  }
  btn.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  if (!open || panel.dataset.rqRead) return;
  panel.dataset.rqRead = "1";
  let d: { r: Requirement; unitId: string | null; general: boolean };
  try {
    d = JSON.parse(btn.dataset.rqData ?? "");
  } catch {
    return;
  }
  if (!d.unitId) return;
  const known = peekMeasure(d.unitId);
  if (known && known !== "loading") return void (panel.innerHTML = body(d.r, known, d.general, false).s);
  panel.innerHTML = body(d.r, null, d.general, true).s;
  void unitMeasure(d.unitId).then((m) => { panel.innerHTML = body(d.r, m, d.general, false).s; });
}

/** One click and one key handler for every toggle on the page, whichever bundle drew it. Safe to call again. */
export function wireRequirementToggles() {
  const g = globalThis as { __unitsRq?: boolean; document?: Document };
  if (g.__unitsRq || !g.document) return;
  g.__unitsRq = true;
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rq-toggle]");
    if (!b) return;
    e.preventDefault(); // a toggle inside a link or a label acts as itself
    e.stopPropagation();
    toggle(b);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = (document.activeElement as HTMLElement | null)?.closest?.("[data-rq]")?.querySelector<HTMLElement>('[data-rq-toggle][aria-expanded="true"]');
    if (open) { toggle(open); open.focus(); }
  });
}

export const REQUIREMENT_CSS = `
.rq{display:block;min-width:0}
.rq-btn{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:3px 10px;border:1px solid var(--border);border-radius:12px;background:var(--bg);color:var(--ts);font:500 12px/1.5 var(--sans);cursor:pointer}
.rq-btn::before{content:"?";display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;background:var(--bg3);color:var(--tp);font:500 10px/1 var(--sans)}
.rq-btn:hover,.rq-btn[aria-expanded="true"]{background:var(--tp);color:var(--bg);border-color:var(--tp)}
.rq-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.rq-panel{display:grid;gap:6px;margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg);overflow-wrap:anywhere}
.rq-panel[hidden]{display:none}
.rq-panel p{margin:0;font:400 12.5px/1.5 var(--sans);color:var(--ts);letter-spacing:0}
.rq-panel b{font-weight:500;color:var(--tp)}
.rq-top{padding:11px 16px;border-top:1px solid var(--border);background:var(--bg2)}
.rq-top .rq-btn{margin-top:0}
`;

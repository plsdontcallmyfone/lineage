// Swarm fields of the launch form (docs/plans/SWARMS.md 6; owner approval 2026-10-13): one coin, several
// agents. Step "The agent" gets a size control and, above one, a row per agent with its name, model
// and role; the credits minimum becomes Core's own minimum once per agent; Review lists the roster and
// the cost before the one signature. The roster rides in the signed soul (`swarm` block), whose digest
// the launch already commits on chain, so the launch transaction is what it was.
//
// Everything comes from Core: GET /v1/swarms/config (the largest size now, what a screen past the free
// one costs the vault per hour) and the model registry (the default lead is the priciest model's
// agent). While Core's `swarms` flag is off that route answers a miss, nothing here renders, the size
// stays 1 and a launch is exactly what it was.
import { buildSwarm, defaultLead, defaultSeatNames, SEAT_NAME_MAX, textSafety, validateSwarm, type SoulSwarm } from "@units/souls/doc";
import type { ModelChoice } from "../../../packages/core/src/model-registry.ts";
import { html, raw, type Raw } from "../src/html.ts";
import { fmtUsd } from "../src/usd.ts";
import { entryOf, M, modelChoice, priceText } from "./models.ts";
import { minUsd, P, SEATS } from "./prepay.ts";

interface SwarmCfg {
  settings: { max_members: number; seat_desktop_usd_per_h: number | null; seat_desktop_free_seats: number };
  min_usd_per_seat: string | null;
  max_now: number;
  capacity: { seats_free: number | null };
}

export const SW = {
  cfg: null as SwarmCfg | null,
  loaded: false,
  size: 1,
  /** rows 2..N (row 1 is the form's own name and model): typed name (empty: the default) and "provider/id" */
  rows: [] as { name: string; model: string | null }[],
  /** the agent picked as lead, or null: the default (the priciest model's) */
  lead: null as number | null,
  /** the first agent's own name when typed (empty: the default) */
  name1: "",
};

let loading: Promise<void> | null = null;
/** the wallet the settings were last read for ("" for none connected) */
let loadedFor: string | null = null;
/** Whether Core's answer lets this form offer several agents: swarms are on, and open to the wallet it was asked for. */
export const swarmOffered = (j: any): boolean => !!j && !j._miss && j.enabled === true && !!j.settings && j.launch?.open !== false;
/**
 * Reads Core's swarm settings, once per connected wallet; a miss (the flag is off) leaves the form as
 * it was. Core may open swarms to listed launcher wallets only (`launch.open` false for any other):
 * the form then shows no Agents field, and a size picked for another wallet falls back to one.
 */
export function loadSwarmCfg(then: () => void, wallet: string | null = null): void {
  const who = wallet ?? "";
  if ((SW.loaded && loadedFor === who) || loading) return;
  const had = !!SW.cfg;
  loading = fetch(`/api/swarms/config?optional=1${who ? `&wallet=${encodeURIComponent(who)}` : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      SW.cfg = swarmOffered(j) ? (j as SwarmCfg) : null;
    })
    .catch(() => {
      SW.cfg = null;
    })
    .finally(() => {
      SW.loaded = true;
      loadedFor = who;
      loading = null;
      if (!SW.cfg) {
        SW.size = 1;
        SEATS.n = 1;
      }
      if (SW.cfg || had) then();
    });
}

const keyOf = (c: ModelChoice) => `${c.provider}/${c.id}`;
const choiceOf = (k: string | null): ModelChoice | null => {
  if (!k) return null;
  const [provider, ...rest] = k.split("/");
  return { provider: provider!, id: rest.join("/") };
};
const pickable = () => (M.view?.models ?? []).filter((m) => m.pickable);

/** The models of the agents in order: the form's own pick first, then each row's (default: the same as the first). */
function models(): (ModelChoice | null)[] {
  const first = modelChoice();
  return [first, ...SW.rows.slice(0, SW.size - 1).map((r) => (r.model && pickable().some((m) => keyOf(m) === r.model) ? choiceOf(r.model) : first))];
}

function names(base: string): string[] {
  const d = defaultSeatNames(base, SW.size);
  return d.map((n, i) => (i === 0 ? SW.name1.trim() || n : SW.rows[i - 1]?.name.trim() || n));
}

/** The agent that leads: the one picked, else the one whose model has the highest output price in the registry. */
export function leadSeat(): number {
  if (SW.lead !== null && SW.lead >= 1 && SW.lead <= SW.size) return SW.lead;
  const ms = models();
  if (ms.some((m) => !m)) return 1;
  return defaultLead(ms as ModelChoice[], (m) => entryOf(m)?.rate?.output ?? null);
}

/** The largest size the form offers now: Core's setting, lowered to the screens the hosted runtime reports free. */
const maxNow = () => Math.max(1, SW.cfg?.max_now ?? 1);

/** The soul's swarm block for the form as filled, or null: one agent, swarms off, or no model to name. */
export function swarmBlock(base: string): SoulSwarm | null {
  if (!SW.cfg || SW.size < 2) return null;
  const ms = models();
  if (ms.some((m) => !m)) return null;
  const ns = names(base);
  return buildSwarm(ns.map((name, i) => ({ name, model: ms[i]! })), leadSeat());
}

/** The soul with the roster recorded (after withModel): the block for two or more agents, none for one. */
export function withSwarm<T extends { model?: ModelChoice; persona: { name: string }; swarm?: SoulSwarm }>(doc: T): T {
  const { swarm: _old, ...rest } = doc;
  const block = doc.model ? swarmBlock(doc.persona.name) : null;
  SEATS.n = block ? block.members.length : 1;
  return (block ? { ...rest, swarm: block } : rest) as T;
}

const screenLine = (): string => {
  const s = SW.cfg!.settings;
  const paid = Math.max(0, SW.size - s.seat_desktop_free_seats);
  if (paid === 0 || s.seat_desktop_usd_per_h === 0) return "Every agent has its own live screen; the screens are not charged to the vault.";
  const from = s.seat_desktop_free_seats + 1;
  const who = paid === 1 ? `the screen of agent ${from} is` : `the screens of agents ${from} to ${SW.size} are`;
  const free = s.seat_desktop_free_seats === 0 ? "" : s.seat_desktop_free_seats === 1 ? "The first is free; " : `The first ${s.seat_desktop_free_seats} are free; `;
  const rate = s.seat_desktop_usd_per_h === null ? "at the screen service's own rate" : `at ${fmtUsd(s.seat_desktop_usd_per_h)} an hour${paid === 1 ? "" : " each"}`;
  return `Every agent has its own live screen. ${free}${who} paid by the vault ${rate} while running.`;
};

/** The fields of step "The agent" (into #w-swarm); empty while swarms are off. */
export function swarmFields(base: string): Raw {
  if (!SW.cfg) return html``;
  const max = maxNow();
  if (SW.size > max) SW.size = max;
  const free = SW.cfg.capacity.seats_free;
  const ms = models();
  const ns = names(base);
  const lead = leadSeat();
  const opts = pickable();
  const first = modelChoice();
  const per = P.cfg?.min_usd ?? SW.cfg.min_usd_per_seat;
  return html`<fieldset class="lz-swarm"><legend class="eyebrow">Agents</legend>
    <div class="wl-fine" style="margin-bottom:8px">One coin can fund several agents that work on the repository at the same time. Each takes a different target and can run a different model; they share one vault, one coin page and one record.</div>
    <div class="seg" role="radiogroup" aria-label="Number of agents">${Array.from({ length: max }, (_, i) => i + 1).map(
      (n) => html`<label class="seg-b" aria-pressed="${String(n === SW.size)}" style="cursor:pointer"><input type="radio" name="l_sw_size" value="${String(n)}"${n === SW.size ? raw(" checked") : ""} style="position:absolute;opacity:0;width:0;height:0">${String(n)}</label>`,
    )}</div>
    <div class="wl-fine" style="margin-top:6px">${max < SW.cfg.settings.max_members && free !== null ? `${free} screen${free === 1 ? " is" : "s are"} free on the network now, so up to ${max} agent${max === 1 ? "" : "s"} can start.` : `Up to ${SW.cfg.settings.max_members} agents per coin.`}</div>
    ${SW.size < 2
      ? ""
      : html`<div class="wl-models" style="margin-top:12px">${ns.map((name, i) => {
          const m = ms[i];
          const e = entryOf(m ?? null);
          return html`<div class="wl-model lz-seat" style="grid-template-columns:minmax(0,1fr)">
            <div class="lz-seat-g">
              <label><span class="eyebrow">Agent ${String(i + 1)} name</span><input name="l_sw_name_${String(i + 1)}" maxlength="${String(SEAT_NAME_MAX)}" autocomplete="off" value="${i === 0 ? SW.name1 : (SW.rows[i - 1]?.name ?? "")}" placeholder="${name}"></label>
              ${i === 0
                ? html`<label><span class="eyebrow">Model</span><input value="${e?.name ?? "the model picked above"}" disabled title="The first agent runs the model picked above"></label>`
                : html`<label><span class="eyebrow">Model</span><select name="l_sw_model_${String(i + 1)}">${opts.map((o) => html`<option value="${keyOf(o)}"${m && keyOf(o) === keyOf(m) ? raw(" selected") : ""}>${entryOf(o)?.name ?? o.id}</option>`)}</select></label>`}
              <label><span class="eyebrow">Role</span><select name="l_sw_role_${String(i + 1)}"><option value="lead"${i + 1 === lead ? raw(" selected") : ""}>Lead</option><option value="builder"${i + 1 === lead ? "" : raw(" selected")}>Builder</option></select></label>
            </div>
            <span class="wl-fine">${e ? priceText(e) : first ? "" : "No model can be picked now."}</span>
          </div>`;
        })}</div>
        <div class="wl-fine" style="margin-top:8px">The lead plans who takes which target, then works like the others. By default it is the agent with the priciest model. ${screenLine()}</div>
        <div class="wl-fine" style="margin-top:4px">Model credits: ${per ? `${fmtUsd(Number(per))} for each agent, ${fmtUsd(Number(minUsd()))} for ${SW.size}` : "read from Core on the Funding step"}.</div>`}
  </fieldset>`;
}

/** A change of one of the fields above; returns true when the roster changed. */
export function onSwarmInput(t: HTMLInputElement | HTMLSelectElement, root: HTMLElement | null): boolean {
  const n = t.name ?? "";
  if (!n.startsWith("l_sw_") || !SW.cfg) return false;
  const seat = Number(n.split("_").pop());
  if (n === "l_sw_size") {
    SW.size = Math.max(1, Math.min(maxNow(), Number(t.value) || 1));
    while (SW.rows.length < SW.size - 1) SW.rows.push({ name: "", model: null });
    if (SW.lead !== null && SW.lead > SW.size) SW.lead = null;
    SEATS.n = SW.size;
    // the credits follow the size: Core's minimum once per agent (the launcher may raise it afterwards)
    const dep = root?.querySelector<HTMLInputElement>('[name="l_deposit"]');
    if (dep && P.cfg) {
      dep.value = minUsd();
      dep.placeholder = minUsd();
    }
  } else if (n.startsWith("l_sw_name_")) {
    if (seat === 1) SW.name1 = t.value;
    else if (SW.rows[seat - 2]) SW.rows[seat - 2]!.name = t.value;
    return true; // typed text: the caller does not re-render the fields under the cursor
  } else if (n.startsWith("l_sw_model_")) {
    if (SW.rows[seat - 2]) SW.rows[seat - 2]!.model = t.value;
  } else if (n.startsWith("l_sw_role_")) {
    // exactly one lead: picking Lead moves it here; picking Builder on the lead hands it back to the default
    SW.lead = t.value === "lead" ? seat : SW.lead === seat || leadSeat() === seat ? (seat === 1 ? Math.min(2, SW.size) : 1) : SW.lead;
  }
  return true;
}

/** What is wrong with the roster as filled, in words for the step, or null (always null for one agent). */
export function swarmProblem(base: string): string | null {
  if (!SW.cfg || SW.size < 2) return null;
  const b = swarmBlock(base);
  if (!b) return "Pick a model that can run for every agent.";
  const errs = [...validateSwarm(b, b.members[0]!.model), ...b.members.flatMap((m) => textSafety(m.name, `agent ${m.seat}`))];
  if (!errs.length) return null;
  const e = errs[0]!;
  if (/used by another seat/.test(e)) return "Two agents have the same name; give each its own.";
  if (/\.name:/.test(e)) return `An agent's name can hold letters, digits, spaces, dots, apostrophes and hyphens, at most ${SEAT_NAME_MAX} characters.`;
  if (/names a real person/.test(e)) return "An agent's name cannot be a real person's.";
  return `The agents are not valid: ${e.replace(/^soul\.swarm\.?/, "")}.`;
}

/** Review: the roster and what it costs, before the one signature. Null for one agent. */
export function swarmReview(base: string): Raw | null {
  const b = swarmBlock(base);
  if (!b) return null;
  const per = P.cfg?.min_usd ?? null;
  return html`<b>${b.members.length} agents</b>, one coin and one vault. ${b.members.map((m, i) => html`${i ? "; " : ""}${m.name} <span class="dim">${m.role === "lead" ? "Lead" : "Builder"}, ${entryOf(m.model)?.name ?? m.model.id}</span>`)}.
    <span class="dim">${per ? `Credits at least ${fmtUsd(Number(per))} for each agent, ${fmtUsd(Number(minUsd()))} in all. ` : ""}${screenLine()} One signature, as for one agent.</span>`;
}

// Model picker of the launch form (plan M): provider first, then model, each model with the price
// its compute vault will be metered at. Everything shown comes from Core's model registry
// (GET /v1/models: prices read from each provider's own page on the stated day, caveats included)
// and the hosted runtime's report of which providers have a key; a provider without a key, or a
// model without a published price, is shown and cannot be picked. The pick goes into the soul
// (`model`), which the agent key signs and set_profile commits on chain; the runtime runs that model
// and its provenance record attests it. No logos: a three-letter monogram per provider.
import type { ModelChoice, ModelEntry, ModelRegistry, ProviderEntry, Rate } from "../../../packages/core/src/model-registry.ts";
import { html, raw, type Raw } from "../src/html.ts";

interface ModelsView {
  registry: ModelRegistry | null;
  availability: { providers: Record<string, boolean>; reported_at: number | null };
  models: { provider: string; id: string; pickable: boolean; why: string | null }[];
}

export const M = {
  view: null as ModelsView | null,
  err: null as string | null,
  provider: null as string | null,
  /** "provider/id" of the picked model */
  pick: null as string | null,
};

const keyOf = (c: ModelChoice) => `${c.provider}/${c.id}`;

export async function loadModels(): Promise<void> {
  try {
    const r = await fetch("/api/models");
    if (!r.ok) throw new Error(`Core /v1/models: HTTP ${r.status}`);
    M.view = (await r.json()) as ModelsView;
    M.err = M.view.registry ? null : "Core has no model registry configured";
    const reg = M.view.registry;
    if (reg) {
      const ok = (c: ModelChoice) => pickableOf(c)?.pickable;
      const first = ok(reg.default) ? reg.default : M.view.models.find((m) => m.pickable) ?? null;
      M.pick = first ? keyOf(first) : null;
      M.provider = first?.provider ?? reg.providers[0]?.id ?? null;
    }
  } catch (e) {
    M.err = (e as Error).message;
    M.view = null;
  }
}

function pickableOf(c: ModelChoice) {
  return M.view?.models.find((m) => m.provider === c.provider && m.id === c.id) ?? null;
}

/** The picked model, or null when nothing can be picked. */
export function modelChoice(): ModelChoice | null {
  if (!M.pick) return null;
  const [provider, ...rest] = M.pick.split("/");
  const c = { provider: provider!, id: rest.join("/") };
  return pickableOf(c)?.pickable ? c : null;
}

export function isDefaultChoice(c: ModelChoice | null): boolean {
  const d = M.view?.registry?.default;
  return !c || (!!d && d.provider === c.provider && d.id === c.id);
}

export function entryOf(c: ModelChoice | null): ModelEntry | null {
  if (!c) return null;
  return M.view?.registry?.models.find((m) => m.provider === c.provider && m.id === c.id) ?? null;
}

/** "Monogram": first three letters, so Meta, Moonshot and MiniMax stay apart. */
const mono = (p: ProviderEntry) => p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
/** A stable hue per provider id, for the monogram tile. */
const hue = (s: string) => [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);

/** Integers print bare, anything else to the cent, or to the tenth of a cent when the price has one (0.125, 0.003): never rounded into another figure. */
export const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(3).replace(/(\.\d\d)0$/, "$1")}`;
const rateText = (r: Rate) => `${usd(r.input)} in / ${usd(r.output)} out${r.cached_input != null ? `, cached ${usd(r.cached_input)}` : ""}`;

export function priceText(m: ModelEntry): string {
  if (m.status !== "verified" || !m.rate) return "no first-party price published";
  return `${rateText(m.tiers?.length ? m.tiers[0]!.rate : m.rate)} per 1M tokens`;
}

function caveats(m: ModelEntry): string[] {
  const out: string[] = [];
  if (m.peak) out.push(`${rateText(m.peak.rate)} inside ${m.peak.windows.map((w) => `${w.start} to ${w.end} UTC`).join(" and ")}${m.peak.windows[0]!.days.length === 5 ? " on weekdays" : ""}; metered by the clock`);
  if (m.tiers && m.tiers.length > 1) out.push(`rate shown up to ${m.tiers[0]!.up_to_input_tokens.toLocaleString("en-US")} input tokens; ${m.tiers.slice(1).map((t) => `${rateText(t.rate)} up to ${t.up_to_input_tokens.toLocaleString("en-US")}`).join("; ")}`);
  if (m.note) out.push(m.note);
  return out;
}

export function modelFieldset(): Raw {
  return html`<fieldset><legend class="eyebrow">Model</legend>
    <div class="wl-fine" style="margin-bottom:8px">The model the agent runs. Pick the provider, then the model. Its compute vault is charged at the price shown, read from the provider's own pricing page on the date given; the hosted runtime's daily cap covers every provider. The choice goes into the soul the agent key signs, and every candidate's provenance record names the model that ran.</div>
    <div id="w-models">${M.view || M.err ? modelsBody() : html`<div class="wl-fine">Reading the model registry…</div>`}</div>
  </fieldset>`;
}

export function modelsBody(): Raw {
  if (M.err || !M.view?.registry) return html`<div class="wl-fine">Model registry unavailable: ${M.err ?? "none configured"}. The agent runs the network default.</div>`;
  const reg = M.view.registry;
  const avail = M.view.availability.providers;
  const prov = reg.providers.find((p) => p.id === M.provider) ?? reg.providers[0]!;
  const models = reg.models.filter((m) => m.provider === prov.id && m.enabled !== false);
  const anyPick = M.view.models.some((m) => m.pickable);
  return html`<div class="wl-prov" role="radiogroup" aria-label="Provider">
      ${reg.providers.map((p) => {
        const on = !!avail[p.id] && p.adapter !== "none";
        const n = reg.models.filter((m) => m.provider === p.id && m.enabled !== false).length;
        return html`<label class="wl-prov-i${p.id === prov.id ? " on" : ""}${on ? "" : " off"}">
          <input type="radio" name="l_provider" value="${p.id}"${p.id === prov.id ? raw(" checked") : ""}>
          <span class="wl-mono" style="--h:${hue(p.id)}" aria-hidden="true">${mono(p)}</span>
          <span class="wl-prov-t"><b>${p.name}</b><span class="dim">${on ? `${n} model${n === 1 ? "" : "s"}` : p.adapter === "none" ? "no API price" : "unavailable"}</span></span>
        </label>`;
      })}
    </div>
    <div class="wl-models" role="radiogroup" aria-label="Model">
      ${models.map((m) => {
        const k = `${m.provider}/${m.id}`;
        const v = M.view!.models.find((x) => x.provider === m.provider && x.id === m.id);
        const ok = !!v?.pickable;
        const cv = caveats(m);
        return html`<label class="wl-model${ok ? "" : " off"}${M.pick === k ? " on" : ""}">
          <input type="radio" name="l_model" value="${k}"${M.pick === k ? raw(" checked") : ""}${ok ? "" : raw(" disabled")}>
          <span class="wl-model-t"><span><b>${m.name}</b> <span class="dim">${m.id}</span>${isDefaultChoice({ provider: m.provider, id: m.id }) ? html` <span class="mark">default</span>` : ""}</span>
            ${cv.length ? html`<span class="wl-fine">${cv.join(". ")}</span>` : ""}
            ${ok ? "" : html`<span class="wl-fine">Cannot be picked: ${v?.why ?? "unknown"}.</span>`}</span>
          <span class="wl-model-p num">${priceText(m)}</span>
        </label>`;
      })}
    </div>
    <div class="wl-fine" style="margin-top:6px">${prov.name} prices read ${prov.read_on} from <a href="${prov.pricing_url}" target="_blank" rel="noopener">${prov.pricing_url.replace(/^https:\/\//, "")}</a>${prov.page_dated ? `; the page is dated ${prov.page_dated}` : "; the page prints no date, so this is what it said that day"}.${prov.note ? ` ${prov.note}` : ""}${!anyPick ? " No provider has a key on the hosted runtime yet." : ""}</div>`;
}

/** Handles a provider or model radio; returns true when the pick changed. */
export function onModelInput(t: HTMLInputElement): boolean {
  if (t.name === "l_provider") {
    M.provider = t.value;
    // keep the pick if it is this provider's, else the provider's first pickable model
    if (!M.pick?.startsWith(`${t.value}/`)) {
      const first = M.view?.models.find((m) => m.provider === t.value && m.pickable);
      if (first) M.pick = `${first.provider}/${first.id}`;
    }
    return true;
  }
  if (t.name === "l_model") {
    M.pick = t.value;
    return true;
  }
  return false;
}

/** The soul with the picked model recorded (a default pick is recorded too, so the profile is explicit). */
export function withModel<T extends { model?: ModelChoice }>(doc: T, c: ModelChoice | null): T {
  const { model: _old, ...rest } = doc;
  return (c ? { ...rest, model: { provider: c.provider, id: c.id } } : rest) as T;
}

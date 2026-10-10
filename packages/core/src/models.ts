import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { checkRegistry, findModel, offerable, openrouterRoute, pickable, validChoice, type Availability, type ModelChoice, type ModelRegistry } from "./model-registry.ts";

// Model registry in Core (plan M, SPEC 17.4). The seed is config/models.json (or LINEAGE_MODELS);
// the admin replaces it with POST /v1/admin/models and that stored version wins from then on. The
// hosted runtime reports which providers have a key on its host (never a key) with
// POST /v1/admin/models/availability; GET /v1/models serves the registry with a pickable flag per
// model, which is what the launch form offers. A soul naming a model the registry does not price is
// refused (souls.ts calls `checkChoice`).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registry TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_availability (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  providers TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  reported_by TEXT NOT NULL
);`;

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

export const DEFAULT_MODELS_PATH = join(import.meta.dir, "../../../config/models.json");

const instances = new WeakMap<Core, Models>();
export function modelsOf(core: Core): Models {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new Models(core)));
  return m;
}

export class Models {
  private readonly c: Internals;
  private seed: ModelRegistry | null = null;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    const path = process.env.LINEAGE_MODELS ?? DEFAULT_MODELS_PATH;
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const errs = checkRegistry(raw);
      if (errs.length) throw new Error(`model registry ${path}: ${errs.slice(0, 5).join("; ")}`);
      this.seed = raw;
    }
  }

  /** Tests and tools: replace the file seed. */
  setSeed(r: ModelRegistry | null): void {
    if (r) {
      const errs = checkRegistry(r);
      if (errs.length) throw new Error(errs.join("; "));
    }
    this.seed = r;
  }

  registry(): { registry: ModelRegistry; source: "admin" | "seed"; updated_at: number | null } | null {
    const row = this.c.db.query<{ registry: string; updated_at: number }, []>("SELECT registry, updated_at FROM model_registry WHERE id = 1").get();
    if (row) return { registry: JSON.parse(row.registry), source: "admin", updated_at: row.updated_at };
    return this.seed ? { registry: this.seed, source: "seed", updated_at: null } : null;
  }

  availability(): Availability {
    const row = this.c.db.query<{ providers: string; reported_at: number; reported_by: string }, []>("SELECT * FROM model_availability WHERE id = 1").get();
    return row ? { providers: JSON.parse(row.providers), reported_at: row.reported_at, by: row.reported_by } : { providers: {}, reported_at: null, by: null };
  }

  /** GET /v1/models: the registry, availability and a pickable flag per model. */
  view() {
    const r = this.registry();
    if (!r) return { registry: null, availability: this.availability(), models: [] };
    const avail = this.availability();
    return {
      registry: r.registry,
      source: r.source,
      updated_at: r.updated_at,
      availability: avail,
      models: r.registry.models.map((m) => {
        const p = pickable(r.registry, m, avail);
        // plan MODELS-AND-SELF-FUNDING: the route it would run on, and that route's listed price
        const o = openrouterRoute(r.registry, m);
        return { provider: m.provider, id: m.id, pickable: p.ok, why: p.why, via: p.via, route: p.via === "openrouter" && o ? { id: o.id, rate: o.rate, tiers: o.tiers ?? null, note: o.note ?? null, funding_fee_bps: r.registry.routing?.openrouter?.funding_fee_bps ?? 0 } : null };
      }),
    };
  }

  /** POST /v1/admin/models { registry }. */
  put(by: string, body: unknown) {
    const reg = (body as { registry?: unknown })?.registry;
    const errs = checkRegistry(reg);
    if (errs.length) throw bad("bad_registry", errs.slice(0, 10).join("; "));
    this.c.db.query("INSERT OR REPLACE INTO model_registry (id, registry, updated_at, updated_by) VALUES (1, ?, ?, ?)").run(JSON.stringify(reg), this.c.now(), by);
    this.c.emitEvent("models.updated", { models: (reg as ModelRegistry).models.length });
    return this.view();
  }

  /** POST /v1/admin/models/availability { providers: { id: boolean } } (runtime or admin). */
  report(by: string, body: unknown) {
    const p = (body as { providers?: unknown })?.providers;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw bad("bad_availability", "providers: { id: boolean }");
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(k) || typeof v !== "boolean") throw bad("bad_availability", `providers.${k.slice(0, 40)}: boolean`);
      out[k] = v;
    }
    if (Object.keys(out).length > 32) throw bad("bad_availability", "at most 32 providers");
    this.c.db.query("INSERT OR REPLACE INTO model_availability (id, providers, reported_at, reported_by) VALUES (1, ?, ?, ?)").run(JSON.stringify(out), this.c.now(), by);
    return this.availability();
  }

  /** A soul's model choice must be a priced registry entry (any provider; a key can arrive later). Null: fine. */
  checkChoice(c: unknown): string | null {
    if (c === undefined) return null;
    if (!validChoice(c)) return "soul.model: { provider, id }";
    const r = this.registry();
    if (!r) return null; // no registry configured: nothing to check against
    const m = findModel(r.registry, c as ModelChoice);
    if (!m) return `soul.model: ${(c as ModelChoice).provider}/${(c as ModelChoice).id} is not in the model registry`;
    // a model some route can run (its own API, or OpenRouter) may be named; a key can arrive later
    if (!offerable(r.registry, m)) return m.status !== "verified" ? `soul.model: ${m.name} has no published price and cannot be picked` : `soul.model: ${m.name} is not offered`;
    return null;
  }
}

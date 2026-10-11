import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import {
  GUARD_RULE_VERSION,
  guardConfigAt,
  guardConfigDigest,
  guardRuleFor,
  validLimit,
  type CandidateKind,
  type GuardConfigVersion,
  type GuardRule,
} from "./protocol.ts";

// Guard limits config (SPEC 10.1 rule 6, docs/plans/GUARD-LIMITS.md). Recipes are frozen, so the
// limits on non-target metrics live here: an append-only list of versions, each with a network
// default, the candidate kinds it applies to and per-recipe overrides keyed by recipe_id. A
// candidate is judged with the version in force at its committed_at; before the first version, with
// rule version 1 (no guards). Every version is public (GET /v1/guard-config) so verify.ts and
// replicas recompute each verdict with the same rule; an edit never changes an existing version and
// takes effect only after Core's clock (strictly later than any commit so far), so no committed candidate's rule
// can change.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS guard_configs (
    version INTEGER PRIMARY KEY,
    effective_from_ms INTEGER NOT NULL,
    config TEXT NOT NULL,                 -- canonical fields (GuardConfigVersion without digest)
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT                       -- admin id, null for the seed from network config
  );
`;

const KINDS: CandidateKind[] = ["perf", "slim", "fix"];

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
  tx<T>(f: () => T): T;
  emitEvent(type: string, data: unknown): void;
}

const instances = new WeakMap<Core, GuardConfig>();
export function guardConfigOf(core: Core): GuardConfig {
  let g = instances.get(core);
  if (!g) instances.set(core, (g = new GuardConfig(core)));
  return g;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export class GuardConfig {
  private readonly c: Internals;
  private cache: GuardConfigVersion[] | null = null;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    this.seed();
  }

  /** Version 1 from network config (guard_activation_ms set), once, strictly after Core's clock (candidates already committed keep rule 1). */
  private seed() {
    const at = this.c.cfg.guard_activation_ms;
    if (at === null || at === undefined) return;
    if (this.c.db.query("SELECT 1 FROM guard_configs LIMIT 1").get()) return;
    this.insert({ version: 1, effective_from_ms: Math.max(at, this.c.now() + 1), default_max_regression: this.c.cfg.guard_max_regression ?? 0.01, kinds: ["perf", "slim"], overrides: {} }, null);
  }

  private insert(v: Omit<GuardConfigVersion, "digest">, by: string | null): GuardConfigVersion {
    const full: GuardConfigVersion = { ...v, kinds: [...v.kinds].sort() as CandidateKind[], digest: guardConfigDigest(v) };
    const { digest, ...fields } = full;
    this.c.db
      .query("INSERT INTO guard_configs (version, effective_from_ms, config, digest, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(full.version, full.effective_from_ms, JSON.stringify(fields), digest, this.c.now(), by);
    this.cache = null;
    this.c.emitEvent("guard_config.version", { version: full.version, effective_from_ms: full.effective_from_ms, digest });
    return full;
  }

  history(): GuardConfigVersion[] {
    if (this.cache) return this.cache;
    const rows = this.c.db.query<{ config: string; digest: string }, []>("SELECT config, digest FROM guard_configs ORDER BY version").all();
    this.cache = rows.map((r) => ({ ...(JSON.parse(r.config) as Omit<GuardConfigVersion, "digest">), digest: r.digest }));
    return this.cache;
  }

  /** The rule a candidate is judged with: the version in force at its commit, resolved for its recipe; null = rule version 1. */
  ruleFor(committed_at_ms: number, recipe_id: string): GuardRule | null {
    return guardRuleFor(guardConfigAt(this.history(), committed_at_ms), recipe_id);
  }

  view() {
    const versions = this.history();
    const now = this.c.now();
    return {
      rule_version: GUARD_RULE_VERSION,
      activation_ms: versions[0]?.effective_from_ms ?? null,
      current: guardConfigAt(versions, now),
      versions,
      note: "A candidate is judged with the version in force at its committed_at; one committed before activation_ms keeps rule version 1 (target metric only).",
    };
  }

  /**
   * Admin edit: a new version from the current one with the given fields changed. `overrides` maps
   * recipe_id to that recipe's full metric map (replacing it; null removes the recipe's overrides);
   * each limit is a fraction or null (unguarded). Takes effect at `effective_from_ms` (default Core's clock
   * + 1 ms), always after Core's clock and never before the latest version.
   */
  set(by: string, body: unknown): GuardConfigVersion {
    return this.c.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "an object of guard config fields expected");
      for (const k of Object.keys(body))
        if (!["default_max_regression", "kinds", "overrides", "effective_from_ms"].includes(k)) throw bad("bad_config", `unknown field ${k.slice(0, 40)}`);
      const versions = this.history();
      const last = versions[versions.length - 1];
      const now = this.c.now();
      const base = last ?? { version: 0, effective_from_ms: 0, default_max_regression: this.c.cfg.guard_max_regression ?? 0.01, kinds: ["perf", "slim"] as CandidateKind[], overrides: {} };
      const next: Omit<GuardConfigVersion, "digest"> = {
        version: base.version + 1,
        effective_from_ms: now + 1,
        default_max_regression: base.default_max_regression,
        kinds: [...base.kinds],
        overrides: structuredClone(base.overrides),
      };
      if (body.default_max_regression !== undefined) {
        if (body.default_max_regression === null || !validLimit(body.default_max_regression)) throw bad("bad_config", "default_max_regression is a fraction from 0 to 1");
        next.default_max_regression = body.default_max_regression;
      }
      if (body.kinds !== undefined) {
        if (!Array.isArray(body.kinds) || !body.kinds.every((k) => KINDS.includes(k as CandidateKind))) throw bad("bad_config", `kinds is a list of ${KINDS.join(", ")}`);
        next.kinds = [...new Set(body.kinds as CandidateKind[])];
      }
      if (body.overrides !== undefined) {
        if (!isObj(body.overrides)) throw bad("bad_config", "overrides maps recipe_id to { metric: fraction | null }");
        for (const [rid, m] of Object.entries(body.overrides)) {
          const row = this.c.db.query<{ json: string }, [string]>("SELECT json FROM recipes WHERE recipe_id = ?").get(rid);
          if (!row) throw bad("bad_config", `unknown recipe_id ${rid.slice(0, 80)}`);
          if (m === null) {
            delete next.overrides[rid];
            continue;
          }
          if (!isObj(m)) throw bad("bad_config", `overrides.${rid.slice(0, 16)} maps metric names to a fraction or null`);
          const names = new Set(((JSON.parse(row.json) as { metrics?: { name: string }[] }).metrics ?? []).map((x) => x.name));
          for (const [name, lim] of Object.entries(m)) {
            if (!names.has(name)) throw bad("bad_config", `recipe ${rid.slice(0, 16)} has no metric ${name.slice(0, 40)}`);
            if (!validLimit(lim)) throw bad("bad_config", `overrides.${rid.slice(0, 16)}.${name.slice(0, 40)} is a fraction from 0 to 1 or null`);
          }
          next.overrides[rid] = { ...m } as Record<string, number | null>;
        }
      }
      if (body.effective_from_ms !== undefined) {
        if (!Number.isSafeInteger(body.effective_from_ms)) throw bad("bad_config", "effective_from_ms is an integer (ms)");
        next.effective_from_ms = body.effective_from_ms as number;
      }
      // strictly after Core's clock: a candidate committed at this very ms was committed under the old rule
      if (next.effective_from_ms <= now) throw bad("bad_config", "effective_from_ms must be after Core's clock (a committed candidate's rule never changes)");
      if (last && next.effective_from_ms < last.effective_from_ms) throw bad("bad_config", `effective_from_ms cannot be before version ${last.version}'s (${last.effective_from_ms})`);
      return this.insert(next, by);
    });
  }
}

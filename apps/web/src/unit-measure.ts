// What Core serves about a unit's metrics beyond the board: each metric's parser, the recipe's class,
// whether the recipe checks that behaviour is unchanged, the values measured when the unit was set up,
// and those measured in the replays of its newest generation (the unit's best code now). Read once
// per unit and shared by the post form and the requirement explanations. Every figure is one Core
// served: where several replays measured a metric the middle measurement is taken, never an average.

export interface UnitMeasure {
  cls: string | null;
  parser: Record<string, string>;
  /** per metric: its measurement is exact (the same code on the same input always gives the same number) */
  deterministic: Record<string, boolean>;
  /** the recipe has an equivalence check: a change must produce the same output as before */
  equivalence: boolean;
  /** accepted generations so far */
  height: number;
  /** measured when the unit was set up, and when that was (ms) */
  base: Record<string, number>;
  createdAt: number | null;
  /** measured on the newest generation in its replays, and when it was accepted (ms); null while there is none */
  tip: Record<string, number> | null;
  tipAt: number | null;
}

/** The middle measurement (the lower of the two middle ones): always a number that was measured. */
export const middle = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor((xs.length - 1) / 2)]!;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Builds the measure from Core's unit and its newest generation (GET /v1/units/:id and /v1/generations/:tip). */
export function measureOf(u: any, g: any): UnitMeasure | null {
  if (!u?.recipe) return null;
  const m: UnitMeasure = {
    cls: typeof u.recipe.class === "string" ? u.recipe.class : null, equivalence: !!u.recipe.equivalence, height: Number(u.height) || 0, tip: null, tipAt: null,
    createdAt: num(u.created_at) ? u.created_at : null,
    deterministic: Object.fromEntries(((u.recipe.metrics ?? []) as { name: string; deterministic?: unknown }[]).map((x) => [x.name, x.deterministic === true])),
    parser: Object.fromEntries(((u.recipe.metrics ?? []) as { name: string; parser?: string }[]).filter((x) => typeof x.parser === "string").map((x) => [x.name, x.parser!])),
    base: Object.fromEntries(Object.entries((u.calibration?.metrics ?? {}) as Record<string, { base_value?: unknown }>).filter(([, v]) => num(v?.base_value)).map(([k, v]) => [k, v.base_value as number])),
  };
  const per = new Map<string, number[]>();
  for (const r of (g?.replays ?? []) as { result?: { metrics?: Record<string, { cand?: unknown }> } }[])
    for (const [name, x] of Object.entries(r.result?.metrics ?? {})) {
      const cand = Array.isArray(x?.cand) ? x.cand.filter(num) : [];
      if (cand.length) per.set(name, [...(per.get(name) ?? []), middle(cand)]);
    }
  if (m.height > 0 && per.size) {
    m.tip = Object.fromEntries([...per].map(([k, v]) => [k, middle(v)]));
    m.tipAt = num(g?.accepted_at) ? g.accepted_at : null;
  }
  return m;
}

const cache = new Map<string, UnitMeasure | "loading" | null>();
const jobs = new Map<string, Promise<UnitMeasure | null>>();
/** What is known now without asking: the measure, "loading", null (Core had none), or undefined (not asked yet). */
export const peekMeasure = (id: string) => cache.get(id);
/** Reads the unit from Core once. */
export function unitMeasure(id: string): Promise<UnitMeasure | null> {
  let job = jobs.get(id);
  if (!job) {
    cache.set(id, "loading");
    const j = (path: string) => fetch(path, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    job = (async () => {
      const u = await j(`/api/lineages/${id}`);
      const g = u && Number(u.height) > 0 && typeof u.tip === "string" ? await j(`/api/generations/${u.tip}`) : null;
      const m = measureOf(u, g);
      cache.set(id, m);
      return m;
    })();
    jobs.set(id, job);
  }
  return job;
}

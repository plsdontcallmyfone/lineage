import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { H, sha256Hex, type Calibration, type Recipe } from "@units/protocol";
import { UNITS_HOME, calibrate, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree, RecipeError, type LoadedRecipe } from "@units/sandbox";
import { CoreClient, type SigningKey } from "../../core/src/client.ts";
import { calibCommitment } from "../../core/src/recipe-proposals.ts";
import { duplicateUnit, headroomError } from "../../core/src/more-units.ts";
import { toolLoop, withBuiltTree, type SpendLedger } from "./discovery.ts";
import { ToolBox } from "./proposers/anthropic.ts";
import type { ProposeContext } from "./proposers/types.ts";

// Agent-proposed recipes (SPEC 6.2), worker side.
// - RecipeDrafter: Claude reads a checkout of a target repository and drafts recipe.yml plus the
//   overlay harness (benchmark and equivalence programs). It can trial-calibrate its draft in the
//   real sandbox (the same calibrate() Core's reference runner uses) and may submit only a draft
//   whose last trial built, found stable tests, kept every deterministic metric enabled and ran
//   the equivalence harness to identical digests twice.
// - submitProposal: uploads the overlay files as blobs and posts the proposal to Core.
// - CalibrationVerifier: a qualified verifier's side of the calibration replays: materializes the
//   proposed recipe from Core (recipe JSON plus overlay blobs), checks its recipe_id, prepares the
//   dependency layer, calibrates with the shared seed, commits, then reveals once every drawn
//   verifier has committed.

// ---------------------------------------------------------------------------------------------
// Drafting

export interface DraftTarget {
  /** recipe name to use (lowercase kebab) */
  name: string;
  repo: string;
  commit: string;
  class: Recipe["class"];
  arch: "amd64" | "arm64";
  /** pinned image for the class (one Core already vets: used by an active lineage of the class) */
  image: string;
}

export interface TrialReport {
  ok: boolean;
  recipe_id?: string;
  text: string;
}

/** What the drafter of an ADDITIONAL unit is told about a unit the repository already has (plan AGENT-EFFICIENCY 8.2). */
export interface ExistingUnit {
  name: string;
  recipe: Recipe;
  height: number;
  metrics: {
    name: string;
    kind: string;
    command: string;
    enabled: boolean;
    base_value: number | null;
    /** accepted changes that targeted it, and their combined ratio (1 when none) */
    accepted: number;
    ratio: number;
    /** the share of its tip value that is not the library, where the calibration records it */
    fixed_share: number | null;
  }[];
  /** Core's dry facts for the unit, as one sentence, or null */
  recent: string | null;
}

export interface MoreContext {
  units: ExistingUnit[];
  /** the largest share of an instruction-count metric that may be outside the library at generation 0 */
  maxFixedShare: number;
}

/** Reads what Core knows about the given units: recipe, calibrated values, accepted changes per target, the dry facts. */
export async function describeUnits(client: CoreClient, lineages: string[]): Promise<ExistingUnit[]> {
  const out: ExistingUnit[] = [];
  for (const id of lineages) {
    const v = await client.request("GET", `/v1/lineages/${id}`, undefined, { sign: false });
    if (v.status !== 200) throw new Error(`unit ${id.slice(0, 10)}: HTTP ${v.status}`);
    const view = v.body as { recipe: Recipe; height: number; calibration: Calibration; generations: { entry_type: string; reverted_by: string | null; effect: { metric?: string; ratio?: number } | null }[] };
    const d = await client.request("GET", `/v1/lineages/${id}/dry`, undefined, { sign: false }).catch(() => null);
    const f = d?.status === 200 ? (d.body as { facts?: { attempts: number; fruitless: number; accepted: number; best_gain_pct: number | null; fixed?: Record<string, { share: number }> } }).facts : undefined;
    const live = view.generations.filter((g) => g.entry_type === "patch" && !g.reverted_by);
    out.push({
      name: view.recipe.name,
      recipe: view.recipe,
      height: view.height,
      metrics: view.recipe.metrics.map((m) => {
        const mine = live.filter((g) => g.effect?.metric === m.name && typeof g.effect.ratio === "number");
        const c = view.calibration.metrics[m.name];
        return { name: m.name, kind: m.kind, command: m.command, enabled: !!c?.enabled, base_value: typeof c?.base_value === "number" ? c.base_value : null, accepted: mine.length, ratio: mine.reduce((a, g) => a * (g.effect!.ratio as number), 1), fixed_share: f?.fixed?.[m.name]?.share ?? null };
      }),
      recent: f && f.attempts ? `of its last ${f.attempts} final attempts ${f.fruitless} ended without an improvement and ${f.accepted} were accepted${f.best_gain_pct === null ? "" : ` (largest gain ${f.best_gain_pct.toFixed(1)}%)`}` : null,
    });
  }
  return out;
}

/** The prompt section of an additional unit: what exists, what was achieved, what to add, and the two refusals. */
export function moreSection(more: MoreContext): string {
  const pctOf = (x: number) => `${(100 * x).toFixed(1)}%`;
  const units = more.units
    .map((u) => {
      const ms = u.metrics.map((m) => {
        const got = m.accepted ? `${m.accepted} accepted change${m.accepted === 1 ? "" : "s"}, now at ${m.ratio.toFixed(4)} of its start` : "no accepted change yet";
        const fixed = m.fixed_share === null ? "" : `; at least ${pctOf(m.fixed_share)} of what is left is not the library`;
        return `  - ${m.name} (${m.kind}${m.enabled ? "" : ", disabled"}): \`${m.command}\`; calibrated ${m.base_value ?? "-"}; ${got}${fixed}`;
      });
      return `- unit ${u.name} (${u.height} accepted generation${u.height === 1 ? "" : "s"}); a patch may change: ${u.recipe.patch.allowed_paths.join(", ")}; tests: \`${u.recipe.test.command}\`\n${ms.join("\n")}${u.recent ? `\n  recent work: ${u.recent}` : ""}`;
    })
    .join("\n");
  const limit = pctOf(more.maxFixedShare).replace(/\.0%$/, "%");
  return `

THIS IS AN ADDITIONAL UNIT. The repository already has ${more.units.length === 1 ? "a unit" : `${more.units.length} units`}, and agents have taken the easy gains there: most recent attempts found nothing more to improve. Existing units, with what was achieved on each target:
${units}

Your unit must add headroom those units do not have. Choose one or more, by reading the code:
(a) another part of the code: a module, package or crate the existing units do not let a patch change, which has tests of its own; allow only that part;
(b) a heavier or more realistic workload on the same code, as NEW targets with their own names (for example encode_long_ir, decode_batch_ir): larger and more varied inputs, the calls real users make, so that the library's own work is nearly all of each count;
(c) more targets: operations of the library that no existing target measures, and binary size where this class measures it.
Keep the prepare, build and test commands of the format reference (it is this repository's own unit) unless the new part of the code needs others.

Two rules are checked for an additional unit:
1. No duplicate. A draft whose allowed paths overlap an existing unit's and that has no target that unit lacks (the same kind and name, or the same command, is the same target) is refused when you write the recipe. Name every new target for what it measures.
2. Headroom. Every cachegrind metric must declare fixed_command: the metric's command with a flag (--inputs-only) that makes the benchmark do everything except call the library (start, imports, building the seeded inputs) and exit 0. The trial measures it, and fails unless it is at most ${limit} of the metric. So make each workload heavy enough (more and larger inputs, more repetitions of the library calls), build inputs cheaply, and still keep one cachegrind run under about a minute.
In recipe.yml a metric then reads:
  - name: encode_long_ir
    ...
    command: <the cachegrind command> encode_long $LINEAGE_SEED
    fixed_command: <the same command> --inputs-only
If the repository has nothing more to measure (one small module, already covered), call give_up with impossible true and say so.`;
}

const DRAFT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "List files under a directory of the target repository (relative path, '.' for the root).",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file of the target repository, optionally a 1-based inclusive line range.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "search",
    description: "Search the target repository for a regular expression. Returns up to 200 matching lines.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "write_overlay_file",
    description:
      "Create or replace one overlay (harness) file. Overlay files are copied onto the repository root before the build and are always protected. Paths must start with lineage_ (for example lineage_bench.py) and must not exist in the repository.",
    input_schema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false },
  },
  {
    name: "write_recipe",
    description: "Write the whole recipe.yml (YAML). Replaces the previous draft.",
    input_schema: { type: "object", properties: { yaml: { type: "string" } }, required: ["yaml"], additionalProperties: false },
  },
  {
    name: "trial_calibrate",
    description:
      "Validate the draft and calibrate it in the real sandbox exactly as verifiers will: prepare (with network), build, run the tests twice, measure every metric, and run the equivalence harness twice on the same seed. Slow and limited in number; use it when the draft is complete.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit",
    description: "Submit the draft as a recipe proposal. Allowed only right after a trial_calibrate that reported ok, with no edits since.",
    input_schema: { type: "object", properties: { note: { type: "string", description: "one paragraph: what the recipe measures and why it is a good target" } }, required: ["note"], additionalProperties: false },
  },
  {
    name: "give_up",
    description:
      "Stop without a proposal. reason: one plain sentence a visitor of the agent's public page will read (no file dumps, at most 200 characters). impossible: true when no recipe can exist for this repository as it stands (it has no tests of its own that run offline on a CPU, it needs a GPU or other hardware, its results are not deterministic); false when only this draft failed.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, impossible: { type: "boolean" } }, required: ["reason"], additionalProperties: false },
  },
];

/** Overlay paths the drafter may write: lineage_* at any depth, never .git, never an existing repo file. */
export function overlayPathOk(rel: string, repoTree: string): string | null {
  const p = normalize(rel).replace(/^\.\//, "");
  if (!p || p.startsWith("..") || p.startsWith("/") || p.split("/").includes(".git")) return "path outside the overlay";
  if (!/(^|\/)lineage_[\w.-]+$/.test(p)) return "overlay file names must start with lineage_";
  if (existsSync(join(repoTree, p))) return "the repository already has this file; harness files must be new";
  return null;
}

/** The model a recipe is drafted with when the caller names none (a registry id; routed like every Claude call). */
export const DRAFT_MODEL = "claude-opus-5-5";

export class RecipeDrafter {
  constructor(
    private o: {
      client: Anthropic;
      model?: string;
      ledger: SpendLedger;
      capUsd: number;
      /** where the draft lives: <dir>/recipe.yml and <dir>/overlay/ */
      dir: string;
      target: DraftTarget;
      /** an existing recipe of the same class, shown as the format reference */
      example: { recipe_yml: string; overlay: Record<string, string> };
      /** set when the repository already has units: the draft is an additional unit (plan AGENT-EFFICIENCY 8.2) */
      more?: MoreContext;
      maxTrials?: number;
      /** seconds of sandbox time each trial calibration took (the hosted runtime meters them to the agent's vault) */
      onSandbox?: (seconds: number) => void;
      log: (m: string) => void;
    },
  ) {}

  /** Trial calibration of the current draft (also used by tests and scripts directly). */
  async trial(seed = "d1af7"): Promise<TrialReport> {
    let loaded: LoadedRecipe;
    try {
      loaded = loadRecipe(this.o.dir);
    } catch (e) {
      return { ok: false, text: `recipe invalid: ${(e as Error).message}` };
    }
    const r = loaded.recipe;
    const t = this.o.target;
    const fixed: [string, unknown, unknown][] = [
      ["name", r.name, t.name],
      ["repo", r.repo, t.repo],
      ["commit", r.commit, t.commit],
      ["class", r.class, t.class],
      ["requires.arch", r.requires.arch, t.arch],
      ["image", r.image, t.image],
    ];
    for (const [k, got, want] of fixed) if (got !== want) return { ok: false, text: `${k} must be ${want} (got ${got})` };
    // an additional unit: a duplicate of an existing unit is refused here, before any sandbox time
    const dup = this.o.more ? duplicateUnit(r, this.o.more.units.map((u) => u.recipe)) : null;
    if (dup) return { ok: false, text: `duplicate of an existing unit: ${dup.why}` };
    const lines: string[] = [`recipe_id ${loaded.recipe_id}`];
    try {
      const deps = await prepareDeps(loaded);
      lines.push(`prepare ok (deps ${deps.digest.slice(0, 12)})`);
      const { calibration, transcript } = await calibrate({ loaded, deps, seed, runs: 2 });
      lines.push(`build ok; stable tests ${calibration.stable.length}, known failures ${calibration.known_failures.length}, quarantined ${calibration.quarantined.length}`);
      if (calibration.stable.length) lines.push(`stable sample: ${calibration.stable.slice(0, 8).join(", ")}`);
      if (calibration.known_failures.length) lines.push(`known failures: ${calibration.known_failures.slice(0, 10).join(", ")}`);
      let ok = calibration.stable.length > 0;
      for (const m of r.metrics) {
        const c = calibration.metrics[m.name]!;
        lines.push(`metric ${m.name}: ${c.enabled ? "enabled" : "DISABLED"} cv ${c.cv.toExponential(2)} base ${c.base_value ?? "-"}${c.reason ? ` (${c.reason})` : ""}`);
        if (m.deterministic && !c.enabled) ok = false;
      }
      for (const n of transcript.notes.slice(0, 6)) lines.push(`note: ${n.slice(0, 300)}`);
      for (const m of r.metrics) {
        const c = calibration.metrics[m.name];
        if (c?.enabled && typeof c.fixed_value === "number" && typeof c.base_value === "number" && c.base_value > 0) lines.push(`metric ${m.name}: not the library ${c.fixed_value} of ${c.base_value} (${((100 * c.fixed_value) / c.base_value).toFixed(1)}%)`);
      }
      if (this.o.more) {
        const why = headroomError(r, calibration, this.o.more.maxFixedShare);
        if (why) {
          lines.push(`headroom: NOT shown: ${why}`);
          ok = false;
        } else lines.push("headroom: shown");
      }
      if (r.equivalence) {
        const eq = await withBuiltTree({ loaded, deps, parentPatches: [], seed, job: "trial-equiv" }, async (run, tree) => {
          const a = await run("equivalence", r.equivalence!.command, [{ host: tree, container: "/work/src", readonly: true }]);
          const b = await run("equivalence", r.equivalence!.command, [{ host: tree, container: "/work/src", readonly: true }]);
          return { a, b };
        });
        const same = eq.a.exit === 0 && eq.b.exit === 0 && sha256Hex(eq.a.stdout) === sha256Hex(eq.b.stdout) && eq.a.stdout.length > 0;
        lines.push(`equivalence: exit ${eq.a.exit}/${eq.b.exit}, ${eq.a.stdout.length} bytes of output, ${same ? "identical digests" : "NOT identical or failed"}${eq.a.exit ? `; stderr: ${eq.a.stderr.slice(-600)}` : ""}`);
        if (!same) ok = false;
      } else {
        lines.push("equivalence: none (perf metrics need an equivalence harness)");
        ok = false;
      }
      return { ok, recipe_id: loaded.recipe_id, text: lines.join("\n") };
    } catch (e) {
      lines.push(`FAILED: ${(e as Error).message.slice(0, 2500)}`);
      return { ok: false, recipe_id: loaded.recipe_id, text: lines.join("\n") };
    }
  }

  /** Runs the Claude drafting loop. Returns the note when Claude submitted an ok draft. */
  async draft(): Promise<{ submitted: boolean; note?: string; usd: number; turns: number; trials: number; reason?: string; impossible?: boolean }> {
    const t = this.o.target;
    const repoTree = join(newWorkDir("draft-repo"), "src");
    materialize(t.repo, t.commit, null, repoTree);
    mkdirSync(join(this.o.dir, "overlay"), { recursive: true });
    const box = new ToolBox({ tree: repoTree } as unknown as ProposeContext, 0);
    const maxTrials = this.o.maxTrials ?? 4;
    let trials = 0;
    let lastOk: string | null = null; // draft digest of the last ok trial
    const digest = () => {
      const files = [join(this.o.dir, "recipe.yml")];
      const ov = join(this.o.dir, "overlay");
      for (const f of Bun.spawnSync(["find", ov, "-type", "f"]).stdout.toString().split("\n").filter(Boolean).sort()) files.push(f);
      return H("draft", ...files.map((f) => `${relative(this.o.dir, f)}:${existsSync(f) ? sha256Hex(readFileSync(f)) : "-"}`));
    };
    const ex = this.o.example;
    const system = `You are a recipe author in units, a network where agents improve real repositories and every accepted change is reproduced by independent verifiers in a sandbox.

A recipe makes one repository measurable. Draft a recipe for:
- repository ${t.repo} at commit ${t.commit}
- name: ${t.name}; class: ${t.class}; requires.arch: ${t.arch}; image: "${t.image}" (use exactly these)

Sandbox facts: workdir /work/src holds the repository plus your overlay files at the root. prepare commands run once WITH network and may only write under /deps (the repository tree is discarded afterwards); every other step runs with NO network, a read-only /deps, a read-only root filesystem, /tmp as tmpfs, as a non-root user. LINEAGE_SEED is the only nondeterministic input. junit output goes to /out/junit.xml. Commands run under sh -c with cwd /work/src.

Requirements:
- Tests: the repository's own tests, run so the parser recognises every test id (junit via pytest --junitxml=/out/junit.xml works for unittest suites too). Never edit or skip upstream tests.
- Metrics: at least one deterministic perf metric: cachegrind instruction count (parser cachegrind-ir, same valgrind invocation as the example) of an overlay benchmark (lineage_bench.*) whose workload is generated only from the seed argument, exercising the library's real hot path the way it is used in practice, printing a checksum so work cannot be skipped. min_effect 0.01, holdout true.
- Equivalence: an overlay program (lineage_equiv.*) that prints the library's outputs for many seeded random inputs (including edge cases and invalid inputs where the API defines behaviour) so any behaviour change alters the digest.
- patch.allowed_paths: only the library source a patch should change; protected_paths: tests, packaging, CI files and every overlay file (lineage_*).
- Keep limits modest like the example. ${this.o.more ? "The workload is sized by the headroom rule below." : "Bound the workload so one cachegrind run takes a few seconds."}

Format reference, an accepted recipe of the same class (${this.o.more ? "a unit this repository already has" : "another repository"}):
--- recipe.yml ---
${ex.recipe_yml}
${Object.entries(ex.overlay)
  .map(([p, c]) => `--- overlay/${p} ---\n${c}`)
  .join("\n")}

If the repository cannot have a recipe as it stands, do not force one: call give_up with impossible true. That is the case when it has no tests of its own that run offline on a CPU, when its code needs a GPU or other hardware, or when nothing it computes is deterministic. Never write tests for it yourself and never fake a metric.

Work efficiently: read only what you need (the library module and its tests), write the overlay files and recipe, run trial_calibrate, fix what it reports, then submit. You have ${maxTrials} trials.${this.o.more ? moreSection(this.o.more) : ""}`;
    const res = await toolLoop({
      client: this.o.client,
      model: this.o.model ?? DRAFT_MODEL,
      effort: "medium",
      system,
      tools: DRAFT_TOOLS,
      first: this.o.more ? `Start by listing the repository to find what the existing units do not measure, then draft the additional recipe for ${t.repo}.` : `Start by listing the repository, then draft the recipe for ${t.repo}.`,
      ledger: this.o.ledger,
      who: "recipe-drafter",
      capUsd: this.o.capUsd,
      maxTurns: 30,
      log: this.o.log,
      handle: async (name, input) => {
        switch (name) {
          case "list_files":
          case "read_file":
          case "search":
            return box.run(name, input);
          case "write_overlay_file": {
            const p = String(input.path ?? "");
            const err = overlayPathOk(p, repoTree);
            if (err) throw new Error(err);
            const abs = join(this.o.dir, "overlay", normalize(p));
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, String(input.contents ?? ""));
            return `wrote overlay/${p}`;
          }
          case "write_recipe": {
            const y = String(input.yaml ?? "");
            try {
              Bun.YAML.parse(y);
            } catch (e) {
              throw new Error(`not valid YAML: ${(e as Error).message}`);
            }
            if (this.o.more) {
              // free, before any trial: a draft that measures nothing new on the same paths is not written
              const d = Bun.YAML.parse(y) as Partial<Recipe> | null;
              const shaped = d && Array.isArray(d.metrics) && d.metrics.every((m) => m && typeof m.name === "string" && typeof m.command === "string") && Array.isArray(d.patch?.allowed_paths) && d.patch.allowed_paths.every((p) => typeof p === "string");
              const dup = shaped ? duplicateUnit({ name: String(d.name ?? t.name), repo: t.repo, metrics: d.metrics!, patch: d.patch! }, this.o.more.units.map((u) => u.recipe)) : null;
              if (dup) throw new Error(`refused, nothing was written: this draft duplicates an existing unit: ${dup.why}`);
            }
            writeFileSync(join(this.o.dir, "recipe.yml"), y.endsWith("\n") ? y : y + "\n");
            return "wrote recipe.yml";
          }
          case "trial_calibrate": {
            if (trials >= maxTrials) throw new Error(`trial limit reached (${maxTrials}); submit or give_up`);
            trials++;
            this.o.log(`recipe-drafter: trial ${trials}/${maxTrials}`);
            const t0 = Date.now();
            const rep = await this.trial();
            this.o.onSandbox?.((Date.now() - t0) / 1000);
            this.o.log(`recipe-drafter: trial ${trials} ${rep.ok ? "ok" : "not ok"}\n${rep.text}`);
            lastOk = rep.ok ? digest() : null;
            return `${rep.ok ? "TRIAL OK" : "TRIAL NOT OK"}\n${rep.text}`;
          }
          case "submit":
            if (!lastOk || lastOk !== digest()) throw new Error("the last trial_calibrate was not ok, or the draft changed since; trial first");
            return { done: { note: String(input.note ?? "").slice(0, 2000) } };
          case "give_up":
            return { done: { gave_up: String(input.reason ?? "").slice(0, 400), impossible: input.impossible === true } };
          default:
            throw new Error(`unknown tool ${name}`);
        }
      },
    });
    removeTree(dirname(repoTree));
    const v = res.value as { note?: string; gave_up?: string; impossible?: boolean } | null;
    if (v?.note !== undefined) return { submitted: true, note: v.note, usd: res.usd, turns: res.turns, trials };
    if (v?.gave_up !== undefined) return { submitted: false, usd: res.usd, turns: res.turns, trials, reason: v.gave_up || "the drafter gave up without a reason", impossible: v.impossible === true };
    // no decision of the model: the loop ended at its spend cap, its turn limit or a refusal
    return { submitted: false, usd: res.usd, turns: res.turns, trials, reason: trials >= maxTrials ? `the draft did not pass its trial calibration in ${maxTrials} trials` : "the draft was not finished within its spend limit" };
  }
}

// ---------------------------------------------------------------------------------------------
// Submitting

/** Uploads a recipe directory's overlay files as blobs and posts the proposal. */
export async function submitProposal(client: CoreClient, dir: string, note: string) {
  const loaded = loadRecipe(dir);
  const overlay: Record<string, string> = {};
  for (const f of loaded.overlayFiles) {
    const bytes = readFileSync(join(loaded.overlayDir!, f));
    const sha = sha256Hex(bytes);
    const put = await client.putBlob(sha, new Uint8Array(bytes));
    if (put.status >= 300) throw new Error(`blob ${f}: HTTP ${put.status}`);
    overlay[f] = sha;
  }
  const r = await client.post("/v1/recipe-proposals", { recipe: loaded.recipe, recipe_id: loaded.recipe_id, overlay, note });
  if (r.status >= 300) throw new Error(`proposal: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body as { proposal_id: string; status: string; recipe_id: string };
}

// ---------------------------------------------------------------------------------------------
// Verifying

export interface CalibAssignment {
  replay_id: string;
  kind: "calibrate";
  proposal_id: string;
  status: "assigned" | "committed";
  reveal_open: boolean;
  recipe_id: string;
  recipe: Recipe;
  overlay: Record<string, string>;
  seed: string;
  runs: number;
}

/** Writes a proposed recipe (Core's JSON plus overlay blobs) as a recipe directory and checks its id. */
export async function materializeProposal(client: CoreClient, a: { recipe: Recipe; recipe_id: string; overlay: Record<string, string> }, root = join(UNITS_HOME, "proposals")): Promise<LoadedRecipe> {
  // Core supplies both: a compromised Core naming "../../.." made the worker delete and write
  // outside its proposals directory before anything was validated (audit A2, OFF-K1)
  if (typeof a.recipe?.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(a.recipe.name)) throw new RecipeError("proposed recipe name must be lowercase kebab");
  if (typeof a.recipe_id !== "string" || !/^[0-9a-f]{64}$/.test(a.recipe_id)) throw new RecipeError("recipe_id must be 64 hex");
  const dir = join(root, a.recipe.name + "-" + a.recipe_id.slice(0, 12));
  // already written (by an earlier call, or by another process of this home): the id is re-derived from
  // the files, so a match is the same content, and a calibration running in that directory is left alone
  try {
    const have = loadRecipe(dir);
    if (have.recipe_id === a.recipe_id) return have;
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // JSON is YAML; loadRecipe re-derives the overlay digest and protections from the files
  writeFileSync(join(dir, "recipe.yml"), JSON.stringify(a.recipe, null, 2) + "\n");
  for (const [p, sha] of Object.entries(a.overlay)) {
    const r = await client.request("GET", `/v1/blobs/${sha}`, undefined, { sign: false });
    if (r.status !== 200) throw new Error(`overlay blob ${p}: HTTP ${r.status}`);
    const bytes = new Uint8Array(r.body as ArrayBuffer);
    if (sha256Hex(bytes) !== sha) throw new Error(`overlay blob ${p}: digest mismatch`);
    const abs = join(dir, "overlay", normalize(p));
    if (relative(join(dir, "overlay"), abs).startsWith("..")) throw new Error(`overlay path ${p}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  const loaded = loadRecipe(dir);
  if (loaded.recipe_id !== a.recipe_id) throw new RecipeError(`proposed recipe recomputes to ${loaded.recipe_id}, Core says ${a.recipe_id}`);
  return loaded;
}

export class CalibrationVerifier {
  readonly client: CoreClient;
  private pending = new Map<string, { calibration: Calibration; deps_digest: string; salt: string }>();

  constructor(
    core: string,
    key: SigningKey,
    private log: (m: string) => void = (m) => console.log(`[calibrate] ${m}`),
    private root = join(UNITS_HOME, "proposals"),
  ) {
    this.client = new CoreClient(core, key);
  }

  /** True once the worker is stopping: no new calibration run starts. */
  stopping: () => boolean = () => false;

  async once(): Promise<number> {
    const r = await this.client.get("/v1/recipe-proposals/assignments", true);
    if (r.status >= 300) throw new Error(`calibration assignments: HTTP ${r.status}`);
    let acted = 0;
    for (const a of r.body as CalibAssignment[]) {
      try {
        if (a.status === "assigned") {
          if (this.stopping()) continue;
          const t0 = Date.now();
          const loaded = await materializeProposal(this.client, a, this.root);
          const deps = await prepareDeps(loaded);
          const { calibration } = await calibrate({ loaded, deps, seed: a.seed, runs: a.runs });
          const salt = randomBytes(16).toString("hex");
          const res = { calibration, deps_digest: deps.digest };
          this.pending.set(a.replay_id, { ...res, salt });
          const c = await this.client.post(`/v1/recipe-proposals/replays/${a.replay_id}/commit`, { commitment: calibCommitment(res, salt) });
          if (c.status >= 300) throw new Error(`commit: HTTP ${c.status} ${JSON.stringify(c.body)}`);
          const ms = Object.entries(calibration.metrics).map(([k, v]) => `${k}=${v.enabled ? v.base_value : "off"}`).join(" ");
          this.log(`calibration ${a.replay_id.slice(0, 10)} of ${a.recipe.name}: ${calibration.stable.length} stable, ${calibration.known_failures.length} known failures, ${ms}; committed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          acted++;
        } else if (a.reveal_open) {
          const p = this.pending.get(a.replay_id);
          if (!p) continue;
          const v = await this.client.post(`/v1/recipe-proposals/replays/${a.replay_id}/reveal`, p);
          if (v.status >= 300) throw new Error(`reveal: HTTP ${v.status} ${JSON.stringify(v.body)}`);
          this.pending.delete(a.replay_id);
          this.log(`calibration ${a.replay_id.slice(0, 10)}: revealed, proposal ${(v.body as { proposal: string }).proposal}`);
          acted++;
        }
      } catch (e) {
        this.log(`calibration ${a.replay_id.slice(0, 10)}: ${(e as Error).message.slice(0, 600)}`);
      }
    }
    return acted;
  }
}

// ---------------------------------------------------------------------------------------------
// Recipes that came from a proposal

const fetching = new Map<string, Promise<boolean>>();

/**
 * Makes `recipe_id` available in `book`. A recipe Core admitted from a proposal (SPEC 6.2) is in no
 * release: its JSON and overlay blobs are read from Core's accepted proposals once, written under
 * UNITS_HOME/proposals (where the book finds them again after a restart) and checked to recompute to
 * the same id. False when the book does not have it and Core has no accepted proposal for it.
 */
export async function ensureRecipe(book: { has(id: string): boolean; add(l: LoadedRecipe): void }, client: CoreClient, recipe_id: string, root = join(UNITS_HOME, "proposals")): Promise<boolean> {
  if (book.has(recipe_id)) return true;
  if (!/^[0-9a-f]{64}$/.test(recipe_id)) return false;
  let p = fetching.get(recipe_id);
  if (!p) {
    p = (async () => {
      const r = await client.request("GET", "/v1/recipe-proposals?status=accepted", undefined, { sign: false });
      if (r.status !== 200 || !Array.isArray(r.body)) return false;
      const a = (r.body as { recipe: Recipe; recipe_id: string; overlay: Record<string, string> }[]).find((x) => x.recipe_id === recipe_id);
      if (!a) return false;
      book.add(await materializeProposal(client, a, root));
      return true;
    })().finally(() => fetching.delete(recipe_id));
    fetching.set(recipe_id, p);
  }
  return (await p) || book.has(recipe_id);
}

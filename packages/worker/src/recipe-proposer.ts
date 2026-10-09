import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { H, sha256Hex, type Calibration, type Recipe } from "@lineage/protocol";
import { LINEAGE_HOME, calibrate, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree, RecipeError, type LoadedRecipe } from "@lineage/sandbox";
import { CoreClient, type SigningKey } from "../../core/src/client.ts";
import { calibCommitment } from "../../core/src/recipe-proposals.ts";
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
    description: "Stop without a proposal, with the reason.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
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
      maxTrials?: number;
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
  async draft(): Promise<{ submitted: boolean; note?: string; usd: number; turns: number; trials: number; reason?: string }> {
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
    const system = `You are a recipe author in Lineage, a network where agents improve real repositories and every accepted change is reproduced by independent verifiers in a sandbox.

A recipe makes one repository measurable. Draft a recipe for:
- repository ${t.repo} at commit ${t.commit}
- name: ${t.name}; class: ${t.class}; requires.arch: ${t.arch}; image: "${t.image}" (use exactly these)

Sandbox facts: workdir /work/src holds the repository plus your overlay files at the root. prepare commands run once WITH network and may only write under /deps (the repository tree is discarded afterwards); every other step runs with NO network, a read-only /deps, a read-only root filesystem, /tmp as tmpfs, as a non-root user. LINEAGE_SEED is the only nondeterministic input. junit output goes to /out/junit.xml. Commands run under sh -c with cwd /work/src.

Requirements:
- Tests: the repository's own tests, run so the parser recognises every test id (junit via pytest --junitxml=/out/junit.xml works for unittest suites too). Never edit or skip upstream tests.
- Metrics: at least one deterministic perf metric: cachegrind instruction count (parser cachegrind-ir, same valgrind invocation as the example) of an overlay benchmark (lineage_bench.*) whose workload is generated only from the seed argument, exercising the library's real hot path the way it is used in practice, printing a checksum so work cannot be skipped. min_effect 0.01, holdout true.
- Equivalence: an overlay program (lineage_equiv.*) that prints the library's outputs for many seeded random inputs (including edge cases and invalid inputs where the API defines behaviour) so any behaviour change alters the digest.
- patch.allowed_paths: only the library source a patch should change; protected_paths: tests, packaging, CI files and every overlay file (lineage_*).
- Keep limits modest like the example. Bound the workload so one cachegrind run takes a few seconds.

Format reference, an accepted recipe of the same class (another repository):
--- recipe.yml ---
${ex.recipe_yml}
${Object.entries(ex.overlay)
  .map(([p, c]) => `--- overlay/${p} ---\n${c}`)
  .join("\n")}

Work efficiently: read only what you need (the library module and its tests), write the overlay files and recipe, run trial_calibrate, fix what it reports, then submit. You have ${maxTrials} trials.`;
    const res = await toolLoop({
      client: this.o.client,
      model: this.o.model ?? "claude-opus-5-5",
      effort: "medium",
      system,
      tools: DRAFT_TOOLS,
      first: `Start by listing the repository, then draft the recipe for ${t.repo}.`,
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
            writeFileSync(join(this.o.dir, "recipe.yml"), y.endsWith("\n") ? y : y + "\n");
            return "wrote recipe.yml";
          }
          case "trial_calibrate": {
            if (trials >= maxTrials) throw new Error(`trial limit reached (${maxTrials}); submit or give_up`);
            trials++;
            this.o.log(`recipe-drafter: trial ${trials}/${maxTrials}`);
            const rep = await this.trial();
            this.o.log(`recipe-drafter: trial ${trials} ${rep.ok ? "ok" : "not ok"}\n${rep.text}`);
            lastOk = rep.ok ? digest() : null;
            return `${rep.ok ? "TRIAL OK" : "TRIAL NOT OK"}\n${rep.text}`;
          }
          case "submit":
            if (!lastOk || lastOk !== digest()) throw new Error("the last trial_calibrate was not ok, or the draft changed since; trial first");
            return { done: { note: String(input.note ?? "").slice(0, 2000) } };
          case "give_up":
            return { done: { gave_up: String(input.reason ?? "") } };
          default:
            throw new Error(`unknown tool ${name}`);
        }
      },
    });
    removeTree(dirname(repoTree));
    const v = res.value as { note?: string; gave_up?: string } | null;
    if (v?.note !== undefined) return { submitted: true, note: v.note, usd: res.usd, turns: res.turns, trials };
    return { submitted: false, usd: res.usd, turns: res.turns, trials, reason: v?.gave_up ?? "no submission" };
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
export async function materializeProposal(client: CoreClient, a: { recipe: Recipe; recipe_id: string; overlay: Record<string, string> }, root = join(LINEAGE_HOME, "proposals")): Promise<LoadedRecipe> {
  // Core supplies both: a compromised Core naming "../../.." made the worker delete and write
  // outside its proposals directory before anything was validated (audit A2, OFF-K1)
  if (typeof a.recipe?.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(a.recipe.name)) throw new RecipeError("proposed recipe name must be lowercase kebab");
  if (typeof a.recipe_id !== "string" || !/^[0-9a-f]{64}$/.test(a.recipe_id)) throw new RecipeError("recipe_id must be 64 hex");
  const dir = join(root, a.recipe.name + "-" + a.recipe_id.slice(0, 12));
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
    private root = join(LINEAGE_HOME, "proposals"),
  ) {
    this.client = new CoreClient(core, key);
  }

  async once(): Promise<number> {
    const r = await this.client.get("/v1/recipe-proposals/assignments", true);
    if (r.status >= 300) throw new Error(`calibration assignments: HTTP ${r.status}`);
    let acted = 0;
    for (const a of r.body as CalibAssignment[]) {
      try {
        if (a.status === "assigned") {
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

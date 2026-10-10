import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, H, matchesAny, type MetricSpec, type Recipe } from "@lineage/protocol";
import {
  applyPatch,
  commitTime,
  imageArch,
  imageDigest,
  materialize,
  newWorkDir,
  openPermissions,
  parseMetric,
  readRegularFile,
  removeTree,
  runContainer,
  type DepsLayer,
  type LoadedRecipe,
  type RunResult,
} from "@lineage/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import type { SigningKey } from "../../core/src/client.ts";
import { hotspotTarget, profileCommitment, profileTool, repoPath, type Profile, type ProfileFn } from "../../core/src/findings.ts";
import { MODEL_PRICES, ToolBox } from "./proposers/anthropic.ts";
import type { ProposeContext } from "./proposers/types.ts";
import { RecipeBook } from "./recipes.ts";

// LLM discovery (SPEC 12.8). Profiling runs in the same sandbox as every measurement: the lineage's
// tip is built in a fresh container and one deterministic metric is profiled.
// - callgrind (valgrind metrics): the metric command with cachegrind swapped for callgrind, writing
//   /out/callgrind.out; self (exclusive) Ir per function is parsed on the host. Like cachegrind Ir,
//   callgrind Ir is a guest instruction count and reproduces exactly in the pinned image.
// - cu (Solana compute-unit metrics): every CU metric of the recipe is run and the breakdown is per
//   measured instruction (one "function" per metric, self = its compute units).
// A finder (HotspotAnalyst, Claude) reads the profile and the source and names one hotspot; the
// numbers it files are the profile's, never the model's. A replayer (DiscoveryAgent) reruns the
// same profile at the same tip and seed and reveals its own numbers.

// ---------------------------------------------------------------------------------------------
// Profiles

/** The metric command rewritten to run under callgrind, or null when the metric is not valgrind-based. */
export function callgrindCommand(m: MetricSpec): string | null {
  if (m.parser !== "cachegrind-ir" || !/\bvalgrind\s/.test(m.command) || !/--tool=cachegrind\b/.test(m.command)) return null;
  const cmd = m.command
    .replace(/--tool=cachegrind\b/, "--tool=callgrind")
    .replace(/\s--cache-sim=\S+/g, "")
    .replace(/\s--branch-sim=\S+/g, "")
    .replace(/\s--cachegrind-out-file=\S+/g, "")
    .replace(/\bvalgrind\s/, "valgrind --log-fd=9 --callgrind-out-file=/out/callgrind.out --dump-instr=no --compress-pos=no ");
  // valgrind logs to fd 9 (the container's stderr); the program's own output is discarded (SPEC 8 isolation)
  return `exec 9>&2; ( ${cmd} ) >/dev/null 2>/dev/null; lineage_ec=$?; kill -9 -1 2>/dev/null; exit $lineage_ec`;
}

/**
 * Self (exclusive) cost per function from a callgrind output file (format version 1). Cost lines
 * directly after a `calls=` line are inclusive costs of that call and belong to the callee, so they
 * are skipped. Name compression (`fn=(id) name`, later `fn=(id)`) is resolved per kind.
 */
export function parseCallgrind(text: string): Profile & { summary: number | null; events: string[] } {
  const lines = text.split("\n");
  let positions = 1;
  let events: string[] = ["Ir"];
  let summary: number | null = null;
  const names = { fn: new Map<string, string>(), fl: new Map<string, string>(), ob: new Map<string, string>() };
  const resolve = (kind: "fn" | "fl" | "ob", v: string): string => {
    const m = /^\((\d+)\)(?:\s+(.*))?$/.exec(v.trim());
    if (!m) return v.trim();
    if (m[2] !== undefined) {
      names[kind].set(m[1]!, m[2]);
      return m[2];
    }
    return names[kind].get(m[1]!) ?? `(${m[1]})`;
  };
  const costs = new Map<string, ProfileFn>();
  let file: string | null = null;
  let fn: ProfileFn | null = null;
  let skipNext = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l) continue;
    if (l.startsWith("positions:")) positions = l.slice(10).trim().split(/\s+/).length;
    else if (l.startsWith("events:")) events = l.slice(7).trim().split(/\s+/);
    else if (l.startsWith("summary:") || l.startsWith("totals:")) summary = Number(l.split(":")[1]!.trim().split(/\s+/)[0]);
    else if (l.startsWith("fl=")) {
      file = resolve("fl", l.slice(3));
      if (file === "???" || file === "") file = null; // no debug info: the finder attributes the source file
    }
    else if (l.startsWith("fi=") || l.startsWith("fe=")) resolve("fl", l.slice(3)); // inline file: cost stays with the function
    else if (l.startsWith("ob=")) resolve("ob", l.slice(3));
    else if (l.startsWith("cfl=") || l.startsWith("cfi=")) resolve("fl", l.slice(4));
    else if (l.startsWith("cob=")) resolve("ob", l.slice(4));
    else if (l.startsWith("cfn=")) resolve("fn", l.slice(4));
    else if (l.startsWith("fn=")) {
      // callgrind marks recursion levels as name'2, name'3 (--separate-recs): one function, summed
      const name = resolve("fn", l.slice(3)).replace(/'\d+$/, "");
      const key = `${name}\u0000${file ?? ""}`;
      fn = costs.get(key) ?? { fn: name, file, self: 0 };
      costs.set(key, fn);
    } else if (l.startsWith("calls=")) skipNext = true;
    else if (/^[0-9+\-*]/.test(l)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      const parts = l.split(/\s+/);
      const v = Number(parts[positions] ?? 0);
      if (fn && Number.isFinite(v)) fn.self += v;
    }
  }
  const functions = [...costs.values()].filter((f) => f.self > 0).sort((a, b) => b.self - a.self || (a.fn < b.fn ? -1 : 1));
  const total = functions.reduce((a, f) => a + f.self, 0);
  return { total, functions, summary, events };
}

/** The top functions of a profile, at most `n`, as filed or revealed (Core accepts up to 200). */
export function topFunctions(p: Profile, n = 60): Profile {
  return { total: p.total, functions: p.functions.slice(0, n).map((f) => ({ fn: f.fn, file: f.file, self: f.self })) };
}

function envFor(seed: string, sourceEpoch: number): Record<string, string> {
  // the same environment evaluate() gives every sandbox step (packages/sandbox evaluate.ts envFor)
  return {
    LINEAGE_SEED: seed,
    SOURCE_DATE_EPOCH: String(sourceEpoch),
    CARGO_HOME: "/deps/cargo",
    PIP_CACHE_DIR: "/deps/pip-cache",
    npm_config_cache: "/deps/npm-cache",
    VIRTUAL_ENV: "/deps/venv",
    PATH: "/deps/venv/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

export interface ProfileRun {
  tool: "callgrind" | "cu";
  profile: Profile;
  /** callgrind's own summary line, for a consistency check against the summed self costs */
  summary: number | null;
  steps: { step: string; exit: number; duration_ms: number; stderr_tail: string }[];
}

/**
 * Builds the lineage tip (snapshot + overlay + deps outputs + accepted patches) in the sandbox and
 * profiles one deterministic metric with the given seed.
 */
export type SandboxRun = (step: string, cmd: string, mounts: { host: string; container: string; readonly?: boolean }[]) => Promise<RunResult>;

/**
 * Materializes and builds a generation (snapshot + overlay + deps outputs + patches) in a fresh
 * sandbox, then hands `body` a runner for more steps with the same image, limits, environment and
 * read-only deps layer as every replay (SPEC 8). The work directory is removed afterwards.
 */
export async function withBuiltTree<T>(
  input: { loaded: LoadedRecipe; deps: DepsLayer; parentPatches: string[]; seed: string; job: string },
  body: (run: SandboxRun, tree: string, work: string, steps: ProfileRun["steps"]) => Promise<T>,
): Promise<T> {
  const { loaded, deps, seed } = input;
  const r = loaded.recipe;
  const image = await imageDigest(r.image);
  if (r.requires?.arch && imageArch(r.image) !== r.requires.arch) throw new Error(`image arch differs from requires.arch ${r.requires.arch}`);
  const work = newWorkDir(input.job);
  const steps: ProfileRun["steps"] = [];
  const env = envFor(seed, commitTime(r.repo, r.commit));
  const run: SandboxRun = async (step, cmd, mounts) => {
    const res = await runContainer({
      image,
      cmd,
      cwd: "/work/src",
      mounts: [...mounts, { host: join(deps.dir, "layer"), container: "/deps", readonly: true }],
      network: false,
      env,
      limits: r.limits,
      timeout_s: r.limits.wall_s,
      job: `${input.job}-${step}`,
    });
    steps.push({ step, exit: res.exit, duration_ms: res.duration_ms, stderr_tail: res.stderr.slice(-1500) });
    return res;
  };
  try {
    const tree = join(work, "src");
    materialize(r.repo, r.commit, loaded.overlayDir, tree);
    const outputs = join(deps.dir, "outputs");
    if (existsSync(outputs) && readdirSync(outputs).length) cpSync(outputs, tree, { recursive: true });
    input.parentPatches.forEach((p, i) => {
      if (!applyPatch(tree, p)) throw new Error(`parent series broken at generation ${i + 1}`);
    });
    openPermissions(work);
    const b = await run("build", r.build.commands.join(" && "), [{ host: tree, container: "/work/src" }]);
    if (b.exit !== 0) throw new Error(`build failed (${b.exit}): ${b.stderr.slice(-800)}`);
    return await body(run, tree, work, steps);
  } finally {
    removeTree(work);
  }
}

/** Builds the lineage tip and profiles one deterministic metric with the given seed. */
export async function profileTip(input: { loaded: LoadedRecipe; deps: DepsLayer; parentPatches: string[]; metric: string; seed: string }): Promise<ProfileRun> {
  const r = input.loaded.recipe;
  const tool = profileTool(r, input.metric);
  if (!tool) throw new Error(`metric ${input.metric} cannot be profiled (needs a deterministic valgrind or compute-unit metric)`);
  return withBuiltTree({ ...input, job: "profile" }, async (run, tree, work, steps) => {
    if (tool === "cu") {
      const functions: ProfileFn[] = [];
      for (const m of r.metrics.filter((x) => profileTool(r, x.name) === "cu")) {
        const res = await run(`cu-${m.name}`, m.command, [{ host: tree, container: "/work/src", readonly: true }]);
        if (res.exit !== 0) throw new Error(`metric ${m.name} exited ${res.exit}`);
        functions.push({ fn: m.name, file: null, self: parseMetric(m.parser, res.stdout, res.stderr) });
      }
      functions.sort((a, b) => b.self - a.self);
      return { tool, profile: { total: functions.reduce((a, f) => a + f.self, 0), functions }, summary: null, steps };
    }
    const m = r.metrics.find((x) => x.name === input.metric)!;
    const cmd = callgrindCommand(m);
    if (!cmd) throw new Error(`metric ${m.name} has no callgrind form`);
    const out = join(work, "out");
    mkdirSync(out, { recursive: true });
    openPermissions(out);
    const res = await run("callgrind", cmd, [
      { host: tree, container: "/work/src", readonly: true },
      { host: out, container: "/out" },
    ]);
    if (res.exit !== 0) throw new Error(`callgrind run exited ${res.exit}: ${res.stderr.slice(-800)}`);
    const text = readRegularFile(join(out, "callgrind.out"), 256 * 1024 * 1024);
    if (!text) throw new Error("callgrind wrote no output file");
    const p = parseCallgrind(text);
    return { tool, profile: { total: p.total, functions: p.functions }, summary: p.summary, steps };
  });
}

/** A model client (scripts outside packages/worker cannot resolve the SDK themselves). Reads ANTHROPIC_API_KEY. */
export function anthropicClient(): Anthropic {
  return new Anthropic();
}

// ---------------------------------------------------------------------------------------------
// Spend ledger: every model call is priced and logged; a hard cap across runs

export interface SpendEntry {
  at: string;
  who: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
}

/** Append-only JSONL spend log with a hard total cap (the lane's budget). */
export class SpendLedger {
  constructor(public file: string, public capUsd: number) {}

  entries(): SpendEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SpendEntry);
  }

  total(): number {
    return this.entries().reduce((a, e) => a + e.usd, 0);
  }

  remaining(): number {
    return this.capUsd - this.total();
  }

  /** Logs usage that was already priced (the AnthropicProposer's meter, SPEC 13.7 shape). */
  add(who: string, u: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number }): SpendEntry {
    const e: SpendEntry = { at: new Date().toISOString(), who, ...u };
    appendFileSync(this.file, JSON.stringify(e) + "\n");
    return e;
  }

  /** Prices a response's usage (MODEL_PRICES; unknown models at the highest listed rate) and logs it. */
  record(who: string, model: string, u: Anthropic.Beta.BetaUsage): SpendEntry {
    // a dated snapshot id (claude-haiku-4-5-20251001) is priced as its model, not at the highest rate
    const p = MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{8}$/, "")] ?? Object.values(MODEL_PRICES).reduce((a, b) => (b.output > a.output ? b : a));
    const e: SpendEntry = {
      at: new Date().toISOString(),
      who,
      model,
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      usd: 0,
    };
    e.usd = (e.input_tokens * p.input + e.output_tokens * p.output + e.cache_read_tokens * p.cache_read + e.cache_write_tokens * p.cache_write) / 1e6;
    appendFileSync(this.file, JSON.stringify(e) + "\n");
    return e;
  }
}

/**
 * One tool-using conversation with a hard spend cap: before each turn the projected cost (the last
 * turn's cost again) must fit in both the per-task cap and the ledger's remaining budget.
 */
export async function toolLoop(o: {
  client: Anthropic;
  model: string;
  effort: "low" | "medium" | "high";
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  first: string;
  ledger: SpendLedger;
  who: string;
  capUsd: number;
  maxTurns: number;
  log: (m: string) => void;
  /** returns a tool result, or { done } to stop with a value */
  handle: (name: string, input: Record<string, unknown>) => Promise<string | { done: unknown }>;
}): Promise<{ value: unknown; usd: number; turns: number }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.first }];
  let usd = 0;
  let last = 0;
  for (let turn = 0; turn < o.maxTurns; turn++) {
    if (usd + last > o.capUsd || last > o.ledger.remaining()) {
      o.log(`${o.who}: spend cap reached (${usd.toFixed(4)} USD this task, ${o.ledger.total().toFixed(4)} USD in the ledger)`);
      return { value: null, usd, turns: turn };
    }
    const msg = await o.client.beta.messages
      .stream({
        model: o.model,
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: o.effort },
        cache_control: { type: "ephemeral" },
        system: o.system,
        tools: o.tools,
        messages,
      })
      .finalMessage();
    const e = o.ledger.record(o.who, msg.model ?? o.model, msg.usage);
    usd += e.usd;
    last = e.usd;
    o.log(`${o.who}: turn ${turn + 1} ${e.usd.toFixed(4)} USD (${e.input_tokens} in, ${e.output_tokens} out, ${e.cache_read_tokens} cache read, ${e.cache_write_tokens} cache write); task ${usd.toFixed(4)}, ledger ${o.ledger.total().toFixed(4)}`);
    if (msg.stop_reason === "refusal") return { value: null, usd, turns: turn + 1 };
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) return { value: null, usd, turns: turn + 1 };
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let done: { done: unknown } | null = null;
    for (const c of calls) {
      try {
        const out = await o.handle(c.name, (c.input ?? {}) as Record<string, unknown>);
        if (typeof out === "string") results.push({ type: "tool_result", tool_use_id: c.id, content: out });
        else {
          done = out;
          results.push({ type: "tool_result", tool_use_id: c.id, content: "ok" });
        }
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: c.id, is_error: true, content: (err as Error).message });
      }
    }
    if (done) return { value: done.done, usd, turns: turn + 1 };
    messages.push({ role: "user", content: results });
  }
  o.log(`${o.who}: turn limit reached`);
  return { value: null, usd, turns: o.maxTurns };
}

// ---------------------------------------------------------------------------------------------
// The finder: Claude reads the profile and the source and names one hotspot

const READ_TOOLS = ["list_files", "read_file", "search"];

export const ANALYST_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "List files under a directory of the repository (relative path, '.' for the root).",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file, optionally a 1-based inclusive line range.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "search",
    description: "Search the repository for a regular expression. Returns up to 200 matching lines as path:line: text.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "file_hotspot",
    description:
      "File one hotspot finding: a function from the profile table (exact name as listed, by its row number) whose source is in a patchable path and that a bounded patch could make cheaper. The numbers filed are the profile's own.",
    input_schema: {
      type: "object",
      properties: {
        row: { type: "integer", description: "row number in the profile table" },
        file: { type: "string", description: "repository path of the function's source; required when the table shows no file (builds without debug info)" },
        rationale: { type: "string", description: "why this is the hotspot and what a patch could do, two to five sentences" } },
      required: ["row", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "no_hotspot",
    description: "Stop without filing, with the reason (for example: the cost is all in the standard library or the harness).",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
  },
];

/** The identifier a profiled symbol ends in: `<[u8] as base58::ToBase58>::to_base58` gives `to_base58`. */
export function shortName(fn: string): string {
  const last = fn.replace(/<[^<>]*>/g, "").split("::").pop() ?? fn;
  return (/[A-Za-z_][A-Za-z0-9_]*/.exec(last.replace(/\(.*$/, ""))?.[0] ?? last).trim();
}

/**
 * The repository file a profiled function lives in: the profile's own file when it has one, else
 * the finder's attribution, which must exist in the tree and define the symbol's short name.
 */
export function attributeFile(tree: string, f: ProfileFn, claimed: string | null): string {
  const own = repoPath(f.file);
  if (own) return own;
  if (!claimed) throw new Error("this row has no source file in the profile; pass file");
  const rp = repoPath(claimed);
  if (!rp || rp.includes("..")) throw new Error("file must be a repository path");
  const abs = join(tree, rp);
  if (!existsSync(abs)) throw new Error(`${rp} does not exist`);
  const name = shortName(f.fn);
  if (!name || !readFileSync(abs, "utf8").includes(name)) throw new Error(`${rp} does not contain ${name}`);
  return rp;
}

export interface HotspotChoice {
  fn: ProfileFn;
  rationale: string;
}

/** Formats a profile as a numbered table, the rows Claude chooses from. */
export function profileTable(p: Profile, rows = 30): string {
  return p.functions
    .slice(0, rows)
    .map((f, i) => `${i + 1}. ${((100 * f.self) / p.total).toFixed(2)}%  self ${f.self}  ${f.fn}${f.file ? `  [${repoPath(f.file) ?? f.file}]` : ""}`)
    .join("\n");
}

export async function analyseHotspot(o: {
  client: Anthropic;
  model?: string;
  ledger: SpendLedger;
  capUsd: number;
  loaded: LoadedRecipe;
  tree: string;
  metric: string;
  tool: string;
  profile: Profile;
  log: (m: string) => void;
}): Promise<{ choice: HotspotChoice | null; usd: number; turns: number; reason?: string }> {
  const r = o.loaded.recipe;
  const m = r.metrics.find((x) => x.name === o.metric)!;
  const shown = o.profile.functions.slice(0, 30);
  const system = `You are a discovery agent in Lineage, a network where code changes count only when other machines reproduce them.

Repository: ${r.repo} at commit ${r.commit} (class ${r.class}).
You are given a ${o.tool === "cu" ? "compute-unit breakdown" : "callgrind profile (self, exclusive, instruction counts per function)"} of the metric ${o.metric} (${m.direction} is better), measured in the sandbox by: ${m.command}
Patchable paths: ${r.patch.allowed_paths.join(", ")}. Protected (never patchable, includes the benchmark harness): ${r.patch.protected_paths.join(", ")}.

Your job: name ONE hotspot that a bounded patch (at most ${r.patch.max_files} files, ${r.patch.max_lines} lines) to the patchable library source could make measurably cheaper without changing behaviour. Prefer the library function whose own code dominates the metric. Standard library, allocator, interpreter or harness functions are not hotspots by themselves; if they dominate, attribute them to the library function that drives them only if that function is in the table. Read the relevant source before filing. Be brief and efficient: a few tool calls at most. The profile numbers are measured; do not restate or estimate other numbers.`;
  const first = `Profile of ${o.metric}, total ${o.profile.total}, top ${shown.length} functions by self cost:\n${profileTable(o.profile)}`;
  const box = new ToolBox({ tree: o.tree, loaded: o.loaded } as unknown as ProposeContext, 0);
  const res = await toolLoop({
    client: o.client,
    model: o.model ?? "claude-opus-5-5",
    effort: "medium",
    system,
    tools: ANALYST_TOOLS,
    first,
    ledger: o.ledger,
    who: "hotspot-analyst",
    capUsd: o.capUsd,
    maxTurns: 8,
    log: o.log,
    handle: async (name, input) => {
      if (READ_TOOLS.includes(name)) return box.run(name, input);
      if (name === "no_hotspot") return { done: { none: String(input.reason ?? "") } };
      if (name === "file_hotspot") {
        const row = Number(input.row);
        const f = shown[row - 1];
        if (!f) throw new Error(`row ${row} is not in the table`);
        const rp = attributeFile(o.tree, f, typeof input.file === "string" ? input.file : null);
        if (!matchesAny(rp, r.patch.allowed_paths) || matchesAny(rp, r.patch.protected_paths)) throw new Error(`${rp} is not a patchable path; pick a library function`);
        return { done: { fn: { ...f, file: rp }, rationale: String(input.rationale ?? "").slice(0, 2000) } };
      }
      throw new Error(`unknown tool ${name}`);
    },
  });
  const v = res.value as { fn?: ProfileFn; rationale?: string; none?: string } | null;
  if (v?.fn) return { choice: { fn: v.fn, rationale: v.rationale ?? "" }, usd: res.usd, turns: res.turns };
  return { choice: null, usd: res.usd, turns: res.turns, reason: v?.none ?? "no choice" };
}

// ---------------------------------------------------------------------------------------------
// The network side: filing claims and reproducing other agents' profiles

export interface ProfileAssignment {
  replay_id: string;
  kind: "profile";
  claim_id: string;
  status: "assigned" | "committed";
  reveal_open: boolean;
  lineage_id: string;
  recipe_id: string;
  tip: string;
  metric: string;
  tool: string;
  seed: string;
}

export class DiscoveryAgent {
  readonly client: CoreClient;
  private pending = new Map<string, { result: Profile; salt: string }>();

  constructor(
    core: string,
    key: SigningKey,
    private recipes: RecipeBook = new RecipeBook(),
    private log: (m: string) => void = (m) => console.log(`[discovery] ${m}`),
  ) {
    this.client = new CoreClient(core, key);
  }

  private async ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
    const r = await p;
    if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  }

  /** The tip's tree (patch series and dependency digest) and the loaded recipe. */
  async tipOf(lineage: string, gen?: string) {
    const view = await this.ok(this.client.get(`/v1/lineages/${lineage}`), "lineage");
    const tree = await this.ok(this.client.get(`/v1/lineages/${lineage}/tree${gen ? `?gen=${gen}` : ""}`), "tree");
    const loaded = this.recipes.get(view.recipe_id);
    const deps = await this.recipes.depsFor(loaded, tree.deps_digest);
    return { view, tree, loaded, deps, patches: (tree.patches as { patch: string }[]).map((p) => p.patch) };
  }

  /** Files a hotspot claim from a measured profile and Claude's (or any) choice of function. */
  async file(o: { lineage_id: string; tip: string; metric: string; tool: string; seed: string; profile: Profile; choice: HotspotChoice }) {
    const body = {
      lineage_id: o.lineage_id,
      tip: o.tip,
      metric: o.metric,
      tool: o.tool,
      seed: o.seed,
      target: { function: o.choice.fn.fn, file: repoPath(o.choice.fn.file) },
      profile: topFunctions(o.profile),
      note: o.choice.rationale,
    };
    return this.ok(this.client.post("/v1/findings/hotspots", body), "file hotspot");
  }

  /** True once the worker is stopping: no new profile run starts. */
  stopping: () => boolean = () => false;

  /** One pass over this agent's profile assignments: profile and commit new ones, reveal committed ones. */
  async replayOnce(): Promise<number> {
    const list = await this.ok<ProfileAssignment[]>(this.client.get("/v1/findings/assignments", true), "profile assignments");
    let acted = 0;
    for (const a of list) {
      try {
        if (a.status === "assigned" && !this.stopping()) {
          const t0 = Date.now();
          const { loaded, deps, patches } = await this.tipOf(a.lineage_id, a.tip);
          const run = await profileTip({ loaded, deps, parentPatches: patches, metric: a.metric, seed: a.seed });
          const result = topFunctions(run.profile, 200);
          const salt = randomBytes(16).toString("hex");
          this.pending.set(a.replay_id, { result, salt });
          await this.ok(this.client.post(`/v1/findings/replays/${a.replay_id}/commit`, { commitment: profileCommitment(result, salt) }), "commit profile");
          this.log(`profile ${a.replay_id.slice(0, 10)} (${a.metric}, ${a.tool}): total ${run.profile.total}, top ${run.profile.functions[0]?.fn ?? "-"}, committed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          acted++;
        }
        const p = this.pending.get(a.replay_id);
        if (p && (a.status === "committed" || a.status === "assigned")) {
          const r = await this.ok(this.client.post(`/v1/findings/replays/${a.replay_id}/reveal`, { result: p.result, salt: p.salt }), "reveal profile");
          this.pending.delete(a.replay_id);
          this.log(`profile ${a.replay_id.slice(0, 10)}: revealed, claim ${(r as { claim: string }).claim}`);
          acted++;
        }
      } catch (e) {
        this.log(`profile ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`);
      }
    }
    return acted;
  }
}

/** A seed for the finder's own profile run. */
export const discoverySeed = (): string => randomBytes(16).toString("hex");

/** Digest of a profile as filed (for logs and run records). */
export const profileDigest = (p: Profile): string => H("profile", canonicalJson(p));

export { hotspotTarget, type Recipe };

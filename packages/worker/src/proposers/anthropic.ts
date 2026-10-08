import Anthropic from "@anthropic-ai/sdk";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { canonicalizeDiff, guard, judge, matchesAny, sha256Hex, type CandidateKind, type CandidateView } from "@lineage/protocol";
import { diffWorkingTree, evaluate } from "@lineage/sandbox";
import type { Proposal, ProposeContext, Proposer } from "./types.ts";

// LLM proposer: Claude edits the parent tree through a small, path-confined tool set and can
// measure its own change in the real sandbox before submitting. Spend is metered per attempt
// against a hard dollar cap.

export interface AnthropicProposerOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** hard cap for one attempt, USD */
  max_usd: number;
  max_turns?: number;
  max_evals?: number;
  /** price table in USD per million tokens; defaults are the published rates for the default model */
  prices?: { input: number; output: number; cache_read: number; cache_write: number };
}

/** claude-opus-5-5 published rates (USD per million tokens); cache writes at 1.25x input. */
const OPUS_55 = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 };

/**
 * Published rates (USD per million tokens, cache writes at 1.25x input) of the models a response can
 * come from: the requested model, or another one when the server-side refusal fallback answered.
 * A model missing here is priced at the highest rate listed, so spend is never under-counted.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-opus-5-5": OPUS_55,
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
};
const PRICE_CEILING = MODEL_PRICES["claude-fable-5-1"]!;

/** Version of this proposer's harness (prompt and tool set); provenance records it (identity plan I5). */
export const PROPOSER_VERSION = "anthropic/1";

const SKIP_DIRS = new Set([".git", "target", "node_modules", "__pycache__", ".venv", "dist", "build"]);
const MAX_READ = 60_000;

type ToolInput = Record<string, unknown>;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "List files under a directory of the repository (relative path, '.' for the root). Build output and VCS directories are hidden.",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file, optionally a 1-based inclusive line range. Long files are truncated; read them in ranges.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search the repository for a regular expression (case sensitive). Returns up to 200 matching lines as path:line: text.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "Replace exactly one occurrence of old_string with new_string in a file. Only files under the allowed paths and outside the protected paths can be edited.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a whole file. Same path rules as edit_file. Prefer edit_file for small changes.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false },
  },
  {
    name: "evaluate",
    description:
      "Build, test and measure your current change against the parent in the real sandbox, exactly as replayers will. Returns the guard result, failing tests, equivalence result and the measured ratio for the target. Slow and limited in number: use it when you believe the change is ready.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["perf", "fix", "slim"] }, target: { type: "string", description: "metric name, or a known-failure test id for kind fix" } },
      required: ["kind", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "submit",
    description: "Submit the current change as a candidate. Call this only after evaluate reported the change as accepted. Or call give_up.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["perf", "fix", "slim"] }, target: { type: "string" }, rationale: { type: "string" } },
      required: ["kind", "target", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "give_up",
    description: "Stop without submitting, with the reason (for example: no measurable improvement found).",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
  },
];

function systemPrompt(ctx: ProposeContext): string {
  const r = ctx.loaded.recipe;
  const c = ctx.calibration;
  const metrics = r.metrics
    .map((m) => {
      const cal = c.metrics[m.name];
      const state = cal?.enabled === false ? `DISABLED (${cal.reason})` : "enabled";
      return `- ${m.name}: kind ${m.kind}, ${m.direction} is better, ${m.deterministic ? "deterministic (instruction counts or sizes)" : `wall-clock, ${m.rounds} interleaved rounds`}, minimum improvement ${(m.min_effect * 100).toFixed(1)}%, ${state}. Measured by: ${m.command}`;
    })
    .join("\n");
  return `You are an authoring agent in Lineage, a network that only accepts code changes other machines can reproduce.

Repository: ${r.repo} at commit ${r.commit}${ctx.parentPatches.length ? `, plus ${ctx.parentPatches.length} accepted generation patches already applied` : ""}.

Your job: make ONE bounded change to the library source that measurably improves a target below, without changing behaviour, then submit it. Independent replayers will rebuild, rerun the full test suite and remeasure with random benchmark seeds you never see. A change is accepted only if:
- it touches only these paths: ${r.patch.allowed_paths.join(", ")}; never these protected paths: ${r.patch.protected_paths.join(", ")};
- at most ${r.patch.max_files} files and ${r.patch.max_lines} added plus removed lines;
- every stable test still passes (${c.stable.length} stable tests);
- for perf and slim: outputs are byte-identical to the parent on seeded random inputs (equivalence harness${r.equivalence ? ": " + r.equivalence.command : ": none for this recipe"}), and the metric improves by at least its minimum on every replay;
- for fix: the targeted known-failing tests pass afterwards.

Metrics:
${metrics}

Known failing tests (fix targets): ${c.known_failures.length ? c.known_failures.join(", ") : "none"}.

Rules that matter:
- Do not special-case benchmark inputs, seeds, the harness, environment variables or timing. Replayers use holdout seeds and auditors read every patch.
- Do not weaken behaviour the tests do not cover; the equivalence harness will catch it.
- Read the hot code before editing. Prefer one clear algorithmic or allocation improvement over many micro-edits.
- Use evaluate before submit. If evaluate does not report accepted, either fix the change or give_up. Submitting a change that fails costs your agent its compute for nothing.
- Be efficient with tool calls; your compute is metered.${ctx.soul ? `\n${ctx.soul}` : ""}`;
}

/** sha256 over the tool set and the prompt template: which harness produced a candidate (provenance, identity plan I5). */
export const HARNESS_DIGEST = sha256Hex(new TextEncoder().encode(JSON.stringify({ v: PROPOSER_VERSION, tools: TOOLS, prompt: systemPrompt.toString() })));

export class AnthropicProposer implements Proposer {
  readonly name = "anthropic";
  private client: Anthropic;
  private opts: Required<Omit<AnthropicProposerOptions, "prices">> & { prices: NonNullable<AnthropicProposerOptions["prices"]> };

  constructor(opts: AnthropicProposerOptions, client?: Anthropic) {
    this.client = client ?? new Anthropic();
    this.opts = {
      model: opts.model ?? "claude-opus-5-5",
      effort: opts.effort ?? "high",
      max_usd: opts.max_usd,
      max_turns: opts.max_turns ?? 40,
      max_evals: opts.max_evals ?? 4,
      prices: opts.prices ?? OPUS_55,
    };
  }

  async propose(ctx: ProposeContext): Promise<Proposal | null> {
    const o = this.opts;
    // a hosted runtime may lower the cap for one attempt (its per-agent and global budgets)
    const cap = Math.min(o.max_usd, ctx.maxUsd ?? Infinity);
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0 };
    let lastTurnUsd = 0;
    const addUsage = (u: Anthropic.Beta.BetaUsage, model: string) => {
      const p = model === o.model ? o.prices : (MODEL_PRICES[model] ?? PRICE_CEILING);
      const d = {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      };
      const usd = (d.input_tokens * p.input + d.output_tokens * p.output + d.cache_read_tokens * p.cache_read + d.cache_write_tokens * p.cache_write) / 1e6;
      usage.input_tokens += d.input_tokens;
      usage.output_tokens += d.output_tokens;
      usage.cache_read_tokens += d.cache_read_tokens;
      usage.cache_write_tokens += d.cache_write_tokens;
      usage.usd += usd;
      lastTurnUsd = usd;
      try {
        ctx.meter?.model({ ...d, usd, model });
      } catch {
        /* metering must not change what the model sees */
      }
    };
    const tools = new ToolBox(ctx, o.max_evals);
    const held = (ctx.intents ?? []).filter((i) => i.agent !== ctx.self && i.status === "open");
    const findings =
      (ctx.findings.map((f) => `- ${f.kind}: ${f.target}`).join("\n") || "- (none listed; pick a metric)") +
      (held.length
        ? `\n\nOther agents have filed public intents (advisory, no locks) on: ${held.map((i) => `${i.kind} ${Array.isArray(i.target) ? i.target.join(",") : i.target}`).join("; ")}. Prefer another target unless you have a clearly different idea.`
        : "");
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: `Open findings for this lineage:\n${findings}\n\nStart by exploring the source, then make and evaluate your change.` },
    ];

    for (let turn = 0; turn < o.max_turns; turn++) {
      // projected: the next turn is assumed to cost what the last one did, so the cap holds before a turn, not after it
      if (usage.usd >= cap || usage.usd + lastTurnUsd > cap) {
        ctx.log(`anthropic: spend cap reached (${usage.usd.toFixed(4)} USD spent, cap ${cap.toFixed(4)})`);
        return null;
      }
      const stream = this.client.beta.messages.stream({
        model: o.model,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: o.effort },
        cache_control: { type: "ephemeral" },
        system: systemPrompt(ctx),
        tools: TOOLS,
        messages,
      });
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.APIError) throw err;
        ctx.log("anthropic: unparseable tool input, re-issuing turn");
        continue;
      }
      addUsage(message.usage, message.model ?? o.model);
      if (message.stop_reason === "refusal") {
        ctx.log(`anthropic: refusal (${message.stop_details?.category ?? "no category"})`);
        return null;
      }
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) {
        ctx.log("anthropic: ended without submit");
        return null;
      }
      if (message.stop_reason === "max_tokens") throw new Error("tool input truncated at max_tokens");
      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let submitted: Proposal | null = null;
      let gaveUp = false;
      for (const call of calls) {
        const input = (call.input ?? {}) as ToolInput;
        if (call.name === "submit") {
          const v = tools.validateSubmit(input);
          if (v.ok) {
            submitted = { kind: v.kind, target: v.kind === "fix" ? [v.target] : v.target, rationale: String(input.rationale ?? ""), claimed_effect: v.ratio };
            results.push({ type: "tool_result", tool_use_id: call.id, content: "submitted" });
          } else results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: v.error });
          continue;
        }
        if (call.name === "give_up") {
          ctx.log(`anthropic: gave up: ${String(input.reason ?? "")}`);
          tools.report({ kind: "give_up" });
          gaveUp = true;
          results.push({ type: "tool_result", tool_use_id: call.id, content: "ok" });
          continue;
        }
        try {
          const out = await tools.run(call.name, input);
          results.push({ type: "tool_result", tool_use_id: call.id, content: out });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: (e as Error).message });
        }
      }
      if (submitted) return { ...submitted, usage };
      if (gaveUp) return null;
      messages.push({ role: "user", content: results });
      ctx.log(`anthropic: turn ${turn + 1}, ${usage.usd.toFixed(4)} USD so far`);
    }
    ctx.log("anthropic: turn limit reached");
    return null;
  }
}

/** Path-confined tool implementations. Exported for tests. */
export class ToolBox {
  private evals = 0;
  private lastAccepted: { kind: CandidateKind; target: string; diffHash: string; ratio?: number } | null = null;

  constructor(private ctx: ProposeContext, private maxEvals: number) {}

  /** Live activity (SPEC 17.1). Never throws: telemetry must not change what the model sees. */
  report(e: Parameters<NonNullable<ProposeContext["activity"]>>[0]): void {
    try {
      this.ctx.activity?.(e);
    } catch {
      /* ignore */
    }
  }

  private resolvePath(p: unknown): { abs: string; rel: string } {
    if (typeof p !== "string" || p.length === 0) throw new Error("path must be a non-empty string");
    const abs = resolve(this.ctx.tree, normalize(p));
    const rel = relative(this.ctx.tree, abs);
    if (rel.startsWith("..") || rel === "" && p !== "." || rel.split("/").includes(".git")) throw new Error("path outside the repository");
    // the repository itself may ship symlinks pointing outside it (adversarial review 2026-10-07):
    // resolve every existing component and refuse anything that lands outside the real tree root
    const root = realpathSync(this.ctx.tree);
    let probe = abs;
    while (!existsSync(probe) && probe !== root && probe.length > root.length) probe = dirname(probe);
    const real = existsSync(probe) ? realpathSync(probe) : root;
    if (real !== root && !real.startsWith(root + sep)) throw new Error("path outside the repository");
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error("symlinks are not followed");
    return { abs, rel: rel || "." };
  }

  private checkWritable(rel: string): void {
    const rules = this.ctx.loaded.recipe.patch;
    if (matchesAny(rel, rules.protected_paths)) throw new Error(`${rel} is protected`);
    if (!matchesAny(rel, rules.allowed_paths)) throw new Error(`${rel} is outside the allowed paths (${rules.allowed_paths.join(", ")})`);
  }

  async run(name: string, input: ToolInput): Promise<string> {
    switch (name) {
      case "list_files": {
        const { abs, rel } = this.resolvePath(input.dir ?? ".");
        if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error("not a directory");
        const out: string[] = [];
        const walk = (d: string, depth: number) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (SKIP_DIRS.has(e.name)) continue;
            const p = join(d, e.name);
            if (e.isDirectory()) {
              if (depth < 4) walk(p, depth + 1);
            } else out.push(relative(this.ctx.tree, p));
            if (out.length > 500) return;
          }
        };
        walk(abs, 0);
        return `${rel}:\n` + out.sort().join("\n");
      }
      case "read_file": {
        const { abs, rel } = this.resolvePath(input.path);
        if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("no such file");
        const bytes = readFileSync(abs);
        const lines = bytes.toString("utf8").split("\n");
        const s = typeof input.start_line === "number" ? Math.max(1, input.start_line) : 1;
        const e = typeof input.end_line === "number" ? Math.min(lines.length, input.end_line) : lines.length;
        // the hash covers the whole file, so the wall can check it against the generation tree
        if (e >= s) this.report({ kind: "read", path: rel, start_line: s, end_line: e, content_sha256: sha256Hex(bytes) });
        let text = lines
          .slice(s - 1, e)
          .map((l, i) => `${s + i}\t${l}`)
          .join("\n");
        if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + `\n[truncated; ${lines.length} lines total, read a range]`;
        return `${rel} (${lines.length} lines)\n${text}`;
      }
      case "search": {
        if (typeof input.pattern !== "string") throw new Error("pattern must be a string");
        if (input.pattern.length > 0 && input.pattern.length <= 500) this.report({ kind: "search", query: input.pattern });
        const p = Bun.spawnSync(["git", "grep", "-n", "-E", "-I", "--", input.pattern], { cwd: this.ctx.tree });
        const out = p.stdout.toString().split("\n").filter(Boolean);
        return out.length ? out.slice(0, 200).join("\n") + (out.length > 200 ? `\n[${out.length - 200} more]` : "") : "no matches";
      }
      case "edit_file": {
        const { abs, rel } = this.resolvePath(input.path);
        this.checkWritable(rel);
        if (typeof input.old_string !== "string" || typeof input.new_string !== "string") throw new Error("old_string and new_string must be strings");
        const src = readFileSync(abs, "utf8");
        const count = src.split(input.old_string).length - 1;
        if (count !== 1) throw new Error(`old_string must occur exactly once (found ${count})`);
        // path and line range only: the new text stays sealed until the candidate is revealed
        const start = src.slice(0, src.indexOf(input.old_string)).split("\n").length;
        this.report({ kind: "edit", path: rel, start_line: start, end_line: start + Math.max(0, input.old_string.split("\n").length - 1) });
        writeFileSync(abs, src.replace(input.old_string, () => input.new_string as string));
        return `edited ${rel}`;
      }
      case "write_file": {
        const { abs, rel } = this.resolvePath(input.path);
        this.checkWritable(rel);
        if (typeof input.contents !== "string") throw new Error("contents must be a string");
        if (existsSync(abs)) this.report({ kind: "edit", path: rel, start_line: 1, end_line: Math.max(1, readFileSync(abs, "utf8").split("\n").length) });
        writeFileSync(abs, input.contents);
        return `wrote ${rel}`;
      }
      case "evaluate":
        return this.evaluate(input);
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  currentDiff(): string {
    const raw = diffWorkingTree(this.ctx.tree);
    return raw.trim() ? canonicalizeDiff(raw) : "";
  }

  private async evaluate(input: ToolInput): Promise<string> {
    if (this.evals >= this.maxEvals) throw new Error(`evaluation limit reached (${this.maxEvals})`);
    const kind = input.kind as CandidateKind;
    const target = String(input.target ?? "");
    const diff = this.currentDiff();
    if (!diff) return "no changes yet";
    const g = guard(diff, this.ctx.loaded.recipe.patch);
    if (!g.ok) return `guard rejected the change: ${g.violation} (${g.detail})`;
    this.evals++;
    this.ctx.log(`anthropic: evaluating (${this.evals}/${this.maxEvals})`);
    this.report({ kind: "evaluate", target: target.slice(0, 200) || kind });
    const { result, transcript } = await evaluate({ loaded: this.ctx.loaded, deps: this.ctx.deps, parentPatches: this.ctx.parentPatches, candidatePatch: diff, seed: this.ctx.seed, onPhase: this.ctx.onPhase, enabledMetrics: Object.entries(this.ctx.calibration.metrics).filter(([, m]) => m.enabled).map(([n]) => n) });
    // sandbox time as the transcript records it (hosted runtime metering, SPEC 13.7)
    try {
      this.ctx.meter?.sandbox(transcript.steps.reduce((a, st) => a + st.duration_ms, 0) / 1000);
    } catch {
      /* ignore */
    }
    const cand: CandidateView = { candidate_id: "self", author: "self", kind, target: kind === "fix" ? [target] : target };
    const j = judge(this.ctx.loaded.recipe, this.ctx.calibration, cand, [{ replay_id: "self", replayer: "self-check", seed: this.ctx.seed, result }], {
      quorum: 1,
      det_tolerance: 0.001,
      bootstrap_resamples: 4000,
    });
    const lines = [`outcome: ${j.outcome}${j.reason ? ` (${j.reason}: ${j.detail})` : ""}`, `guard: ok, ${g.files} files, ${g.lines} lines`];
    lines.push(`build: base ${result.build.base}, candidate ${result.build.cand}`);
    const failing = this.ctx.calibration.stable.filter((t) => !result.tests.cand_pass.includes(t));
    if (failing.length) lines.push(`stable tests failing: ${failing.slice(0, 20).join(", ")}`);
    if (result.equivalence) lines.push(`equivalence: ${result.equivalence.base_digest === result.equivalence.cand_digest ? "identical outputs" : "OUTPUTS DIFFER from parent"}`);
    for (const [name, s] of Object.entries(result.metrics)) {
      if (s.base.length && s.cand.length) {
        const b = s.base.reduce((a, x) => a + x, 0) / s.base.length;
        const c = s.cand.reduce((a, x) => a + x, 0) / s.cand.length;
        lines.push(`metric ${name}: parent ${Math.round(b)}, candidate ${Math.round(c)}, ratio ${(c / b).toFixed(4)}`);
      }
    }
    let ratio: number | undefined;
    if (j.effect && "ratio" in j.effect) ratio = j.effect.ratio;
    this.lastAccepted = j.outcome === "accepted" ? { kind, target, diffHash: Bun.hash(diff).toString(), ratio } : null;
    return lines.join("\n");
  }

  validateSubmit(input: ToolInput): { ok: true; kind: CandidateKind; target: string; ratio?: number } | { ok: false; error: string } {
    const a = this.lastAccepted;
    if (!a) return { ok: false, error: "the last evaluate did not report accepted; evaluate first or give_up" };
    if (a.kind !== input.kind || a.target !== input.target) return { ok: false, error: `submit must match the last accepted evaluation (${a.kind} ${a.target})` };
    if (Bun.hash(this.currentDiff()).toString() !== a.diffHash) return { ok: false, error: "the change was edited after the last evaluation; evaluate again" };
    return { ok: true, kind: a.kind, target: a.target, ratio: a.ratio };
  }
}

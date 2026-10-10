#!/usr/bin/env bun
// Real provider sessions (plan M exit): for every provider with a key in ~/.config/lineage/providers.env
// (or Anthropic's in model.env), one capped authoring attempt on a calibrated recipe through the
// runtime's routing: a soul names the model, RoutedProposer resolves it against the model registry
// (config/models.json), the adapter runs the real API with the real sandbox, every response is metered
// at the registry price, and a provenance record is built from what the meter saw. Keys are never
// printed. Results append to scripts/providers/RUNS.md and RUNS-LAST.json.
//
//   bun scripts/providers/real-session.ts [--recipe recipes/fixture-b58] [--max-usd 0.3] [--model provider/id ...]
// Without --model: per provider with a key, its cheapest priced model.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeDiff } from "@lineage/protocol";
import { diffWorkingTree, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import type { ModelChoice, ModelRegistry } from "../../packages/core/src/model-registry.ts";
import { loadProviderKeys } from "../../packages/worker/src/proposers/providers.ts";
import { RegistrySource, RoutedProposer } from "../../packages/runtime/src/providers.ts";
import { provenanceRecord, type AttemptTotals } from "../../packages/runtime/src/provenance.ts";
import { redact } from "../../packages/runtime/src/state.ts";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const many = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]!] : []));
const recipeDir = resolve(ROOT, opt("recipe") ?? "recipes/fixture-b58");
const maxUsd = Number(opt("max-usd") ?? 0.3);

const reg: ModelRegistry = JSON.parse(readFileSync(join(ROOT, "config/models.json"), "utf8"));
const keys = loadProviderKeys();
const picks: ModelChoice[] = many("model").length
  ? many("model").map((s) => ({ provider: s.split("/")[0]!, id: s.split("/").slice(1).join("/") }))
  : Object.keys(keys).flatMap((p) => {
      const ms = reg.models.filter((m) => m.provider === p && m.status === "verified" && m.enabled !== false).sort((a, b) => a.rate!.output - b.rate!.output);
      return ms.length ? [{ provider: p, id: ms[0]!.id }] : [];
    });
console.log(`providers with a key: ${Object.keys(keys).join(", ") || "none"}; sessions: ${picks.map((p) => `${p.provider}/${p.id}`).join(", ")}; cap ${maxUsd} USD each`);

const loaded = loadRecipe(recipeDir);
const calib = JSON.parse(readFileSync(join(recipeDir, "calibration.json"), "utf8"));
const calibration = calib.calibration ?? calib;
const deps = await prepareDeps(loaded);
const results: unknown[] = [];
// OpenRouter's own account of each session (plan MODELS-AND-SELF-FUNDING): total_usage before and after
const orUsage = async (): Promise<number | null> => {
  if (!keys.openrouter) return null;
  const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${keys["openrouter-management"] ?? keys.openrouter}` } }).catch(() => null);
  const j = r?.ok ? ((await r.json()) as { data?: { total_usage?: number } }) : null;
  return typeof j?.data?.total_usage === "number" ? j.data.total_usage : null;
};

for (const pick of picks) {
  const work = newWorkDir("provider-session");
  const tree = join(work, "src");
  const t0 = Date.now();
  const totals: AttemptTotals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: t0, finished_at: 0 };
  const logs: string[] = [];
  let error: string | null = null;
  let proposal: unknown = null;
  let diffLines = 0;
  const usageBefore = await orUsage();
  try {
    materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
    const findings = loaded.recipe.metrics.filter((m) => calibration.metrics[m.name]?.enabled).map((m) => ({ key: m.name, kind: "metric_target", target: m.name }));
    // Core stand-in for the two reads the router makes: the registry, and the agent's soul naming the model
    const core = (async (url: string) => (url.endsWith("/v1/models") ? Response.json({ registry: reg }) : Response.json({ doc: { model: pick } }))) as unknown as typeof fetch;
    const o = { core: "http://core.invalid", keys, attempt_max_usd: maxUsd, effort: "low" as const, max_turns: 14, max_evals: 2, fetch: core };
    const p = new RoutedProposer("SESSION", o, new RegistrySource(o));
    proposal = await p.propose({
      loaded,
      deps,
      calibration,
      parentPatches: [],
      findings,
      tree,
      seed: "a11ce5eed0000002",
      log: (m) => {
        logs.push(m);
        console.log(redact(`[${pick.provider}] ${m}`));
      },
      meter: {
        model: (u) => {
          totals.input_tokens += u.input_tokens;
          totals.output_tokens += u.output_tokens;
          totals.cache_read_tokens += u.cache_read_tokens;
          totals.cache_write_tokens += u.cache_write_tokens;
          totals.usd += u.usd;
          if (!totals.models.includes(u.model)) totals.models.push(u.model);
        },
        sandbox: (s) => (totals.sandbox_s += s),
        harness: (h) => (totals.proposer = h),
        route: (rt) => (totals.route = { via: rt.via, model: rt.model, upstream: totals.route?.upstream ?? [] }),
        upstream: (n) => {
          const rt = (totals.route ??= { via: "openrouter", model: pick, upstream: [] });
          if (!rt.upstream.includes(n)) rt.upstream.push(n);
        },
      },
    });
    const raw = diffWorkingTree(tree);
    diffLines = raw.trim() ? canonicalizeDiff(raw).split("\n").length : 0;
  } catch (e) {
    error = redact((e as Error).message);
    console.log(`[${pick.provider}] error: ${error}`);
  } finally {
    removeTree(work);
  }
  totals.finished_at = Date.now();
  // OpenRouter's usage counter can lag a few seconds behind the last response
  let usageAfter: number | null = null;
  // (seen 2026-10-10: per-session deltas were off by up to a session; read until two readings agree)
  for (let i = 0, prev: number | null = null; i < 12 && usageBefore !== null; i++) {
    await Bun.sleep(10_000);
    usageAfter = await orUsage();
    if (usageAfter !== null && usageAfter > usageBefore && usageAfter === prev) break;
    prev = usageAfter;
  }
  const record = provenanceRecord({ commit_id: "0".repeat(64), agent: "SESSION", recipe_id: loaded.recipe_id, lineage_id: "0".repeat(64), totals, amount: 0n, price: { line_per_usd: "0", line_per_sandbox_s: "0" }, requestedModel: pick.id });
  const r = { at: new Date().toISOString(), pick: `${pick.provider}/${pick.id}`, recipe: loaded.recipe.name, seconds: Math.round((Date.now() - t0) / 1000), usd: Number(totals.usd.toFixed(6)), tokens: { in: totals.input_tokens, out: totals.output_tokens, cache_read: totals.cache_read_tokens, cache_write: totals.cache_write_tokens }, sandbox_s: Math.ceil(totals.sandbox_s), outcome: error ? `error: ${error}` : proposal ? "submitted" : (logs.filter((l) => !l.startsWith("model route")).pop() ?? "no proposal"), diff_lines: diffLines, provenance: { models: record.models, provider: record.provider, proposer: record.proposer, harness_digest: record.harness_digest, route: record.route ?? null }, openrouter_credits_used: usageBefore !== null && usageAfter !== null ? Number((usageAfter - usageBefore).toFixed(6)) : null };
  results.push(r);
  console.log(JSON.stringify(r, null, 2));
}

writeFileSync(join(import.meta.dir, "RUNS-LAST.json"), JSON.stringify(results, null, 2) + "\n");
const md = join(import.meta.dir, "RUNS.md");
if (!existsSync(md)) writeFileSync(md, "# Provider sessions (plan M)\n\nReal authoring attempts through the runtime's provider routing, one per provider with a key. Spend is the registry price of the tokens the API reported.\n\n| at (UTC) | model | recipe | outcome | USD | tokens in / out / cache read | sandbox s | provenance |\n|---|---|---|---|---|---|---|---|\n");
for (const r of results as any[])
  appendFileSync(md, `| ${r.at.slice(0, 16).replace("T", " ")} | ${r.pick} | ${r.recipe} | ${String(r.outcome).replace(/\|/g, "/").slice(0, 120)} | ${r.usd.toFixed(4)} | ${r.tokens.in} / ${r.tokens.out} / ${r.tokens.cache_read} | ${r.sandbox_s} | ${r.provenance.provider}: ${r.provenance.models.join(", ")}, ${r.provenance.proposer.name} ${r.provenance.proposer.version}${r.provenance.route ? `; route ${r.provenance.route.via}${r.provenance.route.upstream.length ? ` (${r.provenance.route.upstream.join(", ")})` : ""}` : ""}${r.openrouter_credits_used !== null && r.openrouter_credits_used !== undefined ? `; OpenRouter credits used ${r.openrouter_credits_used}` : ""} |\n`);

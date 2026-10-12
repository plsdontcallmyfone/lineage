#!/usr/bin/env bun
// Proof that a picked model is the model that runs (plan MODELS-AND-SELF-FUNDING, route rule of
// 2026-10-12). For every model in config/models.json the hosted runtime's own resolveRoute picks the
// route with the keys of providers.env, and ONE real request with the authoring tool set goes out the
// way the runtime sends it: Claude models to OpenRouter's Anthropic Messages endpoint through the
// Anthropic SDK, the others to its chat completions endpoint. The answer's own `model` and upstream
// `provider` are recorded beside the soul's model and the id that was sent. No Core, no chain, no
// sandbox; keys are never printed.
//
//   bun scripts/models/route-proof.ts [--only provider[,provider]] [--one-per-provider] [--out file.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry } from "../../packages/core/src/model-registry.ts";
import { TOOLS } from "../../packages/worker/src/proposers/anthropic.ts";
import { FUNCTION_TOOLS } from "../../packages/worker/src/proposers/openai-compat.ts";
import { loadProviderKeys, loadProviderSpecs } from "../../packages/worker/src/proposers/providers.ts";
import { anthropicClientFor, resolveRoute } from "../../packages/runtime/src/providers.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const reg: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../config/models.json"), "utf8"));
const keys = loadProviderKeys({ create: false });
const specs = loadProviderSpecs();
const only = opt("only")?.split(",");
const SYSTEM = "You are checking a tool connection. Use the tools; do not answer in prose.";
const USER = "Call list_files with dir '.' now.";
const fee = 1 + (reg.routing?.openrouter?.funding_fee_bps ?? 0) / 10_000;

const rows: Record<string, unknown>[] = [];
const seen = new Set<string>();
for (const m of reg.models) {
  if (only && !only.includes(m.provider)) continue;
  if (argv.includes("--one-per-provider") && seen.has(m.provider)) continue;
  const r = resolveRoute(reg, { provider: m.provider, id: m.id }, keys, specs);
  const row: Record<string, unknown> = { soul_model: `${m.provider}/${m.id}`, name: m.name };
  rows.push(row);
  if (!r.ok) {
    row.error = `no route: ${r.why}`;
    continue;
  }
  seen.add(m.provider);
  Object.assign(row, { via: r.via, sent_to: r.provider.id, sent_id: r.model.id });
  try {
    if (specs[m.provider]?.adapter === "anthropic") {
      const c = anthropicClientFor(r);
      const res = (await c.beta.messages.create({ model: r.model.id, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: [{ role: "user", content: USER }], ...(r.request_extra as object) })) as unknown as { model: string; provider?: string; content: { type: string; name?: string }[]; usage: Record<string, unknown> };
      Object.assign(row, { endpoint: "messages", answered_model: res.model, upstream: res.provider ?? null, tool_call: res.content.find((b) => b.type === "tool_use")?.name ?? null, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cost: res.usage.cost ?? null });
    } else {
      const res = await fetch(`${r.provider.base_url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${r.key}`, ...(r.provider.headers ?? {}) },
        body: JSON.stringify({ model: r.model.id, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }], tools: FUNCTION_TOOLS, tool_choice: "auto", [r.provider.token_param ?? "max_tokens"]: 1024, ...(r.provider.extra_body ?? {}), ...r.request_extra }),
      });
      const j = (await res.json()) as { model?: string; provider?: string; choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[]; usage?: Record<string, unknown>; error?: { message?: string; code?: unknown } };
      if (!res.ok || !j.choices) throw new Error(`HTTP ${res.status}${j.error ? ` ${String(j.error.code ?? "")} ${String(j.error.message ?? "").slice(0, 200)}` : ""}`);
      Object.assign(row, { endpoint: "chat/completions", answered_model: j.model ?? null, upstream: j.provider ?? null, tool_call: j.choices[0]?.message?.tool_calls?.[0]?.function?.name ?? null, input_tokens: j.usage?.prompt_tokens ?? null, output_tokens: j.usage?.completion_tokens ?? null, cost: j.usage?.cost ?? null });
    }
    // the answer names the id that was sent, or a dated snapshot of it
    const a = String(row.answered_model ?? "");
    row.same_model = a === r.model.id || a.startsWith(`${r.model.id}-`) || a.startsWith(`${r.model.id}:`);
  } catch (e) {
    row.error = String((e as Error).message).slice(0, 300);
  }
  console.log(JSON.stringify(row));
}
const cost = rows.reduce((a, r) => a + (typeof r.cost === "number" ? r.cost : 0), 0);
const out = { at: new Date().toISOString(), prefer: reg.routing?.prefer ?? "openrouter", models: rows.length, answered: rows.filter((r) => !r.error).length, tool_calls: rows.filter((r) => r.tool_call).length, same_model: rows.filter((r) => r.same_model).length, openrouter_cost_usd: Number(cost.toFixed(6)), metered_usd: Number((cost * fee).toFixed(6)), rows };
if (opt("out")) writeFileSync(opt("out")!, JSON.stringify(out, null, 1) + "\n");
console.log(`${out.answered} of ${out.models} answered, ${out.tool_calls} with a tool call, ${out.same_model} named the sent model; OpenRouter charged ${out.openrouter_cost_usd} USD`);

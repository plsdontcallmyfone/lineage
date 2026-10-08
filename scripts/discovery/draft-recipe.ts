#!/usr/bin/env bun
// Claude drafts a recipe for a new real repository (SPEC 6.2, W6). The draft is written to
// recipes/<name>/ (recipe.yml + overlay/) and trial-calibrated in the real sandbox; Claude may
// only submit a draft whose last trial was ok. Every model call is priced and appended to
// scripts/discovery/spend.jsonl; the lane's hard cap (3 USD total) is enforced across runs.
//
// Usage: bun scripts/discovery/draft-recipe.ts [--cap 1.2] [--example base58-py]
// Target (chosen by the lane, drafted by Claude): sipa/bech32, the Bech32/Bech32m reference
// implementation (BIP 173/350) in Python, MIT licence (header of ref/python/segwit_addr.py), with
// its own unittest suite (ref/python/tests.py) and a checksum loop (bech32_polymod) as hot path.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRecipe } from "@lineage/sandbox";
import { SpendLedger, anthropicClient } from "../../packages/worker/src/discovery.ts";
import { RecipeDrafter, type DraftTarget } from "../../packages/worker/src/recipe-proposer.ts";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const LANE_CAP = 3;
const ledger = new SpendLedger(join(import.meta.dir, "spend.jsonl"), LANE_CAP);
const cap = Math.min(Number(opt("cap") ?? 1.2), ledger.remaining());
if (!(cap > 0)) {
  console.error(`no budget left: ledger total ${ledger.total().toFixed(4)} USD of ${LANE_CAP}`);
  process.exit(1);
}

for (const line of readFileSync(`${process.env.HOME}/.config/lineage/model.env`, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const exampleName = opt("example") ?? "base58-py";
const ex = loadRecipe(join(ROOT, "recipes", exampleName));
const overlay: Record<string, string> = {};
for (const f of readdirSync(ex.overlayDir!)) overlay[f] = readFileSync(join(ex.overlayDir!, f), "utf8");

const target: DraftTarget = {
  name: "bech32-py",
  repo: "https://github.com/sipa/bech32",
  commit: "7a7d7ab158db7078a333384e0e918c90dbc42917",
  class: "python",
  arch: ex.recipe.requires.arch as "arm64" | "amd64",
  image: ex.recipe.image,
};
const dir = join(ROOT, "recipes", target.name);
if (existsSync(join(dir, "recipe.yml")) && !argv.includes("--force")) {
  console.error(`${dir}/recipe.yml exists; pass --force to redraft`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const before = ledger.total();
const drafter = new RecipeDrafter({
  client: anthropicClient(),
  ledger,
  capUsd: cap,
  dir,
  target,
  example: { recipe_yml: readFileSync(join(ex.dir, "recipe.yml"), "utf8"), overlay },
  log: (m) => console.log(`[draft] ${m}`),
});
const t0 = Date.now();
const out = await drafter.draft();
const record = {
  target,
  model: "claude-opus-5-5",
  example: exampleName,
  submitted: out.submitted,
  note: out.note ?? null,
  reason: out.reason ?? null,
  turns: out.turns,
  trials: out.trials,
  usd: Math.round(out.usd * 1e6) / 1e6,
  ledger_total_usd: Math.round(ledger.total() * 1e6) / 1e6,
  wall_seconds: Math.round((Date.now() - t0) / 100) / 10,
  date: new Date().toISOString(),
};
writeFileSync(join(dir, "proposal.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
console.log(`spend this run ${(ledger.total() - before).toFixed(4)} USD; lane total ${ledger.total().toFixed(4)} of ${LANE_CAP}`);

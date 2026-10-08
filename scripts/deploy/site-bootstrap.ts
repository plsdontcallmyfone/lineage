#!/usr/bin/env bun
// Lineage site: creates the site's lineages. Runs on the server as the `lineage` user, once per
// deploy (systemd unit lineage-bootstrap, a oneshot before lineage-reference). Idempotent: recipes
// and snapshots are upserts and a recipe that already has a lineage is not calibrated again.
//
//   bun scripts/deploy/site-bootstrap.ts --recipes fixture-b58,base58-py,minbpe [--core http://127.0.0.1:9660]
//     [--caps /var/lib/lineage/site/caps.json] [--runs 5]
//
// For each recipe (already re-pinned to this machine by arch-recipes.ts): register the recipe and
// its snapshot with Core (admin key), flag the site's reference runner (registered on chain by
// site-chain.ts), and let it calibrate the recipe in the sandbox, which creates the lineage. Needs
// Docker. Writes /var/lib/lineage/site/lineages.json ({ name: { recipe_id, lineage_id } }).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSolanaJson } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { Worker } from "../../packages/worker/src/index.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = opt("core") ?? "http://127.0.0.1:9660";
const names = (opt("recipes") ?? "fixture-b58,base58-py,minbpe").split(",").filter(Boolean);
const caps = JSON.parse(readFileSync(opt("caps") ?? "/var/lib/lineage/site/caps.json", "utf8"));
const RUNS = Number(opt("runs") ?? 5);
const SITE = join(homedir(), ".config", "lineage", "site");
const OUT = "/var/lib/lineage/site/lineages.json";
const log = (m: string) => console.log(`[bootstrap] ${m}`);
const key = (n: string) => keyFromSolanaJson(JSON.parse(readFileSync(join(SITE, `${n}.json`), "utf8")));

async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

for (let i = 0; i < 120 && !(await fetch(`${CORE}/v1/health`).catch(() => null))?.ok; i++) await Bun.sleep(1000);
const admin = key("admin");
const ref = key("verifier-ref");
const A = new CoreClient(CORE, admin);
// Core mirrors onchain agents every poll; the reference runner appears once site-chain.ts registered it.
for (let i = 0; ; i++) {
  if ((await A.get(`/v1/agents/${ref.id}`)).status === 200) break;
  if (i === 0) await A.post("/v1/admin/chain/sync", {});
  if (i > 60) throw new Error(`reference runner ${ref.id} is not in Core: is it registered on chain (site-chain.ts)?`);
  await Bun.sleep(5000);
}
await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference flag");
const worker = new Worker({ core: CORE, key: ref, capabilities: caps, log: (m) => log(`ref ${m}`) });
await worker.declareCapabilities();

const result: Record<string, { recipe_id: string; lineage_id: string | null }> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
let failed = 0;
for (const name of names) {
  try {
    const loaded = loadRecipe(join(ROOT, "recipes", name));
    log(`${name}: recipe ${loaded.recipe_id.slice(0, 12)}..., preparing the dependency layer`);
    const deps = await prepareDeps(loaded);
    await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
    const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
    let lineage = (await ok<any[]>(A.get("/v1/lineages"), "lineages")).find((l) => l.recipe_id === loaded.recipe_id);
    if (!lineage) {
      log(`${name}: calibrating, ${RUNS} runs (reference runner)`);
      await worker.submitCalibration(loaded.recipe_id, snap.snapshot_id, RUNS);
      lineage = (await ok<any[]>(A.get("/v1/lineages"), "lineages")).find((l) => l.recipe_id === loaded.recipe_id);
    }
    result[name] = { recipe_id: loaded.recipe_id, lineage_id: lineage?.lineage_id ?? null };
    log(`${name}: lineage ${lineage?.lineage_id?.slice(0, 12) ?? "none"}`);
  } catch (e) {
    failed++;
    log(`${name}: FAILED ${(e as Error).message}`);
  }
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
}
log(failed ? `${failed} recipe(s) failed` : "done");
process.exit(failed ? 1 : 0);

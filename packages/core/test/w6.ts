import { calibId, recipeId, signMessage, type Calibration, type Recipe } from "../src/protocol.ts";
import { CALIB, DEPS, RECIPE, SNAP, bare, expectOk, makeVerifier, type Agent, type Env } from "./helpers.ts";

// Shared fixtures for the W6 tests (findings.test.ts, recipe-proposals.test.ts).

export const IMG = `lineage/fx@sha256:${"a".repeat(64)}`;
export const R2: Recipe = {
  ...RECIPE,
  image: IMG,
  metrics: [
    { ...RECIPE.metrics[0]!, command: "valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null bench encode $LINEAGE_SEED", parser: "cachegrind-ir" },
    ...RECIPE.metrics.slice(1),
  ],
};
export const CALIB2: Calibration = { ...CALIB, recipe_id: recipeId(R2), snapshot_id: SNAP };

/** A Core with one lineage of R2 (class rust, arm64, vetted image IMG) and `n` qualified verifiers. */
export async function w6env(n = 3, over: Record<string, unknown> = {}): Promise<Env> {
  const b = bare(over);
  await expectOk(b.admin.c.post("/v1/admin/recipes", { recipe: R2, recipe_id: recipeId(R2) }));
  await expectOk(b.admin.c.post("/v1/admin/snapshots", { repo: R2.repo, commit: R2.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(b.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB2, sig: signMessage(ref.key, calibId(CALIB2.recipe_id, SNAP, CALIB2)) }));
  const verifiers: Agent[] = [];
  for (let i = 0; i < n; i++) verifiers.push(await makeVerifier(b));
  return { ...b, verifiers, reference: ref, lineage: lin.lineage_id, gen0: lin.gen0 };
}


#!/usr/bin/env bun
// C7b prototype (docs/plans/C7B-UPSTREAM-DEPENDENCY-CREDIT.md): measures how much a downstream
// crate gains when its vendored dependency layer is swapped from an upstream lineage's base to
// trees that include the upstream's accepted generations, and attributes that gain to the upstream
// generations with the same exact Shapley code the measured split uses (packages/protocol shapley.ts).
//
// Fixture pair:
//   upstream   fixtures/b58 (the fixture-b58 lineage's repository), with its accepted perf patches
//              perf_encode (encode) and perf_decode (digit_value lookup, used by decode only);
//   downstream a small address crate written here (scripts/c7b/addr), depending on the upstream by
//              path through vendor/fixture-b58, the way a recipe's deps layer is vendored. Its own
//              code (a version byte and a 4-byte checksum) runs before every upstream encode call.
//
// Every number comes from real runs in the lineage/rust:m1 sandbox image under cachegrind (the
// fixture lineage's deterministic metric). Usage: bun scripts/c7b/prototype.ts [--out <json>]
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orientedRatio, sha256Hex, shapleyValues, sharesBps } from "@lineage/protocol";
import { containerUser, loadRecipe, parseCachegrindIr, runContainer } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1]! : join(import.meta.dir, "RESULTS.json");
const recipe = loadRecipe(join(ROOT, "recipes/fixture-b58")).recipe;
const IMAGE = recipe.image;
const SEED = "c7b0c7b0c7b0c7b0";
const UPSTREAM_PATCHES = ["perf_encode", "perf_decode"] as const;

function git(cwd: string, args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=c7b", "-c", "user.email=c7b@lineage", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** Upstream tree with the patches of `mask` applied (bit i = UPSTREAM_PATCHES[i]). */
function upstreamTree(dest: string, mask: number) {
  cpSync(join(ROOT, "fixtures/b58"), dest, { recursive: true });
  git(dest, ["init", "-q"]);
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "-m", "base"]);
  UPSTREAM_PATCHES.forEach((name, i) => {
    if (!(mask & (1 << i))) return;
    const f = join(dest, ".git", `${name}.diff`);
    writeFileSync(f, readFileSync(join(ROOT, "fixtures/b58-patches", `${name}.diff`), "utf8"));
    git(dest, ["apply", f]);
  });
  rmSync(join(dest, ".git"), { recursive: true, force: true });
}

async function run(dir: string, cmd: string, job: string) {
  const r = await runContainer({
    image: IMAGE,
    cmd,
    cwd: "/work",
    mounts: [{ host: dir, container: "/work" }],
    network: false,
    env: { CARGO_TARGET_DIR: "/work/target", CARGO_HOME: "/tmp/cargo" },
    limits: { ...recipe.limits, wall_s: 600 },
    timeout_s: 600,
    job,
  });
  if (r.exit !== 0) throw new Error(`${job}: exit ${r.exit}\n${r.stderr.slice(-2000)}`);
  return r;
}

const valgrind = (bin: string, args: string) => `valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null ${bin} ${args}`;

interface State {
  mask: number;
  upstream: string[];
  downstream_ir: number[];
  downstream_digest: string;
  upstream_encode_ir: number;
  build_s: number;
}

async function measure(mask: number): Promise<State> {
  const dir = mkdtempSync(join(tmpdir(), "lineage-c7b-"));
  try {
    cpSync(join(import.meta.dir, "addr"), dir, { recursive: true });
    upstreamTree(join(dir, "vendor/fixture-b58"), mask);
    cpSync(join(ROOT, "recipes/fixture-b58/overlay/examples"), join(dir, "vendor/fixture-b58/examples"), { recursive: true });
    Bun.spawnSync(["chmod", "-R", "a+rwX", dir]);
    const t0 = performance.now();
    await run(dir, "cargo build --release --offline --examples && cd vendor/fixture-b58 && CARGO_TARGET_DIR=/work/target-up cargo build --release --offline --examples", `c7b-build-${mask}`);
    const build_s = (performance.now() - t0) / 1000;
    const ir: number[] = [];
    let digest = "";
    // three runs: cachegrind instruction counts are deterministic, the repeats show it
    for (let k = 0; k < 3; k++) {
      const r = await run(dir, valgrind("target/release/examples/addr_bench", SEED), `c7b-ir-${mask}-${k}`);
      ir.push(parseCachegrindIr(r.stderr + "\n" + r.stdout));
      const d = sha256Hex(r.stdout.trim());
      if (digest && d !== digest) throw new Error("downstream output changed between runs");
      digest = d;
    }
    const eq = await run(dir, "target/release/examples/addr_bench --print " + SEED, `c7b-eq-${mask}`);
    const up = await run(dir, valgrind("target-up/release/examples/lineage_bench", `encode ${SEED}`), `c7b-up-${mask}`);
    return {
      mask,
      upstream: UPSTREAM_PATCHES.filter((_, i) => mask & (1 << i)),
      downstream_ir: ir,
      downstream_digest: sha256Hex(eq.stdout),
      upstream_encode_ir: parseCachegrindIr(up.stderr + "\n" + up.stdout),
      build_s: Math.round(build_s * 10) / 10,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const started = new Date().toISOString();
const states: State[] = [];
for (let mask = 0; mask < 1 << UPSTREAM_PATCHES.length; mask++) {
  const s = await measure(mask);
  console.log(`deps layer {${s.upstream.join(", ") || "base"}}: downstream Ir ${s.downstream_ir.join(", ")}, upstream encode Ir ${s.upstream_encode_ir}, build ${s.build_s}s`);
  states.push(s);
}
const base = states[0]!.downstream_ir[0]!;
const v = states.map((s) => Math.max(0, 1 - orientedRatio(base, s.downstream_ir[0]!, "lower")));
const phi = shapleyValues(UPSTREAM_PATCHES.length, v);
const share = sharesBps(phi);
const full = states.at(-1)!;
const results = {
  started,
  finished: new Date().toISOString(),
  image: IMAGE,
  seed: SEED,
  host: `${process.platform} ${process.arch}`,
  states,
  deterministic: states.every((s) => s.downstream_ir.every((x) => x === s.downstream_ir[0])),
  behaviour_preserved: states.every((s) => s.downstream_digest === states[0]!.downstream_digest),
  downstream_ratio_full_swap: full.downstream_ir[0]! / base,
  upstream_encode_ratio_full: full.upstream_encode_ir / states[0]!.upstream_encode_ir,
  coalition_gains: Object.fromEntries(states.map((s, i) => [s.upstream.join("+") || "base", v[i]])),
  shapley: Object.fromEntries(UPSTREAM_PATCHES.map((n, i) => [n, phi[i]])),
  share_bps: share ? Object.fromEntries(UPSTREAM_PATCHES.map((n, i) => [n, share[i]])) : null,
  container_user: containerUser(),
};
writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ ...results, states: undefined }, null, 2));

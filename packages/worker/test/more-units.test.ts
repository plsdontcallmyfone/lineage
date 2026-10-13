import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Recipe } from "@units/protocol";
import { loadRecipe } from "@units/sandbox";
import type { CoreClient } from "../../core/src/client.ts";
import type { SpendLedger } from "../src/discovery.ts";
import { CLASS_NOTES, RecipeDrafter, classNotes, describeUnits, moreSection, type ExistingUnit } from "../src/recipe-proposer.ts";
import { REPO_ROOT } from "../src/recipes.ts";

// The drafter of an ADDITIONAL unit (docs/plans/AGENT-EFFICIENCY.md 8.2): what it is told about the
// repository's existing units, and the duplicate refusal before any sandbox time.

const base = loadRecipe(join(REPO_ROOT, "recipes/base58-py")).recipe;
const unit = (over: Partial<ExistingUnit> = {}): ExistingUnit => ({
  name: base.name,
  recipe: base,
  height: 25,
  metrics: base.metrics.map((m, i) => ({ name: m.name, kind: m.kind, command: m.command, enabled: true, base_value: 1_000_000 * (i + 1), accepted: i === 0 ? 9 : 0, ratio: i === 0 ? 0.1532 : 1, fixed_share: i === 0 ? 0.42 : null })),
  recent: "of its last 12 final attempts 9 ended without an improvement and 2 were accepted (largest gain 1.2%)",
  ...over,
});

describe("what the drafter of an additional unit is told", () => {
  const text = moreSection({ units: [unit()], maxFixedShare: 0.1 });
  test("each existing unit: allowed paths, tests, every target with its command, calibrated value and what was achieved", () => {
    expect(text).toContain("THIS IS AN ADDITIONAL UNIT");
    expect(text).toContain(`unit base58-py (25 accepted generations); a patch may change: ${base.patch.allowed_paths.join(", ")}; tests: \`${base.test.command}\``);
    const m0 = base.metrics[0]!;
    expect(text).toContain(`- ${m0.name} (perf): \`${m0.command}\`; calibrated 1000000; 9 accepted changes, now at 0.1532 of its start; at least 42.0% of what is left is not the library`);
    expect(text).toContain(`- ${base.metrics[1]!.name} (perf): \`${base.metrics[1]!.command}\`; calibrated 2000000; no accepted change yet`);
    expect(text).toContain("recent work: of its last 12 final attempts 9 ended without an improvement");
  });
  test("what to add, and the two rules with the setting's figure", () => {
    expect(text).toContain("(a) another part of the code");
    expect(text).toContain("(b) a heavier or more realistic workload on the same code, as NEW targets with their own names");
    expect(text).toContain("(c) more targets");
    expect(text).toContain("fails unless it is at most 10% of the metric");
    expect(moreSection({ units: [unit()], maxFixedShare: 0.125 })).toContain("at most 12.5% of the metric");
    expect(text).toContain("fixed_command: <the same command> --inputs-only");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the duplicate refusal costs no sandbox time", () => {
  test("a draft with the existing unit's targets on its paths fails its trial before anything runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "units-more-draft-"));
    mkdirSync(join(dir, "overlay"), { recursive: true });
    for (const f of loadRecipe(join(REPO_ROOT, "recipes/base58-py")).overlayFiles) {
      mkdirSync(join(dir, "overlay", f, ".."), { recursive: true });
      writeFileSync(join(dir, "overlay", f), await Bun.file(join(REPO_ROOT, "recipes/base58-py/overlay", f)).text());
    }
    const draft: Recipe = { ...base, name: "base58-2" };
    delete (draft as { overlay_digest?: string }).overlay_digest;
    writeFileSync(join(dir, "recipe.yml"), JSON.stringify(draft, null, 2));
    let sandbox = 0;
    const d = new RecipeDrafter({
      client: {} as Anthropic,
      ledger: {} as SpendLedger,
      capUsd: 1,
      dir,
      target: { name: "base58-2", repo: base.repo, commit: base.commit, class: base.class, arch: base.requires.arch, image: base.image },
      example: { recipe_yml: "", overlay: {} },
      more: { units: [unit()], maxFixedShare: 0.1 },
      onSandbox: () => sandbox++,
      log: () => {},
    });
    const rep = await d.trial();
    expect(rep.ok).toBe(false);
    expect(rep.text).toStartWith("duplicate of an existing unit: it measures nothing the unit base58-py does not already measure on the same paths");
    expect(sandbox).toBe(0);
  });
});

test("describeUnits reads the recipe, the calibrated values, the accepted changes per target and the dry facts from Core", async () => {
  const L = "a".repeat(64);
  const m0 = base.metrics[0]!.name;
  const client = {
    request: async (_m: string, path: string) => {
      if (path === `/v1/lineages/${L}`)
        return {
          status: 200,
          body: {
            recipe: base, height: 3,
            calibration: { metrics: Object.fromEntries(base.metrics.map((m) => [m.name, { enabled: true, cv: 0, base_value: 500 }])) },
            generations: [
              { entry_type: "genesis", reverted_by: null, effect: null },
              { entry_type: "patch", reverted_by: null, effect: { metric: m0, ratio: 0.5 } },
              { entry_type: "patch", reverted_by: null, effect: { metric: m0, ratio: 0.8 } },
              { entry_type: "patch", reverted_by: "x", effect: { metric: m0, ratio: 0.1 } },
            ],
          },
        };
      if (path === `/v1/lineages/${L}/dry`) return { status: 200, body: { facts: { attempts: 12, fruitless: 9, accepted: 2, best_gain_pct: 1.24, fixed: { [m0]: { share: 0.6 } } } } };
      return { status: 404, body: null };
    },
  } as unknown as CoreClient;
  const [u] = await describeUnits(client, [L]);
  expect(u!.name).toBe("base58-py");
  expect(u!.metrics[0]).toMatchObject({ name: m0, base_value: 500, accepted: 2, fixed_share: 0.6 });
  expect(u!.metrics[0]!.ratio).toBeCloseTo(0.4, 12);
  expect(u!.metrics[1]).toMatchObject({ accepted: 0, ratio: 1, fixed_share: null });
  expect(u!.recent).toBe("of its last 12 final attempts 9 ended without an improvement and 2 were accepted (largest gain 1.2%)");
});

describe("class conventions in the drafter's prompt", () => {
  test("every class with a toolchain image a draft can use has its block: python, rust, go, zig, cpp, solana", () => {
    for (const cls of ["python", "rust", "go", "zig", "cpp", "solana"]) {
      expect(classNotes(cls)).toContain(`Conventions of class ${cls}`);
      expect(CLASS_NOTES[cls]).not.toContain(String.fromCharCode(0x2014));
    }
    expect(classNotes("cuda")).toBe("");
  });
  test("each block names the class's own test parser and where its harness lives", () => {
    expect(CLASS_NOTES.rust).toContain("parser libtest");
    expect(CLASS_NOTES.rust).toContain("examples/lineage_bench.rs");
    expect(CLASS_NOTES.go).toContain("gotap");
    expect(CLASS_NOTES.go).toContain("GOMAXPROCS=1 GOGC=off");
    expect(CLASS_NOTES.zig).toContain("parser bytes");
    expect(CLASS_NOTES.cpp).toContain("parser tap");
    expect(CLASS_NOTES.solana).toContain("compute units");
    expect(CLASS_NOTES.solana).toContain("no fixed_command");
    expect(CLASS_NOTES.python).toContain("--junitxml=/out/junit.xml");
  });
  test("the conventions match the recipes of each class in this tree", () => {
    const of = (name: string) => loadRecipe(join(REPO_ROOT, "recipes", name)).recipe;
    expect(of("base58-rs").test.parser).toBe("libtest");
    expect(of("bip39-go").test.command).toContain("gotap");
    expect(of("bip39-go").metrics[0]!.command).toContain("GOMAXPROCS=1 GOGC=off");
    expect(of("zig-clap").metrics[0]!.parser).toBe("bytes");
    expect(of("bitcoin-base58").test.parser).toBe("tap");
    expect(of("spl-record").metrics[0]!.parser).toBe("number");
    expect(of("base58-py").test.command).toContain("--junitxml=/out/junit.xml");
  });
});

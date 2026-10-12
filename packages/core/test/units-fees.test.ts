import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitsFees } from "../src/units-fees.ts";
import { expectOk, setup, type Env } from "./helpers.ts";

// GET /v1/units-fees: the fee keeper's public log, summed. No log, no figures.

let env: Env | null = null;
const saved = process.env.UNITS_FEES_LOG;
afterEach(() => {
  env?.close();
  env = null;
  if (saved === undefined) delete process.env.UNITS_FEES_LOG;
  else process.env.UNITS_FEES_LOG = saved;
});

const line = (n: number, over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, run_id: `run-${n}`, time: `2026-10-12T00:0${n}:00.000Z`, cluster: "mainnet", mint: "MINT", creator: "CREATOR", venue: "curve",
  collected_lamports: "27732291", collect_cost_lamports: "895881", collect_signature: `c${n}`, reserve_lamports: "10000000", compute_share_lamports: "8418205",
  burn_share_lamports: "8418205", compute_lamports: "8418205", compute_address: "COMPUTE", compute_signature: `p${n}`, buyback_lamports: "2970296", units_bought: "79324982117",
  buyback_signature: `b${n}`, units_burned: "79324982117", burn_signature: `b${n}`, overhead_lamports: "3928482",
  owed: { compute_lamports: "0", buyback_lamports: "5447909", burn_units: "0", reserve_lamports: "6071518" }, notes: [], ...over,
});

describe("GET /v1/units-fees", () => {
  test("no keeper log: available false and no figure", async () => {
    process.env.UNITS_FEES_LOG = join(mkdtempSync(join(tmpdir(), "units-fees-")), "none.jsonl");
    const e = (env = await setup({ verifiers: 1 }));
    const r = await expectOk(e.anon.get("/v1/units-fees"));
    expect([r.available, r.totals, r.runs]).toEqual([false, null, []]);
    expect(r.reason).toContain("has not written a log");
  });
  test("totals are the sums of the log's lines; runs come newest first, limited; the keeper's private ledger is not served", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "units-fees-")), "runs.jsonl");
    writeFileSync(file, [line(1), line(2, { collected_lamports: "0", collect_cost_lamports: "0", collect_signature: null, compute_lamports: "0", compute_signature: null, units_bought: "5", units_burned: "5", buyback_lamports: "7", overhead_lamports: "5001" }),
      line(3)].join("\n") + "\n");
    process.env.UNITS_FEES_LOG = file;
    const e = (env = await setup({ verifiers: 1 }));
    const r = await expectOk(e.anon.get("/v1/units-fees"));
    expect(r.available).toBe(true);
    expect(r.totals).toEqual({
      runs: 3, first_run_at: "2026-10-12T00:01:00.000Z", last_run_at: "2026-10-12T00:03:00.000Z", collected_lamports: "55464582", collect_cost_lamports: "1791762",
      compute_lamports: "16836410", buyback_lamports: "5940599", units_bought: "158649964239", units_burned: "158649964239", overhead_lamports: "7861965",
    });
    expect([r.mint, r.compute_address]).toEqual(["MINT", "COMPUTE"]);
    expect(r.runs.map((x: { run_id: string }) => x.run_id)).toEqual(["run-3", "run-2", "run-1"]);
    expect(r.runs[1]).toMatchObject({ collect_signature: null, compute_signature: null, units_burned: "5", burn_signature: "b2" });
    expect(JSON.stringify(r)).not.toContain("owed");
    expect(JSON.stringify(r)).not.toContain("CREATOR");
    const one = await expectOk(e.anon.get("/v1/units-fees?limit=1"));
    expect([one.runs.length, one.runs[0].run_id, one.totals.runs]).toEqual([1, "run-3", 3]);
    // a new line is served on the next read
    appendFileSync(file, line(4) + "\n");
    expect((await expectOk(e.anon.get("/v1/units-fees?limit=1"))).totals.runs).toBe(4);
  });
  test("a torn last line, a repeated run id and a malformed amount add nothing", () => {
    const file = join(mkdtempSync(join(tmpdir(), "units-fees-")), "runs.jsonl");
    writeFileSync(file, [line(1), line(1), line(2, { collected_lamports: "-5", units_burned: 12 }), '{"v":1,"run_id":"run-3","time":"2026-10-12T00:03'].join("\n"));
    const r = unitsFees({ file, limit: 500 });
    expect(r.totals).toMatchObject({ runs: 2, collected_lamports: "27732291", units_burned: "79324982117" });
    expect(r.runs.length).toBe(2);
    expect(unitsFees({ file, limit: 0 }).runs).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlan, planProblem, type Plan } from "./live-launch.ts";

// The guard that stands between the page's Review step and the wallet's signature in the live mainnet
// launch (scripts/mainnet/live-launch.ts): the plan is read from the page's own text and refused when
// it is not the launch the fork measured.

// the Review text of the wizard run on the mainnet fork (WIZARD-FORK-LAST.json, the "Transactions" row)
const fork = JSON.parse(readFileSync(join(import.meta.dir, "WIZARD-FORK-LAST.json"), "utf8"));
const forkRow = (fork.results as { check: string; detail: string }[]).find((r) => /Review: the launch simulated/.test(r.check))!.detail;
const rows = [
  { label: "Token creation", usd: "$1.59", sol: "0.0148 SOL" },
  { label: "Total", usd: "$11.27", sol: "0.1049 SOL; the wallet must hold 0.1057 SOL (the purchase at its slippage bound)" },
];
const ok = "simulation succeeded on mainnet";

test("the plan is read from the page's Review text", () => {
  const p = parsePlan(forkRow, rows, ok);
  expect(p.txs).toEqual([
    { groups: ["launch", "soul"], bytes: 1092, v0: true },
    { groups: ["sol-to-units", "initial-buy", "credits", "tip"], bytes: 1091, v0: true },
  ]);
  expect(p.total_sol).toBe(0.1049);
  expect(p.total_usd).toBe(11.27);
  expect(p.must_hold_sol).toBe(0.1057);
  expect(p.simulated).toBe(true);
  expect(planProblem(p, { maxSol: 0.15, balanceSol: 0.5 })).toBeNull();
});

test("a plan outside the limits is never signed", () => {
  const base = parsePlan(forkRow, rows, ok);
  const bad = (over: Partial<Plan>, o = { maxSol: 0.15, balanceSol: 0.5 }) => planProblem({ ...base, ...over }, o);
  expect(bad({ simulated: false })).toMatch(/simulation/);
  expect(bad({ txs: base.txs.slice(0, 1) })).toMatch(/1 transactions/);
  expect(bad({ txs: [base.txs[1]!, base.txs[0]!] })).toMatch(/first transaction/);
  expect(bad({ txs: [base.txs[0]!, { ...base.txs[1]!, bytes: 1233 }] })).toMatch(/1233 bytes/);
  expect(bad({ txs: [base.txs[0]!, { ...base.txs[1]!, groups: ["sol-to-units", "units-account", "initial-buy", "credits"] }] })).toMatch(/units account/);
  expect(bad({ total_sol: null })).toMatch(/no SOL total/);
  expect(bad({}, { maxSol: 0.1, balanceSol: 0.5 })).toMatch(/over the limit of 0.1/);
  expect(bad({}, { maxSol: 0.15, balanceSol: 0.1 })).toMatch(/wallet holds 0.1/);
  // the total alone is checked when the page names no larger amount to hold
  expect(bad({ must_hold_sol: null, total_sol: 0.2 })).toMatch(/0.2 SOL, over the limit/);
});

test("a simulation that failed, or a Jupiter route, is not the measured launch", () => {
  expect(planProblem(parsePlan(forkRow, rows, "Simulation failed: {\"InstructionError\":[2,{\"Custom\":6001}]}"), { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/simulation/);
  expect(planProblem(parsePlan("Jupiter swap 1; launch + soul (1092 bytes, v0)", rows, ok), { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/1 transactions/);
});

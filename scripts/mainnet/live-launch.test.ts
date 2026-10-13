import { expect, test } from "bun:test";
import { parsePlan, planProblem, type Plan } from "./live-launch.ts";

// The guard that stands between the page's Review step and the wallet's signature in the live mainnet
// launch (scripts/mainnet/live-launch.ts): the plan is read from the page's own text and refused when
// it is not the launch the fork measured.

// the "Transactions" row of the Review step as the live wizard showed it on 2026-10-12 (second mainnet test
// launch: a chosen image and three links in the metadata URI, the units account chosen), and the same plan
// without the units account. Fixed text: this test must not move with a record another run rewrites.
const liveRow = "Transactionslaunch + soul (1195 bytes, v0); sol-to-units + initial-buy + credits + units-account + tip (1140 bytes, v0) Launch (one signature)";
const forkRow = "Transactionslaunch + soul (1092 bytes, v0); sol-to-units + initial-buy + credits + tip (1091 bytes, v0) Launch (one signature)";
const rows = [
  { label: "Token creation", usd: "$1.59", sol: "0.0148 SOL" },
  { label: "Total", usd: "$11.27", sol: "0.1049 SOL; the wallet must hold 0.1057 SOL (the purchase at its slippage bound)" },
];
const ok = "What you pay Token creation";

test("the plan is read from the page's Review text", () => {
  const p = parsePlan(forkRow, rows, ok);
  expect(p.txs).toEqual([
    { groups: ["launch", "soul"], bytes: 1092, v0: true },
    { groups: ["sol-to-units", "initial-buy", "credits", "tip"], bytes: 1091, v0: true },
  ]);
  expect(p.total_sol).toBe(0.1049);
  expect(p.total_usd).toBe(11.27);
  expect(p.must_hold_sol).toBe(0.1057);
  expect(p.built).toBe(true);
  expect(parsePlan(forkRow, rows, "simulation succeeded on mainnet What you pay").built).toBe(false);
  expect(planProblem(p, { maxSol: 0.15, balanceSol: 0.5 })).toBeNull();
  // the plan of the live launch with the units account: read whole, signable only when the account was chosen
  const live = parsePlan(liveRow, rows, ok);
  expect(live.txs).toEqual([
    { groups: ["launch", "soul"], bytes: 1195, v0: true },
    { groups: ["sol-to-units", "initial-buy", "credits", "units-account", "tip"], bytes: 1140, v0: true },
  ]);
  expect(planProblem(live, { maxSol: 0.15, balanceSol: 0.5, unitsAccount: true })).toBeNull();
  expect(planProblem(live, { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/did not choose/);
});

test("a plan outside the limits is never signed", () => {
  const base = parsePlan(forkRow, rows, ok);
  const bad = (over: Partial<Plan>, o = { maxSol: 0.15, balanceSol: 0.5 }) => planProblem({ ...base, ...over }, o);
  expect(bad({ built: false })).toMatch(/no built launch/);
  expect(bad({ txs: base.txs.slice(0, 1) })).toMatch(/1 launch transactions/);
  expect(bad({ txs: [base.txs[1]!, base.txs[0]!] })).toMatch(/first transaction/);
  expect(bad({ txs: [base.txs[0]!, { ...base.txs[1]!, bytes: 1233 }] })).toMatch(/1233 bytes/);
  const withAccount = [base.txs[0]!, { ...base.txs[1]!, groups: ["sol-to-units", "initial-buy", "credits", "units-account", "tip"] }];
  expect(bad({ txs: withAccount })).toMatch(/did not choose/);
  // the units account, when this run chose it, must be paid for in the plan, and only then
  expect(planProblem({ ...base, txs: withAccount }, { maxSol: 0.15, balanceSol: 0.5, unitsAccount: true })).toBeNull();
  expect(bad({}, { maxSol: 0.15, balanceSol: 0.5, unitsAccount: true } as any)).toMatch(/no transaction of the plan pays its fee/);
  expect(bad({ total_sol: null })).toMatch(/no SOL total/);
  expect(bad({}, { maxSol: 0.1, balanceSol: 0.5 })).toMatch(/over the limit of 0.1/);
  expect(bad({}, { maxSol: 0.15, balanceSol: 0.1 })).toMatch(/wallet holds 0.1/);
  // the total alone is checked when the page names no larger amount to hold
  expect(bad({ must_hold_sol: null, total_sol: 0.2 })).toMatch(/0.2 SOL, over the limit/);
});

test("a hosted launch's binding rides as one more transaction, last and alone", () => {
  const base = parsePlan(forkRow, rows, ok);
  const bind = { groups: ["bind"], bytes: 340, v0: true };
  expect(planProblem({ ...base, txs: [...base.txs, bind] }, { maxSol: 0.15, balanceSol: 0.5 })).toBeNull();
  expect(planProblem({ ...base, txs: [base.txs[0]!, bind, ...base.txs.slice(1)] }, { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/binding is not a transaction of its own at the end/);
  expect(planProblem({ ...base, txs: [...base.txs.slice(0, -1), { ...base.txs.at(-1)!, groups: [...base.txs.at(-1)!.groups, "bind"] }] }, { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/binding is not a transaction of its own/);
});

test("with the site's initial buy at zero the plan carries the credits alone, and an initial buy is then out of place", () => {
  const base = parsePlan(forkRow, rows, ok);
  const noBuy = base.txs.map((t) => ({ ...t, groups: t.groups.filter((g) => g !== "initial-buy") }));
  expect(planProblem({ ...base, txs: noBuy }, { maxSol: 0.15, balanceSol: 0.5, initialBuy: false })).toBeNull();
  expect(planProblem({ ...base, txs: noBuy }, { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/do not carry the initial buy/);
  expect(planProblem(base, { maxSol: 0.15, balanceSol: 0.5, initialBuy: false })).toMatch(/initial buy is set to zero/);
});

test("a simulation that failed, or a Jupiter route, is not the measured launch", () => {
  expect(planProblem(parsePlan(forkRow, rows, "Simulation failed: {\"InstructionError\":[2,{\"Custom\":6001}]}"), { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/simulation/);
  expect(planProblem(parsePlan("Jupiter swap 1; launch + soul (1092 bytes, v0)", rows, ok), { maxSol: 0.15, balanceSol: 0.5 })).toMatch(/1 launch transactions/);
});

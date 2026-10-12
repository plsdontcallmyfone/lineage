import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopPool } from "../../desktop/src/pool.ts";
import type { DesktopBackend } from "../../desktop/src/backend.ts";
import { parseConfig } from "../src/config.ts";
import { SharedDesktopBudget } from "../src/desktops.ts";

// One E2B day budget across two runtimes on one server (the devnet site and the mainnet test instance,
// config desktop_shared): each publishes its spend and counts the other's against the one cap.

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "units-e2b-shared-"));
  tmp.push(d);
  return d;
};
const T = Date.UTC(2026, 9, 11, 12);

test("the two instances together stay under the one cap; a new UTC day starts from zero", () => {
  const dir = scratch();
  let now = T;
  const dev = new SharedDesktopBudget({ dir, name: "devnet", peers: ["mainnet"] }, 16, { now: () => now });
  const main = new SharedDesktopBudget({ dir, name: "mainnet", peers: ["devnet"], strict: true }, 16, { now: () => now });
  // before the second instance exists the first behaves as it did: the whole cap
  expect(dev.left()).toBe(16);
  // strict: the peer has published nothing yet, so there is no budget
  expect(main.left()).toBe(0);
  dev.publish(10);
  main.publish(0);
  expect(main.left()).toBe(6);
  expect(dev.left()).toBe(16);
  main.publish(5.5);
  expect(dev.left()).toBe(10.5);
  // own spend 10 of a cap of 10.5 left to it; the other: 5.5 of 6: together 15.5 of 16
  dev.publish(16);
  expect(main.left()).toBe(0);
  now = T + 86_400_000;
  dev.publish(0);
  main.publish(0);
  expect(main.left()).toBe(16);
  expect(dev.left()).toBe(16);
});

test("strict: a stale, malformed or negative peer file leaves no budget; not strict: it counts as zero", () => {
  const dir = scratch();
  const now = T;
  const main = new SharedDesktopBudget({ dir, name: "mainnet", peers: ["devnet"], strict: true, stale_s: 600 }, 16, { now: () => now });
  const dev = new SharedDesktopBudget({ dir, name: "devnet", peers: ["mainnet"] }, 16, { now: () => now });
  const f = join(dir, "devnet.json");
  writeFileSync(f, JSON.stringify({ day: "2026-10-11", usd: 4, at: now }));
  expect(main.left()).toBe(12);
  writeFileSync(f, JSON.stringify({ day: "2026-10-11", usd: 4, at: now - 601_000 }));
  expect(main.left()).toBe(0);
  writeFileSync(f, JSON.stringify({ day: "2026-10-11", usd: 4 }));
  expect(main.left()).toBe(0);
  writeFileSync(f, JSON.stringify({ day: "2026-10-11", usd: -50, at: now }));
  expect(main.left()).toBe(0);
  writeFileSync(join(dir, "mainnet.json"), "{not json");
  expect(dev.left()).toBe(16);
  writeFileSync(join(dir, "mainnet.json"), JSON.stringify({ day: "2026-10-11", usd: -3 }));
  expect(dev.left()).toBe(16);
});

test("the desktop pool refuses a new E2B desktop once the peers' spend leaves no room for one", () => {
  const dir = scratch(), root = scratch();
  const now = () => T;
  const shared = new SharedDesktopBudget({ dir, name: "mainnet", peers: ["devnet"], strict: true }, 16, { now });
  const fake = { name: "e2b", usdPerS: 0.000046, unavailable: () => null } as unknown as DesktopBackend & { usdPerS: number };
  const cfg = { root, desktops_max: 0, e2b_max: 2, desktop_usd_per_day: 16, allow: [], e2b: { session_max_s: 3600 } };
  let pool: DesktopPool | null = null;
  Object.defineProperty(cfg, "desktop_usd_per_day", { enumerable: true, get: () => { if (pool) shared.publish(pool.spentToday()); return shared.left(); } });
  pool = new DesktopPool(cfg, { e2b: fake, local: fake, now, timers: false });
  const dev = new SharedDesktopBudget({ dir, name: "devnet", peers: ["mainnet"] }, 16, { now });
  dev.publish(15.5);
  // one desktop for its whole hour is 0.1656 USD: fits in the 0.5 left
  expect(pool.e2bBudgetOk()).toBe(true);
  dev.publish(15.9);
  expect(pool.e2bBudgetOk()).toBe(false);
  expect(pool.status().e2b.cap_usd).toBeCloseTo(0.1, 6);
});

test("config: desktop_shared and the mainnet config price source are validated", () => {
  const base = { mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" };
  expect(parseConfig({ ...base, desktop_shared: { dir: "/var/lib/units-shared/e2b-spend", name: "mainnet", peers: ["devnet"], strict: true } }).desktop_shared?.peers).toEqual(["devnet"]);
  expect(() => parseConfig({ ...base, desktop_shared: { dir: "relative", name: "mainnet", peers: ["devnet"] } })).toThrow(/desktop_shared/);
  expect(() => parseConfig({ ...base, desktop_shared: { dir: "/x", name: "mainnet", peers: ["mainnet"] } })).toThrow(/desktop_shared/);
  expect(parseConfig({ ...base, price: { source: "config" } }).price?.source).toBe("config");
  expect(() => parseConfig({ ...base, price: { source: "feed" } })).toThrow(/price.source/);
  expect(() => parseConfig({ ...base, price: {} })).toThrow(/sanity band/);
});

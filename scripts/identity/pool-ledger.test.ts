// The owner's pool ledger (pool-ledger.ts): an account goes to one instance only, the ledger entry is on
// the disk before the transfer, and a re-run to the same instance is safe.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "../../packages/souls/src/github/pool.ts";
import { Ledger, planShip, seed, ship, syncFromServer } from "./pool-ledger.ts";

const tmp = mkdtempSync(join(tmpdir(), "units-pool-ledger-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tok = (l: string) => `ghp_${l.padEnd(36, "x")}`;
function fixture(accounts: { login: string; status?: string; assigned_agent?: string | null; note?: string }[]) {
  const d = join(tmp, `f${++n}`);
  rmSync(d, { recursive: true, force: true });
  const poolPath = join(tmp, `pool${n}.json`);
  writeFileSync(poolPath, JSON.stringify({ version: 1, accounts: accounts.map((a) => ({ token: tok(a.login), status: "available", assigned_agent: null, ...a })) }), { mode: 0o600 });
  return { pool: new Pool(poolPath), ledger: new Ledger(join(tmp, `ledger${n}.json`)) };
}
const ok = async () => ({ ok: true }) as const;
const status = (p: Pool, login: string) => p.read().accounts.find((a) => a.login === login)!.status;

describe("seed", () => {
  test("every account that is not plainly available, the excluded logins and an exclusions list are recorded; the free ones are not", () => {
    const { pool, ledger } = fixture([
      { login: "free1" }, { login: "free2" },
      { login: "gone1", status: "assigned", assigned_agent: "AgentOne" },
      { login: "srv1", status: "server_reserve", note: "pushed to the site reserve 2026-10-09" },
      { login: "kept1", status: "reserved" }, { login: "dead1", status: "token_invalid" },
      { login: "ver1t0l3" }, { login: "seen1" },
    ]);
    const r = seed(pool, ledger, { exclusions: ["seen1", "elsewhere9"], exclusionsInstance: "devnet" });
    expect(r.added.sort()).toEqual(["dead1", "elsewhere9", "gone1", "kept1", "seen1", "srv1", "ver1t0l3"]);
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(ledger.path, "utf8")).not.toContain("ghp_");
    expect(ledger.get("gone1")).toMatchObject({ state: "consumed", assigned_agent: "AgentOne" });
    expect(ledger.get("srv1")).toMatchObject({ state: "consumed", instance: "devnet" });
    expect(ledger.get("SEEN1")).toMatchObject({ instance: "devnet" });
    const p = planShip(pool, ledger, "mainnet");
    expect(p.fresh.map((a) => a.login)).toEqual(["free1", "free2"]);
    expect(p.refused.map((x) => x.login).sort()).toEqual(["dead1", "gone1", "kept1", "seen1", "srv1", "ver1t0l3"]);
    // a second seed adds nothing
    expect(seed(pool, ledger).added).toEqual([]);
  });
});

describe("ship", () => {
  test("the ledger entry and the pool mark are on the disk BEFORE the transfer; a transfer that dies leaves the accounts consumed", async () => {
    const { pool, ledger } = fixture([{ login: "a1" }, { login: "a2" }, { login: "a3" }]);
    let seenAtTransfer: unknown = null;
    const boom = ship({
      pool, ledger, instance: "mainnet", host: "h", count: 2, verify: ok,
      transfer: async (lines) => {
        // what a crash right here would leave behind, read back from the files
        seenAtTransfer = { ledger: Object.values(new Ledger(ledger.path).read().accounts).map((e) => `${e.login}:${e.instance}:${e.state}`), pool: ["a1", "a2", "a3"].map((l) => status(new Pool(pool.path), l)), lines: lines.trim().split("\n").map((l) => JSON.parse(l).login) };
        throw new Error("connection lost");
      },
    });
    await expect(boom).rejects.toThrow("connection lost");
    expect(seenAtTransfer).toEqual({ ledger: ["a1:mainnet:shipping", "a2:mainnet:shipping"], pool: ["server_reserve", "server_reserve", "available"], lines: ["a1", "a2"] });
    // after the failure: still the mainnet instance's, refused anywhere else, never plainly available again
    expect(ledger.eligible("a1", "devnet")).toEqual({ ok: false, why: expect.stringContaining("to mainnet") });
    expect(planShip(pool, ledger, "devnet").fresh.map((a) => a.login)).toEqual(["a3"]);
    expect(pool.candidates().map((a) => a.login)).toEqual(["a3"]);
  });

  test("a re-run to the same instance sends the unconfirmed ones again and nothing twice; the server's answer confirms them", async () => {
    const { pool, ledger } = fixture([{ login: "b1" }, { login: "b2" }, { login: "b3" }]);
    await expect(ship({ pool, ledger, instance: "mainnet", host: "h", count: 2, verify: ok, transfer: async () => { throw new Error("down"); } })).rejects.toThrow("down");
    const server = new Set<string>(["b1"]); // b1 did arrive before the connection died
    const sent: string[][] = [];
    const transfer = async (lines: string) => {
      const logins = lines.trim().split("\n").map((l) => JSON.parse(l).login as string);
      sent.push(logins);
      const added = logins.filter((l) => !server.has(l)), present = logins.filter((l) => server.has(l));
      for (const l of added) server.add(l);
      return { added, present, refused: [] };
    };
    const r = await ship({ pool, ledger, instance: "mainnet", host: "h", count: 0, verify: ok, transfer });
    expect(sent).toEqual([["b1", "b2"]]);
    expect(r).toMatchObject({ added: ["b2"], present: ["b1"], refused_by_server: [] });
    expect(ledger.get("b1")!.state).toBe("shipped");
    expect(ledger.get("b2")!.state).toBe("shipped");
    // again: nothing left to send again, the next fresh one goes
    const r2 = await ship({ pool, ledger, instance: "mainnet", host: "h", count: null, verify: ok, transfer });
    expect(sent[1]).toEqual(["b3"]);
    expect(r2.added).toEqual(["b3"]);
    const r3 = await ship({ pool, ledger, instance: "mainnet", host: "h", count: null, verify: ok, transfer });
    expect(sent.length).toBe(2);
    expect(r3.sent).toEqual([]);
    expect([...server].sort()).toEqual(["b1", "b2", "b3"]);
  });

  test("refused across instances: an account sent to devnet, or assigned anywhere, never goes to mainnet", async () => {
    const { pool, ledger } = fixture([{ login: "c1" }, { login: "c2" }, { login: "c3" }, { login: "c4" }]);
    const accept = async (lines: string) => ({ added: lines.trim().split("\n").map((l) => JSON.parse(l).login as string), present: [], refused: [] });
    await ship({ pool, ledger, instance: "devnet", host: "d", count: 1, verify: ok, transfer: accept });
    expect(ledger.get("c1")).toMatchObject({ instance: "devnet", state: "shipped" });
    // even if someone resets the pool file by hand, the ledger refuses
    pool.update("c1", { status: "available" });
    ledger.consume("c2", { instance: null, agent: "AgentLocal", reason: "assigned by hand" });
    const sent: string[] = [];
    const r = await ship({ pool, ledger, instance: "mainnet", host: "m", count: null, verify: ok, transfer: async (lines) => (sent.push(...lines.trim().split("\n").map((l) => JSON.parse(l).login)), accept(lines)) });
    expect(sent).toEqual(["c3", "c4"]);
    expect(r.skipped).toEqual([{ login: "c1", why: expect.stringContaining("shipped to devnet") }, { login: "c2", why: "assigned to agent AgentLocal" }]);
    expect(() => ledger.markShipping(["c1"], "mainnet", "m")).toThrow("c1 is not free for mainnet");
    expect(ledger.get("c1")).toMatchObject({ instance: "devnet", state: "shipped" });
  });

  test("a token GitHub rejects is not sent and is recorded as used up; an unreachable GitHub sends nothing and consumes nothing", async () => {
    const { pool, ledger } = fixture([{ login: "d1" }, { login: "d2" }]);
    const sent: string[] = [];
    const r = await ship({
      pool, ledger, instance: "mainnet", host: "m", count: null,
      verify: async (a) => (a.login === "d1" ? { ok: false, why: "HTTP 401", invalid: true } : { ok: false, why: "HTTP 503", invalid: false }),
      transfer: async (lines) => (sent.push(lines), { added: [], present: [], refused: [] }),
    });
    expect(sent).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(ledger.get("d1")).toMatchObject({ state: "consumed" });
    expect(status(pool, "d1")).toBe("token_invalid");
    expect(ledger.get("d2")).toBeNull();
    expect(status(pool, "d2")).toBe("available");
  });
});

describe("sync", () => {
  test("the server's assignments reach the ledger; a login the ledger never knew is recorded as that instance's", () => {
    const { ledger } = fixture([]);
    ledger.markShipping(["e1", "e2"], "mainnet", "m");
    const r = syncFromServer(ledger, "mainnet", [
      { login: "e1", status: "assigned", assigned_agent: "AgentE1" },
      { login: "e2", status: "available", assigned_agent: null },
      { login: "stray", status: "assigned", assigned_agent: "AgentS" },
    ]);
    expect(r.recorded.sort()).toEqual(["e1", "stray"]);
    expect(ledger.get("e1")).toMatchObject({ state: "shipped", assigned_agent: "AgentE1" });
    expect(ledger.get("e2")).toMatchObject({ state: "shipped", assigned_agent: null });
    expect(ledger.get("stray")).toMatchObject({ instance: "mainnet", state: "consumed", assigned_agent: "AgentS" });
    expect(ledger.eligible("e1", "mainnet")).toEqual({ ok: false, why: "assigned to agent AgentE1 on mainnet" });
    expect(ledger.eligible("e2", "mainnet")).toEqual({ ok: true, resend: true });
  });
});

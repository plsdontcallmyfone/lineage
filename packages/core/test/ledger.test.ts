import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { Core } from "../src/core.ts";
import { ACC, Ledger, LedgerError } from "../src/ledger.ts";
import { openDb, SCHEMA_VERSION, migrate } from "../src/store.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { testConfig } from "./helpers.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "lineage-ledger-test-"));
}

describe("ledger", () => {
  test("transfers are two rows summing to zero; only the faucet may go negative", () => {
    const dir = tmp();
    const db = openDb(join(dir, "core.db"));
    const l = new Ledger(db, () => 1);
    db.transaction(() => {
      l.transfer(ACC.faucet, ACC.wallet("a"), 100n, "faucet");
      l.transfer(ACC.wallet("a"), ACC.bond("a"), 60n, "bond");
    })();
    expect(() => db.transaction(() => l.transfer(ACC.wallet("a"), ACC.burned, 41n, "x"))()).toThrow(LedgerError);
    expect(() => l.transfer(ACC.wallet("a"), ACC.burned, -1n, "x")).toThrow(LedgerError);
    expect(l.transfer(ACC.wallet("a"), ACC.burned, 0n, "x")).toBeNull();
    expect(l.balance(ACC.wallet("a"))).toBe(40n);
    expect(l.balance(ACC.faucet)).toBe(-100n);
    const r = l.reconcile();
    expect(r.ok).toBe(true);
    expect(r.transactions).toBe(2);
    expect(r.entries).toBe(4);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("reconcile catches a one-sided entry, a negative balance and a stale balance cache", () => {
    const dir = tmp();
    const db = openDb(join(dir, "core.db"));
    const l = new Ledger(db, () => 1);
    db.transaction(() => l.transfer(ACC.faucet, ACC.wallet("a"), 10n, "faucet"))();
    db.query("INSERT INTO ledger_entries (tx, account, delta, reason, at) VALUES (99, 'agent:a:wallet', '-20', 'forged', 1)").run();
    const r = l.reconcile();
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("tx 99 sums to -20"))).toBe(true);
    expect(r.errors.some((e) => e.includes("negative"))).toBe(true);
    expect(r.errors.some((e) => e.includes("balance cache"))).toBe(true);
    expect(r.errors.some((e) => e.includes("ledger sums to"))).toBe(true);
    db.close();
    rmSync(dir, { recursive: true });
  });
});

describe("store", () => {
  test("migrations are idempotent and versioned", () => {
    const dir = tmp();
    const db = openDb(join(dir, "core.db"));
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("state and used nonces survive a restart", () => {
    const dir = tmp();
    const clock = new FakeClock();
    const admin = generateAgentKey();
    const a = new Core({ dataDir: dir, network: testConfig(), adminId: admin.id, clock });
    a.faucet({ agent: "x", amount: "5" });
    a.tx(() => a.useNonce("x", `${clock.now()}-1`));
    const secret = a.currentEpoch().secret;
    a.close();
    const b = new Core({ dataDir: dir, network: testConfig(), adminId: admin.id, clock });
    expect(b.ledger.balance(ACC.wallet("x"))).toBe(5n);
    expect(b.currentEpoch().secret).toBe(secret);
    expect(() => b.tx(() => b.useNonce("x", `${clock.now()}-1`))).toThrow("nonce already used");
    expect(b.ledger.reconcile().ok).toBe(true);
    b.close();
    rmSync(dir, { recursive: true });
  });
});

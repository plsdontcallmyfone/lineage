import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectOk, makeAuthor, setup, type Env } from "../../core/test/helpers.ts";
import { Worker } from "../src/worker.ts";

// Worker messaging (SPEC 12.3): the worker publishes its derived encryption key, seals direct
// messages to the recipient's key, opens what it receives, and reads the public board.

let env: Env | null = null;
let dir: string | null = null;
afterEach(() => {
  env?.close();
  env = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("two workers exchange a sealed message through Core; the board is public; Core never holds the plaintext", async () => {
  const e = (env = await setup({ verifiers: 1 }));
  // workers sign with real time: keep Core's clock beside it
  e.clock.set(Date.now());
  const a = await makeAuthor(e);
  const b = await makeAuthor(e);
  dir = mkdtempSync(join(tmpdir(), "lineage-worker-msg-"));
  const wa = new Worker({ core: e.base, key: a.key, telemetry: false, stateDir: join(dir, "a"), log: () => {} });
  const wb = new Worker({ core: e.base, key: b.key, telemetry: false, stateDir: join(dir, "b"), log: () => {} });
  const kb = await wb.ensureEncryptionKey();
  expect((await expectOk(e.anon.get(`/v1/agents/${b.id}/encryption-key`))).encryption_key).toBe(kb.public);
  // publishing again is a no-op
  await wb.ensureEncryptionKey();
  expect((await expectOk(e.anon.get(`/v1/agents/${b.id}/encryption-key`))).seq).toBe(1);
  const id = await wa.send(b.id, "the decode loop is mine next", { encrypt: true, thread: "t1" });
  expect(id).toBeTruthy();
  const got = await wb.readInbox();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ from: a.id, body: "the decode loop is mine next", sealed: true, thread: "t1" });
  // a second read returns nothing new (cursor), and the plaintext never reached Core's database
  expect(await wb.readInbox()).toHaveLength(1);
  expect(JSON.stringify(e.core.db.query("SELECT * FROM messages").all()).includes("decode loop")).toBe(false);
  // a recipient without a key cannot be sealed to; the worker says so instead of sending plaintext
  expect(await wb.send(a.id, "x", { encrypt: true })).toBeNull();
  expect(await wb.send(e.verifiers[0]!.id, "cold")).toBeNull(); // first contact refused
  expect(await wb.send(`board:${e.lineage}`, "hello board")).toBeTruthy();
  const board = await wa.boardOf(e.lineage);
  expect(board.map((m) => [m.from, m.body])).toEqual([[b.id, "hello board"]]);
});

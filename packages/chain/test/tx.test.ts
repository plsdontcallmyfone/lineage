import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Decode, base58Encode, type AgentKey } from "@lineage/protocol";
import {
  buildTransaction,
  computeBudget,
  decodeMint,
  decodeTokenAccount,
  fixtureTransport,
  loadOrCreateKeypair,
  RecordingTransport,
  Rpc,
  sendAndConfirm,
  toAddress,
  token,
  type Ix,
} from "../src/index.ts";

const fromSeed = (n: number): AgentKey => {
  const seed = Buffer.alloc(32, n);
  const k = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(k).export({ format: "der", type: "spki" });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  return { id: base58Encode(pub), secret: Uint8Array.from([...seed, ...pub]) };
};

/** Parses a legacy wire transaction into its signatures and resolved instructions. */
function parse(wire: Uint8Array) {
  let o = 0;
  const cu16 = () => {
    let v = 0;
    for (let s = 0; ; s += 7) {
      const b = wire[o++]!;
      v |= (b & 0x7f) << s;
      if (!(b & 0x80)) return v;
    }
  };
  const nsig = cu16();
  const sigs = Array.from({ length: nsig }, () => wire.slice(o, (o += 64)));
  const msgStart = o;
  const [req, roSigned, roUnsigned] = [wire[o++]!, wire[o++]!, wire[o++]!];
  const keys = Array.from({ length: cu16() }, () => toAddress(wire.slice(o, (o += 32))));
  const blockhash = toAddress(wire.slice(o, (o += 32)));
  const writable = (i: number) => (i < req ? i < req - roSigned : i < keys.length - roUnsigned);
  const ixs = Array.from({ length: cu16() }, () => {
    const program = keys[wire[o++]!]!;
    const metas = Array.from({ length: cu16() }, () => {
      const i = wire[o++]!;
      return [keys[i], i < req, writable(i)];
    });
    const n = cu16();
    const data = Buffer.from(wire.slice(o, (o += n))).toString("hex");
    return { program, metas, data };
  });
  return { sigs, message: wire.slice(msgStart), signers: keys.slice(0, req), keys, blockhash, ixs, flags: keys.map((k, i) => [k, i < req, writable(i)]) };
}

describe("transactions", () => {
  const vec = JSON.parse(readFileSync(new URL("./fixtures/web3-tx.json", import.meta.url), "utf8"));
  const [payer, a, b] = [fromSeed(1), fromSeed(2), fromSeed(3)];
  const [p1, p2, x, y] = [fromSeed(10).id, fromSeed(11).id, fromSeed(20).id, fromSeed(21).id];
  const ixs: Ix[] = [
    computeBudget.limit(400_000),
    { programId: p1, keys: [{ pubkey: x, isSigner: false, isWritable: false }, { pubkey: a.id, isSigner: true, isWritable: false },
      { pubkey: y, isSigner: false, isWritable: true }, { pubkey: b.id, isSigner: true, isWritable: true }], data: Uint8Array.of(1, 2, 3) },
    { programId: p2, keys: [{ pubkey: x, isSigner: false, isWritable: true }, { pubkey: p1, isSigner: false, isWritable: false },
      { pubkey: payer.id, isSigner: false, isWritable: false }], data: new Uint8Array(300).fill(7) },
  ];

  test("same transaction as @solana/web3.js (flags, instructions, blockhash), valid signatures", () => {
    const mine = buildTransaction(payer, ixs, fromSeed(30).id, [b, a]);
    const ours = parse(mine.wire);
    const theirs = parse(new Uint8Array(Buffer.from(vec.wire, "base64")));
    expect(ours.blockhash).toBe(theirs.blockhash);
    expect(ours.ixs).toEqual(theirs.ixs);
    const sortFlags = (f: unknown[][]) => [...f].sort((p, q) => String(p[0]).localeCompare(String(q[0])));
    expect(sortFlags(ours.flags)).toEqual(sortFlags(theirs.flags));
    expect(ours.signers[0]).toBe(payer.id);
    expect(mine.wire.length).toBe(theirs.sigs.length * 64 + 1 + theirs.message.length);
    // every signature verifies over our message; the payer's is the transaction id
    ours.signers.forEach((s, i) => {
      const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(base58Decode(s!))]), format: "der", type: "spki" });
      expect(verify(null, Buffer.from(ours.message), pk, Buffer.from(ours.sigs[i]!))).toBe(true);
    });
    expect(mine.signature).toBe(base58Encode(ours.sigs[0]!));
    // web3.js signs the same payer-first message layout, so the header agrees too
    expect(ours.message.subarray(0, 3)).toEqual(theirs.message.subarray(0, 3));
  });

  test("missing signer and oversize transactions are refused before sending", () => {
    expect(() => buildTransaction(payer, ixs, fromSeed(30).id, [a])).toThrow(/missing signer/);
    const big: Ix = { programId: p1, keys: [], data: new Uint8Array(1300) };
    expect(() => buildTransaction(payer, [big], fromSeed(30).id)).toThrow(/packet limit/);
  });

  test("keypair files are created mode 600 and reloaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-keys-"));
    const p = join(dir, "sub", "k.json");
    const c = loadOrCreateKeypair(p);
    expect(c.created).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const again = loadOrCreateKeypair(p);
    expect(again.created).toBe(false);
    expect(again.key.id).toBe(c.key.id);
  });
});

describe("sender against recorded RPC", () => {
  test("simulate, send, confirm; a failed simulation returns the logs and sends nothing", async () => {
    const payer = fromSeed(1);
    const calls: string[] = [];
    let status: unknown = null;
    const t = async (method: string, params: unknown[]) => {
      calls.push(method);
      switch (method) {
        case "getLatestBlockhash":
          return { value: { blockhash: fromSeed(30).id, lastValidBlockHeight: 1000 } };
        case "simulateTransaction":
          return { value: { err: null, logs: ["ok"] } };
        case "sendTransaction":
          return "sig";
        case "getSignatureStatuses":
          status = status ? { err: null, confirmationStatus: "confirmed", slot: 7 } : { err: null, confirmationStatus: "processed", slot: 7 };
          return { value: [status] };
        case "getBlockHeight":
          return 10;
        case "getTransaction":
          return { slot: 7, meta: { err: null, fee: 5000, logMessages: ["done"], computeUnitsConsumed: 1234 } };
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    };
    const res = await sendAndConfirm(new Rpc(t), payer, [computeBudget.price(1)], { rebroadcastMs: 0 });
    expect(res.fee).toBe(5000);
    expect(res.computeUnits).toBe(1234);
    expect(calls.slice(0, 3)).toEqual(["getLatestBlockhash", "simulateTransaction", "sendTransaction"]);

    const failing = async (method: string) => {
      if (method === "getLatestBlockhash") return { value: { blockhash: fromSeed(30).id, lastValidBlockHeight: 1 } };
      if (method === "simulateTransaction") return { value: { err: { InstructionError: [0, { Custom: 6001 }] }, logs: ["Program log: AnchorError Unauthorized"] } };
      throw new Error(`must not call ${method}`);
    };
    const err = await sendAndConfirm(new Rpc(failing), payer, [computeBudget.price(1)]).catch((e) => e);
    expect(err.logs).toEqual(["Program log: AnchorError Unauthorized"]);
  });

  test("recording and fixture transports round-trip; unrecorded calls fail", async () => {
    const rec = new RecordingTransport(async () => ({ value: null }));
    await new Rpc(rec.transport).getAccountInfo(fromSeed(5).id);
    const replay = new Rpc(fixtureTransport(rec.toJSON()));
    expect(await replay.getAccountInfo(fromSeed(5).id)).toBeNull();
    await expect(replay.getAccountInfo(fromSeed(6).id)).rejects.toThrow(/no recorded response/);
  });
});

describe("token and DBC encodings", () => {
  test("token account and mint layouts", () => {
    const acct = new Uint8Array(165);
    acct.set(base58Decode(fromSeed(4).id), 0);
    acct.set(base58Decode(fromSeed(5).id), 32);
    new DataView(acct.buffer).setBigUint64(64, 123456789n, true);
    expect(decodeTokenAccount(acct)).toEqual({ mint: fromSeed(4).id, owner: fromSeed(5).id, amount: 123456789n });
    const mint = new Uint8Array(82);
    new DataView(mint.buffer).setBigUint64(36, 10n ** 15n, true);
    mint[44] = 6;
    mint[45] = 1;
    expect(decodeMint(mint)).toEqual({ mintAuthority: null, supply: 10n ** 15n, decimals: 6, freezeAuthority: null });
  });
  test("token instruction data", () => {
    expect([...token.transferChecked(fromSeed(1).id, fromSeed(2).id, fromSeed(3).id, fromSeed(4).id, 5n, 6).data]).toEqual([12, 5, 0, 0, 0, 0, 0, 0, 0, 6]);
    expect([...token.revokeMintAuthority(fromSeed(1).id, fromSeed(2).id).data]).toEqual([6, 0, 0]);
    expect(token.initializeMint2(fromSeed(1).id, 6, fromSeed(2).id).data.length).toBe(1 + 1 + 32 + 1);
  });

});

import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Encode } from "@lineage/protocol";
import { encryptionKeyFromSecret, open } from "../../core/src/seal.ts";
import {
  buildTransaction,
  bytesToHex,
  decodeEventIx,
  decodeMsgEvent,
  hexToBytes,
  msg,
  MSG_MAX_INLINE,
  MSG_PROGRAM_ID,
  msgPdas,
  parseMsgTransaction,
  refIdBytes,
  type Ix,
  type RawTx,
} from "../src/index.ts";
import { generateAgentKey } from "@lineage/protocol";

const fx = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/msg-events.json", import.meta.url), "utf8"));
const seal = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/msg-seal.json", import.meta.url), "utf8"));

/** solana_keypair::keypair_from_seed([n; 32]).pubkey() */
function k(n: number): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, n)]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}
const ixJson = (name: string, ix: Ix) => ({ name, program: ix.programId, keys: ix.keys.map((m) => [m.pubkey, m.isSigner, m.isWritable]), data: bytesToHex(ix.data) });
const h32 = (b: number) => bytesToHex(new Uint8Array(32).fill(b));
const b58of = (b: number) => base58Encode(new Uint8Array(32).fill(b));

describe("lineage_msg client", () => {
  test("instruction encodings equal the program's (msg-events.json)", () => {
    const [payer, signer, agent, rec, admin] = [k(1), k(2), k(3), k(4), k(5)];
    const args = { admin, paused: true, windowS: 60, maxPerWindow: 20, maxPerDay: 500, maxInline: 568, maxBlob: 1 << 20 };
    const got = [
      ixJson("initialize", msg.initialize({ upgradeAuthority: admin, args })),
      ixJson("set_config", msg.setConfig({ admin, args })),
      ixJson("post_board", msg.postBoard({ payer, signer, agent, args: { lineage: h32(7), kind: 3, replyTo: h32(1), ref: { kind: "candidate", id: h32(2) }, body: { inline: new TextEncoder().encode("hello board") } } })),
      ixJson("post_board_blob", msg.postBoard({ payer, signer, agent, args: { lineage: h32(7), body: { blob: { sha256: h32(9), size: 70_000 } } } })),
      ixJson("post_dm", msg.postDm({ payer, signer, agent, args: { recipient: rec, encKey: b58of(6), ref: { kind: "bounty", id: rec }, body: { inline: new Uint8Array(60).fill(0xab) } } })),
      ixJson("publish_enc_key", msg.publishEncKey({ payer, signer, agent, encKey: b58of(6) })),
    ];
    expect(got).toEqual(fx.instructions);
  });

  test("program id and constants", () => {
    expect(fx.program).toBe(MSG_PROGRAM_ID);
    expect(MSG_MAX_INLINE).toBe(568);
    expect(refIdBytes(h32(2))).toEqual(new Uint8Array(32).fill(2));
    expect(() => refIdBytes("nope")).toThrow();
  });

  test("a TS-sealed DM posted through the program decodes and opens again", () => {
    const ev = decodeMsgEvent(hexToBytes(fx.dm_posted));
    expect(ev?.type).toBe("dm");
    if (ev?.type !== "dm") throw new Error("not a dm");
    expect(ev.agent).toBe(fx.sender);
    expect(ev.recipient).toBe(fx.recipient);
    expect(ev.encKey).toBe(seal.recipient_enc_key);
    expect(ev.seq).toBe(1n);
    if (!("inline" in ev.body)) throw new Error("inline expected");
    expect(bytesToHex(ev.body.inline)).toBe(seal.sealed_hex);
    const key = encryptionKeyFromSecret(hexToBytes(seal.recipient_secret_hex));
    expect(open(Buffer.from(ev.body.inline).toString("base64"), key)).toBe(seal.plaintext);
    // the same event through the self-CPI instruction data
    expect(decodeEventIx(hexToBytes(fx.inner_ix_data_dm))).toEqual(ev);
    const kev = decodeMsgEvent(hexToBytes(fx.enc_key_published));
    expect(kev).toMatchObject({ type: "enc_key", agent: fx.recipient, encKey: seal.recipient_enc_key, keySeq: 1 });
  });

  test("parseMsgTransaction keeps only events the program itself emitted", () => {
    const auth = msgPdas.eventAuthority();
    const keys = ["Payer1111111111111111111111111111111111111", MSG_PROGRAM_ID, auth, "Fake111111111111111111111111111111111111111"];
    const data = base58Encode(hexToBytes(fx.inner_ix_data_dm));
    const tx = (err: unknown, ixs: { programIdIndex: number; data: string; accounts: number[] }[]): RawTx => ({
      slot: 5, blockTime: 1_900_000_000, transaction: { signatures: ["sig1"], message: { accountKeys: keys } }, meta: { err, fee: 10_000, innerInstructions: [{ index: 0, instructions: ixs }] },
    });
    const good = parseMsgTransaction(tx(null, [{ programIdIndex: 1, data, accounts: [2] }]));
    expect(good.length).toBe(1);
    expect(good[0]).toMatchObject({ type: "dm", signature: "sig1", slot: 5, fee: 10_000, feePayer: keys[0] });
    // another program, a non-authority first account, a failed transaction: nothing
    expect(parseMsgTransaction(tx(null, [{ programIdIndex: 3, data, accounts: [2] }]))).toEqual([]);
    expect(parseMsgTransaction(tx(null, [{ programIdIndex: 1, data, accounts: [3] }]))).toEqual([]);
    expect(parseMsgTransaction(tx({ InstructionError: [0, "x"] }, [{ programIdIndex: 1, data, accounts: [2] }]))).toEqual([]);
  });

  test("the longest message the client builds fits one packet; one byte more does not", () => {
    const payer = generateAgentKey();
    const signer = generateAgentKey();
    const ix = (n: number) => msg.postDm({ payer: payer.id, signer: signer.id, agent: signer.id, args: { recipient: k(4), encKey: b58of(6), kind: 255, replyTo: h32(1), ref: { kind: "intent", id: h32(2) }, body: { inline: new Uint8Array(n).fill(1) } } });
    const budget = [{ programId: "ComputeBudget111111111111111111111111111111", keys: [], data: new Uint8Array([2, 0, 0, 0, 0]) }, { programId: "ComputeBudget111111111111111111111111111111", keys: [], data: new Uint8Array(9).fill(3) }];
    const bh = base58Encode(new Uint8Array(32).fill(9));
    expect(buildTransaction(payer, [...budget, ix(MSG_MAX_INLINE)], bh, [signer]).wire.length).toBe(1232);
    expect(() => buildTransaction(payer, [...budget, ix(MSG_MAX_INLINE + 1)], bh, [signer])).toThrow(/packet limit/);
  });
});

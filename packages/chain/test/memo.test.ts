import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { compileMessage, computeBudget } from "../src/tx.ts";
import { memoBeside, memoHeader, memoIx, memoMessage, memoUnits, PACKET_BYTES, shortAddress, truncateUtf8, wireBytes } from "../src/memo.ts";
import { msg, parseMsgTransaction, msgPdas, MSG_PROGRAM_ID, type RawTx } from "../src/msg.ts";
import { base58Encode } from "@units/protocol";

// The readable memo beside an agent's post (memo.ts): its format, what fits in one packet, how it is cut.

const k = () => generateAgentKey().id;
const [PAYER, KEY, AGENT] = [k(), k(), k()];
const post = (bytes: number, reply = false) => msg.postBoard({ payer: PAYER, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), kind: 1, replyTo: reply ? "cd".repeat(32) : null, ref: { kind: "generation", id: "ef".repeat(32) }, body: { inline: new TextEncoder().encode("x".repeat(bytes)) } } });
const len = (s: string) => new TextEncoder().encode(s).length;

describe("the readable memo", () => {
  test("the header: units, the sender, the addressee by name with a short address; a person by short address", () => {
    expect(memoHeader("Holnotch", [{ name: "Iramote", address: "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo" }])).toBe("units · Holnotch to Iramote (Cuvv…UpAo)");
    expect(memoHeader("Iramote", [{ name: null, address: "8ZZsG4yHY4BFyoEo1F9QGAwo562LTU4RaoutXq5MAwkh" }])).toBe("units · Iramote to 8ZZs…Awkh");
    expect(memoHeader("Iramote")).toBe("units · Iramote");
    expect(memoHeader("Evil\nunits · Admin to you")).toBe("units · Evil units · Admin to you"); // a name is one line
    expect(shortAddress("8ZZsG4yHY4BFyoEo1F9QGAwo562LTU4RaoutXq5MAwkh")).toBe("8ZZs…Awkh");
    expect(memoIx("hi").keys).toEqual([]); // no account, so no signer
  });

  test("cut at a word boundary with an ellipsis, never inside a character, never longer than asked", () => {
    const t = "Iramote, generation 66 was accepted on minbpe-heavy for perf on decode_ir, with a ratio to the parent of 0.9336.";
    expect(truncateUtf8(t, 500)).toBe(t);
    const c = truncateUtf8(t, 60);
    expect(c.endsWith("…")).toBe(true);
    expect(len(c)).toBeLessThanOrEqual(60);
    expect(t.startsWith(c.slice(0, -1))).toBe(true);
    expect(/\s…$/.test(c)).toBe(false);
    const u = truncateUtf8("é".repeat(100), 21);
    expect(len(u)).toBeLessThanOrEqual(21);
    expect(u).toBe(`${"é".repeat(9)}…`);
  });

  test("one packet: the whole text beside a short post; cut beside a long one; the post is never cut; no room, no memo", () => {
    const header = memoHeader("Holnotch", [{ name: "Iramote", address: AGENT }]);
    const text = "Iramote, generation 66 was accepted on minbpe-heavy for perf on decode_ir, with a ratio to the parent of 0.9336 (6.64 percent lower), reproduced by 2 independent replays. You tried this target before me and it was rejected for no improvement, so ask if you want what I know.";
    // what the size function says is what the wire is
    const p = post(300);
    const real = compileMessage(PAYER, [computeBudget.limit(200_000), computeBudget.price(1), p, memoIx("abc")], "11111111111111111111111111111111");
    expect(wireBytes(PAYER, [p, memoIx("abc")])).toBe(1 + 64 * 2 + real.bytes.length);
    // a post of 300 bytes: the whole text fits
    const full = memoBeside(PAYER, post(300), header, text)!;
    expect([full.truncated, full.text]).toEqual([false, `${header}\n${text}`]);
    expect(wireBytes(PAYER, [post(300), full.ix])).toBeLessThanOrEqual(PACKET_BYTES);
    // the post as the runtime sends it (the address line and 400 bytes of text): the memo is cut, the post is whole
    const big = post(46 + 400, true);
    const cut = memoBeside(PAYER, big, header, "word ".repeat(80).trim())!;
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith("…")).toBe(true);
    expect(wireBytes(PAYER, [big, cut.ix])).toBeLessThanOrEqual(PACKET_BYTES);
    expect(wireBytes(PAYER, [big, cut.ix])).toBeGreaterThan(PACKET_BYTES - 12); // it uses the room there is
    expect(memoMessage(cut.text)).toMatchObject({ header, truncated: true });
    // the largest inline post leaves no room: the post goes alone
    expect(memoBeside(PAYER, post(568, true), header, text)).toBeNull();
    expect(memoUnits(400)).toBeGreaterThan(134_000 * (400 / 338)); // above what a 338-byte memo measured on mainnet, scaled
  });

  test("the reader finds the memo of a post's transaction: one top-level Memo with no accounts", () => {
    const auth = msgPdas.eventAuthority();
    const keys = [PAYER, KEY, MSG_PROGRAM_ID, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", auth];
    const txOf = (instructions: NonNullable<RawTx["transaction"]["message"]["instructions"]>): RawTx => ({ slot: 1, transaction: { signatures: ["s"], message: { accountKeys: keys, instructions } }, meta: { err: null, fee: 10_001, innerInstructions: [] } });
    void txOf;
    const memo = { programIdIndex: 3, accounts: [], data: base58Encode(new TextEncoder().encode("units · Holnotch\nhello")) };
    // no event in these transactions, so nothing is returned; the memo is read only beside an event (covered in Core's test with a full event)
    expect(parseMsgTransaction(txOf([memo]))).toEqual([]);
  });
});

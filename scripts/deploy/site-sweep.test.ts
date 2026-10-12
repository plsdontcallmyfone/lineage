// The second instance's key sweep (site-sweep.ts): what a key can send away, and the close instruction.
import { expect, test } from "bun:test";
import { TOKEN_2022_PROGRAM } from "@units/chain";
import { BASE_FEE, closeTokenAccount, sweepable } from "./site-sweep.ts";

test("a key sends everything above the one fee it pays; no more than the fee is dust", () => {
  expect(sweepable(0n)).toBe(0n);
  expect(sweepable(BASE_FEE)).toBe(0n);
  expect(sweepable(BASE_FEE + 1n)).toBe(1n);
  expect(sweepable(50_000_000n)).toBe(49_995_000n);
});

test("CloseAccount: the token account and the destination writable, the owner signs, instruction 9", () => {
  const ix = closeTokenAccount("A", "D", "O", TOKEN_2022_PROGRAM);
  expect(ix.programId).toBe(TOKEN_2022_PROGRAM);
  expect(ix.keys).toEqual([{ pubkey: "A", isSigner: false, isWritable: true }, { pubkey: "D", isSigner: false, isWritable: true }, { pubkey: "O", isSigner: true, isWritable: false }]);
  expect([...ix.data]).toEqual([9]);
});

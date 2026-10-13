#!/usr/bin/env bun
// Durable nonces on DEVNET, the system program's rules checked by running them (docs/plans/SEAMLESS-BIND.md
// section 10: the backup bind signature). Real devnet transactions with the lane's devnet test key; nothing
// here can reach mainnet (devnet-process pins the network and the genesis is asserted). Fees only: the nonce
// account's rent comes back when it is closed at the end.
//
//   1  a nonce account made now holds a value that did not exist when its creation was signed: it is
//      derived from the blockhash of the block BEFORE the one the creation landed in
//   2  so a transaction signed in the same approval as that creation (it can only carry the blockhash known
//      then) is an ordinary transaction: once that blockhash has aged out it can never land
//   3  a transaction signed over the nonce account's stored value lands after any wait, exactly once: it
//      advances the nonce, and the same bytes sent again are refused
//   4  the nonce authority alone closes the account, and the whole balance goes where it says
import "../../packages/chain/src/devnet-process.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { base58Decode, base58Encode } from "@units/protocol";
import { buildTransaction, loadKeypair, Rpc, system, type Ix } from "@units/chain";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const SYS = "11111111111111111111111111111111";
const RECENT = "SysvarRecentB1ockHashes11111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const NONCE_SPACE = 80;
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const seeded = (base: string, seed: string) => base58Encode(createHash("sha256").update(base58Decode(base)).update(seed).update(base58Decode(SYS)).digest());
const initNonce = (nonce: string, authority: string): Ix => ({ programId: SYS, keys: [{ pubkey: nonce, isSigner: false, isWritable: true }, { pubkey: RECENT, isSigner: false, isWritable: false }, { pubkey: RENT, isSigner: false, isWritable: false }], data: cat(u32(6), base58Decode(authority)) });
const advance = (nonce: string, authority: string): Ix => ({ programId: SYS, keys: [{ pubkey: nonce, isSigner: false, isWritable: true }, { pubkey: RECENT, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: false }], data: u32(4) });
const withdraw = (nonce: string, to: string, authority: string, lamports: bigint): Ix => ({ programId: SYS, keys: [{ pubkey: nonce, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: RECENT, isSigner: false, isWritable: false }, { pubkey: RENT, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: false }], data: cat(u32(5), u64(lamports)) });
const memo = (text: string, signer: string): Ix => ({ programId: MEMO, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: new TextEncoder().encode(text) });

const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const me = loadKeypair(join(homedir(), ".config", "lineage", "devnet", "launch-e2e-test.json"));
const T0 = Date.now();
const log = (m: string) => console.log(`[nonce-devnet +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => (results.push({ check: name, ok, detail }), log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`), ok);
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
const send = (wire: Uint8Array) => rpc.call<string>("sendTransaction", [b64(wire), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]);
const landed = async (sig: string, ms = 60_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(1500)) {
    const s = (await rpc.call<{ value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).value[0];
    if (s && s.confirmationStatus !== "processed") return s;
  }
  return null;
};
const nonceOf = async (a: string) => {
  const acc = await rpc.getAccountInfo(a);
  return acc && acc.data.length === NONCE_SPACE ? { authority: base58Encode(acc.data.subarray(8, 40)), value: base58Encode(acc.data.subarray(40, 72)), lamports: BigInt(acc.lamports) } : null;
};

const seed = `bindnonce${Date.now().toString(36)}`;
const nonce = seeded(me.id, seed);
const rent = BigInt(await rpc.call<number>("getMinimumBalanceForRentExemption", [NONCE_SPACE]));
const before = BigInt(await rpc.getBalance(me.id));
log(`launcher ${me.id}; nonce account ${nonce} (seed ${seed}); rent for ${NONCE_SPACE} bytes: ${rent} lamports`);

// ---- 1 and 2: creation, and a transaction signed in the same "approval" (the same blockhash, before the account exists)
const { blockhash: B } = await rpc.getLatestBlockhash();
const create = buildTransaction(me, [system.createAccountWithSeed(me.id, seed, rent, NONCE_SPACE, SYS), initNonce(nonce, me.id)], B);
const sameApproval = buildTransaction(me, [advance(nonce, me.id), memo("signed with the creation", me.id)], B);
const cSig = await send(create.wire);
const c = await landed(cSig);
if (!c || c.err) throw new Error(`creation did not land: ${JSON.stringify(c)}`);
const made = (await nonceOf(nonce))!;
const block = await rpc.call<{ previousBlockhash: string; blockhash: string }>("getBlock", [c.slot, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
const derived = base58Encode(createHash("sha256").update("DURABLE_NONCE").update(base58Decode(block.previousBlockhash)).digest());
check("1a the stored nonce is not the blockhash the creation was signed with", made.value !== B, `signed with ${B.slice(0, 12)}…, stored ${made.value.slice(0, 12)}…`);
check("1b the stored nonce is sha256(\"DURABLE_NONCE\" + the blockhash before the landing block): unknowable when signing", made.value === derived, `landing slot ${c.slot}, previous blockhash ${block.previousBlockhash.slice(0, 12)}…`);
check("1c the launcher is the authority; the account holds exactly the rent", made.authority === me.id && made.lamports === rent);

log("waiting for the creation's blockhash to age out (150 blocks, over a minute) …");
for (;;) {
  const v = (await rpc.call<{ value: boolean }>("isBlockhashValid", [B, { commitment: "processed" }])).value;
  if (!v) break;
  await sleep(5000);
}
await sleep(3000);
const late = await send(sameApproval.wire).then((s) => ({ sig: s, err: null as string | null })).catch((e) => ({ sig: null, err: String((e as Error).message) }));
check("2 a transaction signed with the creation (the only blockhash known then) cannot land once that blockhash is gone", !late.sig && /Blockhash not found|BlockhashNotFound/i.test(late.err ?? ""), (late.err ?? "it was accepted").slice(0, 140));

// ---- 3: signed over the stored value, sent after the wait, and once only
const durable = buildTransaction(me, [advance(nonce, me.id), memo("signed over the stored nonce", me.id)], made.value);
log("the durable transaction was signed over the stored value; waiting another 90 s before sending it …");
await sleep(90_000);
const dSig = await send(durable.wire);
const d = await landed(dSig);
const after = await nonceOf(nonce);
check("3a a transaction signed over the stored nonce lands long after any blockhash of its time", !!d && !d.err, `${dSig.slice(0, 16)}… in slot ${d?.slot}, ${Math.round((Date.now() - T0) / 1000)} s after the run began`);
check("3b landing advanced the nonce", !!after && after.value !== made.value);
const again = await rpc.call<string>("sendTransaction", [b64(durable.wire), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]).then(() => null).catch((e) => String((e as Error).message));
check("3c the same bytes sent again are refused (already processed, or the nonce has moved)", !!again, (again ?? "accepted").slice(0, 140));
// a tampered order: the advance not first is not a nonce transaction at all
const notFirst = buildTransaction(me, [memo("first", me.id), advance(nonce, me.id)], after!.value);
const nf = await send(notFirst.wire).then(() => null).catch((e) => String((e as Error).message));
check("3d with anything before AdvanceNonceAccount the stored nonce is not accepted as a blockhash", !!nf && /Blockhash not found|BlockhashNotFound/i.test(nf), (nf ?? "accepted").slice(0, 140));

// ---- 4: closing: the authority's signature, the whole balance to the address it names
const other = loadKeypair(join(homedir(), ".config", "lineage", "devnet", "launch-e2e-test.json")); // the same key: no second funded key in this lane
const { blockhash: B2 } = await rpc.getLatestBlockhash();
const close = buildTransaction(other, [withdraw(nonce, me.id, me.id, rent)], B2);
const wSig = await send(close.wire);
const wl = await landed(wSig);
const gone = await rpc.getAccountInfo(nonce);
const end = BigInt(await rpc.getBalance(me.id));
check("4 the authority withdrew the whole balance and the account is gone; the rent is back", !!wl && !wl.err && !gone, `spent in all ${before - end} lamports (fees only)`);

const out = { at: new Date().toISOString(), network: "devnet", launcher: me.id, nonce_account: nonce, rent_lamports: rent.toString(), signatures: { create: cSig, durable: dSig, close: wSig }, landing_slot: c.slot, signed_blockhash: B, stored_nonce: made.value, results };
await Bun.write(join(import.meta.dir, "NONCE-DEVNET-LAST.json"), JSON.stringify(out, null, 2) + "\n");
const pass = results.every((r) => r.ok);
log(`${results.filter((r) => r.ok).length} of ${results.length} checks passed`);
process.exit(pass ? 0 : 1);

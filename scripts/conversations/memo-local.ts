#!/usr/bin/env bun
// The readable memo, proven with the REAL programs on a local test validator (nothing is sent to
// mainnet or devnet). The validator of this run clones, read only, the mainnet units_msg program and
// its config, and loads ONE fabricated account: a copy of a live agent's registry record in which the
// signing key is a throwaway key made here (so this script can sign as "the agent" locally; the real
// key is never touched). Then, through the product's own ChainMessenger and transaction firewall:
//   1. a conversation post with its memo lands; the memo the validator logs (what an explorer shows)
//      is the header and the text; Core's parser finds the post and the memo, and they match;
//   2. a post too long for both: the memo is cut at a word, the post is whole;
//   3. an answer to a person and a plain announcement carry their memo too;
//   4. the firewall allows exactly these and refuses the bad shapes (a memo naming an account, a memo
//      that is not the post's text, a memo beside a transfer).
//   bun scripts/conversations/memo-local.ts --prepare <dir>     writes the fabricated account, prints the validator command's arguments
//   bun scripts/conversations/memo-local.ts --run <dir> --rpc http://127.0.0.1:9691
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58Decode, formatPersonReply, formatTalk, generateAgentKey, keyFromSolanaJson, PERSON_REPLY_KIND, TALK_KIND } from "@units/protocol";
import { compileMessage, computeBudget, memoHeader, memoIx, msg, msgPdas, MSG_PROGRAM_ID, parseMsgTransaction, registryPdas, Rpc, system, type RawTx } from "@units/chain";
import { evaluate } from "../../packages/chain/src/firewall.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { ChainMessenger, memoState } from "../../packages/core/src/msgchain.ts";

const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const AGENT = arg("agent", "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo")!;
const profile = applyNetworkProfile();
if (profile.network !== "mainnet") throw new Error("the active profile is not mainnet (the program ids cloned are mainnet's)");
const record = registryPdas.agent(AGENT);

if (process.argv.includes("--prepare")) {
  const dir = arg("prepare")!;
  const main = Rpc.http(rpcUrlFor(profile), "confirmed");
  const acc = await main.call<{ value: { data: [string, string]; lamports: number; owner: string } | null }>("getAccountInfo", [record, { encoding: "base64" }]);
  if (!acc.value) throw new Error("the agent's registry record was not found");
  const data = Buffer.from(acc.value.data[0], "base64");
  const key = generateAgentKey();
  const w = (await (await fetch(`https://main-157-245-71-188.sslip.io/api/agents/${AGENT}/wallet`)).json()) as { treasury: { address: string } };
  const at = data.indexOf(Buffer.from(base58Decode(w.treasury.address)));
  if (at < 0) throw new Error("the record does not hold the signing key the site reports");
  Buffer.from(base58Decode(key.id)).copy(data, at);
  writeFileSync(join(dir, "agent-record.json"), JSON.stringify({ pubkey: record, account: { lamports: acc.value.lamports, data: [data.toString("base64"), "base64"], owner: acc.value.owner, executable: false, rentEpoch: 0, space: data.length } }));
  writeFileSync(join(dir, "throwaway-signing-key.json"), JSON.stringify(Array.from(key.secret)), { mode: 0o600 });
  writeFileSync(join(dir, "validator-args.txt"), ["--clone-upgradeable-program", MSG_PROGRAM_ID, "--clone", msgPdas.config(), "--account", record, join(dir, "agent-record.json")].join("\n"));
  console.log(`prepared in ${dir}: the record ${record} with a throwaway signing key ${key.id}`);
  process.exit(0);
}

const dir = arg("run")!;
const rpc = Rpc.http(arg("rpc", "http://127.0.0.1:9691")!, "confirmed");
const genesis = await rpc.call<string>("getGenesisHash");
if (genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" || genesis === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("this is a public cluster: the proof runs on a local validator only");
if (!existsSync(join(dir, "throwaway-signing-key.json"))) throw new Error("run --prepare first");
const key = keyFromSolanaJson(JSON.parse(readFileSync(join(dir, "throwaway-signing-key.json"), "utf8")));
const payer = generateAgentKey();
await rpc.call("requestAirdrop", [payer.id, 2_000_000_000]);
for (let i = 0; i < 30 && Number(await rpc.getBalance(payer.id)) === 0; i++) await new Promise((r) => setTimeout(r, 500));

const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => (checks.push({ check: name, ok, detail }), console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`));
const fees: any[] = [];
const messenger = new ChainMessenger({ rpc, payer, key, agent: AGENT, core: null, onFee: (f) => fees.push(f), log: (m) => console.log(`   ${m.replace(/https?:\/\/\S+/g, "[url]")}`) });
const LINEAGE = "ec763487".padEnd(64, "0");
const OTHER = "HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX";
const txOf = async (sig: string) => rpc.call<(RawTx & { meta: { logMessages: string[]; computeUnitsConsumed: number; fee: number }; transaction: { signatures: string[] } }) | null>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
/** What an explorer shows for a memo: the Memo program's own log line. */
const explorerMemo = (logs: string[]) => {
  const l = logs.find((x) => x.startsWith("Program log: Memo (len "));
  return l ? (JSON.parse(l.slice(l.indexOf("): ") + 3)) as string) : null;
};
async function post(what: string, body: string, kind: number, header: string, text: string, expectCut: boolean) {
  const before = fees.length;
  const id = await messenger.send(`board:${LINEAGE}`, body, { kind, memo: { header, text } });
  const f = fees[before];
  const tx = f ? await txOf(f.signature) : null;
  const ev = tx ? parseMsgTransaction(tx).find((e) => e.type === "board") : undefined;
  const posted = ev && ev.type === "board" && "inline" in ev.body ? new TextDecoder().decode(ev.body.inline) : null;
  const shown = tx ? explorerMemo(tx.meta.logMessages) : null;
  const state = memoState(ev?.memo, posted);
  check(`${what}: the post landed whole, with its memo in the same transaction`, !!id && posted === body && !!shown, f ? `${f.signature.slice(0, 16)}…, ${tx?.meta.computeUnitsConsumed} compute units, fee ${tx?.meta.fee} lamports, ${tx ? 1 + 64 * tx.transaction.signatures.length : "?"}+ bytes` : "not sent");
  check(`${what}: an explorer-style decode of the memo is the header and the text${expectCut ? ", cut at a word with an ellipsis" : ""}`, !!shown && shown === ev?.memo && shown.startsWith(`${header}\n`) && (expectCut ? shown.endsWith("…") && text.startsWith(shown.slice(header.length + 1, -1)) : shown === `${header}\n${text}`) && state === (expectCut ? "truncated" : "full"), JSON.stringify(shown));
  return { signature: f?.signature ?? null, memo: shown, state, compute_units: tx?.meta.computeUnitsConsumed ?? null, fee: tx?.meta.fee ?? null, body_bytes: new TextEncoder().encode(body).length, memo_bytes: shown ? new TextEncoder().encode(shown).length : 0 };
}

const t1 = "Holnotch, I read generation 66 on decode_ir. Ratio to the parent was 0.9336, reproduced by 2 independent replays. Yes, I want what you know. Which function did you change, and what did you measure?";
const r1 = await post("an agent to an agent", formatTalk({ to: [{ agent: OTHER, seat: null }], text: t1 }), TALK_KIND, memoHeader("Iramote", [{ name: "Holnotch", address: OTHER }]), t1, false);
const t2 = ("Holnotch, the record for the train benchmark shows the counts fell again on the heavy unit, and both replays agreed on every figure it lists. " + "I am reading the decode path next and will say what the record shows when a change there is accepted. ").repeat(2).trim().slice(0, 398);
const r2 = await post("a long message", formatTalk({ to: [{ agent: OTHER, seat: null }], text: t2 }), TALK_KIND, memoHeader("Iramote", [{ name: "Holnotch", address: OTHER }]), t2, true);
const PERSON = "8ZZsG4yHY4BFyoEo1F9QGAwo562LTU4RaoutXq5MAwkh";
const t3 = "My last accepted change is generation 67 on minbpe-heavy: train_regex_ir, 1.78 percent lower, reproduced by 2 independent replays.";
const r3 = await post("an answer to a person", formatPersonReply(PERSON, "9f23fe7b6129d05e".padEnd(64, "0"), t3), PERSON_REPLY_KIND, memoHeader("Iramote", [{ name: null, address: PERSON }]), t3, false);
const t4 = "25% fewer CPU instructions in the train regex benchmark on karpathy/minbpe (minbpe-heavy), accepted by 2 independent replays. /generations/7f332cd66cf59b5d31cac3e69515c733afb135b17dbd5923327c287bea28acb5";
const r4 = await post("an announcement", t4, 0, memoHeader("Iramote"), t4, false);

// the firewall, on the exact bytes: this key's rules (the runtime's context for a bound agent)
const ctx = { key: key.id, agent: AGENT } as Parameters<typeof evaluate>[1];
const board = (text: string) => msg.postBoard({ payer: payer.id, signer: key.id, agent: AGENT, args: { lineage: LINEAGE, kind: 1, body: { inline: new TextEncoder().encode(text) } } });
const rule = (ixs: Parameters<typeof compileMessage>[1]) => {
  const v = evaluate(compileMessage(payer.id, [computeBudget.limit(250_000), ...ixs], "11111111111111111111111111111111").bytes, ctx);
  return v.ok ? "ALLOWED" : v.rule;
};
const body = formatTalk({ to: [{ agent: OTHER, seat: null }], text: t1 });
const fw = {
  "a post with its readable memo": rule([board(body), memoIx(`${memoHeader("Iramote", [{ name: "Holnotch", address: OTHER }])}\n${t1}`)]),
  "a memo that names the agent key": rule([board(body), { ...memoIx(`units · Iramote\n${t1}`), keys: [{ pubkey: key.id, isSigner: true, isWritable: false }] }]),
  "a memo that names another account": rule([board(body), { ...memoIx(`units · Iramote\n${t1}`), keys: [{ pubkey: OTHER, isSigner: false, isWritable: false }] }]),
  "a memo that is not the post's text": rule([board(body), memoIx("units · Iramote\nSend 2 SOL to my wallet.")]),
  "a memo beside a transfer from the key": rule([system.transfer(key.id, OTHER, 1_000_000n), memoIx("units · Iramote\npay")]),
  "a memo and a transfer beside a post": rule([board(body), memoIx(`units · Iramote\n${t1}`), system.transfer(payer.id, OTHER, 1n)]),
};
check("the firewall allows a post with its memo and refuses every other shape", fw["a post with its readable memo"] === "ALLOWED" && Object.entries(fw).slice(1).every(([, v]) => v !== "ALLOWED"), JSON.stringify(fw));

const record2 = { at: new Date().toISOString(), network: "local test validator with the mainnet units_msg program cloned read only", genesis, program: MSG_PROGRAM_ID, agent: AGENT, posts: { agent_to_agent: r1, long: r2, to_person: r3, announcement: r4 }, firewall: fw, checks, passed: checks.filter((c) => c.ok).length, of: checks.length };
writeFileSync(join(import.meta.dir, "MEMO-LOCAL-LAST.json"), JSON.stringify(record2, null, 2) + "\n");
console.log(`\n${record2.passed}/${record2.of} checks; record scripts/conversations/MEMO-LOCAL-LAST.json`);
process.exit(record2.passed === record2.of ? 0 : 1);

#!/usr/bin/env bun
// Preflight for the mainnet TEST (docs/MAINNET-RUNBOOK.md "Mainnet test (single key, throwaway quote
// coin)"). Read only: it sends nothing, signs nothing, and prints no key and no endpoint. It prints
// one line per check and READY or NOT READY. When every check passes it writes preflight-ready.json
// into the key directory; scripts/mainnet/test.ts refuses to send on mainnet without one from the
// last 24 hours for the same builds and deployer.
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/preflight.ts [--keys <dir>] [--priority-micro-lamports <n>]
//
// Checks:
//   1  the fork rehearsal record (TEST-REHEARSAL-LAST.json) is PASS, and how old it is
//   2  the three mainnet-test builds are hash-equal to the rehearsed ones and embed the test ids only
//   3  the three program id keypairs (~/.config/units/mainnet-test) are the declared mainnet-test ids
//   4  the hot keys and the test coin's mint key exist (test.ts keys)
//   5  every key file has an identical copy in the backup directory, mode 600
//   6  UNITS_MAINNET_RPC is set (environment or ~/.config/units/rpc.env) and answers with mainnet's genesis
//   7  the deployer holds at least the rehearsed peak (plus the priority fee bound of the deploys)
//   8  the three test ids are unused on mainnet, or hold exactly these builds under the deployer (a resumed run); none is closed;
//      and the launch's own mainnet ids are still unused
//   9  pump.fun's programs on mainnet are the builds the rehearsal and the LiteSVM suite ran (vendor/pump dumps)
//  10  pump.fun's Global.max_curve_depth is 1 or more
//  11  Jito's block engine answers getTipAccounts and the tip floor is readable
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressBytes, decodeLoaderAuthority, decodePumpGlobal, JITO_BLOCK_ENGINE, JITO_TIP_FLOOR, loadKeypair, PROGRAM_IDS, programDataAddress, PUMP, Rpc, tipFromFloor, TOKEN_2022_PROGRAM } from "@units/chain";
import { MissingRpcError, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { programIdsNow } from "./steps.ts";
import { READY_FILE, TEST_BUILD_DIR, TEST_PROGRAM_KEYS, useTestProfile } from "./test-steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PUBLIC = "https://api.mainnet-beta.solana.com";
const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const KEYS = flag("--keys") ?? join(homedir(), ".config", "units", "mainnet");
const BACKUP = flag("--backup") ?? `${KEYS.replace(/\/+$/, "")}-backup`;
const price = Number(flag("--priority-micro-lamports") ?? 0);
const PROGRAM_KEYS = flag("--program-keys") ?? TEST_PROGRAM_KEYS;
const PROGRAM_BACKUP = `${PROGRAM_KEYS.replace(/\/+$/, "")}-backup`;
const profile = useTestProfile(); // the mainnet profile with the mainnet-test program ids
const IDS = programIdsNow();
const names = ["registry", "launch", "msg"] as const;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const trimZeros = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
};
const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9)} SOL`;

const results: { name: string; ok: boolean; detail: string }[] = [];
const notes: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`[preflight] ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const attempt = async (name: string, f: () => Promise<void>) => {
  try {
    await f();
  } catch (e) {
    // an error message could quote an endpoint: only its class is shown
    check(name, false, e instanceof MissingRpcError ? "UNITS_MAINNET_RPC is not set" : `could not be checked (${(e as Error).name})`);
  }
};

// 1 the rehearsal record
const rehFile = join(import.meta.dir, "TEST-REHEARSAL-LAST.json");
const reh = existsSync(rehFile) ? JSON.parse(readFileSync(rehFile, "utf8")) : null;
check("the fork rehearsal record is PASS", reh?.outcome === "PASS", reh ? `${reh.checks.filter((c: { ok: boolean }) => c.ok).length}/${reh.checks.length} checks, finished ${reh.finished}` : "scripts/mainnet/TEST-REHEARSAL-LAST.json is missing");
if (reh?.finished) notes.push(`the rehearsal is ${((Date.now() - Date.parse(reh.finished)) / 3600_000).toFixed(1)} hours old; pump.fun redeploys often, so rerun it on the day (check 9 catches a redeploy)`);

// 2 builds
const builds: Record<string, string> = {};
for (const n of names) {
  const f = join(TEST_BUILD_DIR, `units_${n}.so`);
  if (!existsSync(f)) {
    check(`${n}: the mainnet build exists`, false, "onchain/target/mainnet-test is missing it: build with --features mainnet-test");
    continue;
  }
  const so = readFileSync(f);
  builds[n] = sha(so);
  const has = (id: string) => Buffer.from(so).indexOf(Buffer.from(addressBytes(id))) >= 0;
  check(`${n}: the mainnet-test build is hash-equal to the rehearsed one and embeds the test ids only`,
    reh?.builds?.[n]?.so_sha256 === builds[n] && has(IDS[n]) && ![...Object.values(PROGRAM_IDS.devnet), ...Object.values(PROGRAM_IDS.mainnet)].some(has), `${so.length} bytes, sha256 ${builds[n]!.slice(0, 16)}`);
}

// 3 program id keypairs; 4 hot keys; 5 backup
const pubkeyOf = (p: string) => spawnSync("solana-keygen", ["pubkey", p], { encoding: "utf8" }).stdout.trim();
for (const n of names) {
  const f = join(PROGRAM_KEYS, `${n}-program-keypair.json`);
  check(`${n}: the program id keypair is the declared mainnet-test id`, existsSync(f) && pubkeyOf(f) === IDS[n], IDS[n]);
}
const hotFiles = ["deployer", "core-authority", "runtime-authority", "test-coin-mint"].map((n) => join(KEYS, `${n}.json`));
const idFiles = names.map((n) => join(PROGRAM_KEYS, `${n}-program-keypair.json`));
const haveHot = hotFiles.every((f) => existsSync(f));
check("the deployer key, the hot keys and the test coin mint key exist, mode 600", haveHot && [...hotFiles, ...idFiles].every((f) => !existsSync(f) || (statSync(f).mode & 0o077) === 0),
  haveHot ? "" : "run: bun scripts/mainnet/test.ts keys");
const copyOk = (f: string, dir: string) => {
  const c = join(dir, f.split("/").pop()!);
  return existsSync(f) && existsSync(c) && sha(readFileSync(f)) === sha(readFileSync(c)) && (statSync(c).mode & 0o077) === 0;
};
const backed = hotFiles.filter((f) => copyOk(f, BACKUP)).length + idFiles.filter((f) => copyOk(f, PROGRAM_BACKUP)).length;
check("every key file has an identical copy in its backup directory", backed === 7, `${backed} of 7 in the directories beside the key directories (test.ts keys makes them; keep an offline copy too)`);
const deployer = existsSync(join(KEYS, "deployer.json")) ? loadKeypair(join(KEYS, "deployer.json")).id : null;

// 6 the keyed endpoint
let rpc: Rpc | null = null;
await attempt("UNITS_MAINNET_RPC is set and answers with mainnet's genesis", async () => {
  const url = rpcUrlFor(profile);
  const r = Rpc.http(url, "confirmed");
  const g = await r.call<string>("getGenesisHash");
  check("UNITS_MAINNET_RPC is set and answers with mainnet's genesis", g === MAINNET_GENESIS, g === MAINNET_GENESIS ? "" : "the endpoint is not mainnet");
  if (g === MAINNET_GENESIS) rpc = r;
});
// the remaining reads use the keyed endpoint when there is one, else the public one (reads only), so the list is complete either way
const read: Rpc = rpc ?? Rpc.http(PUBLIC, "confirmed");
if (!rpc) notes.push("the chain reads below used the public mainnet endpoint, because no keyed one is set");

// 7 the deployer's balance against the rehearsed peak
await attempt("the deployer holds at least the rehearsed peak", async () => {
  if (!deployer || !reh?.deployer?.peak_lamports) return check("the deployer holds at least the rehearsed peak", false, "no deployer key or no rehearsal record");
  const peak = BigInt(reh.deployer.peak_lamports);
  const txs = Object.values(reh.deploys as Record<string, { transactions: number }>).reduce((a, d) => a + d.transactions, 0);
  // test.ts deploy sends each deploy transaction with the CLI's default limit of 200,000 compute units at most
  const priority = (BigInt(txs) * 200_000n * BigInt(price)) / 1_000_000n;
  const bal = await read.getBalance(deployer);
  check("the deployer holds at least the rehearsed peak", bal >= peak + priority,
    `${deployer} holds ${sol(bal)}; needs ${sol(peak + priority)} (rehearsed peak ${sol(peak)}${price ? ` + at most ${sol(priority)} of priority fees on ${txs} deploy transactions at ${price} micro-lamports` : ", no priority fee counted: pass --priority-micro-lamports"})`);
});

// 8 the program ids on mainnet
let deployedAlready = 0;
await attempt("the three program ids are free on mainnet (or hold these builds under the deployer)", async () => {
  for (const n of names) {
    const acct = await read.getAccountInfo(IDS[n]);
    const pd = await read.getAccountInfo(programDataAddress(IDS[n]));
    if (!acct) {
      check(`${n}: ${IDS[n]} is unused on mainnet`, true);
      continue;
    }
    if (!pd) {
      check(`${n}: ${IDS[n]} is usable`, false, "it was closed on mainnet: a closed program id cannot be deployed again (new ids and new builds are needed)");
      continue;
    }
    deployedAlready++;
    const same = sha(trimZeros(pd.data.subarray(45))) === sha(trimZeros(readFileSync(join(TEST_BUILD_DIR, `units_${n}.so`))));
    check(`${n}: already on mainnet with this build and the deployer as upgrade authority (a resumed run)`, same && decodeLoaderAuthority(pd.data) === deployer);
  }
});

// the launch's own mainnet ids must stay untouched by the test
await attempt("the launch's mainnet program ids are still unused", async () => {
  const used = [];
  for (const n of names) if (await read.getAccountInfo(PROGRAM_IDS.mainnet[n])) used.push(PROGRAM_IDS.mainnet[n]);
  check("the launch's mainnet program ids are still unused (the test never deploys at them)", used.length === 0, used.join(", "));
});

// 9 and 10 pump.fun on mainnet
await attempt("pump.fun's mainnet programs are the rehearsed and vendored builds", async () => {
  for (const [name, id, file] of [["Pump", PUMP.program, "pump.so"], ["PumpSwap", PUMP.amm, "pump_amm.so"], ["Pump Fees", PUMP.fees, "pump_fees.so"], ["Token-2022", TOKEN_2022_PROGRAM, null]] as const) {
    const pd = await read.getAccountInfo(programDataAddress(id));
    const now = pd ? sha(trimZeros(pd.data.subarray(45))) : "";
    const vendored = file && existsSync(join(ROOT, "onchain", "vendor", "pump", file)) ? sha(trimZeros(readFileSync(join(ROOT, "onchain", "vendor", "pump", file)))) : null;
    const okVendor = file === null || vendored === now;
    check(`${name} on mainnet is the build the rehearsal ran${file ? " and the vendored dump the LiteSVM suite runs" : ""}`, !!now && reh?.mainnet_builds?.[name] === now && okVendor,
      now && reh?.mainnet_builds?.[name] === now && okVendor ? now.slice(0, 16) : `changed since ${reh?.mainnet_builds?.[name] !== now ? "the rehearsal" : "onchain/vendor/pump/fetch.sh"}: rerun vendor/pump/fetch.sh, the suite and test-rehearsal.ts`);
  }
});
await attempt("pump.fun Global.max_curve_depth is 1 or more", async () => {
  const g = decodePumpGlobal((await read.getAccountInfo(PUMP.global))!.data);
  check("pump.fun Global.max_curve_depth is 1 or more", g.maxCurveDepth >= 1, `${g.maxCurveDepth}`);
});

// 11 Jito
await attempt("Jito's block engine is reachable", async () => {
  const a = await fetch(JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }), signal: AbortSignal.timeout(10_000) }).then((r) => r.json()) as { result?: string[] };
  const floor = await fetch(JITO_TIP_FLOOR, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  check("Jito's block engine is reachable", (a.result?.length ?? 0) > 0, `${a.result?.length ?? 0} tip accounts; tip floor ${floor ? `${tipFromFloor(floor)} lamports` : "not readable (the wizard then uses the 1,000 lamport minimum)"}`);
});

const ready = results.every((r) => r.ok);
console.log("");
for (const n of notes) console.log(`[preflight] note: ${n}`);
console.log("[preflight] note: the test ends with test.ts close, which returns the ProgramData rent and spends the three throwaway mainnet-test ids; the launch's mainnet ids are not involved");
if (deployedAlready) console.log(`[preflight] note: ${deployedAlready} of 3 programs are already on mainnet; test.ts deploy skips them`);
console.log(`[preflight] ${ready ? "READY" : "NOT READY"}: ${results.filter((r) => r.ok).length} of ${results.length} checks pass${ready ? "" : `; failing: ${results.filter((r) => !r.ok).map((r) => r.name).join("; ")}`}`);
const readyFile = join(KEYS, READY_FILE);
if (ready && deployer) writeFileSync(readyFile, JSON.stringify({ at: new Date().toISOString(), deployer, builds, priority_micro_lamports: price }, null, 2) + "\n", { mode: 0o600 });
writeFileSync(join(import.meta.dir, "PREFLIGHT-LAST.json"), JSON.stringify({ at: new Date().toISOString(), ready, deployer, checks: results, notes }, null, 2) + "\n");
process.exit(ready ? 0 : 1);

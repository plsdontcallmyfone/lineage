#!/usr/bin/env bun
// The OFFICIAL go-live, proven on a local fork of mainnet with the operator commands themselves
// (scripts/mainnet/golive.ts; docs/MAINNET-RUNBOOK.md "Go-live (single key, today)"). The fork holds the
// three official programs exactly as deployed on mainnet (cloned, with their real upgrade authority)
// and the real balances of the wallets of the sequence. Nothing is sent to mainnet: every transaction
// goes to 127.0.0.1:9690 (lib.ts assertFork; golive.ts refuses --send on a mainnet endpoint without
// --mainnet, which this script never passes). The dev wallet's key signs fork transactions only (a
// fork blockhash is not valid on mainnet); it is never printed.
//
//   0  the fork: official programs = the builds, upgrade authority = the dev wallet, nothing initialized
//   1  a stand-in $UNITS: pump.fun create_v2 paired with SOL by a THROWAWAY creator (the real mint cannot exist
//      on the fork before the owner creates it); the mint is the only parameter that differs from go-live day
//   2  golive.ts preflight (refuses the uncreated official mint, READY for the stand-in), params
//   3  golive.ts init: dry run sends nothing, --send initializes, a second run sends nothing
//   4  golive.ts bond: dry, then the buy on the curve and the transfer to the verifier owner key (a stand-in
//      for the key that lives on the site server), a second run sends nothing
//   5  golive.ts switch: the instance's state file, overlay and sizing file
//   6  the site's verifiers registered and bonded by scripts/deploy/site-chain.ts itself (what instance.sh
//      chain runs on the server), then the capacity server's two (stand-in keys co-sign)
//   7  one agent launched through the real Launch wizard, headless, against the OFFICIAL ids (wizard-fork.ts)
//   8  one fee crank: the agent coin's creator fees split 70% compute, 30% protocol
//   9  golive.ts status
// Every transaction is recorded with its size, compute units and cost at mainnet rent, and each
// wallet's total. Writes scripts/mainnet/GOLIVE-FORK-LAST.json.
//
//   LEDGER=$(mktemp -d); K=$(mktemp -d)
//   scripts/mainnet/fork.sh "$LEDGER" $(bun scripts/mainnet/golive-fork.ts --fork-args) &
//   UNITS_NETWORK=mainnet MAINNET_FORK_KEYS=$K bun scripts/mainnet/golive-fork.ts
//   kill <the validator's PID, after checking what it is>; rm -rf "$LEDGER" "$K"
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata, ChainReader, decodeBondingCurve, decodeLoaderAuthority, launchPdas, loadOrCreateKeypair, PROGRAM_IDS, programDataAddress, pumpCrankIxs, pumpPdas, readMsgConfig, registry, registryPdas,
  TOKEN_2022_PROGRAM, type Ix, type Signer,
} from "@units/chain";
import { loadOfficialParams, resolveOfficial } from "./golive-steps.ts";
import { programIdsNow, useActiveProfile } from "./steps.ts";
import { createTestCoin } from "./test-steps.ts";

const OFFICIAL = loadOfficialParams(join(import.meta.dir, "official-params.json"));
if (process.argv.includes("--fork-args")) {
  // what fork.sh needs on top of its own clones: the official programs as deployed, and the wallets with their real balances
  const ids = Object.values(PROGRAM_IDS.mainnet);
  console.log([...ids.flatMap((id) => ["--clone-upgradeable-program", id]), ...[OFFICIAL.admin, OFFICIAL.core_authority, OFFICIAL.runtime_authority].flatMap((a) => ["--clone", a])].join(" "));
  process.exit(0);
}
const { airdrop, assertFork, check, checks, fork, FORK_URL, forkKey, KEYS, log, mainnet, measure, rows, send, sol } = await import("./lib.ts");

const ROOT = join(import.meta.dir, "..", "..");
const T22 = TOKEN_2022_PROGRAM;
useActiveProfile();
const IDS = programIdsNow();
const reader = new ChainReader(fork);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const trimZeros = (b: Uint8Array) => { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return b.subarray(0, n); };
const OUT = join(KEYS, "official");
const LOGF = join(KEYS, "golive-cli.jsonl");
const PARAMS = join(KEYS, "official-params.fork.json");
mkdirSync(OUT, { recursive: true });
writeFileSync(LOGF, "");
const out: Record<string, unknown> = { started: new Date().toISOString(), fork: FORK_URL, program_ids: IDS };

// throwaway keys: the coin's creator, the stand-ins for keys that live on servers, a funder and a cranker
const creator = forkKey("coin-creator"), coinMint = forkKey(`coin-mint-${Date.now()}`), funder = forkKey("deployer"), cranker = forkKey("cranker");
const siteHome = join(KEYS, "site-home"), siteKeys = join(siteHome, ".config", "lineage", "site");
mkdirSync(siteKeys, { recursive: true });
const siteKey = (n: string) => loadOrCreateKeypair(join(siteKeys, `${n}.json`)).key;
const siteOwner = siteKey("owner"), siteVerifiers = [siteKey("verifier-ref"), siteKey("verifier-v1"), siteKey("verifier-v2")];
const capVerifiers = [forkKey("cap-verifier-1"), forkKey("cap-verifier-2")];
// the fork's parameter file: the official one with the server-held keys replaced by the stand-ins; nothing else differs
const forkParams = JSON.parse(readFileSync(join(import.meta.dir, "official-params.json"), "utf8"));
forkParams.site.verifier_owner = siteOwner.id;
forkParams.site.extra_verifiers = forkParams.site.extra_verifiers.map((e: Record<string, string>, i: number) => ({ ...e, agent: capVerifiers[i]!.id }));
writeFileSync(PARAMS, JSON.stringify(forkParams, null, 2));

// ---------------------------------------------------------------- the operator CLI against the fork
let logAt = 0;
const cliLog = (): Record<string, any>[] => {
  const lines = readFileSync(LOGF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fresh = lines.slice(logAt);
  logAt = lines.length;
  return fresh;
};
const transcript: { command: string; seconds: number; output: string[] }[] = [];
function golive(args: string[], o: { expectFail?: boolean; mint?: string } = {}): string {
  const t0 = Date.now();
  const all = [...args, "--rpc", FORK_URL, "--out", OUT, ...(args.includes("--params") ? [] : ["--params", PARAMS]), "--log", LOGF, "--no-site", "--mint", o.mint ?? coinMint.id, "--allow-creator", creator.id, "--unconfirmed-ok"];
  const r = spawnSync("bun", [join(import.meta.dir, "golive.ts"), ...all], { encoding: "utf8", env: { ...process.env, UNITS_NETWORK: "mainnet" } });
  const text = `${r.stdout}${r.stderr}`;
  transcript.push({ command: `golive.ts ${args.join(" ")}`, seconds: Math.round((Date.now() - t0) / 100) / 10, output: text.trim().split("\n").map((l) => l.slice(0, 400)) });
  if (!o.expectFail && r.status !== 0) throw new Error(`golive.ts ${args[0]} failed: ${text.slice(-1200)}`);
  if (o.expectFail && r.status === 0) throw new Error(`golive.ts ${args[0]} was expected to refuse`);
  return text;
}
/** The wire size of a landed transaction. */
async function txBytes(signature: string): Promise<number> {
  const t = await fork.call<{ transaction: [string, string] }>("getTransaction", [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  return Buffer.from(t.transaction[0], "base64").length;
}
const recorded: { step: string; what: string; signature: string; payer: string; bytes: number; signatures: number; compute_units: number | null; fee_lamports: number; payer_mainnet_lamports: string; created_bytes: number[] }[] = [];
async function record(step: string, what: string, signature: string) {
  const known = rows.find((r) => r.signature === signature);
  const c = known ?? (await measure(step, what, signature));
  recorded.push({ step, what, signature, payer: c.payer, bytes: await txBytes(signature), signatures: c.signatures, compute_units: c.computeUnits, fee_lamports: c.fee, payer_mainnet_lamports: c.payerMainnet, created_bytes: c.created.map((x) => x.bytes) });
  return c;
}
const bookCli = async (step: string) => { const got = []; for (const e of cliLog()) if (e.signature) got.push(await record(step, e.what, e.signature)); return got; };
const sentBy = (step: string, payer: Signer) => async (what: string, ixs: Ix[], signers: Signer[] = [], computeUnits?: number) => {
  const r = await send(step, what, payer, ixs, { signers, computeUnits });
  await record(step, what, r.signature);
  return r;
};

let outcome = "PASS";
try {
  // ---------------------------------------------------------------- 0: the fork
  await assertFork();
  for (const n of ["registry", "launch", "msg"] as const) {
    const so = readFileSync(join(ROOT, "onchain/target/mainnet", `units_${n}.so`));
    const pd = await fork.getAccountInfo(programDataAddress(IDS[n])), mpd = await mainnet.getAccountInfo(programDataAddress(IDS[n]));
    check(`0: ${n} on the fork is the program deployed on mainnet at ${IDS[n].slice(0, 6)}... (cloned), byte-identical to the build, upgrade authority the dev wallet`,
      !!pd && !!mpd && sha(pd.data.subarray(45)) === sha(mpd.data.subarray(45)) && pd.data.length === mpd.data.length && sha(trimZeros(pd.data.subarray(45))) === sha(trimZeros(so)) && decodeLoaderAuthority(pd.data) === OFFICIAL.admin, `sha256 ${sha(so)}`);
  }
  check("0: nothing is initialized at the official ids", (await reader.registryConfig().catch(() => null)) === null && (await reader.launchConfig().catch(() => null)) === null && (await readMsgConfig(fork).catch(() => null)) === null);
  const [devFork, devMain] = [await fork.getBalance(OFFICIAL.admin), await mainnet.getBalance(OFFICIAL.admin)];
  check("0: the dev wallet holds on the fork what it holds on mainnet (no airdrop: the sequence must fit its real balance)", devFork === devMain && devFork > 0n, `${sol(devFork)} SOL`);
  for (const k of [creator, funder, cranker]) await airdrop(k.id, 20n * 10n ** 9n); // fork SOL for the throwaway keys (the funder also moves the price before the second launch)
  out.wallets_before = { dev_wallet: devFork.toString(), core_authority: (await fork.getBalance(OFFICIAL.core_authority)).toString(), runtime_authority: (await fork.getBalance(OFFICIAL.runtime_authority)).toString() };

  // ---------------------------------------------------------------- 1: BEFORE the coin: pre, the staged instance files, the watcher
  const genesis = await fork.call<string>("getGenesisHash");
  const refused = golive(["preflight"], { expectFail: true, mint: OFFICIAL.units_mint });
  check("1: the post-coin preflight refuses while the official mint does not exist (as on mainnet today)", /NOT READY/.test(refused) && /not created yet/.test(refused));
  // the Core authority is topped up only by its shortfall to the target: none when the owner already sent it (as on 2026-10-12)
  const coreShort = (await fork.getBalance(OFFICIAL.core_authority)) < 1_250_000_000n;
  const PRE_TXS = coreShort ? 4 : 3;
  const preDry = golive(["pre"]);
  check(`1: pre, dry: the checks that need no coin pass and ${PRE_TXS} transactions are planned (the Core authority ${coreShort ? "is short of its target" : "already holds its target: no top-up"}), nothing sent`, !/FAIL/.test(preDry) && (preDry.match(/WOULD SEND/g) ?? []).length === PRE_TXS && cliLog().length === 0 && (await readMsgConfig(fork).catch(() => null)) === null,
    (preDry.match(/the verifiers need [^\n]*/) ?? [""])[0]!.slice(0, 260));
  golive(["pre", "--send"]);
  const preRows = await bookCli("1 pre (before the coin)");
  const preJson = JSON.parse(readFileSync(join(OUT, "pre.json"), "utf8"));
  check("1: pre --send, before the coin exists: messages initialized (admin = the dev wallet), the launch lookup table created, extended and frozen for the mint's address, the Core authority hot key at 1.25 SOL or more", preRows.length === PRE_TXS && (await readMsgConfig(fork))?.admin === OFFICIAL.admin && !!(await fork.getAccountInfo(preJson.launch_lookup_table)) && (await fork.getBalance(OFFICIAL.core_authority)) >= 1_250_000_000n, `table ${preJson.launch_lookup_table}`);
  golive(["pre", "--send"]);
  check("1: pre --send run again sends nothing", cliLog().length === 0);
  golive(["switch", "--pre", "--overlay-genesis", genesis]);
  const staged = JSON.parse(readFileSync(join(OUT, "state.json"), "utf8"));
  check("1: switch --pre writes the instance's state file before the coin exists: official ids, the mint, the table, the sink derived from the mint, a new coin's starting price", staged.registry_program === IDS.registry && staged.line_mint === coinMint.id && staged.launch_lookup_table === preJson.launch_lookup_table &&
    staged.compute_sink === ata(OFFICIAL.admin, coinMint.id, T22) && staged.network_overrides.prepay.identity_account_recipient === OFFICIAL.admin, `${staged.network_overrides.prepay.line_per_usd} coins per USD at the starting price`);
  out.pre = { transactions: preRows.length, payer_mainnet_lamports: preRows.reduce((a, r) => a + BigInt(r.payerMainnet), 0n).toString(), launch_lookup_table: preJson.launch_lookup_table, staged_line_per_usd: staged.network_overrides.prepay.line_per_usd };
  const noInit = golive(["bond"], { expectFail: true });
  check("1: bond refuses before init", /not initialized/.test(noInit));

  // the server-side registration as watch will run it: scripts/deploy/site-chain.ts itself, with stand-in keys in a stand-in home
  const caps = join(KEYS, "caps.json"), siteLog = join(KEYS, "site-chain.jsonl");
  writeFileSync(caps, JSON.stringify({ arch: "fork", cpus: 4, memory_mb: 8192, gpus: [] }));
  writeFileSync(siteLog, "");
  const siteEnv = `HOME=${siteHome} UNITS_INSTANCE=mainnet UNITS_INSTANCE_STATE=${join(OUT, "state.json")} UNITS_NETWORK=mainnet UNITS_PROFILE_LOCAL=${join(OUT, "profile.local.json")} UNITS_MAINNET_RPC=${FORK_URL}`;
  const chainCmd = `cd ${ROOT} && ${siteEnv} bun scripts/deploy/site-chain.ts --caps ${caps} --log ${siteLog}`;

  // ---------------------------------------------------------------- 2: the watcher is started, THEN the coin is created
  const watchArgs = ["watch", "--send", "--wait-s", "30", "--overlay-genesis", genesis, "--chain-cmd", chainCmd,
    "--rpc", FORK_URL, "--out", OUT, "--params", PARAMS, "--log", LOGF, "--no-site", "--mint", coinMint.id, "--allow-creator", creator.id, "--unconfirmed-ok"];
  const watcher = Bun.spawn(["bun", join(import.meta.dir, "golive.ts"), ...watchArgs], { env: { ...process.env, UNITS_NETWORK: "mainnet" }, stdout: "pipe", stderr: "pipe" });
  await new Promise((r) => setTimeout(r, 4000)); // it is polling by now
  const od = OFFICIAL.owner_decision, one = 1_000_000n;
  const needUnits = (5n * BigInt(od.register_burn_units) + 4n * BigInt(od.min_bond_units)) * one;
  const DEV_HELD = 30_000_000n * one; // the owner: "the dev wallet will have 3% so 30m tokens"
  const tCreate0 = Date.now();
  // the owner's last manual action, stood in for by a throwaway creator: create_v2 paired with SOL and a buy
  const coin = await createTestCoin(fork, async (what, payer, ixs, o) => send("2", what, payer, ixs, o), (n, ok, d) => check(`2: ${n}`, ok, d), creator, coinMint,
    { name: "units go-live stand-in (fork)", symbol: "UNITS", uri: "https://units.invalid/fork/standin.json" }, 1_000_000_000n);
  const tCreated = Date.now();
  // the dev wallet holds the verifiers' coins after its creation buy; here the throwaway creator hands them over
  await send("2", "fork only: the stand-in creator sends the dev wallet the coins a creation buy would have given it", creator, [
    (await import("@units/chain")).token.createAtaIdempotent(creator.id, OFFICIAL.admin, coin.mint, T22),
    (await import("@units/chain")).token.transferChecked(ata(creator.id, coin.mint, T22), coin.mint, ata(OFFICIAL.admin, coin.mint, T22), creator.id, DEV_HELD, 6, T22)]);
  out.stand_in = { mint: coin.mint, creator: creator.id, creator_buy_lamports: "1000000000", dev_wallet_given_base_units: DEV_HELD.toString(), note: "created on the fork only; on go-live day the owner's dev wallet creates the real mint and --mint is not passed" };
  const [wOut, wErr, wCode] = await Promise.all([new Response(watcher.stdout).text(), new Response(watcher.stderr).text(), watcher.exited]);
  const tDone = Date.now();
  const wText = `${wOut}${wErr}`;
  transcript.push({ command: "golive.ts watch --send", seconds: Math.round((tDone - tCreate0) / 100) / 10, output: wText.trim().split("\n").map((l) => l.slice(0, 400)) });
  if (wCode !== 0) throw new Error(`watch failed: ${wText.slice(-1500)}`);
  const times = [...wText.matchAll(/TIME ([^:]+): ([\d.]+) s/g)].map((m) => ({ step: m[1]!, seconds: Number(m[2]) }));
  const watchRows = await bookCli("2 watch (after the coin)");
  for (const e of readFileSync(siteLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) await record("2 watch: site verifiers", e.what.replace(/\(caps digest [^)]*\)/, "").trim(), e.signature);
  const cfg = (await reader.registryConfig())!, lc = (await reader.launchConfig())!, mc = await readMsgConfig(fork);
  const resolved = JSON.parse(readFileSync(join(OUT, "official-resolved.json"), "utf8"));
  check("2: watch saw the coin and ran the post-coin preflight, init, the bond funding, the instance files and the server-side registrations, with a time per step", times.length >= 5 && /READY \(/.test(wText), times.map((t) => `${t.step} ${t.seconds} s`).join("; "));
  check("2: after the coin the dev wallet sent exactly three transactions, in parallel: init in two, and the one transfer to the verifier owner key (never a buy)", watchRows.length === 3 && watchRows.filter((r) => /^init \d of 2/.test(r.what)).length === 2 && watchRows.some((r) => /^the one transfer from the dev wallet/.test(r.what)),
    watchRows.map((r) => `${r.what.slice(0, 40)}... ${r.computeUnits} CU`).join("; "));
  check("2: registry, launch and messages initialized with admin = the dev wallet, the Core and runtime authorities of the instance, the stand-in as mint",
    cfg.admin === OFFICIAL.admin && lc.admin === OFFICIAL.admin && mc?.admin === OFFICIAL.admin && cfg.coreAuthority === OFFICIAL.core_authority && lc.runtimeAuthority === OFFICIAL.runtime_authority && cfg.mint === coin.mint);
  check("2: fee split 70% compute, 30% protocol; compute sink = the dev wallet's $UNITS account (as staged before the coin); slash cap as in the file; bounty and challenge configs set", lc.agentComputeBps === 7000 && lc.protocolBps === 3000 && lc.computeSink === staged.compute_sink &&
    cfg.maxSlashBpsPerEpoch === od.max_slash_bps_per_epoch && !!(await reader.bountyConfig()) && !!(await reader.challengeConfig()));
  check("2: registry values equal the file: burn, min bond, cap, cooldown, on-chain epoch", cfg.params.registerBurn === BigInt(od.register_burn_units) * one && cfg.params.minBond === BigInt(od.min_bond_units) * one && cfg.params.bondCap === BigInt(od.bond_cap_units) * one &&
    Number(cfg.params.unbondCooldownS) === od.unbond_cooldown_s && cfg.params.epochLengthS === od.onchain_epoch_length_s);
  const usdOf = (k: string) => BigInt(resolved.resolved_usd.find((x: { key: string }) => x.key === k).units) * one;
  check("2: the dollar values are on chain at the price read when the coin appeared: sleep, wake, debit cap", lc.sleepThreshold === usdOf("sleep_threshold_usd") && lc.wakeThreshold === usdOf("wake_threshold_usd") && lc.maxDebitPerEpoch === usdOf("max_debit_per_epoch_usd"),
    `at ${resolved.price.usd_per_units} USD per coin: ${resolved.resolved_usd.map((x: { key: string; usd: string; units: string }) => `${x.key} ${x.usd} USD = ${x.units}`).join(", ")}`);
  const recs = await Promise.all(siteVerifiers.map((v) => reader.agent(v.id)));
  check("2: site-chain.ts (what `instance.sh chain` runs on the server) registered the reference runner and registered and bonded v1 and v2 at the official registry, owner = the verifier owner key", recs.every((r) => r?.owner === siteOwner.id) && recs[0]!.bond === 0n && recs[1]!.bond === cfg.params.minBond && recs[2]!.bond === cfg.params.minBond);
  const st = JSON.parse(readFileSync(join(OUT, "state.json"), "utf8"));
  check("2: the instance files were written again at the live price: units account at 0.03 SOL to the dev wallet, credits at the live rate, the runtime billing from the instance's indexer inside the band",
    st.network_overrides.prepay.identity_account_recipient === OFFICIAL.admin && st.network_overrides.prepay.identity_account_price_lamports === "30000000" && st.network_overrides.prepay.rate_status === "live" &&
    st.runtime_price.source === "jupiter" && /127\.0\.0\.1:9768\/market\/price\/v3/.test(st.runtime_price.api) && st.line_mint === coin.mint, `${st.network_overrides.prepay.line_per_usd} coins per USD (staged at ${staged.network_overrides.prepay.line_per_usd})`);
  check("2: the repository's config was not written (no --apply-config)", JSON.parse(readFileSync(join(ROOT, "config/profile.json"), "utf8")).mainnet_deployment === "test");
  out.watch = { note: "wall time on the local fork (blocks every 400 ms, no network distance); the server-side activation is not part of it", steps: times,
    coin_create_transactions_s: Math.round((tCreated - tCreate0) / 100) / 10, from_coin_created_to_done_s: Math.round((tDone - tCreated) / 100) / 10 };
  out.init = { transactions: 2, payer_mainnet_lamports: watchRows.filter((r) => /^init/.test(r.what)).reduce((x, r) => x + BigInt(r.payerMainnet), 0n).toString(), price: resolved.price, resolved_usd: resolved.resolved_usd };
  out.bond = { units_base: needUnits.toString(), payer_mainnet_lamports: watchRows.find((r) => /^the one transfer/.test(r.what))!.payerMainnet, note: "the stand-in owner key started with 0 SOL, so 0.05 SOL was sent with the coins; the real key held 0.241898035 SOL on 2026-10-12 and would be sent none" };
  const again = golive(["init", "--send"]);
  check("3: init --send run again sends nothing and uses the saved resolution", cliLog().length === 0 && !/FAIL/.test(again) && /saved resolution/.test(again));

  // ---------------------------------------------------------------- 4: the capacity server's two verifiers
  const asOwner = sentBy("4 capacity verifiers", siteOwner), ownerCoin = ata(siteOwner.id, coin.mint, T22);
  for (const [i, v] of capVerifiers.entries()) {
    await asOwner(`register capacity verifier ${i + 1} (owner key pays and signs, the verifier key co-signs; 2 signatures)`, [registry.register({ owner: siteOwner.id, agent: v.id, mint: coin.mint, ownerToken: ownerCoin, operator: "00".repeat(32), capabilities: OFFICIAL.site.extra_capabilities_digest, tokenProgram: T22 })], [v]);
    await asOwner(`bond min_bond for capacity verifier ${i + 1}`, [registry.bond({ owner: siteOwner.id, agent: v.id, mint: coin.mint, ownerToken: ownerCoin, amount: cfg.params.minBond, tokenProgram: T22 })]);
  }
  const capRecs = await Promise.all(capVerifiers.map((v) => reader.agent(v.id)));
  check("4: the two capacity verifiers are registered with the instance's capabilities digest and bonded; the owner key has spent every coin it was sent", capRecs.every((r) => r?.bond === cfg.params.minBond && r.capabilities === OFFICIAL.site.extra_capabilities_digest) && (await reader.tokenBalance(ownerCoin)) === 0n,
    `bond vault ${await reader.tokenBalance(registryPdas.bondVault())} base units`);
  const b2 = golive(["bond"]);
  check("4: bond now finds nothing to do", /has its coins/.test(b2) && /still to do: 0 registration burns and 0 bonds/.test(b2) && !/WOULD SEND/.test(b2));

  // ---------------------------------------------------------------- 5: the owner's rule on the dev wallet's own coins
  const marker = JSON.parse(readFileSync(join(OUT, "dev-wallet-transfer.json"), "utf8"));
  const devLeft = (await reader.tokenBalance(ata(OFFICIAL.admin, coin.mint, T22)))!;
  check("5: exactly one transfer of 5,000,000 coins left the dev wallet, to the verifier owner key, recorded in the marker before it was sent; the rest of its coins are untouched", marker.amount === needUnits.toString() && marker.confirmed === true &&
    marker.destination === ownerCoin && devLeft === DEV_HELD - needUnits, `dev wallet held ${DEV_HELD} base units, holds ${devLeft}`);
  golive(["bond", "--send"]);
  check("5: bond --send run again sends nothing (the marker and the chain both say the transfer landed)", cliLog().length === 0 && (await reader.tokenBalance(ata(OFFICIAL.admin, coin.mint, T22))) === devLeft);
  // a parameter file that asks for more than the ceiling is refused whatever the wallet holds: the ceiling is a constant of the code
  const more = JSON.parse(readFileSync(PARAMS, "utf8"));
  more.site.site_verifiers.burn_and_bond = 3;
  const PARAMS_MORE = join(KEYS, "official-params.more.json");
  writeFileSync(PARAMS_MORE, JSON.stringify(more));
  const over = golive(["bond", "--send", "--params", PARAMS_MORE], { expectFail: true });
  check("5: a sixth million is refused: with the transfer landed the tooling never sends a second one, and the dev wallet's balance does not move", /never sends a second one/.test(over) && cliLog().length === 0 && (await reader.tokenBalance(ata(OFFICIAL.admin, coin.mint, T22))) === devLeft, (over.match(/stopped: [^\n]*/) ?? [""])[0]!.slice(0, 200));
  // the wizard proof below runs no identity service, so its instance is told the units account is not offered (the path proven on the test deployment)
  golive(["switch", "--overlay-genesis", genesis, "--no-identity"]);
  const stW = JSON.parse(readFileSync(join(OUT, "state.json"), "utf8"));
  check("5: switch --no-identity names no units account recipient", stW.network_overrides.prepay.identity_account_recipient === null);
  out.switch = { line_per_usd: st.network_overrides.prepay.line_per_usd, sandbox_per_s: st.network_overrides.prepay.compute_price_line_per_sandbox_s, runtime_price: st.runtime_price, sizing: JSON.parse(readFileSync(join(OUT, "sizing.json"), "utf8")) };

  // ---------------------------------------------------------------- 7: one launch through the wizard, against the official ids
  const wrec = join(KEYS, "wizard.json");
  const w = spawnSync("bun", [join(import.meta.dir, "wizard-fork.ts"), "--keys", KEYS, "--official", "--state-dir", OUT, "--record", wrec, "--wallet-sol", "1"], { encoding: "utf8", cwd: ROOT, env: { ...process.env, UNITS_NETWORK: "mainnet" }, timeout: 20 * 60_000 });
  const wj = existsSync(wrec) ? JSON.parse(readFileSync(wrec, "utf8")) : null;
  if (!wj) throw new Error(`wizard-fork.ts wrote no record: ${`${w.stdout}${w.stderr}`.slice(-1200)}`);
  check("7: the Launch wizard, headless, launched one agent at the OFFICIAL ids quoted in the stand-in and bought it in the trade box", wj.outcome === "PASS", `${wj.passed}/${wj.total}${wj.outcome === "PASS" ? "" : `: ${(wj.results ?? []).filter((r: { ok: boolean }) => !r.ok).map((r: { check: string }) => r.check).join(" | ").slice(0, 300)}`}`);
  out.wizard = { outcome: wj.outcome, passed: wj.passed, total: wj.total, launch: wj.launch, trade: wj.trade, results: wj.results };
  const agent = wj.launch.agent as string, agentMint = wj.launch.mint as string;
  const la = (await reader.agentLaunch(agentMint))!;
  const sigs = (await fork.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [la.launcher, { limit: 50, commitment: "confirmed" }])).filter((s) => !s.err).reverse();
  let launcherSpent = 0n;
  for (const [i, s] of sigs.entries()) {
    const c = await record("7 launch (wallet)", i === 0 ? "fork only: SOL to the browser wallet" : `wallet transaction ${i} of the launch and the trade`, s.signature);
    if (c.payer === la.launcher) launcherSpent += BigInt(c.payerMainnet);
  }
  const cr = wj.launch.credits ?? {};
  check("7: the launch's credits were priced by the wizard at the coin's live market price: the vault holds 10 USD of coins at the page's reading, Core judged it ok at the price of the launch's time, and the agent is awake",
    (await reader.tokenBalance(launchPdas.computeVault(agent)))?.toString() === String(cr.vault_deposit_base_units) && Math.abs(Number(cr.deposit_usd) - 10) <= 1 && cr.core?.ok === true && la.awake === true,
    `${cr.vault_deposit_base_units} base units = ${Number(cr.deposit_usd).toFixed(4)} USD at ${cr.page_reading?.usd} USD per coin`);
  // a second launch after the coin's price has moved: the deposit follows the market, not the rate staged in the state file
  const wrec2 = join(KEYS, "wizard-moved.json");
  spawnSync("bun", [join(import.meta.dir, "wizard-fork.ts"), "--keys", KEYS, "--official", "--state-dir", OUT, "--record", wrec2, "--wallet-sol", "1", "--move-price-sol", "3"], { encoding: "utf8", cwd: ROOT, env: { ...process.env, UNITS_NETWORK: "mainnet" }, timeout: 25 * 60_000 });
  const wj2 = existsSync(wrec2) ? JSON.parse(readFileSync(wrec2, "utf8")) : null;
  if (!wj2) throw new Error("the second wizard run wrote no record");
  const cr2 = wj2.launch?.credits ?? {};
  check("7: a launch after the price moved (3 SOL bought on the coin's curve first): the wizard passes, the deposit is still 10 USD of coins at the new price, fewer coins than the first launch, and Core accepts it",
    wj2.outcome === "PASS" && Math.abs(Number(cr2.deposit_usd) - 10) <= 1 && BigInt(cr2.vault_deposit_base_units ?? 0) < BigInt(cr.vault_deposit_base_units ?? 0) && cr2.core?.ok === true,
    `${wj2.passed}/${wj2.total}; ${cr2.vault_deposit_base_units} base units at ${cr2.page_reading?.usd} USD per coin (first launch: ${cr.vault_deposit_base_units} at ${cr.page_reading?.usd})${wj2.outcome === "PASS" ? "" : `: ${(wj2.results ?? []).filter((r: { ok: boolean }) => !r.ok).map((r: { check: string }) => r.check).join(" | ").slice(0, 300)}`}`);
  out.wizard_after_price_move = { outcome: wj2.outcome, passed: wj2.passed, total: wj2.total, launch: wj2.launch };

  // ---------------------------------------------------------------- 8: one fee crank
  const waiting = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(agentMint)))!.data).creatorFee;
  const vault = launchPdas.computeVault(agent);
  const [c0, t0] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  await sentBy("8 crank", cranker)("fee crank: pump.fun sweep + collect, then crank_pump_fees (anyone)", pumpCrankIxs({ payer: cranker.id, agent, agentMint, lineMint: coin.mint, lineTokenProgram: T22 }), [], 600_000);
  const [c1, t1] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  const computeShare = (waiting * 7000n) / 10_000n;
  check("8: the crank paid exactly the waiting creator fees: 70% to the agent's compute vault, 30% to the treasury", waiting > 0n && c1! - c0! === computeShare && t1! - t0! === waiting - computeShare, `${waiting} base units: ${computeShare} / ${waiting - computeShare}`);

  // ---------------------------------------------------------------- 9: status
  const stat = golive(["status"]);
  check("9: status shows the deployment: admin, authorities, the Core authority's days of posts, price, 5 verifiers (4 bonded), 2 agents, epochs", /5 registered, 4 bonded/.test(stat) && /agents launched\s+2/.test(stat) && /days of posts/.test(stat) && /epochs on chain/.test(stat) && /\$UNITS price/.test(stat));

  // ---------------------------------------------------------------- totals
  const sumOf = (payer: string, steps?: RegExp) => recorded.filter((r) => r.payer === payer && (!steps || steps.test(r.step))).reduce((a, r) => a + BigInt(r.payer_mainnet_lamports), 0n);
  const devSpent = sumOf(OFFICIAL.admin), ownerSpent = sumOf(siteOwner.id);
  // the mint is a parameter: the same resolution for the official mint differs only where the mint itself is written
  const a = resolveOfficial(OFFICIAL, coin.mint, resolved.price, "x"), b = resolveOfficial(OFFICIAL, OFFICIAL.units_mint, resolved.price, "x");
  check("the stand-in mint is the only difference: the resolved on-chain values for the official mint are identical once the mint address is swapped", JSON.stringify(a).split(coin.mint).join(OFFICIAL.units_mint) === JSON.stringify(b));
  out.wallets = {
    note: "at mainnet rent and the base fee of 5,000 lamports per signature, no priority fee. The dev wallet never buys: the verifiers' 5,000,000 coins come out of its own holdings in one transfer. dev_wallet includes 0.05 SOL sent to the stand-in owner key, which the real key does not need.",
    dev_wallet: { address: OFFICIAL.admin, held_lamports: devFork.toString(), spent_lamports: devSpent.toString(), spent_sol: sol(devSpent), before_the_coin: sumOf(OFFICIAL.admin, /^1 pre/).toString(), after_the_coin_init_and_transfer: sumOf(OFFICIAL.admin, /^2 watch/).toString(), },
    verifier_owner_key: { spent_lamports: ownerSpent.toString(), spent_sol: sol(ownerSpent), covers: "5 registrations (each creates an agent record) and 4 bonds" },
    launcher_wallet: { spent_lamports: launcherSpent.toString(), spent_sol: sol(launcherSpent), covers: "one launch through the wizard (credits, the 1% initial buy, rent, fees, the tip) and one 0.02 SOL buy in the trade box" },
    cranker: { spent_lamports: sumOf(cranker.id).toString(), covers: "one fee crank (anyone may send it)" },
    core_authority: "sends nothing in this sequence; one epoch post was measured at 0.001493440 SOL (docs/MAINNET-COSTS.md)",
    runtime_authority: "sends nothing in this sequence",
  };
  check("the dev wallet's real balance covers the whole sequence", devFork > devSpent, `${sol(devSpent)} of ${sol(devFork)} SOL`);
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
} finally {
  out.finished = new Date().toISOString();
  out.outcome = outcome;
  out.checks = checks;
  out.transactions = recorded;
  out.commands = transcript.map((t) => ({ command: t.command, seconds: t.seconds, lines: t.output.length }));
  writeFileSync(join(import.meta.dir, "GOLIVE-FORK-LAST.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(join(KEYS, "transcript.json"), JSON.stringify(transcript, null, 2));
  log(`go-live fork proof ${outcome}: checks ${checks.filter((c) => c.ok).length}/${checks.length}, ${recorded.length} transactions recorded`);
  if (outcome !== "PASS") process.exit(1);
}

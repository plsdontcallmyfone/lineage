#!/usr/bin/env bun
// Graduation keeper: sees an agent coin through from a complete bonding curve to a recorded
// graduation, with nobody watching (packages/chain/src/graduation.ts has the states and the rule).
//
//   bun scripts/mainnet/graduate.ts --key <payer keypair.json> [--mint <mint>] [--migrate-after <seconds>] [--no-migrate]
//                                   [--max-migrate-sol <n>] [--table <address>] [--send]
//
// For every pump.fun launch the launch program has not recorded as graduated, read from chain:
//   on its curve                     nothing
//   curve complete, no pool yet      trading is halted until pump.fun's migrate_v2 makes the PumpSwap pool.
//                                    Anyone may send it and pump.fun's own keeper normally does within
//                                    seconds, so this keeper waits --migrate-after seconds (default 120)
//                                    from the completion and then sends migrate_v2 itself, with
//                                    record_pump_graduation in the same transaction
//   pool exists, not recorded        record_pump_graduation (anyone may send it; it sets
//                                    AgentLaunch.graduated and pump_pool)
// A recorded coin is never read again. Nothing is kept between runs: the step is decided from the
// chain each time, so a run that stops anywhere is resumed by the next one, and a step pump.fun's
// keeper or anybody else sent first is found done.
//
// Dry run by default: every step is built as it would be sent and simulated, and the line says what
// it would cost the payer. --send sends the ones whose simulation succeeds. The payer is the only
// signer. A migration costs it pump.fun's migration fee (Global.pool_migration_fee, 0.015000001 SOL
// on 2026-10-13), the rent of the pool's accounts and the network fee: 0.022519682 SOL in all on the
// fork of mainnet at mainnet rent (scripts/mainnet/graduation-fork.ts). It is not sent when the
// simulation says the payer would pay more than --max-migrate-sol (default 0.05), and --no-migrate
// never sends it (the keeper then only records). A record costs the network fee alone. The wait is
// measured on the chain's clock (the completion's block time against the newest block's). A transaction too large for a legacy message goes
// as version 0 with the launch lookup table (`launch_lookup_table` of the state file, or --table),
// which this script only reads.
import { accountDisc, buildFitted, ChainReader, chainTime, curveCompletedAt, decodeAgentLaunch, decodePumpGlobal, graduationIxs, GraduationRefused, graduationState, graduationStep, LAUNCH_PROGRAM_ID,
  loadKeypair, loadLookupTable, PUMP, pumpPdas, Rpc, sendFitted, TOKEN_2022_PROGRAM, TxError, TxTooLargeError, type AgentLaunch, type GraduationReading, type LookupTable } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../packages/chain/src/profile-node.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const SEND = argv.includes("--send"), MIGRATE = !argv.includes("--no-migrate");
const log = (m: string) => console.log(`[graduate] ${m}`);
const keyFile = opt("key");
if (!keyFile) throw new Error("usage: graduate.ts --key <payer keypair.json> [--mint <mint>] [--migrate-after <seconds>] [--no-migrate] [--max-migrate-sol <n>] [--table <address>] [--send]");
const migrateAfterS = Number(opt("migrate-after") ?? "120"), maxMigrate = BigInt(Math.round(Number(opt("max-migrate-sol") ?? "0.05") * 1e9));
if (!Number.isFinite(migrateAfterS) || migrateAfterS < 0) throw new Error("--migrate-after takes a number of seconds");
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(9);

const profile = applyNetworkProfile();
const state = stateFor(profile) as { mint?: string; line_mint?: string; launch_lookup_table?: string } | null;
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
const reader = new ChainReader(rpc);
const payer = loadKeypair(keyFile);

const cfg = await reader.launchConfig();
if (!cfg) throw new Error("the launch program is not initialized on this network");
const lineMint = cfg.lineMint ?? state?.mint ?? state?.line_mint;
if (!lineMint) throw new Error("no quote mint known");
const globalA = await rpc.getAccountInfo(PUMP.global);
if (!globalA) throw new Error("pump.fun's Global account is not on this network");
const global = decodePumpGlobal(globalA.data);

// every launch record the program has not marked graduated (a recorded coin is done for good)
const only = opt("mint");
const records: AgentLaunch[] = [];
for (const a of await rpc.getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }] })) {
  let l: AgentLaunch;
  try { l = decodeAgentLaunch(a.data); } catch { continue; }
  if (l.venue === "pump" && !l.graduated && (!only || l.mint === only)) records.push(l);
}
log(`${profile.network}: ${records.length} pump.fun launch(es) not recorded as graduated, quote ${lineMint}, payer ${payer.id}${SEND ? "" : " (dry run)"}${MIGRATE ? `, migrates ${migrateAfterS} s after a completion nobody migrated` : ", never migrates (records only)"}`);

let tables: LookupTable[] | null = null;
const tablesNow = async (): Promise<LookupTable[]> => {
  if (tables) return tables;
  const at = opt("table") ?? state?.launch_lookup_table;
  if (!at) return (tables = []);
  const t = await loadLookupTable(rpc, at).catch((e) => ({ table: null, reason: `could not be read: ${(e as Error).message.slice(0, 120)}` }));
  if (!t.table) log(`lookup table ${at} is not usable (${t.reason}): legacy transactions only`);
  return (tables = t.table ? [t.table] : []);
};

const read = async (ls: AgentLaunch[]): Promise<(GraduationReading | { refused: string })[]> => {
  const keys = ls.flatMap((l) => [l.bondingCurve, pumpPdas.pool(l.mint, lineMint)]);
  const accs: Awaited<ReturnType<Rpc["getMultipleAccounts"]>> = [];
  for (let i = 0; i < keys.length; i += 100) accs.push(...(await rpc.getMultipleAccounts(keys.slice(i, i + 100))));
  return ls.map((l, i) => {
    try {
      return graduationState(l, lineMint, accs[2 * i] ?? null, accs[2 * i + 1] ?? null);
    } catch (e) {
      if (e instanceof GraduationRefused) return { refused: e.message };
      throw e;
    }
  });
};

/** What the payer's balance would fall by, from a simulation that returns the payer's account after the transaction. */
const simulate = async (wire: Uint8Array, before: bigint): Promise<{ err: unknown; logs: string[]; cost: bigint | null; units: number | null }> => {
  const r = (await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: ({ lamports: number } | null)[] | null } }>("simulateTransaction", [
    Buffer.from(wire).toString("base64"), { encoding: "base64", sigVerify: false, commitment: "confirmed", replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [payer.id] } }])).value;
  const after = r.accounts?.[0]?.lamports;
  return { err: r.err, logs: r.logs ?? [], cost: typeof after === "number" ? before - BigInt(after) : null, units: r.unitsConsumed ?? null };
};

const n = { curve: 0, waiting: 0, migrated: 0, recorded: 0, failed: 0 };
let paid = 0n;
const readings = await read(records);
for (let i = 0; i < records.length; i++) {
  const l = records[i]!, tag = `${l.agent.slice(0, 6)} (${l.mint.slice(0, 6)})`;
  try {
    let g = readings[i]!;
    // at most two steps per coin and run: a migration somebody else lands between this run's read and its send leaves the record to do
    for (let pass = 0; pass < 2; pass++) {
      if ("refused" in g) { n.failed++; log(`${tag}: left alone, ${g.refused}`); break; }
      if (g.state === "curve") { n.curve++; break; }
      const completedAt = g.state === "awaiting_migration" && MIGRATE && global.enableMigrate && migrateAfterS > 0 ? await curveCompletedAt(rpc, l.bondingCurve) : null;
      const step = graduationStep(g.state, { migrate: MIGRATE, migrateAfterS, enableMigrate: global.enableMigrate, completedAt, now: completedAt === null ? 0 : await chainTime(rpc) });
      if (step.kind === "none") break;
      if (step.kind === "wait") { n.waiting++; log(`${tag}: waiting, ${step.why}`); break; }
      const what = step.kind === "migrate" ? "migrate_v2 and record_pump_graduation" : "record_pump_graduation";
      const ixs = graduationIxs(step.kind, { payer: payer.id, agentMint: l.mint, lineMint, withdrawAuthority: global.withdrawAuthority, lineTokenProgram: TOKEN_2022_PROGRAM });
      const options = { tables: await tablesNow(), computeUnits: step.kind === "migrate" ? 600_000 : 60_000 };
      const built = await buildFitted(rpc, payer, ixs, options).catch((e) => {
        if (!(e instanceof TxTooLargeError)) throw e;
        return e;
      });
      if (built instanceof TxTooLargeError) { n.failed++; log(`${tag}: ${step.why}; ${what} not sent, ${built.message}`); break; }
      const before = await rpc.getBalance(payer.id);
      const sim = await simulate(built.tx.wire, before);
      const form = `${built.fit.form === "legacy" ? "legacy" : "v0"} transaction, ${built.fit.size} bytes`;
      if (sim.err) {
        // somebody else may have just done this step: look again, once
        const [again] = await read([{ ...l, graduated: (await reader.agentLaunch(l.mint))?.graduated ?? l.graduated }]);
        if (pass === 0 && again && !("refused" in again) && again.state !== g.state) { log(`${tag}: ${what} no longer applies (now ${again.state.replace("_", " ")}): somebody else sent a step first`); g = again; continue; }
        n.failed++;
        log(`${tag}: ${step.why}; ${what} not sent, simulation failed: ${JSON.stringify(sim.err).slice(0, 160)} ${sim.logs.filter((x) => /Error|error|failed/.test(x)).slice(-2).join(" | ").slice(0, 260)}`);
        break;
      }
      const cost = sim.cost === null ? "the cost could not be read from the simulation" : `would cost the payer ${sol(sim.cost)} SOL`;
      if (step.kind === "migrate" && (sim.cost === null || sim.cost > maxMigrate)) {
        n.waiting++;
        log(`${tag}: ${step.why}; migrate_v2 not sent, ${cost}, more than --max-migrate-sol ${sol(maxMigrate)} allows: waiting for pump.fun's migration`);
        break;
      }
      log(`${tag}: ${step.why}; ${what}: simulation ok, ${cost} (${form}${sim.units !== null ? `, ${sim.units} compute units` : ""}; payer holds ${sol(before)} SOL)`);
      if (!SEND) { log(`${tag}: would send ${what}`); break; }
      try {
        const r = await sendFitted(rpc, payer, ixs, { ...built.options, computeUnits: options.computeUnits, log: (m: string) => log(`  ${m}`) });
        const spent = before - (await rpc.getBalance(payer.id));
        paid += spent;
        if (step.kind === "migrate") n.migrated++;
        n.recorded++;
        log(`${tag}: sent ${what} ${r.signature} (${r.form}, ${r.size} bytes${r.fee !== undefined ? `, fee ${r.fee} lamports` : ""}); the payer paid ${sol(spent)} SOL`);
        break;
      } catch (e) {
        if (!(e instanceof TxError)) throw e;
        const [again] = await read([{ ...l, graduated: (await reader.agentLaunch(l.mint))?.graduated ?? l.graduated }]);
        if (pass === 0 && again && !("refused" in again) && again.state !== g.state) { log(`${tag}: ${what} did not land (${e.message.slice(0, 120)}); the coin is now ${again.state.replace("_", " ")}: somebody else sent a step first`); g = again; continue; }
        throw e;
      }
    }
  } catch (e) {
    n.failed++;
    log(`${tag}: ${(e as Error).message.slice(0, 260)}`);
  }
}
log(`done: ${n.curve} on their curves, ${n.waiting} waiting for a migration, ${n.migrated} migrated and ${n.recorded} recorded by this run${n.failed ? `, ${n.failed} not done (see above)` : ""}; the payer paid ${sol(paid)} SOL`);
process.exit(n.failed ? 1 : 0);

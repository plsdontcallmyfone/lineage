#!/usr/bin/env bun
// Rehearsal of Core's deployment switch (packages/core/src/deployments.ts) on a COPY of a Core database.
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/golive-core-carry.ts --data <core data dir> --chain <chain config>
//     [--config config/network.json] [--out <file>]
//
// The environment is the one the restarted Core will have: the network profile must already name the
// new programs (UNITS_MAINNET_DEPLOYMENT=official while config/profile.json still says "test", and no
// UNITS_PROFILE_LOCAL of the earlier deployment), and UNITS_MAINNET_RPC is the keyed endpoint.
//
// Run it on the machine that holds the database, after the new registry is initialized and the
// verifiers are registered and bonded on it, and before Core is restarted with the new chain config.
// It copies core.db (VACUUM INTO, a consistent snapshot; the live database is opened read-only and is
// not changed), starts a Core on the copy the way main.ts does (parameters from chain, then one bridge
// sync) and prints what the real restart will do: which registry is retired and through which epoch,
// which agents are retired and hidden, what is kept (units, calibrations, qualifications), each
// verifier's bond as read from the new registry and who is eligible per unit, what is left in the
// sending queues, and how long the chain reads took.
//
// Read-only on chain: the bridge is built without a signing key, so it cannot send. The Core authority
// key file named in the chain config is opened only to compare its public key with the registry's.
// Nothing is printed that is a secret (the RPC URL is redacted). Exit 0: ready; 1: something to fix; 2: usage.
import "../../packages/protocol/src/env-alias.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChainReader, httpTransport, loadKeypair, Rpc } from "@units/chain";
import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { ChainBridge, chainBootstrap, expandHome, loadChainSettings } from "../../packages/core/src/chain.ts";
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { deploymentsOf } from "../../packages/core/src/deployments.ts";
import { hiddenOf } from "../../packages/core/src/hidden.ts";
import { generateAgentKey } from "../../packages/core/src/protocol.ts";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const dataDir = arg("data");
const chainFile = arg("chain");
if (!dataDir || !chainFile) {
  console.error("usage: golive-core-carry.ts --data <core data dir> --chain <chain config> [--config config/network.json] [--out <file>]");
  process.exit(2);
}
const src = join(resolve(dataDir), "core.db");
if (!existsSync(src)) {
  console.error(`${src}: no Core database there`);
  process.exit(2);
}

const profile = applyNetworkProfile();
const settings = loadChainSettings(chainFile);
if (!settings) {
  console.error(`${chainFile}: no chain settings (mode devnet or mainnet)`);
  process.exit(2);
}
if (settings.mode !== profile.network) {
  console.error(`chain.mode ${settings.mode} differs from the network profile ${profile.network}`);
  process.exit(2);
}
const url = profile.network === "mainnet" ? rpcUrlFor(profile) : settings.rpc_url;

// the copy
const work = mkdtempSync(join(tmpdir(), "units-core-carry-"));
const copy = join(work, "core.db");
const t0 = Date.now();
{
  const ro = new Database(src, { readonly: true });
  ro.query("VACUUM INTO ?").run(copy);
  ro.close();
}
const copyMs = Date.now() - t0;

const calls: Record<string, { n: number; ms: number }> = {};
let retries = 0;
const inner = httpTransport(url, { onRetry: () => void retries++ });
const rpc = new Rpc(async (method, params) => {
  const t = Date.now();
  try {
    return await inner(method, params);
  } finally {
    const c = (calls[method] ??= { n: 0, ms: 0 });
    c.n++;
    c.ms += Date.now() - t;
  }
}, "confirmed");

const problems: string[] = [];
const notes: string[] = [];
let report: Record<string, unknown> = {};
let core: Core | null = null;
try {
  const before = new Database(copy, { readonly: true });
  const count = (db: Database, sql: string) => (db.query(sql).get() as { c: number }).c;
  const has = (db: Database, t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const snap = (db: Database) => ({
    units_active: count(db, "SELECT COUNT(*) AS c FROM lineages WHERE status = 'active'"),
    calibrations: count(db, "SELECT COUNT(*) AS c FROM calibrations"),
    qualifications_passed: count(db, "SELECT COUNT(*) AS c FROM qualifications WHERE status = 'passed'"),
    agents: count(db, "SELECT COUNT(*) AS c FROM agents"),
    generations: count(db, "SELECT COUNT(*) AS c FROM generations WHERE entry_type = 'patch'"),
  });
  const was = snap(before);
  const deploymentsBefore = has(before, "chain_deployments") ? (before.query("SELECT registry_program, label, retired_at FROM chain_deployments ORDER BY first_seen_at").all() as { registry_program: string; label: string | null; retired_at: number | null }[]) : [];
  const inFlight = {
    candidates: count(before, "SELECT COUNT(*) AS c FROM candidates WHERE status NOT IN ('accepted','rejected','expired')"),
    replays: count(before, "SELECT COUNT(*) AS c FROM replays WHERE status IN ('assigned','committed')"),
    qualifications: count(before, "SELECT COUNT(*) AS c FROM qualifications WHERE status IN ('assigned','committed')"),
    unsent_slashes: count(before, "SELECT COUNT(*) AS c FROM slashes s LEFT JOIN chain_slashes c ON c.slash_id = s.id WHERE c.signature IS NULL"),
    open_bounties: has(before, "bounties") ? count(before, "SELECT COUNT(*) AS c FROM bounties WHERE status = 'open'") : 0,
    open_chain_challenges: has(before, "challenges") ? count(before, "SELECT COUNT(*) AS c FROM challenges WHERE source = 'chain' AND resolve_sig IS NULL") : 0,
  };
  const openEpoch = (before.query("SELECT n FROM epochs WHERE status = 'open' ORDER BY n DESC LIMIT 1").get() as { n: number } | null)?.n ?? null;
  before.close();

  const current = deploymentsBefore.filter((d) => d.retired_at === null).map((d) => d.registry_program);
  if (!current.length) problems.push("the database records no current registry (chain_deployments is empty): Core would not see a switch; start the present Core once in chain mode first");
  if (current.includes(settings.registry_program)) notes.push(`the database already reads ${settings.registry_program}: nothing is retired by this start`);
  if (inFlight.candidates || inFlight.replays) notes.push(`${inFlight.candidates} candidate(s) and ${inFlight.replays} replay(s) are in flight: they continue after the switch (a retired author earns nothing; verifiers are paid for replays they finish afterwards)`);
  if (inFlight.open_bounties || inFlight.open_chain_challenges) notes.push(`${inFlight.open_bounties} open bounty row(s) and ${inFlight.open_chain_challenges} unresolved chain challenge(s) of the earlier registry stay in the database as they are`);

  const reader = new ChainReader(rpc, settings.registry_program, settings.launch_program);
  const tBoot = Date.now();
  const boot = await chainBootstrap(loadNetworkConfig(arg("config", "config/network.json")!), reader);
  const bootMs = Date.now() - tBoot;
  core = new Core({ dataDir: work, network: boot.network, adminId: generateAgentKey().id, clock: systemClock, trees: null, chainMode: true, firstEpoch: boot.firstEpoch });
  const logs: string[] = [];
  const bridge = new ChainBridge(core, settings, { reader, coreKey: null, log: (m) => logs.push(m) });
  const tTick = Date.now();
  let tickError: string | null = null;
  await bridge.tick().catch((e: Error) => (tickError = e.message));
  const tickMs = Date.now() - tTick;
  if (tickError) problems.push(`the chain sync failed: ${tickError}`);

  const db = core.db;
  const now = snap(db);
  for (const k of ["units_active", "calibrations", "qualifications_passed"] as const) if (now[k] !== was[k]) problems.push(`${k} changed across the switch: ${was[k]} before, ${now[k]} after`);
  const d = deploymentsOf(core);
  const retired = db.query("SELECT agent_id, mint, registry_program, label FROM retired_agents ORDER BY agent_id").all() as { agent_id: string; mint: string | null }[];
  for (const r of retired) if ((core.agentView(r.agent_id) as { awake: boolean | null }).awake) problems.push(`retired agent ${r.agent_id} is awake`);
  const hidden = new Set(hiddenOf(core).agents().keys());
  for (const r of retired) if (!hidden.has(r.agent_id)) problems.push(`retired agent ${r.agent_id} is not hidden from the listings`);
  if (core.chainPendingSlashes().length) problems.push(`${core.chainPendingSlashes().length} slash(es) would be sent to this registry`);
  if (core.chainPendingEpochs().length) problems.push(`epoch(s) ${core.chainPendingEpochs().map((e) => e.n).join(", ")} would be posted to this registry`);

  const verifiers = (db.query("SELECT agent_id, reference FROM agents WHERE kind = 'verifier' AND shadow = 0 ORDER BY agent_id").all() as { agent_id: string; reference: number }[]).map((v) => {
    const view = core!.agentView(v.agent_id, { admin: true }) as { bond: string; suspended_through_epoch?: number };
    return { agent: v.agent_id, reference: !!v.reference, bond: view.bond, bonded: BigInt(view.bond) >= core!.cfg.min_bond, suspended_through_epoch: view.suspended_through_epoch ?? null };
  });
  const internals = core as unknown as { eligiblePool(a: Set<string>, o: Set<string>, l: unknown): { agent: string }[]; lineageRow(id: string): unknown };
  const units = (db.query("SELECT lineage_id FROM lineages WHERE status = 'active' ORDER BY created_at, lineage_id").all() as { lineage_id: string }[]).map((l) => {
    const eligible = internals.eligiblePool(new Set(), new Set(), internals.lineageRow(l.lineage_id)).map((x) => x.agent);
    return { lineage_id: l.lineage_id, eligible_verifiers: eligible.length, references: verifiers.filter((v) => v.reference).length };
  });
  for (const u of units) if (u.eligible_verifiers < core.cfg.quorum) problems.push(`unit ${u.lineage_id}: ${u.eligible_verifiers} eligible verifier(s), quorum is ${core.cfg.quorum} (are the verifiers registered and bonded on this registry?)`);

  const view = bridge.view() as { core_authority?: string; epochs_posted?: string; line_mint?: string; agents?: unknown };
  let coreKey: string | null = null;
  if (settings.core_authority_key) {
    try {
      coreKey = loadKeypair(expandHome(settings.core_authority_key)).id;
    } catch (e) {
      notes.push(`the Core authority key file could not be read here: ${(e as Error).message}`);
    }
    if (coreKey && view.core_authority && coreKey !== view.core_authority) problems.push(`the configured Core authority ${coreKey} is not the registry's ${view.core_authority}: Core could not post epochs`);
  } else notes.push("the chain config names no core_authority_key: this Core would only read");

  report = {
    ok: problems.length === 0,
    rpc: redactRpc(url),
    registry_program: settings.registry_program,
    launch_program: settings.launch_program,
    quote_mint: boot.registry.mint,
    quote_decimals: boot.decimals,
    registry: { core_authority: view.core_authority ?? null, core_authority_matches_config: coreKey ? coreKey === view.core_authority : null, epochs_posted: view.epochs_posted ?? null, agents: view.agents ?? null },
    deployments: d.list().deployments.map((x) => ({ registry_program: x.registry_program, label: x.label, retired: x.retired_at !== null, through_epoch: x.through_epoch, unposted_epochs: x.unposted_epochs })),
    epoch: { open_before: openEpoch, open_after: core.currentEpoch().n, first_post_will_be: core.currentEpoch().n },
    kept: { before: was, after: now },
    retired_agents: retired,
    hidden: hiddenOf(core).list().hidden.map((h) => ({ mint: h.mint, reason: h.reason, added_by: h.added_by })),
    verifiers,
    units,
    quorum: core.cfg.quorum,
    min_bond: core.cfg.min_bond.toString(),
    in_flight_before: inFlight,
    queues_after: { slashes: core.chainPendingSlashes().length, epochs: core.chainPendingEpochs().map((e) => e.n) },
    timing_ms: { copy: copyMs, bootstrap: bootMs, first_sync: tickMs, rpc_retries: retries, rpc_calls: calls },
    bridge_log: logs.map((l) => l.slice(0, 300)),
    notes,
    problems,
  };
} catch (e) {
  problems.push((e as Error).message);
  report = { ok: false, rpc: redactRpc(url), registry_program: settings.registry_program, notes, problems, timing_ms: { copy: copyMs, rpc_calls: calls } };
} finally {
  core?.close();
  rmSync(work, { recursive: true, force: true });
}

const text = JSON.stringify(report, null, 1);
const out = arg("out");
if (out) writeFileSync(out, text + "\n");
console.log(text);
process.exit(problems.length ? 1 : 0);

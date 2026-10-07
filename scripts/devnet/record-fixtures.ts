#!/usr/bin/env bun
// Records the devnet RPC responses one Core chain-mode sync reads (bootstrap plus one bridge tick,
// read-only: no Core authority key) into packages/core/test/fixtures/devnet-rpc.json, so the Core
// chain-mode tests replay real chain state with no live RPC.
// Usage: bun scripts/devnet/record-fixtures.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainReader, RecordingTransport, Rpc, httpTransport } from "@lineage/chain";
import { generateAgentKey } from "@lineage/protocol";
import { ChainBridge, chainBootstrap } from "../../packages/core/src/chain.ts";
import { FakeClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { loadState, log, ROOT, RPC_URL } from "./lib.ts";

const state = loadState();
const rec = new RecordingTransport(httpTransport(RPC_URL));
const reader = new ChainReader(new Rpc(rec.transport), state.registry_program, state.launch_program);
const boot = await chainBootstrap(loadNetworkConfig(join(ROOT, "config/network.json")), reader);
const dir = mkdtempSync(join(tmpdir(), "lineage-rec-"));
const core = new Core({ dataDir: dir, network: boot.network, adminId: generateAgentKey().id, clock: new FakeClock(1_900_000_000_000), chainMode: true, firstEpoch: boot.firstEpoch });
const settings = { mode: "devnet" as const, rpc_url: RPC_URL, registry_program: state.registry_program, launch_program: state.launch_program };
const bridge = new ChainBridge(core, settings, { reader, coreKey: null });
const snap = (await bridge.tick()) as Record<string, unknown>;
core.close();
rmSync(dir, { recursive: true, force: true });
const out = join(ROOT, "packages/core/test/fixtures/devnet-rpc.json");
writeFileSync(
  out,
  JSON.stringify(
    {
      _note: `Recorded from ${RPC_URL} on ${new Date().toISOString()} by scripts/devnet/record-fixtures.ts: the reads of chainBootstrap and one ChainBridge tick. Replayed by packages/core/test/chain.test.ts.`,
      state: { line_mint: state.line_mint, agents: state.agents, first_epoch: boot.firstEpoch, slot: snap.slot },
      responses: rec.toJSON(),
    },
    null,
    1,
  ) + "\n",
);
log(`recorded ${rec.entries.size} responses to ${out} (slot ${snap.slot}, first epoch ${boot.firstEpoch})`);
log(`balances read: ${JSON.stringify(snap.balances)}`);

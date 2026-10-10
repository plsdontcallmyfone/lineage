// Audit A1-08 on devnet: after the registry upgrade that adds the per agent, per epoch slash cap,
// grows the devnet Config by its two bytes (`migrate_config_slash_cap`, admin = the devnet deployer)
// and checks the result. Run once, right after the upgrade (every registry instruction fails on the
// previous Config layout until it runs):
//   bun onchain/scripts/slash-cap-devnet.ts [cap_bps]      (default: strike_limit x the largest share)
// Read-only when the Config already has the cap.
import { registry } from "../../packages/chain/src/index.ts";
import { deployer, log, reader, send, sol } from "../../scripts/devnet/lib.ts";

const before = await reader.registryConfig();
if (!before) throw new Error("registry not initialized");
const p = before.params;
const share = Math.max(p.canarySlashBps, p.minoritySlashBps, p.revealSlashBps);
const cap = process.argv[2] ? Number(process.argv[2]) : Math.min(10_000, share * Math.max(1, p.strikeLimit));
const dep = deployer();
if (dep.id !== before.admin) throw new Error(`the deployer ${dep.id} is not the registry admin ${before.admin}`);
const bal0 = await reader.rpc.call<{ value: number }>("getBalance", [dep.id]);
if (before.maxSlashBpsPerEpoch === null) {
  log(`migrate_config_slash_cap ${cap} bps (largest share ${share}, strike_limit ${p.strikeLimit})`);
  await send("A1-08", `lineage_registry::migrate_config_slash_cap (Config +2 bytes, max_slash_bps_per_epoch ${cap})`, dep, [
    registry.migrateConfigSlashCap({ admin: dep.id, maxSlashBpsPerEpoch: cap }),
  ]);
} else log(`Config already has the cap: ${before.maxSlashBpsPerEpoch} bps`);
const after = (await reader.registryConfig())!;
const bal1 = await reader.rpc.call<{ value: number }>("getBalance", [dep.id]);
const ok = after.maxSlashBpsPerEpoch !== null && after.maxSlashBpsPerEpoch >= share && after.epochsPosted >= before.epochsPosted &&
  after.admin === before.admin && after.coreAuthority === before.coreAuthority && String(after.maxRebatePerEpoch) === String(before.maxRebatePerEpoch);
console.log(JSON.stringify({ max_slash_bps_per_epoch: after.maxSlashBpsPerEpoch, largest_share_bps: share, strike_limit: p.strikeLimit,
  epochs_posted: String(after.epochsPosted), last_epoch: String(after.lastEpoch), deployer_sol_spent: sol(BigInt(bal0.value - bal1.value)), ok }));
if (!ok) process.exit(1);

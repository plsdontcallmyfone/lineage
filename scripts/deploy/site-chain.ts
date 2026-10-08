#!/usr/bin/env bun
// Lineage site: registers the site's verifiers on devnet (lineage_registry register + bond), owned
// by the site's own owner key, with the capabilities digest of this machine (caps.json). Runs on the
// server as the `lineage` user. Idempotent: an agent already registered is not registered again,
// a bond already at min_bond is not topped up, and a changed caps.json sends update_agent.
//
//   bun scripts/deploy/site-chain.ts --caps /var/lib/lineage/site/caps.json [--plan] [--log <jsonl>]
//
// --plan reads the chain and prints what it would send, sending nothing (the dry run uses it).
// Keys: ~/.config/lineage/site/{owner,verifier-ref,verifier-v1,verifier-v2}.json (made by
// site-keys.ts). The owner must hold SOL for fees and tLINE for 3 burns and 2 bonds; fund-site.ts,
// run on the owner's machine, sends both. Only public keys and signatures are printed.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, H } from "@lineage/protocol";
import { ata, ChainReader, loadKeypair, registry, Rpc, sendAndConfirm, TOKEN_2022_PROGRAM, type Ix, type Signer } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PLAN = argv.includes("--plan");
const LOG = opt("log") ?? "/var/lib/lineage/site/tx-log.jsonl";
const SITE = join(homedir(), ".config", "lineage", "site");
const devnet = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const caps = JSON.parse(readFileSync(opt("caps") ?? "/var/lib/lineage/site/caps.json", "utf8"));
const capsDigest = H("caps", canonicalJson(caps));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const mint = devnet.line_mint as string;
const log = (m: string) => console.log(`[site-chain] ${m}`);

const owner = loadKeypair(join(SITE, "owner.json"));
const verifiers: { name: string; key: Signer; bond: boolean }[] = [
  { name: "ref", key: loadKeypair(join(SITE, "verifier-ref.json")), bond: false },
  { name: "v1", key: loadKeypair(join(SITE, "verifier-v1.json")), bond: true },
  { name: "v2", key: loadKeypair(join(SITE, "verifier-v2.json")), bond: true },
];

async function send(what: string, ixs: Ix[], signers: Signer[] = []) {
  if (PLAN) {
    log(`plan: ${what}`);
    return;
  }
  const r = await sendAndConfirm(rpc, owner, ixs, { signers, log: (m) => log(`  ${m}`) });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), step: "site-chain", what, fee: r.fee ?? null, signature: r.signature }) + "\n");
  log(`${what}: ${r.signature}`);
}

const cfg = await reader.registryConfig();
if (!cfg) throw new Error("registry config not found on devnet");
const { registerBurn, minBond } = cfg.params;
const ownerLine = ata(owner.id, mint, T22);
const recs = await Promise.all(verifiers.map((v) => reader.agent(v.key.id)));
let needLine = 0n;
for (const [i, v] of verifiers.entries()) {
  const rec = recs[i];
  if (!rec) needLine += registerBurn + (v.bond ? minBond : 0n);
  else if (v.bond && rec.bond < minBond) needLine += minBond - rec.bond;
}
const sol = await rpc.getBalance(owner.id);
const line = (await reader.tokenBalance(ownerLine)) ?? 0n;
log(`owner ${owner.id}: ${(Number(sol) / 1e9).toFixed(6)} SOL, ${line} tLINE base units; needs ${needLine} tLINE base units; caps digest ${capsDigest.slice(0, 16)}...`);
if (needLine > line || (needLine > 0n && sol < 20_000_000n)) {
  const msg = `owner ${owner.id} is not funded (needs ${needLine} tLINE base units and 0.02 SOL): run scripts/deploy/deploy.sh <host> fund on the owner's machine`;
  if (PLAN) log(`plan: ${msg}`);
  else throw new Error(msg);
}

for (const [i, v] of verifiers.entries()) {
  let rec = recs[i];
  if (!rec) {
    await send(`register verifier ${v.name} ${v.key.id} (caps digest ${capsDigest.slice(0, 12)}...)`, [
      registry.register({ owner: owner.id, agent: v.key.id, mint, ownerToken: ownerLine, operator: "00".repeat(32), capabilities: capsDigest, tokenProgram: T22 }),
    ], [v.key]);
    rec = PLAN ? null : await reader.agent(v.key.id);
  } else {
    if (rec.owner !== owner.id) throw new Error(`verifier ${v.name} ${v.key.id} is registered to another owner ${rec.owner}`);
    if (rec.capabilities !== capsDigest)
      await send(`update_agent ${v.name} ${v.key.id}: caps digest ${rec.capabilities.slice(0, 12)}... to ${capsDigest.slice(0, 12)}...`, [
        registry.updateAgent({ owner: owner.id, agent: v.key.id, operator: rec.operator, capabilities: capsDigest }),
      ]);
  }
  const bond = rec?.bond ?? 0n;
  if (v.bond && bond < minBond)
    await send(`bond ${minBond - bond} base units for ${v.name} ${v.key.id}`, [
      registry.bond({ owner: owner.id, agent: v.key.id, mint, ownerToken: ownerLine, amount: minBond - bond, tokenProgram: T22 }),
    ]);
  const now = PLAN ? rec : await reader.agent(v.key.id);
  log(`${v.name} ${v.key.id}: ${now ? `registered, bond ${now.bond}, caps ${now.capabilities === capsDigest ? "match" : "differ"}` : "not registered"}`);
}
log(PLAN ? "plan done (nothing sent)" : "done");

#!/usr/bin/env bun
// Registers and bonds verifiers whose keys live on capacity hosts (docs/DEPLOY-SITE.md "Adding
// capacity"). The owner's key is on one machine and each verifier's key on its host, so a register is
// built and signed by the owner here and co-signed on the host; a bond needs the owner only.
//
//   bun scripts/deploy/capacity-host/verifier-chain.ts --registry <program id> --agents <id,id,...>
//       --caps-digest <64 hex> [--owner <keypair.json>] [--mint <quote mint>] --plan
//         reads the chain and prints what each agent needs (burn, bond, SOL) and sends nothing
//   ... --register <agent id>     prints the owner-signed register transaction (base64) and the cosign
//                                 command for the host; it is valid for about a minute and is not sent here
//   ... --send <base64>           sends the register once the host co-signed it (cosign-register.ts there)
//   ... --bond <agent id>         sends the bond up to min_bond (owner only)
//
// --registry names the deployment on purpose: it must equal the registry program of the active network
// profile (UNITS_NETWORK, and for mainnet UNITS_MAINNET_DEPLOYMENT or UNITS_PROFILE_LOCAL), or nothing
// is read or built. The burn, the minimum bond and the quote mint are read from that registry's config
// on chain, never assumed. Only public keys and signatures are printed.
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, compileMessage, loadKeypair, registry, Rpc, sendAndConfirm, signBytes, TOKEN_2022_PROGRAM, type Signer } from "@units/chain";
import { base58Encode } from "@units/protocol";
import { REGISTRY_PROGRAM_ID } from "../../../packages/chain/src/programs.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../../packages/chain/src/profile-node.ts";
import { assertCluster, sendWire } from "../../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire } from "../../../packages/chain/src/browser/wire.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../../../packages/chain/src/tx.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PLAN = argv.includes("--plan");
const ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const log = (m: string) => console.log(`[verifier-chain] ${m}`);

const profile = applyNetworkProfile();
const want = opt("registry");
if (!want || !ID.test(want)) throw new Error("--registry <program id> is required: the registry of the deployment you mean");
if (want !== REGISTRY_PROGRAM_ID) throw new Error(`--registry ${want} is not the active profile's registry ${REGISTRY_PROGRAM_ID} (network ${profile.network}); select the deployment with UNITS_NETWORK and, for mainnet, UNITS_MAINNET_DEPLOYMENT or UNITS_PROFILE_LOCAL`);
const agents = (opt("agents") ?? opt("register") ?? opt("bond") ?? "").split(",").filter(Boolean);
const SEND = opt("send");
if (!SEND && (!agents.length || !agents.every((a) => ID.test(a)))) throw new Error("--agents <id,id,...> (or --register <id>, --bond <id>, --send <base64>) is required");
const caps = opt("caps-digest");
if ((PLAN || opt("register")) && !(caps && /^[0-9a-f]{64}$/.test(caps))) throw new Error("--caps-digest <64 hex> is required (the capabilities digest the host printed)");

const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
// --send <base64>: the register after the host's cosign-register.ts. Sent only when it is nothing but
// units_registry instructions of this registry (and compute budget) and every signature is present.
if (SEND) {
  if (!/^[A-Za-z0-9+/=]{100,4000}$/.test(SEND)) throw new Error("--send takes a base64 transaction");
  const wire = new Uint8Array(Buffer.from(SEND, "base64"));
  const parsed = parseWire(wire);
  const msg = decodeMessage(parsed.message);
  for (const ix of msg.instructions) if (ix.programId !== REGISTRY_PROGRAM_ID && ix.programId !== COMPUTE_BUDGET_PROGRAM) throw new Error(`refusing to send: an instruction of ${ix.programId}, not of the registry ${REGISTRY_PROGRAM_ID}`);
  if (parsed.signatures.some((sig) => sig.every((b) => b === 0))) throw new Error("refusing to send: a signature is missing (co-sign on the host first)");
  await assertCluster(rpc, profile.genesis);
  const sim = await rpc.simulate(wire);
  if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${(sim.logs ?? []).slice(-6).join("\n")}`);
  const { lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const r = await sendWire(rpc, wire, lastValidBlockHeight, (m) => log(`  ${m}`));
  if (r.err) throw new Error(`transaction ${r.signature} failed: ${JSON.stringify(r.err)}`);
  log(`sent: ${r.signature} (slot ${r.slot})`);
  process.exit(0);
}
const reader = new ChainReader(rpc);
const cfg = await reader.registryConfig();
if (!cfg) throw new Error(`no registry config at ${REGISTRY_PROGRAM_ID} on ${profile.network}`);
const { registerBurn, minBond } = cfg.params;
const mint = opt("mint") ?? (cfg as { mint?: string }).mint ?? profile.quote?.mint;
if (!mint || !ID.test(mint)) throw new Error("the quote mint is not in the registry config or the profile; pass --mint");
const ownerFile = opt("owner") ?? join(homedir(), ".config", "lineage", "site", "owner.json");
let owner: Signer | null = null;
try {
  owner = loadKeypair(ownerFile);
} catch {
  if (!PLAN) throw new Error(`owner key ${ownerFile} not readable`);
}
log(`${profile.network}, registry ${REGISTRY_PROGRAM_ID}, quote mint ${mint}: register burn ${registerBurn} base units, min bond ${minBond} base units`);

const recs = await Promise.all(agents.map((a) => reader.agent(a)));
let need = 0n;
let registers = 0;
for (const [i, a] of agents.entries()) {
  const rec = recs[i];
  const burn = rec ? 0n : registerBurn;
  const bond = rec ? (rec.bond < minBond ? minBond - rec.bond : 0n) : minBond;
  need += burn + bond;
  if (!rec) registers++;
  log(`${a}: ${rec ? `registered (owner ${rec.owner}, bond ${rec.bond}, capabilities ${caps ? (rec.capabilities === caps ? "match" : `differ: ${rec.capabilities.slice(0, 12)}...`) : "not compared"})` : "not registered"}; needs burn ${burn}, bond ${bond}`);
}
if (owner) {
  const sol = await rpc.getBalance(owner.id);
  const bal = (await reader.tokenBalance(ata(owner.id, mint, TOKEN_2022_PROGRAM))) ?? 0n;
  log(`owner ${owner.id}: ${(Number(sol) / 1e9).toFixed(6)} SOL, ${bal} quote base units; these agents need ${need} quote base units in all${need > bal ? " (NOT enough)" : ""}`);
} else log(`these agents need ${need} quote base units in all (owner key not on this machine: balances not read)`);
log(`SOL: each register creates the Agent account (rent 0.002697320 SOL, docs/MAINNET-COSTS.md) and pays a fee with two signatures; each bond pays a fee with one; ${registers} register(s) to do`);

if (PLAN) {
  log("plan done (nothing built, nothing sent)");
  process.exit(0);
}
if (!owner) throw new Error("no owner key");
const ownerToken = ata(owner.id, mint, TOKEN_2022_PROGRAM);

if (opt("register")) {
  const agent = opt("register")!;
  if (recs[0]) throw new Error(`${agent} is already registered`);
  const ix = registry.register({ owner: owner.id, agent, mint, ownerToken, operator: "00".repeat(32), capabilities: caps!, tokenProgram: TOKEN_2022_PROGRAM });
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessage(owner.id, [ix], blockhash);
  if (msg.numSigners !== 2 || msg.keys[0] !== owner.id || !msg.keys.slice(0, 2).includes(agent)) throw new Error("unexpected signer layout");
  // the owner's signature in its slot, the verifier's left empty for `units-worker cosign` on the host
  const wire = new Uint8Array(1 + 64 * msg.numSigners + msg.bytes.length);
  wire[0] = msg.numSigners;
  wire.set(signBytes(owner, msg.bytes), 1);
  wire.set(msg.bytes, 1 + 64 * msg.numSigners);
  log(`register for ${agent}: built and signed by the owner ${owner.id} (${base58Encode(wire.slice(1, 65)).slice(0, 16)}...), NOT sent. It expires with its blockhash in about a minute. On the host, as units-cap:`);
  console.log(`bun packages/worker/src/main.ts cosign --key <the verifier's key file> --tx ${Buffer.from(wire).toString("base64")} --dry-run`);
  log("then the same without --dry-run; then --bond for the same agent here");
} else if (opt("bond")) {
  const agent = opt("bond")!;
  const rec = recs[0];
  if (!rec) throw new Error(`${agent} is not registered yet`);
  if (rec.owner !== owner.id) throw new Error(`${agent} is registered to another owner ${rec.owner}`);
  if (rec.bond >= minBond) log(`${agent} already holds ${rec.bond}: nothing to bond`);
  else {
    const r = await sendAndConfirm(rpc, owner, [registry.bond({ owner: owner.id, agent, mint, ownerToken, amount: minBond - rec.bond, tokenProgram: TOKEN_2022_PROGRAM })], { log: (m) => log(`  ${m}`) });
    log(`bond ${minBond - rec.bond} base units for ${agent}: ${r.signature}`);
  }
} else throw new Error("one of --plan, --register <id>, --bond <id>");

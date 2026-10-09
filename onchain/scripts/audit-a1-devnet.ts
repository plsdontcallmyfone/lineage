#!/usr/bin/env bun
// Internal audit A1 (docs/AUDIT.md, "Onchain"): proves the upgraded lineage_launch fixes on devnet with
// TEST tokens. It never uses the Core authority or the runtime authority and never posts epochs.
//   A1-03  a self-hosted agent's compute vault follows the registry owner: after propose_owner and
//          accept_owner the old launcher can no longer withdraw_compute, open or cancel a bounty
//          (refused in simulation, nothing paid); the new owner can.
//   A1-01  a donation into a bounty escrow vault no longer freezes it: open, donate one base unit and
//          cancel land in one transaction (atomic, so the site's epoch posts cannot race the cancel),
//          and escrow plus donation go back to the payer's compute vault.
// The registry fixes (A1-02, A1-05) need the Core authority to resolve challenges and are proven by
// LiteSVM against the same binary (hash checked in onchain/DEVNET.md).
// Keys: the deployer (~/.config/lineage/devnet-deployer.json) passed explicitly; fresh agent, mint and
// buyer keys are saved under ~/.config/lineage/devnet/a1-<stamp>-*.json (mode 600).
// Usage: bun onchain/scripts/audit-a1-devnet.ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata,
  bounty,
  bountyPdas,
  decodeAgentLaunch,
  decodeBounty,
  IDENTITY_MODE,
  launch,
  launchPdas,
  registry,
  sendAndConfirm,
  system,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  type Ix,
  type SendOptions,
  type Signer,
} from "@lineage/chain";
import { deployer, key, LAMPORTS, loadState, log, reader, ROOT, rpc, sol } from "../../scripts/devnet/lib.ts";

const T22 = TOKEN_2022_PROGRAM;
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const STEP = "A1";
const state = loadState();
const lineMint = state.line_mint!;
const dbcConfig = state.dbc_config!;
const DEC = state.line_decimals ?? 6;
const ONE = 10n ** BigInt(DEC);
const dep = deployer();

const rows: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
async function send(what: string, payer: Signer, ixs: Ix[], o: SendOptions = {}) {
  try {
    const r = await sendAndConfirm(rpc, payer, ixs, { log: (m) => log(`  ${m}`), ...o });
    const when = new Date().toISOString().replace("T", " ").slice(0, 19);
    rows.push(`| ${when} | ${STEP} | ${what.replace(/\|/g, "/")} | ${r.fee ?? "?"} | \`${r.signature}\` |`);
    log(`${what}: ${r.signature}`);
    return r;
  } catch (e) {
    if (e instanceof TxError) for (const l of e.logs.slice(-20)) console.error(`    ${l}`);
    throw e;
  }
}
/** Must be refused in simulation with `code` (nothing is sent, nothing paid). */
async function refused(what: string, payer: Signer, ixs: Ix[], code: string, o: SendOptions = {}) {
  try {
    await sendAndConfirm(rpc, payer, ixs, { attempts: 1, ...o });
    check(what, false, "landed");
  } catch (e) {
    const logs = e instanceof TxError ? e.logs.join("\n") : String(e);
    check(what, logs.includes(code), logs.includes(code) ? `refused in simulation (${code})` : `other error: ${String(e).slice(0, 200)}`);
  }
}
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`[devnet] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
const bal = async (a: string) => (await reader.tokenBalance(a)) ?? 0n;

async function main() {
  const sol0 = await rpc.getBalance(dep.id);
  const lc = (await reader.launchConfig())!;
  const bc = (await reader.bountyConfig())!;
  check("launch and bounty configs live and unpaused", !!lc && !lc.paused && !!bc && !bc.paused && bc.maxBountyOutBps > 0,
    `bounty min ${bc?.minAmount}, out cap ${bc?.maxBountyOutBps} bps, ttl ${bc?.minTtlS}..${bc?.maxTtlS} s`);
  check("deployer holds enough SOL", sol0 > LAMPORTS / 2n, `${sol(sol0)} SOL`);

  // ---------- a self-hosted TEST agent launched by the deployer ----------
  const agent = key(`a1-${STAMP}-agent`);
  const mintKey = key(`a1-${STAMP}-mint`);
  const buyer = key(`a1-${STAMP}-buyer`);
  const mint = mintKey.id;
  await send(`launch_agent: TEST audit agent ${agent.id} (self-hosted), mint ${mint}, launcher = deployer`, dep, [
    launch.launchAgent({ launcher: dep.id, agent: agent.id, agentMint: mint, lineMint, dbcConfig, lineTokenProgram: T22,
      args: { name: "TEST audit agent", symbol: "TAUDIT", uri: "https://lineage.invalid/devnet/agents/audit-a1.json", repoUrl: "https://github.com/karpathy/minbpe",
        identityMode: IDENTITY_MODE.app, hosted: false } }),
  ], { signers: [agent, mintKey], computeUnits: 400_000 });
  const vault = launchPdas.computeVault(agent.id);
  const depLine = ata(dep.id, lineMint, T22);
  const buyerLine = ata(buyer.id, lineMint, T22);
  const fund = 100n * ONE;
  await send(`fund the agent's compute vault with ${fund / ONE} tLINE; buyer ${buyer.id}: 0.02 SOL and a tLINE account`, dep, [
    token.transferChecked(depLine, lineMint, vault, dep.id, fund, DEC, T22),
    system.transfer(dep.id, buyer.id, 20_000_000n),
    token.createAtaIdempotent(dep.id, buyer.id, lineMint, T22),
  ]);
  const w = (signer: string, to: string, amount: bigint) =>
    launch.withdrawCompute({ launcher: signer, agent: agent.id, agentMint: mint, launcherToken: to, lineMint, amount, lineTokenProgram: T22 });
  await send("withdraw_compute 1 tLINE by the launcher (still the owner)", dep, [w(dep.id, depLine, ONE)]);

  // ---------- A1-03: the sale ----------
  await send(`propose_owner: deployer proposes ${buyer.id}`, dep, [registry.proposeOwner({ owner: dep.id, agent: agent.id, newOwner: buyer.id })]);
  await send("accept_owner by the buyer", buyer, [registry.acceptOwner({ newOwner: buyer.id, agent: agent.id })]);
  const rec = (await reader.agent(agent.id))!;
  check("registry owner is the buyer; AgentLaunch.launcher is still the deployer", rec.owner === buyer.id &&
    decodeAgentLaunch((await rpc.getAccountInfo(launchPdas.agentLaunch(mint)))!.data).launcher === dep.id);
  await refused("A1-03 old launcher withdraw_compute after the sale", dep, [w(dep.id, depLine, ONE)], "Unauthorized");
  const b0 = await bal(buyerLine);
  await send("withdraw_compute 2 tLINE by the new owner", buyer, [w(buyer.id, buyerLine, 2n * ONE)]);
  check("A1-03 the new owner withdraws", (await bal(buyerLine)) - b0 === 2n * ONE);

  // ---------- bounties: opener is the registry owner; A1-01 donation ----------
  const now = BigInt(Math.floor(Date.now() / 1000));
  const vaultBal = await bal(vault);
  const amount = bc.minAmount > ONE ? bc.minAmount : ONE;
  check("bounty amount fits the per-window cap", amount * 10_000n <= vaultBal * BigInt(bc.maxBountyOutBps), `${amount} of ${vaultBal}`);
  const id = BigInt(STAMP);
  const args = { bountyId: id, payee: null, amount, termsDigest: "a1".repeat(32), conditionKind: 1, lineageId: "a1".repeat(32), conditionValue: null,
    deadline: now + BigInt(bc.minTtlS) + 600n };
  const open = (opener: string) => bounty.open({ opener, payer: agent.id, payerMint: mint, lineMint, lineTokenProgram: T22, args });
  const cancel = (signer: string, opener: string) => bounty.cancel({ signer, payer: agent.id, payerMint: mint, bountyId: id, opener, lineMint, lineTokenProgram: T22 });
  await refused("A1-03 old launcher open_bounty from the sold agent's vault", dep, [open(dep.id)], "Unauthorized");
  await refused("A1-03 old launcher cancel_bounty of the new owner's bounty", buyer, [open(buyer.id), cancel(dep.id, buyer.id)], "Unauthorized",
    { signers: [dep] });
  const bPda = bountyPdas.bounty(agent.id, id);
  const escrow = bountyPdas.vault(bPda);
  const v0 = await bal(vault);
  await send(`A1-01 open_bounty ${id} (${amount} base units) by the new owner, donate 1 base unit into its escrow vault, cancel_bounty: one transaction`,
    buyer, [open(buyer.id), token.transferChecked(buyerLine, lineMint, escrow, buyer.id, 1n, DEC, T22), cancel(buyer.id, buyer.id)]);
  const b = decodeBounty((await rpc.getAccountInfo(bPda))!.data);
  check("A1-01 cancel landed despite the donation: escrow vault closed, escrow and donation back in the compute vault",
    b.status === "cancelled" && !(await rpc.getAccountInfo(escrow)) && (await bal(vault)) === v0 + 1n, `vault ${v0} -> ${await bal(vault)}`);

  const sol1 = await rpc.getBalance(dep.id);
  return { sol0, sol1 };
}

let outcome = "FAIL";
let spent = "";
try {
  const { sol0, sol1 } = await main();
  outcome = "PASS";
  spent = `deployer ${sol(sol0)} -> ${sol(sol1)} SOL (${sol(sol0 - sol1)} spent, including 0.02 SOL sent to the buyer key)`;
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  const passed = results.filter((r) => r.ok).length;
  const text = ["", `### Audit A1 devnet proof run ${STAMP} (onchain/scripts/audit-a1-devnet.ts)`, "",
    `Outcome: ${outcome}; checks ${passed}/${results.length}${spent ? `; ${spent}` : ""}.`, "",
    ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`), "",
    "| When (UTC) | Step | What | Fee | Signature |", "|---|---|---|---|---|", ...rows, ""].join("\n");
  appendFileSync(join(ROOT, "onchain", "DEVNET.md"), text);
  console.log(`[devnet] audit A1 ${outcome} ${passed}/${results.length}`);
}

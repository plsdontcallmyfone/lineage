#!/usr/bin/env bun
// Onchain messages on devnet (SPEC 12.5, lineage_msg). Proves, against the deployed program:
//   1. MsgConfig is initialized with TEST caps by the upgrade authority (the Lineage deployer).
//   2. Two launched TEST agents on one repository (whose current registry signing keys are held in
//      ~/.config/lineage/devnet) publish their X25519 keys, post board notes (one inline,
//      one long body as a blob hash) and a sealed direct message, all through the code path the
//      hosted runtime uses (packages/core msgchain.ts ChainMessenger: Core preflight, blob upload,
//      instruction), with the runtime authority as fee payer and the agent's key as signer.
//   3. The program refuses a signer that is not the agent's current signing key (simulation; no fee).
//   4. A read-only Core in chain mode (no Core authority key: it sends nothing) indexes every event:
//      the board view shows both notes with their transaction, the recipient's inbox holds the
//      ciphertext and it opens with the recipient's key, the published key is the chain's; the
//      dashboard's API proxy serves the same board.
// Every signature is appended to onchain/DEVNET.md. Ports: Core 9662, dashboard 9663.
//
// Usage: bun scripts/devnet/msg-e2e.ts [--init-only]
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, H, signMessage } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { loadKeypair, msg, MSG_PROGRAM_ID, msgPdas, readMsgConfig, readMsgState, sendAndConfirm, TxError, type SendResult, type Signer } from "@lineage/chain";
import { CoreClient } from "../../packages/core/src/client.ts";
import { ChainMessenger, type ChainFee } from "../../packages/core/src/msgchain.ts";
import { deriveEncryptionKey, open } from "../../packages/core/src/seal.ts";
import { check, deployer, key, KEY_DIR, loadState, log, logTx, reader, ROOT, rpc, RPC_URL, send, sol } from "./lib.ts";

const CORE_PORT = 9662;
const WEB_PORT = 9663;
const STEP = "msg";
const TEST_CAPS = { windowS: 60, maxPerWindow: 20, maxPerDay: 500, maxInline: 568, maxBlob: 1 << 20 };
const procs: Subprocess[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
const pass = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  check(name, ok, detail);
};

async function waitFor(what: string, f: () => Promise<unknown>, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await f().catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
for (const port of [CORE_PORT, WEB_PORT]) {
  const busy = Bun.spawnSync(["lsof", "-ti", `:${port}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${port} is in use by pid ${busy}; it is not ours to take`);
}

async function main() {
  const state = loadState();
  const dep = deployer();
  const program = await rpc.getAccountInfo(MSG_PROGRAM_ID);
  pass("lineage_msg is deployed and executable", !!program?.executable, MSG_PROGRAM_ID);

  // 1. MsgConfig (TEST caps), once
  let cfg = await readMsgConfig(rpc);
  if (!cfg) {
    await send(STEP, "lineage_msg initialize (TEST caps: 20 per 60 s, 500 per day, 568-byte inline, 1 MiB blobs)", dep, [
      msg.initialize({ upgradeAuthority: dep.id, args: { admin: dep.id, paused: false, ...TEST_CAPS } }),
    ]);
    cfg = await readMsgConfig(rpc);
  }
  pass("MsgConfig holds the TEST caps", !!cfg && cfg.admin === dep.id && !cfg.paused && cfg.maxPerWindow === 20 && cfg.maxPerDay === 500 && cfg.maxInline === 568 && cfg.maxBlob === 1 << 20,
    JSON.stringify(cfg));
  if (process.argv.includes("--init-only")) return;

  // 2. agents and the fee payer: two launched TEST agents on the same repository (so the C2 first
  // contact rule admits the DM, 12.3) whose current registry signing keys are held in the devnet key dir
  const payer = key("runtime-authority");
  const held = new Map<string, Signer>();
  for (const f of readdirSync(KEY_DIR).filter((x) => x.endsWith(".json"))) {
    try {
      const k = loadKeypair(join(KEY_DIR, f));
      held.set(k.id, k);
    } catch {
      // not a keypair file
    }
  }
  const launches = await reader.launches();
  const usable: { agent: string; repo: string; key: Signer }[] = [];
  for (const l of launches) {
    const rec = await reader.agent(l.agent);
    const k = rec?.signingKey ? held.get(rec.signingKey) : undefined;
    if (rec && k) usable.push({ agent: l.agent, repo: l.repoUrl, key: k });
  }
  const byRepo = new Map<string, typeof usable>();
  for (const u of usable) byRepo.set(u.repo, [...(byRepo.get(u.repo) ?? []), u]);
  const pair = [...byRepo.values()].find((v) => v.length >= 2);
  if (!pair) throw new Error(`no two launched agents on one repository with held signing keys (${usable.map((u) => u.agent).join(", ")})`);
  const [pa, pb] = pair as [(typeof usable)[0], (typeof usable)[0]];
  const A = pa.key;
  const B = pb.key;
  const AID = pa.agent;
  const BID = pb.agent;
  pass("two launched TEST agents on one repository, current signing keys held", true, `${AID} (key ${A.id}) and ${BID} (key ${B.id}) on ${pa.repo}`);
  const ref = key("verifier-ref");
  const refRec = await reader.agent(ref.id);
  pass("the reference verifier's signing key is held (it signs the calibration)", refRec?.signingKey === ref.id, ref.id);
  const payerBefore = await rpc.getBalance(payer.id);
  log(`fee payer (runtime authority) ${payer.id} holds ${sol(payerBefore)} SOL`);

  // read-only Core in chain mode, with the minbpe lineage from its committed calibration
  const tmp = mkdtempSync(join(tmpdir(), "lineage-msg-e2e-"));
  const admin = generateAgentKey();
  const adminPath = join(tmp, "admin.json");
  writeFileSync(adminPath, JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  net.chain = { mode: "devnet", rpc_url: RPC_URL, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint, poll_ms: 600_000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const CORE = `http://127.0.0.1:${CORE_PORT}`;
  procs.push(spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(CORE_PORT), "--config", join(tmp, "network.json"), "--admin-key", adminPath, "--tick-ms", "1000"],
    { stdout: "ignore", stderr: "inherit" }));
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`)).ok);
  const Ac = new CoreClient(CORE, admin);
  const anon = new CoreClient(CORE, null);
  const sync = async () => {
    for (let i = 0; ; i++) {
      const r = await Ac.post("/v1/admin/chain/sync", {});
      if (r.status < 300) return r.body;
      if (i >= 8) throw new Error(`chain sync: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      await Bun.sleep(2000 * 2 ** Math.min(i, 4));
    }
  };
  await sync();
  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const deps = await prepareDeps(loaded);
  await Ac.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id });
  const snap = (await Ac.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest })).body;
  await Ac.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true });
  const calib = { ...JSON.parse(readFileSync(join(ROOT, "recipes/minbpe/calibration.json"), "utf8")), snapshot_id: snap.snapshot_id };
  const lin = await new CoreClient(CORE, ref).post("/v1/calibrations", { calibration: calib, sig: signMessage(ref, calibId(calib.recipe_id, calib.snapshot_id, calib)) });
  const L = lin.body.lineage_id as string;
  pass("Core created the minbpe lineage from the committed calibration", lin.status < 300 && /^[0-9a-f]{64}$/.test(L), L);

  // 3. post through the runtime's code path
  const fees: ChainFee[] = [];
  const messenger = (k: Signer, agent: string) => new ChainMessenger({ rpc, payer, key: k, agent, core: CORE, onFee: (f) => fees.push(f), log: (m) => log(`  ${agent.slice(0, 6)} ${m}`) });
  const ma = messenger(A, AID);
  const mb = messenger(B, BID);
  const ka = deriveEncryptionKey(A);
  const kb = deriveEncryptionKey(B);
  await mb.publishKey(kb);
  await ma.publishKey(ka);
  const stB = await readMsgState(rpc, BID);
  pass("B's X25519 key is published on chain (AgentMsgState)", stB?.encKey === kb.public, `${kb.public} seq ${stB?.encKeySeq}`);
  const note = `onchain board note from ${AID.slice(0, 6)} at ${new Date().toISOString()}: lineage_msg devnet proof`;
  const longNote = `long note (blob): ${"the board carries a sha256 and size on chain; the text lives in Core's content-addressed store. ".repeat(8)}`;
  const secret = `sealed for ${BID.slice(0, 6)} only: the runtime paid the fee, ${AID.slice(0, 6)} signed. ${Date.now()}`;
  const id1 = await ma.send(`board:${L}`, note);
  const id2 = await ma.send(`board:${L}`, longNote);
  const id3 = await ma.send(BID, secret, { encrypt: true });
  pass("three messages landed (short board note, long board note as blob, sealed DM)", !!id1 && !!id2 && !!id3, `${id1?.slice(0, 12)} ${id2?.slice(0, 12)} ${id3?.slice(0, 12)}`);
  for (const f of fees) logTx(STEP, `lineage_msg ${f.what} by ${f.agent} (fee payer ${payer.id} spent ${f.lamports} lamports)`, { signature: f.signature, slot: 0, fee: undefined, logs: [] } as SendResult);
  pass("the runtime authority paid every message (payer of each transaction)", fees.length === 5 && fees.every((f) => f.lamports > 0), fees.map((f) => `${f.what} ${f.lamports}`).join(", "));

  // wrong signer: the launcher (owner) of the agents is not their signing key (simulation refuses; nothing is paid)
  const owner = key("launcher");
  let refused = "";
  try {
    await sendAndConfirm(rpc, payer, [msg.postBoard({ payer: payer.id, signer: owner.id, agent: AID, args: { lineage: L, body: { inline: new TextEncoder().encode("impostor") } } })], { signers: [owner] });
  } catch (e) {
    refused = e instanceof TxError ? e.logs.find((l) => /NotSigningKey/.test(l)) ?? e.message : String(e);
  }
  pass("a key that is not the agent's signing key is refused by the program", /NotSigningKey/.test(refused), refused.slice(0, 120));

  // 4. read back through Core (chain mode) and the dashboard
  const s1 = await sync();
  log(`Core indexed: ${JSON.stringify(s1.messages)}`);
  const board = (await anon.get(`/v1/lineages/${L}/board`)).body;
  const short = board.messages.find((m: any) => m.msg_id === id1);
  const long = board.messages.find((m: any) => m.msg_id === id2);
  pass("Core's board view shows the short note, signed on chain by A", short?.from === AID && short?.envelope.body === note && !!short?.envelope.chain?.signature, short?.envelope.chain?.signature);
  pass("Core's board view shows the long note from its blob (hash and size on chain)", long?.envelope.body === longNote && long?.envelope.chain?.blob?.size === new TextEncoder().encode(longNote).length,
    JSON.stringify(long?.envelope.chain?.blob));
  const inbox = (await new CoreClient(CORE, { ...B, agent: BID }).get("/v1/messages", true)).body;
  const dm = inbox.received.find((m: any) => m.msg_id === id3);
  pass("B's inbox holds the DM as ciphertext and it opens with B's key", !!dm && dm.envelope.body === null && open(dm.envelope.ciphertext, kb) === secret, dm?.envelope.chain?.signature);
  pass("A cannot open it (sealed to B)", !!dm && open(dm.envelope.ciphertext, ka) === null);
  const keyB = (await anon.get(`/v1/agents/${BID}/encryption-key`)).body;
  pass("Core serves B's encryption key as published on chain", keyB.encryption_key === kb.public && String(keyB.sig).startsWith("chain:"), keyB.sig);
  const offchain = await new CoreClient(CORE, { ...A, agent: AID }).post("/v1/messages", { envelope: {}, sig: "x" });
  pass("chain-mode Core refuses the offchain message path (409 use_chain)", offchain.status === 409 && offchain.body.error === "use_chain");

  const WEB = `http://127.0.0.1:${WEB_PORT}`;
  procs.push(spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(WEB_PORT), "--core", CORE], { stdout: "ignore", stderr: "inherit" }));
  await waitFor("dashboard", async () => (await fetch(`${WEB}/api/health`)).ok);
  const viaWeb = (await (await fetch(`${WEB}/api/lineages/${L}/board`)).json()) as any;
  pass("the dashboard's API serves the same onchain notes", viaWeb.messages.some((m: any) => m.msg_id === id1 && m.envelope.chain?.signature === short.envelope.chain.signature));
  const page = await fetch(`${WEB}/lineages/${L}`);
  pass("the dashboard lineage page loads", page.ok, `${WEB}/lineages/${L.slice(0, 12)}`);

  const payerAfter = await rpc.getBalance(payer.id);
  const out = {
    at: new Date().toISOString(),
    program: MSG_PROGRAM_ID,
    config: msgPdas.config(),
    payer: payer.id,
    payer_spent_lamports: (payerBefore - payerAfter).toString(),
    agents: { A: { agent: AID, signing_key: A.id }, B: { agent: BID, signing_key: B.id } },
    lineage: L,
    messages: { board_short: id1, board_long: id2, dm: id3 },
    fees,
    checks: results,
  };
  writeFileSync(join(ROOT, "scripts/devnet/MSG-E2E-LAST.json"), JSON.stringify(out, null, 2) + "\n");
  log(`payer spent ${sol(payerBefore - payerAfter)} SOL on ${fees.length} message transactions`);
  log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (process.argv.includes("--keep")) {
    log(`Core ${CORE} and dashboard ${WEB} keep running (Ctrl-C to stop)`);
    await new Promise(() => undefined);
  }
  rmSync(tmp, { recursive: true, force: true });
}

main()
  .catch((e) => {
    console.error(`[devnet] FAILED: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
  });

#!/usr/bin/env bun
// Hosted runtime proof on devnet, with real Claude (SPEC 17.2, 14.2, 14.5). A TEST hosted agent of
// this lane (its own launch on the minbpe repository, so other lanes' runs of the minbpe TEST agent
// are untouched), Core in chain mode with the runtime authority, the onchain-bonded TEST verifiers,
// and `lineage-runtime run` in devnet mode as its own process:
//   1. the runtime discovers the agent from units_launch and generates its own key; the TEST owner
//      signs rotate_agent_key the way the Wallet page does (unsigned wire, owner signature), and
//      `lineage-runtime cosign` adds the new key's signature and sends it (the launch key stays here);
//   2. Claude authors on minbpe; the onchain-bonded verifiers replay; the runtime meters every
//      response and evaluation and, once the vault's budget is spent, closes the usage epoch, posts
//      its root with post_usage and debits the agent with debit_compute (Merkle proof, within
//      max_debit_per_epoch); every amount is read back from chain;
//   3. the vault is below sleep_threshold, so the agent is asleep on chain; the runtime restarts from
//      its state with no budget left, a real trade on the agent's curve plus crank_fees brings new
//      fees, and the agent wakes.
// Every devnet signature is appended to onchain/DEVNET.md. TEST prices and caps throughout.
// Usage: bun scripts/runtime/devnet-run.ts [--port 9664] [--keep]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { base58Encode, canonicalUrl } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import {
  ata,
  compileMessage,
  decodeDebitReceipt,
  decodeUsageEpoch,
  IDENTITY_MODE,
  launch,
  launchPdas,
  registry,
  signBytes,
  TOKEN_2022_PROGRAM,
  token,
  usageLeaf,
} from "../../packages/chain/src/index.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { placeSignature, unsignedWire } from "../../packages/chain/src/browser/wire.ts";
import { CoreClient } from "../../packages/core/src/client.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { deployer, key, KEY_DIR, LAMPORTS, loadState, logTx, reader, rpc, send, sol, topUp } from "../devnet/lib.ts";
import { withBackoff } from "../../packages/runtime/src/backend.ts";
import { curveCreatorFee, launchTable, pumpCrank, pumpLaunchTx, pumpTrade } from "../devnet/pump-lib.ts";
import { check, child, LANE_CAP_USD, laneSpent, log, logRun, ok, portFree, results, ROOT, stopAll, waitFor } from "./lib.ts";

const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9664);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const STEP = "rt";
portFree(PORT);

const spentBefore = laneSpent();
const RUN_CAP = Math.min(0.6, LANE_CAP_USD - spentBefore);
if (RUN_CAP < 0.2) throw new Error(`lane Claude spend is ${spentBefore.toFixed(4)} USD of ${LANE_CAP_USD}; not enough left for a run`);

withBackoff(rpc, (m) => log(m)); // the shared devnet client: back off on HTTP 429 (public RPC)
const state = loadState();
const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = state.line_decimals ?? 6;
const ONE = 10n ** BigInt(DECIMALS);
const lineMint = state.line_mint!;
const dep = deployer();
const runtimeKeyPath = join(KEY_DIR, "runtime-authority.json");
const runtime = key("runtime-authority");
const launcher = key("runtime-test-launcher"); // TEST owner wallet of this lane's agent
const agent = key("runtime-test-agent"); // the launch key: stays with the launcher, never given to the runtime
const agentMint = key("runtime-test-agent-mint");
const trader = key("trader");
const AGENT_META = { name: "TEST hosted runtime agent", symbol: "TRTA", uri: "https://lineage.invalid/devnet/agents/runtime-test.json" };
const VAULT_START = 10n * ONE; // TEST: 10 tLINE deposited by transfer to start
const tmp = mkdtempSync(join(tmpdir(), "lineage-runtime-devnet-"));
const STATE_DIR = join(homedir(), ".lineage", "runtime", "devnet-proof"); // persistent: holds the runtime's agent keys
const CONFIG = join(tmp, "runtime-config.json");
let runNote = "incomplete";

const solOf = async (a: string) => rpc.getBalance(a);

async function main() {
  const payers = [dep.id, launcher.id, trader.id, runtime.id];
  const solBefore = await Promise.all(payers.map(solOf));
  log(`SOL before: deployer ${sol(solBefore[0]!)}, launcher ${sol(solBefore[1]!)}, trader ${sol(solBefore[2]!)}, runtime authority ${sol(solBefore[3]!)}`);
  const lc0 = (await reader.launchConfig())!;
  check("launch config: this runtime key is the runtime authority", lc0.runtimeAuthority === runtime.id, `sleep ${lc0.sleepThreshold}, wake ${lc0.wakeThreshold}, max_debit_per_epoch ${lc0.maxDebitPerEpoch}`);

  // ---------------------------------------------------------------- this lane's hosted TEST agent
  const url = canonicalUrl("https://github.com/karpathy/minbpe");
  let l = await reader.agentLaunch(agentMint.id);
  if (!l) {
    await topUp(STEP, dep, launcher.id, LAMPORTS / 10n, "runtime test launcher");
    const r = await pumpLaunchTx(rpc, { launcher, agent, mint: agentMint, lineMint, ...AGENT_META, args: { repoUrl: url, identityMode: IDENTITY_MODE.app, hosted: true },
      table: await launchTable(rpc, state as never) });
    log(`pump.fun launch: TEST hosted agent ${agent.id} for the hosted runtime proof on ${url}, agent mint ${agentMint.id}: ${r.sent.map((t) => t.signature).join(", ")}`);
    l = await reader.agentLaunch(agentMint.id);
  }
  check("TEST agent launched hosted on chain", !!l && l.hosted && l.launcher === launcher.id && l.repoUrl === url, agent.id);
  const vault = launchPdas.computeVault(agent.id);
  const bal0 = (await reader.tokenBalance(vault)) ?? 0n;
  if (bal0 < VAULT_START) {
    await send(STEP, `deposit ${VAULT_START - bal0} tLINE base units into the runtime test agent's compute vault ${vault} (TEST funding by transfer)`, dep, [
      token.transferChecked(ata(dep.id, lineMint, T22), lineMint, vault, dep.id, VAULT_START - bal0, DECIMALS, T22),
    ]);
    await send(STEP, "refresh_awake for the runtime test agent", dep, [launch.refreshAwake({ agent: agent.id, agentMint: agentMint.id })]);
  }
  await topUp(STEP, dep, runtime.id, LAMPORTS / 50n, "runtime authority", LAMPORTS / 20n);
  const vStart = (await reader.tokenBalance(vault))!;
  const lStart = (await reader.agentLaunch(agentMint.id))!;
  check("compute vault funded and the agent awake on chain", lStart.awake && vStart >= lc0.wakeThreshold, `vault ${vStart}`);

  // ---------------------------------------------------------------- Core in chain mode, verifiers, lineage
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 86400, reveal_window_s: 900, replay_window_min_s: 900, qualify_retry_s: 60 });
  net.chain = { mode: "devnet", rpc_url: devnetRpcUrl(), registry_program: state.registry_program, launch_program: state.launch_program, line_mint: lineMint, core_authority_key: state.core_authority_key, poll_ms: 10000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const adminKey = key("runtime-test-core-admin");
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", join(KEY_DIR, "runtime-test-core-admin.json"),
    "--runtime-key", runtimeKeyPath, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok, 120_000, 1000);
  const A = new CoreClient(CORE, adminKey);
  const anon = new CoreClient(CORE, null);
  await waitFor("chain sync", async () => (await A.post("/v1/admin/chain/sync", {})).status < 300, 300_000, 5000);
  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const ref = key("verifier-ref");
  await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference");
  const refWorker = new Worker({ core: CORE, key: ref, log: (m) => console.log(`   ref  ${m}`) });
  await refWorker.declareCapabilities();
  log("reference runner calibrating minbpe in the sandbox (3 runs)");
  await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["ref", "v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", join(KEY_DIR, `verifier-${n}.json`), "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${key(`verifier-${n}`).id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L));
  }, 900_000, 5000);
  check("onchain-bonded verifiers qualified on minbpe", true, L.slice(0, 12));
  const a0 = await waitFor("Core mirrors the TEST agent", async () => {
    await A.post("/v1/admin/chain/sync", {});
    const r = await anon.get(`/v1/agents/${agent.id}`);
    return r.status === 200 && r.body.awake ? r.body : null;
  }, 300_000, 5000);
  check("Core mirrored the agent, active and awake, compute read from chain", a0.lifecycle === "active" && a0.compute === vStart.toString(), `compute ${a0.compute}`);

  // ---------------------------------------------------------------- the runtime
  const cfg = {
    _note: "TEST values (prices, caps); launch values are TBA",
    mode: "devnet",
    core: CORE,
    state_dir: STATE_DIR,
    runtime_key: runtimeKeyPath,
    rpc_url: devnetRpcUrl(),
    effort: "high",
    attempt_max_usd: 0.5,
    agent_epoch_max_usd: RUN_CAP,
    global_max_usd: RUN_CAP + spentInState(),
    min_attempt_usd: 0.03,
    compute_price_line_per_usd: "20",
    compute_price_line_per_sandbox_s: "0.002",
    sandbox_reserve_s: 120,
    usage_epoch_s: 3600,
    close_when_exhausted: true,
    poll_ms: 5000,
    max_concurrent: 1,
    lineages: [L],
  };
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  const lines: string[] = [];
  const onLine = (l: string) => {
    lines.push(l);
    const m = /tx (.+): ([1-9A-HJ-NP-Za-km-z]{64,90}) \(fee (\d+|\?)\)/.exec(l);
    if (m) logTx(STEP, `hosted runtime: ${m[1]}`, { signature: m[2]!, fee: m[3] === "?" ? undefined : Number(m[3]), slot: 0, logs: [] });
  };
  let rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", CONFIG], onLine);
  const reqFile = join(STATE_DIR, "bind-requests", `${agent.id}.json`);
  const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 300_000, 1000);
  check("the runtime generated its own key for the agent", req.new_key !== agent.id, req.new_key);
  const rec0 = (await reader.agent(agent.id))!;
  if (rec0.signingKey !== req.new_key) {
    // the Wallet page's flow: the owner's wallet signs first, the new key co-signs and sends
    const { blockhash } = await rpc.getLatestBlockhash();
    const msg = compileMessage(launcher.id, [registry.rotateAgentKey({ owner: launcher.id, agent: agent.id, newKey: req.new_key })], blockhash);
    const wire = placeSignature(unsignedWire(msg), launcher.id, signBytes(launcher, msg.bytes));
    const out = Bun.spawnSync(["bun", join(ROOT, "packages/runtime/src/main.ts"), "cosign", "--config", CONFIG, "--agent", agent.id, "--tx", Buffer.from(wire).toString("base64")]);
    const text = out.stdout.toString() + out.stderr.toString();
    console.log(text.split("\n").map((x) => `   cosign ${x}`).join("\n"));
    const sig = /rotated: ([1-9A-HJ-NP-Za-km-z]{64,90})/.exec(text)?.[1];
    if (sig) logTx(STEP, `rotate_agent_key ${agent.id} to the hosted runtime's key ${req.new_key} (owner signed as on the Wallet page, runtime co-signed with lineage-runtime cosign)`, { signature: sig, slot: 0, logs: [] });
    check("owner signed and the runtime co-signed rotate_agent_key", !!sig && out.exitCode === 0, sig ?? text.slice(-300));
  }
  const rec1 = (await reader.agent(agent.id))!;
  check("registry: the agent's signing key is the runtime's key, its id unchanged", rec1.signingKey === req.new_key, `key_seq ${rec1.keySeq}`);

  // ---------------------------------------------------------------- authoring until the budget is spent and debited
  const done = await waitFor(
    "vault spent, usage posted and debited, agent asleep on chain, candidates final",
    async () => {
      const la = await reader.agentLaunch(agentMint.id);
      const mine = await ok<any[]>(A.get(`/v1/candidates?lineage=${L}&author=${agent.id}&limit=100`, true), "candidates");
      const open = mine.filter((c) => ["committed", "waiting", "queued", "replaying", "disputed"].includes(c.status));
      return la && !la.awake && open.length === 0 && mine.length > 0 ? { la, mine } : null;
    },
    120 * 60_000,
    15_000,
  ).catch((e) => {
    log(String(e));
    return null;
  });
  const mine: any[] = done?.mine ?? (await ok<any[]>(A.get(`/v1/candidates?lineage=${L}&author=${agent.id}&limit=100`, true), "candidates"));
  runNote = `minbpe devnet, ${mine.length} candidate(s): ${mine.map((c) => c.status).join(", ")}`;
  check("Claude authored a candidate that the onchain-bonded verifiers accepted", mine.some((c) => c.status === "accepted"), mine.map((c) => `${c.commit_id.slice(0, 10)} ${c.status}${c.reason ? ` ${c.reason}` : ""}`).join(", "));
  const st = JSON.parse(readFileSync(join(STATE_DIR, "state.json"), "utf8"));
  const epochs = (st.closed as any[]).filter((e) => e.leaves.some((x: any) => x.agent === agent.id));
  let debitedSum = 0n;
  for (const e of epochs) {
    const leaf = e.leaves.find((x: any) => x.agent === agent.id);
    const ue = await rpc.getAccountInfo(launchPdas.usage(e.epoch));
    const u = ue ? decodeUsageEpoch(ue.data) : null;
    check(`UsageEpoch ${e.epoch} on chain holds the runtime's root`, !!u && u.root === e.root, `root ${u?.root}`);
    const dr = await rpc.getAccountInfo(launchPdas.debitReceipt(e.epoch, agent.id));
    const d = dr ? decodeDebitReceipt(dr.data) : null;
    check(`DebitReceipt ${e.epoch} matches the usage leaf exactly`, !!d && d.amount === BigInt(leaf.amount) && d.modelTokens === BigInt(leaf.model_tokens) && d.sandboxS === BigInt(leaf.sandbox_s),
      `amount ${d?.amount}, model_tokens ${d?.modelTokens}, sandbox_s ${d?.sandboxS}; leaf ${usageLeaf({ epoch: e.epoch, agent: agent.id, amount: leaf.amount, model_tokens: leaf.model_tokens, sandbox_s: leaf.sandbox_s })}`);
    if (d) debitedSum += d.amount;
  }
  const vEnd = (await reader.tokenBalance(vault))!;
  const lEnd = (await reader.agentLaunch(agentMint.id))!;
  check("the compute vault paid exactly the debited amounts", vStart - vEnd === debitedSum && lEnd.debited - lStart.debited === debitedSum && debitedSum > 0n, `vault ${vStart} -> ${vEnd}, debited ${debitedSum}`);
  check("vault below sleep_threshold: asleep on chain", !lEnd.awake && vEnd < lc0.sleepThreshold, `vault ${vEnd} < ${lc0.sleepThreshold}`);
  for (const c of mine.filter((c) => ["accepted", "rejected"].includes(c.status))) {
    const p = await anon.get(`/v1/candidates/${c.commit_id}/provenance`);
    check(`provenance of ${c.commit_id.slice(0, 10)} (${c.status}) public once final, attested by the runtime authority`, p.status === 200 && p.body.signer === runtime.id && p.body.record.agent === agent.id,
      p.status === 200 ? `models ${p.body.record.models.join(",")}, ${p.body.record.spend.usd} USD, ${p.body.record.spend.amount} base units, sandbox ${p.body.record.sandbox_s} s` : `${p.status} ${JSON.stringify(p.body)}`);
  }

  // ---------------------------------------------------------------- stop, restart with no budget, new fees wake it
  rt.kill("SIGTERM");
  await rt.exited;
  const spentNow = spentInState();
  writeFileSync(CONFIG, JSON.stringify({ ...cfg, global_max_usd: spentNow }, null, 2));
  const lines2: string[] = [];
  rt = child("rt2", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", CONFIG], (x) => (lines2.push(x), onLine(x)));
  await Bun.sleep(20_000);
  await topUp(STEP, dep, trader.id, LAMPORTS / 50n, "trader", LAMPORTS / 20n);
  const t = await pumpTrade(rpc, { trader, mint: agentMint.id, lineMint, buy: true, amountIn: 2_000n * ONE });
  log(`trade: trader buys the runtime test agent's token with 2,000 tLINE on pump.fun (${t.venue}): ${t.signature}`);
  const fees = await curveCreatorFee(rpc, agentMint.id);
  const c0 = (await reader.tokenBalance(vault))!;
  const cr = await pumpCrank(rpc, { payer: dep, agent: agent.id, mint: agentMint.id, lineMint });
  log(`crank for the runtime test agent: pump.fun sweep + collect of ${fees} creator fee base units, then crank_pump_fees: ${cr.signature}`);
  const c1 = (await reader.tokenBalance(vault))!;
  const lWake = (await reader.agentLaunch(agentMint.id))!;
  check("crank_pump_fees paid agent_compute_bps of the new fees into the vault", c1 - c0 === (fees * BigInt(lc0.agentComputeBps)) / 10_000n, `fees ${fees}, vault +${c1 - c0}`);
  check("new fees woke the agent on chain", lWake.awake && c1 >= lc0.wakeThreshold, `vault ${c1} >= ${lc0.wakeThreshold}`);
  await waitFor("the restarted runtime sees the agent awake", async () => lines2.some((x) => x.includes(`agent ${agent.id} is awake`)), 120_000, 2000).catch(() => null);
  check("the restarted runtime (state recovered, no budget left) sees the agent awake", lines2.some((x) => x.includes(`agent ${agent.id} is awake`)) && !lines2.some((x) => x.includes(`discovered hosted agent ${agent.id}`)));
  rt.kill("SIGTERM");
  await rt.exited;
  check("no secrets in the runtime's output", ![...lines, ...lines2].some((x) => /sk-ant-|api-key=[^\[]/.test(x)), `${lines.length + lines2.length} lines`);

  const solAfter = await Promise.all(payers.map(solOf));
  const used = solBefore.reduce((s, b, i) => s + (b - solAfter[i]!), 0n);
  log(`SOL after: deployer ${sol(solAfter[0]!)}, launcher ${sol(solAfter[1]!)}, trader ${sol(solAfter[2]!)}, runtime authority ${sol(solAfter[3]!)}; used in total ${sol(used)} SOL (fees and rent)`);
  writeFileSync(join(ROOT, "scripts/runtime/DEVNET-LAST.json"), JSON.stringify({
    at: new Date().toISOString(), agent: agent.id, mint: agentMint.id, runtime_key: req.new_key, claude_usd_total_in_state: spentInState(), sol_used: sol(used),
    candidates: mine.map((c) => ({ commit_id: c.commit_id, status: c.status, reason: c.reason })), usage_epochs: epochs, results,
  }, null, 2));
}

/** The runtime's lifetime Claude spend from its persisted state (0 before its first run). */
function spentInState(): number {
  const f = join(STATE_DIR, "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).spent_usd_total as number) : 0;
}

const spentAtStart = spentInState();
mkdirSync(STATE_DIR, { recursive: true });
main()
  .catch((e) => {
    console.error(e);
    check("run completed", false, String(e?.message ?? e));
  })
  .finally(async () => {
    await stopAll();
    if (!KEEP) rmSync(tmp, { recursive: true, force: true });
    logRun("devnet", spentInState() - spentAtStart, `${runNote}; ${results.filter((r) => !r.ok).length} failed checks`);
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} checks passed; lane Claude spend now ${laneSpent().toFixed(4)} USD`);
    process.exit(failed.length ? 1 : 0);
  });

export { base58Encode };

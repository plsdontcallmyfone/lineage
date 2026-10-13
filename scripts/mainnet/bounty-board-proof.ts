#!/usr/bin/env bun
// The Bounties board against REAL mainnet state, with nothing sent (docs/MAINNET-RUNBOOK.md "Bounty
// escrow program"). Read-only RPC and simulation only: no key file is read and no transaction is signed.
//
//   set -a; . ~/.config/units/rpc.env; set +a      # UNITS_MAINNET_RPC, never printed
//   bun scripts/mainnet/bounty-board-proof.ts [--funder <address>] [--ui] [--keep]
//
// 1. The chain client decodes the live Config of units_bounty.
// 2. A local Core on the mainnet profile, in chain mode WITHOUT the Core authority key (the bridge only
//    reads), with UNITS_FEATURE_OPEN_BOUNTIES=1 and UNITS_FEATURE_BOUNTIES=1, on a fresh data directory:
//    its board must report the escrow settings from that Config and offer posting to any wallet.
// 3. A fresh Core has no units (they live in the site's database). The units a bounty can name are read
//    from the live site's own board (it lists them while its board is still closed).
// 4. open_bounty for the first metric of each of those units, funded by --funder (a public address; the
//    dev wallet by default), is simulated on mainnet with signature checks off. When that wallet does
//    not hold the smallest reward, the funder is instead the largest holder of the coin that keeps it in
//    its associated token account and has SOL for the rent (found by public reads; its address only).
// 5. --ui: a local web server over a small read-only proxy (the board the local Core just answered, with
//    the live site's units; every other read from the live site; every write refused) and
//    tests/ui/bounties.spec.ts with a watch-only mock wallet at the funder's address. The local Core is
//    stopped first and the proxy takes its port. --keep leaves the servers up until Ctrl-C.
//
// Ports 9668 (the Core, then the proxy) and 9669 (web); each is checked for a listener first.
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ata, BOUNTY_PROGRAM_ID, bountyTargetDigest, ChainReader, openBounty, openBountyPdas, PROGRAM_IDS, Rpc } from "@units/chain";
import { hashJson } from "@units/protocol";
import { compileMessage, simulateDetailed, unsignedWire } from "../../packages/chain/src/browser/index.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(import.meta.dir, "BOUNTY-BOARD-PROOF-LAST.json");
const DEV_WALLET = "6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3";
let FUNDER = flag("--funder") ?? DEV_WALLET;
const [P_CORE, P_PROXY, P_WEB] = [9668, 9668, 9669];
process.env.UNITS_NETWORK = "mainnet";
const profile = applyNetworkProfile();
if (profile.network !== "mainnet") throw new Error("not the mainnet profile");
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
if ((await rpc.call<string>("getGenesisHash")) !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("the endpoint is not mainnet");
const reader = new ChainReader(rpc);
const SITE = (JSON.parse(readFileSync(join(ROOT, "config/sites.json"), "utf8")).mainnet_site_url as string).replace(/\/+$/, "");
const T0 = Date.now();
const log = (m: string) => console.log(`[bounty-board +${((Date.now() - T0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const procs: Subprocess[] = [];
let tmp = "";
const stop = () => { for (const p of procs) try { p.kill(); } catch {} if (tmp) rmSync(tmp, { recursive: true, force: true }); };
process.on("SIGINT", () => { stop(); process.exit(130); });
for (const p of [P_CORE, P_WEB]) {
  const busy = Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${p}`, "-sTCP:LISTEN"]).stdout.toString().trim();
  if (busy) throw new Error(`port ${p} is in use (pid ${busy}); not starting`);
}
const j = async (url: string) => { const r = await fetch(url, { headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json() as Promise<any>; };
const waitFor = async (what: string, fn: () => Promise<unknown>, ms = 240_000) => {
  for (const t = Date.now(); Date.now() - t < ms; await Bun.sleep(1000)) if (await fn().catch(() => null)) return;
  throw new Error(`timed out waiting for ${what}`);
};

try {
  // ---------------------------------------------------------------- 1. the chain client on the live Config
  const cfg = await reader.openBountyConfig();
  const reg = (await reader.registryConfig())!;
  if (!cfg) throw new Error(`units_bounty ${BOUNTY_PROGRAM_ID} has no Config on mainnet`);
  const dec = (await reader.mint(reg.mint))!.decimals;
  const ONE = 10n ** BigInt(dec);
  const s = cfg.settings;
  check("the chain client decodes the live Config of units_bounty", cfg.mint === reg.mint && cfg.launchProgram === reg.launchProgram && s.feeBps === 0 && !s.paused,
    `program ${BOUNTY_PROGRAM_ID}, admin ${cfg.admin}, mint ${cfg.mint}, smallest reward ${s.minAmount / ONE} UNITS, deadline ${s.minTtlS} to ${s.maxTtlS} s, grace ${s.refundGraceS} s, contest ${s.contestS} s, fee ${s.feeBps} bps, paused ${s.paused}, opened ${cfg.opened}`);

  // ---------------------------------------------------------------- 2. a local Core, read only, both switches on
  tmp = mkdtempSync(join(tmpdir(), "bounty-board-"));
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  net.chain = { mode: "mainnet", registry_program: PROGRAM_IDS.mainnet.registry, launch_program: PROGRAM_IDS.mainnet.launch }; // no core_authority_key: the bridge only reads
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  writeFileSync(join(tmp, "admin.pub"), "11111111111111111111111111111112\n"); // nobody's key: this Core takes no admin call
  const env = { ...process.env, UNITS_NETWORK: "mainnet", UNITS_FEATURE_OPEN_BOUNTIES: "1", UNITS_FEATURE_BOUNTIES: "1" } as Record<string, string>;
  procs.push(spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(P_CORE), "--config", join(tmp, "network.json"), "--admin-key", join(tmp, "admin.pub"), "--no-trees"],
    { stdout: "ignore", stderr: "inherit", env }));
  const CORE = `http://127.0.0.1:${P_CORE}`;
  await waitFor("the local Core", async () => (await fetch(`${CORE}/v1/health`)).ok);
  await waitFor("the local Core's first read of the escrow program", async () => (await j(`${CORE}/v1/bounties/board`)).escrow);
  const board = await j(`${CORE}/v1/bounties/board`);
  const e = board.escrow;
  check("the local Core's board reports the escrow settings from chain and offers posting to any wallet",
    !!e && e.program === BOUNTY_PROGRAM_ID && e.min_amount === s.minAmount.toString() && e.fee_bps === 0 && e.refund_grace_s === s.refundGraceS && e.contest_s === s.contestS && e.paused === false &&
    board.posting.any_wallet === true, JSON.stringify(e));

  // ---------------------------------------------------------------- 3. the live site: board closed, units listed
  const live = await j(`${SITE}/v1/bounties/board`);
  const units = live.units as { lineage_id: string; repo: string; recipe_name: string; metrics: { name: string; min_improvement_bps: number }[] }[];
  check("the live site lists the units a bounty can name", units.length > 0, `${units.length} units: ${units.map((u) => `${u.repo.replace("https://github.com/", "")} (${u.recipe_name}, ${u.metrics.length} metrics)`).join("; ")}`);
  log(`the live site's board today: settings ${live.settings ? "served" : "null"}, escrow ${live.escrow ? "served" : "null"} (${live.escrow ? "open" : "closed until the deploy"})`);
  const usd = await j(`${SITE}/market/quote-usd`).catch(() => null);
  if (usd?.usd) log(`smallest reward at the site's price now: ${(Number(s.minAmount / ONE) * usd.usd).toFixed(2)} USD (${usd.usd} USD per UNITS)`);

  // ---------------------------------------------------------------- 4. open_bounty simulated on mainnet for a funded wallet
  const tp = (await rpc.getAccountInfo(reg.mint))!.owner;
  const holds = async (owner: string) => [(await reader.tokenBalance(ata(owner, reg.mint, tp))) ?? 0n, BigInt(await rpc.getBalance(owner))] as const;
  const asked = FUNDER;
  if ((await holds(FUNDER))[0] < s.minAmount) {
    const top = (await rpc.call<{ value: { address: string }[] }>("getTokenLargestAccounts", [reg.mint, { commitment: "confirmed" }])).value;
    for (const t of top) {
      const info = await rpc.call<{ value: { data: { parsed: { info: { owner: string } } } } | null }>("getAccountInfo", [t.address, { encoding: "jsonParsed" }]);
      const owner = info.value?.data?.parsed?.info?.owner;
      if (!owner || ata(owner, reg.mint, tp) !== t.address) continue;
      const sys = await rpc.getAccountInfo(owner);
      const [b, l] = await holds(owner);
      if (sys && sys.owner === "11111111111111111111111111111111" && b >= s.minAmount && l > 10_000_000n) { FUNDER = owner; break; }
    }
    log(`${asked} holds ${(await holds(asked))[0] / ONE} UNITS in its token account, below the smallest reward: simulating for ${FUNDER === asked ? "nobody (no holder found)" : `the holder ${FUNDER}`} instead`);
  }
  const [bal, lamports] = await holds(FUNDER);
  check("the simulated funder holds the smallest reward and SOL for the rent", (bal ?? 0n) >= s.minAmount && lamports > 10_000_000n, `${FUNDER}: ${(bal ?? 0n) / ONE} UNITS, ${(Number(lamports) / 1e9).toFixed(9)} SOL`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const sims: unknown[] = [];
  let n = 0;
  for (const u of units) {
    const m = u.metrics[0]!;
    const bountyId = now * 1000n + BigInt(n++);
    const args = { bountyId, amount: s.minAmount, termsDigest: hashJson({ v: 1, kind: "improvement", lineage_id: u.lineage_id, metric: m.name, min_improvement_bps: Math.max(m.min_improvement_bps, 1000), note: "simulation" }),
      lineageId: u.lineage_id, targetDigest: bountyTargetDigest(m.name), minImprovementBps: Math.max(m.min_improvement_bps, 1000), deadline: now + 3n * 86_400n };
    const ix = openBounty.open({ funder: FUNDER, mint: reg.mint, tokenProgram: tp, args });
    const { blockhash } = await rpc.getLatestBlockhash();
    const sim = await simulateDetailed(rpc, unsignedWire(compileMessage(FUNDER, [ix], blockhash)));
    const vault = openBountyPdas.vault(openBountyPdas.bounty(FUNDER, bountyId));
    const moved = sim.accounts.find((a) => a.address === vault);
    const ok = !sim.err && (sim.logs ?? []).some((l) => l.includes("Instruction: OpenBounty")) && !!moved?.after;
    sims.push({ unit: u.lineage_id, repo: u.repo, metric: m.name, err: sim.err, units_consumed: sim.unitsConsumed, fee: sim.fee?.toString() });
    check(`open_bounty simulates on mainnet: ${u.repo.replace("https://github.com/", "")}, ${m.name}`, ok,
      ok ? `${sim.unitsConsumed} compute units, fee ${sim.fee} lamports, ${s.minAmount} base units escrowed; nothing sent` : `${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-3).join(" | ")}`);
  }
  // below the minimum the program refuses: the simulation is the program's own
  const low = openBounty.open({ funder: FUNDER, mint: reg.mint, tokenProgram: tp, args: { bountyId: now * 1000n + 99n, amount: s.minAmount - 1n, termsDigest: "11".repeat(32), lineageId: units[0]!.lineage_id,
    targetDigest: bountyTargetDigest(units[0]!.metrics[0]!.name), minImprovementBps: 1000, deadline: now + 3n * 86_400n } });
  const lowSim = await simulateDetailed(rpc, unsignedWire(compileMessage(FUNDER, [low], (await rpc.getLatestBlockhash()).blockhash)));
  check("one base unit below the smallest reward is refused by the program", !!lowSim.err && (lowSim.logs ?? []).some((l) => l.includes("InvalidArgs")), JSON.stringify(lowSim.err));

  // ---------------------------------------------------------------- 5. the page
  let ui: { ran: boolean; exit?: number } = { ran: false };
  if (argv.includes("--ui") || argv.includes("--keep")) {
    const core = procs.pop()!;
    core.kill();
    await core.exited;
    await waitFor("the Core's port", async () => !Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${P_PROXY}`, "-sTCP:LISTEN"]).stdout.toString().trim(), 20_000);
    Bun.serve({ port: P_PROXY, hostname: "127.0.0.1", async fetch(req) {
      const u = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") return Response.json({ error: "read_only", message: "this proof sends nothing to the live site" }, { status: 405 });
      if (u.pathname === "/v1/bounties/board") return Response.json({ ...board, units });
      const r = await fetch(`${SITE}${u.pathname}${u.search}`, { headers: { accept: req.headers.get("accept") ?? "*/*" } });
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
    } });
    procs.push(spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(P_WEB), "--site", SITE, "--core", `http://127.0.0.1:${P_PROXY}`, "--market", SITE], { stdout: "ignore", stderr: "inherit", env }));
    const WEB = `http://127.0.0.1:${P_WEB}`;
    await waitFor("the web server", async () => (await fetch(`${WEB}/chain/config`)).ok);
    log(`web ${WEB} (Core reads through 127.0.0.1:${P_PROXY})`);
    if (argv.includes("--ui")) {
      const t = spawn(["bunx", "playwright", "test", "tests/ui/bounties.spec.ts", ...(flag("--grep") ? ["-g", flag("--grep")!] : [])], { cwd: ROOT, stdout: "inherit", stderr: "inherit",
        env: { ...env, UI_BASE_URL: WEB, UI_WALLET_ADDRESS: FUNDER, UI_WORKERS: "1" } });
      ui = { ran: true, exit: await t.exited };
      check("tests/ui/bounties.spec.ts on the local build over mainnet state, watch-only wallet at the funder's address", ui.exit === 0, `exit ${ui.exit}`);
    }
    if (argv.includes("--keep")) { log("servers left up; Ctrl-C stops them"); await new Promise(() => {}); }
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), program: BOUNTY_PROGRAM_ID, site: SITE, funder: FUNDER, funder_asked: flag("--funder") ?? DEV_WALLET, config: JSON.parse(JSON.stringify(cfg, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    board_escrow: e, units: units.map((u) => ({ lineage_id: u.lineage_id, repo: u.repo, recipe_name: u.recipe_name, metrics: u.metrics.map((m) => m.name) })), simulations: sims, ui, sent: 0, passed, of: results.length, results }, null, 2) + "\n");
  log(`${passed}/${results.length} checks passed; nothing was signed or sent; wrote ${OUT}`);
  if (passed !== results.length) process.exitCode = 1;
} finally {
  stop();
}
process.exit(process.exitCode ?? 0); // the proxy would keep the process alive

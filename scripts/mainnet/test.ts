#!/usr/bin/env bun
// The mainnet TEST operator commands (docs/MAINNET-RUNBOOK.md "Mainnet test (single key, throwaway quote
// coin)", owner decisions 2026-10-11): one key, the deployer, pays, is admin of all three programs and
// keeps their upgrade authority, so `close` can return the program rent when the test ends. The quote
// is a throwaway pump.fun coin this script creates. The same commands run on the fork rehearsal
// (test-rehearsal.ts). Each command reads chain state first and skips what exists, so a stopped run
// resumes. No key and no endpoint is ever printed.
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/test.ts <command> [options]
//
//   keys      make the hot keys (Core authority, runtime authority) and the test coin's mint key if absent; back every key file up
//   status    what exists at the endpoint and what each key holds (read only)
//   coin      create the test coin (create_v2, SOL-paired, not mayhem) and buy a little: --name --symbol --uri [--buy-sol 0.05]
//   deploy    write-buffer + deploy each mainnet-test build at its TEST id (never the launch's mainnet ids), upgrade authority = the deployer, ProgramData sized to the build
//   init      initialize registry, launch and messages with admin = the deployer, the lookup table, bounty and challenge configs;
//             writes the state file and the profile overlay into --out
//   fund      SOL from the deployer to the hot keys: --core <SOL> --runtime <SOL>; and to another wallet (the site instance's
//             owner key, for its verifiers' registration burns and bonds): --to <address> --sol <SOL> --coin <whole test coins>
//   check     read the whole deployment back (read only)
//   close     end of the test: sweep the hot keys, optionally sell the deployer's test coin (--sell-coin), close the three programs
//             and any buffer to the deployer. Needs --confirm <registry program id>. A closed program id can never be deployed again.
//
// Options: --rpc <url> (default the local fork 127.0.0.1:9690; with --mainnet and no --rpc the keyed
// endpoint from UNITS_MAINNET_RPC or ~/.config/units/rpc.env), --mainnet (required on a mainnet
// endpoint), --keys <dir> (default ~/.config/units/mainnet: deployer.json and the hot keys),
// --program-keys <dir> (default ~/.config/units/mainnet-test: the TEST ids' <name>-program-keypair.json), --params <file> (default
// scripts/mainnet/test-params.json), --out <dir> (default scripts/mainnet; untracked mainnet.json and
// profile.local.json), --priority-micro-lamports <n>, --use-rpc (deploy through the RPC instead of
// TPU), --log <file> (appends one JSON line per transaction).
// On mainnet the sending commands also need a READY preflight of the last 24 hours for the same
// builds (scripts/mainnet/preflight.ts).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ata,
  ChainReader,
  decodeLoaderAuthority,
  loadKeypair,
  loadOrCreateKeypair,
  programDataAddress,
  pumpPdas,
  Rpc,
  sendAndConfirm,
  system,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  type Ix,
  type Signer,
} from "@units/chain";
import { rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { checkEndpoint, parseLaunchParams, programIdsNow, type Loaded } from "./steps.ts";
import { checkTest, createTestCoin, initializeTest, READY_FILE, sellTestCoin, sweepKey, TEST_BUILD_DIR, TEST_PROGRAM_KEYS, useTestProfile } from "./test-steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FORK = "http://127.0.0.1:9690";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const has = (n: string) => argv.includes(n);
const need = (n: string) => flag(n) ?? (() => { throw new Error(`${n} required`); })();

// the mainnet profile with the TEST program ids (cargo feature mainnet-test): the mainnet ids of the launch are never used here
const profile = useTestProfile();
const IDS = programIdsNow();
const KEYS = flag("--keys") ?? join(homedir(), ".config", "units", "mainnet");
const PROGRAM_KEYS = flag("--program-keys") ?? TEST_PROGRAM_KEYS;
const OUT = flag("--out") ?? join(ROOT, "scripts", "mainnet");
const rpcUrl = flag("--rpc") ?? (has("--mainnet") ? rpcUrlFor(profile) : FORK);
const local = rpcUrl.startsWith("http://127.0.0.1:");
const rpc = Rpc.http(rpcUrl, "confirmed");
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
if (price !== undefined && (!Number.isInteger(price) || price < 0)) throw new Error("--priority-micro-lamports must be a whole number");
const LOG = flag("--log");

/** Removes the endpoint and anything key-like in it from text that is about to be printed. */
const scrub = (() => {
  const parts = [rpcUrl];
  try {
    const u = new URL(rpcUrl);
    if (!local) parts.push(u.host, ...[...u.searchParams.values()], ...u.pathname.split("/"), u.username, u.password);
  } catch { /* not a URL */ }
  const sorted = [...new Set(parts)].filter((p) => p.length >= 8).sort((a, b) => b.length - a.length);
  return (s: string) => (local ? s : sorted.reduce((acc, p) => acc.split(p).join("[redacted]"), s));
})();
const say = (m: string) => console.log(`[test] ${scrub(m)}`);
const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9)} SOL`;
const lamports = (s: string) => {
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`${s} is not a SOL amount`);
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const trimZeros = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
};
const record = (o: Record<string, unknown>) => {
  if (LOG) appendFileSync(LOG, JSON.stringify({ cmd, ...o }) + "\n");
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const send = async (what: string, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number } = {}) => {
  try {
    const r = await sendAndConfirm(rpc, payer, ixs, { ...o, priorityMicroLamports: price, computeUnits: o.computeUnits ?? (price ? 400_000 : undefined) });
    say(`${what}: ${r.signature} (fee ${r.fee})`);
    record({ what, signature: r.signature, payer: payer.id });
    return r;
  } catch (e) {
    if (e instanceof TxError) for (const l of e.logs.slice(-15)) console.error(`    ${scrub(l)}`);
    throw new Error(scrub((e as Error).message));
  }
};

const PROGRAMS = (["registry", "launch", "msg"] as const).map((name) => ({
  name, id: IDS[name], so: join(TEST_BUILD_DIR, `units_${name}.so`), key: join(PROGRAM_KEYS, `${name}-program-keypair.json`),
}));
const keyPath = (n: string) => join(KEYS, `${n}.json`);
const deployer = () => loadKeypair(keyPath("deployer"));
const hot = (n: "core-authority" | "runtime-authority" | "test-coin-mint") => {
  if (!existsSync(keyPath(n))) throw new Error(`${n}.json is missing in the key directory: run the keys command first`);
  return loadKeypair(keyPath(n));
};
const pubkeyOf = (p: string) => spawnSync("solana-keygen", ["pubkey", p], { encoding: "utf8" }).stdout.trim();

function loadParams(): Loaded {
  const raw = JSON.parse(readFileSync(flag("--params") ?? join(import.meta.dir, "test-params.json"), "utf8"));
  return parseLaunchParams({ ...raw, core_authority: hot("core-authority").id, runtime_authority: hot("runtime-authority").id, line_mint: hot("test-coin-mint").id });
}

// ---------------------------------------------------------------- the endpoint
const genesis = cmd && cmd !== "keys" ? await checkEndpoint(rpc, profile, { deployed: false, local }) : "";
const isMainnet = genesis === MAINNET_GENESIS;
if (isMainnet && !has("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
if (!isMainnet && has("--mainnet") && cmd !== "keys") throw new Error("--mainnet was passed but the endpoint is not mainnet");
if (cmd && cmd !== "keys") say(`${isMainnet ? "MAINNET" : "not mainnet (a fork)"}: registry ${IDS.registry}, launch ${IDS.launch}, msg ${IDS.msg}`);

/** On mainnet a sending command needs a READY preflight of the last 24 hours for these builds and this deployer. */
function requireReady() {
  if (!isMainnet) return;
  const f = join(KEYS, READY_FILE);
  if (!existsSync(f)) throw new Error("no READY preflight: run scripts/mainnet/preflight.ts first");
  const r = JSON.parse(readFileSync(f, "utf8")) as { at: string; deployer: string; builds: Record<string, string> };
  if (Date.now() - Date.parse(r.at) > 24 * 3600_000) throw new Error("the READY preflight is older than 24 hours: run scripts/mainnet/preflight.ts again");
  if (r.deployer !== deployer().id) throw new Error("the READY preflight was for another deployer");
  for (const p of PROGRAMS) if (r.builds[p.name] !== sha(readFileSync(p.so))) throw new Error(`${p.name}: the build changed since the READY preflight`);
}

// ---------------------------------------------------------------- the solana CLI (deploy and close)
/** Runs the solana CLI against this endpoint through a config file (mode 600, removed after), so the endpoint is not on a command line. */
function cli(args: string[], o: { allowFail?: boolean } = {}): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "units-cli-"));
  chmodSync(dir, 0o700);
  const cfg = join(dir, "cli.yml");
  writeFileSync(cfg, `json_rpc_url: "${rpcUrl}"\nwebsocket_url: ""\nkeypair_path: "${keyPath("deployer")}"\naddress_labels: {}\ncommitment: confirmed\n`, { mode: 0o600 });
  try {
    const r = spawnSync("solana", ["-C", cfg, ...args], { encoding: "utf8" });
    const out = scrub(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (r.status !== 0 && !o.allowFail) throw new Error(`solana ${args.slice(0, 2).join(" ")} failed: ${out.slice(-700)}`);
    return { ok: r.status === 0, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const feeArgs = () => [...(price ? ["--with-compute-unit-price", String(price)] : []), ...(has("--use-rpc") ? ["--use-rpc"] : [])];

async function programCode(id: string): Promise<{ code: Uint8Array; authority: string | null; bytes: number } | null> {
  const pd = await rpc.getAccountInfo(programDataAddress(id));
  if (!pd) return null;
  return { code: trimZeros(pd.data.subarray(45)), authority: decodeLoaderAuthority(pd.data), bytes: pd.data.length };
}

// ---------------------------------------------------------------- commands
async function keys() {
  if (!existsSync(keyPath("deployer"))) throw new Error("deployer.json is missing in the key directory");
  for (const p of PROGRAMS) if (!existsSync(p.key) || pubkeyOf(p.key) !== p.id) throw new Error(`${p.name}: ${p.name}-program-keypair.json is missing or is not ${p.id}`);
  for (const n of ["core-authority", "runtime-authority", "test-coin-mint"] as const) {
    const { key, created } = loadOrCreateKeypair(keyPath(n));
    say(`${n}: ${key.id}${created ? " (made now, mode 600)" : ""}`);
  }
  say(`deployer: ${deployer().id}`);
  // the backup: byte-identical copies beside each key directory; an existing copy is never overwritten
  let n = 0, tight = true;
  for (const [dir, pattern] of [[KEYS, /^(deployer|core-authority|runtime-authority|test-coin-mint)\.json$/], [PROGRAM_KEYS, /^(registry|launch|msg)-program-keypair\.json$/]] as const) {
    const backup = (dir === KEYS ? flag("--backup") : flag("--program-backup")) ?? `${dir.replace(/\/+$/, "")}-backup`;
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    chmodSync(backup, 0o700);
    for (const f of readdirSync(dir).filter((x) => pattern.test(x))) {
      const src = join(dir, f), dst = join(backup, f);
      if (existsSync(dst)) {
        if (sha(readFileSync(dst)) !== sha(readFileSync(src))) throw new Error(`${f}: the backup copy differs from the key file; nothing was overwritten, look at both by hand`);
      } else {
        copyFileSync(src, dst);
        chmodSync(dst, 0o600);
      }
      n++;
      tight &&= (statSync(dst).mode & 0o077) === 0;
    }
  }
  check(`backup: ${n} key files have identical copies (mode 600) in the backup directories beside the key directories`, n === 7 && tight, "keep an offline copy too");
}

async function status() {
  const reader = new ChainReader(rpc);
  const dep = deployer();
  say(`deployer ${dep.id}: ${sol(await rpc.getBalance(dep.id))}`);
  for (const n of ["core-authority", "runtime-authority"] as const) if (existsSync(keyPath(n))) say(`${n} ${loadKeypair(keyPath(n)).id}: ${sol(await rpc.getBalance(loadKeypair(keyPath(n)).id))}`);
  for (const p of PROGRAMS) {
    const a = await rpc.getAccountInfo(p.id), c = await programCode(p.id);
    say(`${p.name} ${p.id}: ${!a ? "no account" : c ? `deployed, ProgramData ${c.bytes} bytes, authority ${c.authority}, ${sha(c.code) === sha(trimZeros(readFileSync(p.so))) ? "equals the build" : "DIFFERS from the build"}` : "CLOSED (the id cannot be deployed again)"}`);
  }
  if (existsSync(keyPath("test-coin-mint"))) {
    const mint = loadKeypair(keyPath("test-coin-mint")).id;
    const curve = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
    say(`test coin ${mint}: ${curve ? "created" : "not created"}; the deployer holds ${(await reader.tokenBalance(ata(dep.id, mint, TOKEN_2022_PROGRAM))) ?? 0n} base units`);
  }
  const c = await reader.registryConfig().catch(() => null);
  say(`registry config: ${c ? `admin ${c.admin}, Core authority ${c.coreAuthority}, mint ${c.mint}, epochs posted ${c.epochsPosted}` : "not initialized"}`);
}

async function coin() {
  requireReady();
  const meta = { name: need("--name"), symbol: need("--symbol"), uri: need("--uri") };
  const r = await createTestCoin(rpc, send, check, deployer(), hot("test-coin-mint"), meta, lamports(flag("--buy-sol") ?? "0.05"));
  say(`test coin ${r.mint}: the deployer holds ${r.held} base units`);
}

async function deploy() {
  requireReady();
  const dep = deployer();
  for (const p of PROGRAMS) {
    const so = readFileSync(p.so);
    if (pubkeyOf(p.key) !== p.id) throw new Error(`${p.name}: the id keypair is not ${p.id}`);
    const acct = await rpc.getAccountInfo(p.id);
    const now = await programCode(p.id);
    if (acct && !now) throw new Error(`${p.name}: ${p.id} was closed; a closed program id cannot be deployed again`);
    if (now) {
      check(`${p.name}: already deployed at ${p.id}, code equals the build, upgrade authority the deployer`, sha(now.code) === sha(trimZeros(so)) && now.authority === dep.id);
      continue;
    }
    // preconditions measured at this endpoint's rent before anything is sent: the buffer and the ProgramData are both funded at the peak
    const rent = (n: number) => rpc.getMinimumBalanceForRentExemption(n);
    const buf = await rent(so.length + 37), pd = await rent(so.length + 45), prog = await rent(36);
    const bufKey = keyPath(`deploy-buffer-${p.name}`);
    if (!existsSync(bufKey)) spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", bufKey]);
    const buffer = pubkeyOf(bufKey);
    const resumed = await rpc.getAccountInfo(buffer);
    const txs = Math.ceil(so.length / 1011) + 2;
    const needNow = (resumed ? 0n : buf) + pd + prog + BigInt(txs) * 5_000n + (price ? (BigInt(txs) * 200_000n * BigInt(price)) / 1_000_000n : 0n);
    const bal = await rpc.getBalance(dep.id);
    if (bal < needNow) throw new Error(`${p.name}: the deployer holds ${sol(bal)}; this deploy needs ${sol(needNow)} at its peak (buffer ${sol(buf)}${resumed ? " already funded" : ""}, ProgramData ${sol(pd)}, program account ${sol(prog)}, fees)`);
    say(`${p.name}: ${so.length} bytes, sha256 ${sha(so).slice(0, 16)}; writing the buffer ${buffer}${resumed ? " (resuming)" : ""}`);
    cli(["program", "write-buffer", p.so, "--buffer", bufKey, "--buffer-authority", keyPath("deployer"), "--fee-payer", keyPath("deployer"), ...feeArgs()]);
    const bufBytes = (await rpc.getAccountInfo(buffer))?.data.length ?? 0;
    cli(["program", "deploy", "--buffer", bufKey, "--program-id", p.key, "--upgrade-authority", keyPath("deployer"), "--max-len", String(so.length), "--fee-payer", keyPath("deployer"), ...feeArgs()]);
    let after = await programCode(p.id);
    for (let i = 0; i < 20 && !after; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      after = await programCode(p.id);
    }
    check(`${p.name}: deployed at ${p.id}, code equals the build, upgrade authority the deployer, buffer closed`,
      !!after && sha(after.code) === sha(trimZeros(so)) && after.authority === dep.id && (await rpc.getAccountInfo(buffer)) === null, after ? `ProgramData ${after.bytes} bytes` : "");
    record({ what: `deploy ${p.name}`, program: p.id, buffer, buffer_bytes: bufBytes, so_bytes: so.length, so_sha256: sha(so) });
    if (after) rmSync(bufKey, { force: true });
  }
}

async function init() {
  requireReady();
  await checkEndpoint(rpc, profile, { deployed: true, local });
  const dep = deployer(), P = loadParams();
  const r = await initializeTest(rpc, send, check, dep, P, flag("--lookup-table") ?? priorState()?.launch_lookup_table);
  await checkTest(rpc, check, dep.id, P, r.lookupTable);
  if (failed) return;
  const reader = new ChainReader(rpc);
  const lc = (await reader.launchConfig())!;
  const symbol = flag("--symbol") ?? priorOverlay()?.profiles?.mainnet?.quote?.symbol ?? "TESTQ";
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "mainnet.json"), JSON.stringify({
    mode: "mainnet", test: true,
    deployment: "mainnet TEST (single key admin and upgrade authority, throwaway pump.fun quote coin; closed when the test ends)",
    program_ids: "mainnet-test (throwaway; the launch's mainnet ids are not used)",
    registry_program: IDS.registry, launch_program: IDS.launch, msg_program: IDS.msg,
    line_mint: P.line_mint, line_token_program: P.line_token_program, line_decimals: P.line_decimals, line_venue: "pump.fun",
    admin: dep.id, core_authority: P.core_authority, runtime_authority: P.runtime_authority,
    launch_lookup_table: r.lookupTable, compute_sink: lc.computeSink, agent_compute_bps: Number(P.net.agent_compute_bps), protocol_bps: Number(P.net.protocol_bps),
    // Core config keys the mainnet instance replaces (scripts/deploy, docs/DEPLOY-SITE.md "Second instance"): the units account
    // payment goes to the deployer, not to config/network.json's devnet treasury key
    network_overrides: { prepay: { identity_account_recipient: dep.id } },
  }, null, 2) + "\n");
  writeFileSync(join(OUT, "profile.local.json"), JSON.stringify({
    _note: "Local overlay for the mainnet TEST instance (UNITS_PROFILE_LOCAL, packages/chain/src/profile-node.ts): the programs are the mainnet-test ids, the quote is the throwaway test coin, and SOL is turned into it on its own pump.fun curve, not through Jupiter. Untracked.",
    profiles: { mainnet: {
      quote: { source: "config", symbol, display: `${symbol} (mainnet test coin)`, mint: P.line_mint, decimals: P.line_decimals, token_program: P.line_token_program, status: "stand-in", units_mint: null },
      swap: false,
      programs: { registry: IDS.registry, launch: IDS.launch, msg: IDS.msg },
    } },
  }, null, 2) + "\n");
  say(`wrote mainnet.json and profile.local.json into ${OUT}`);
}
function priorState(): { launch_lookup_table?: string } | null {
  const f = join(OUT, "mainnet.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
function priorOverlay(): { profiles?: { mainnet?: { quote?: { symbol?: string } } } } | null {
  const f = join(OUT, "profile.local.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

async function fund() {
  requireReady();
  const dep = deployer();
  for (const [n, f] of [["core-authority", "--core"], ["runtime-authority", "--runtime"]] as const) {
    const v = flag(f);
    if (!v) continue;
    await send(`fund ${n} ${hot(n).id} with ${v} SOL`, dep, [system.transfer(dep.id, hot(n).id, lamports(v))]);
  }
  // another wallet (the site instance's owner key, which registers and bonds its verifiers): SOL and whole test coins
  const to = flag("--to");
  if (to) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) throw new Error("--to must be a base58 address");
    const P = loadParams();
    const coins = flag("--coin"), solAmount = flag("--sol");
    if (!coins && !solAmount) throw new Error("--to needs --sol <SOL> and/or --coin <whole test coins>");
    if (coins && !/^\d+$/.test(coins)) throw new Error("--coin is a whole number of test coins");
    const ixs: Ix[] = [];
    if (solAmount) ixs.push(system.transfer(dep.id, to, lamports(solAmount)));
    if (coins) ixs.push(token.createAtaIdempotent(dep.id, to, P.line_mint, P.line_token_program),
      token.transferChecked(ata(dep.id, P.line_mint, P.line_token_program), P.line_mint, ata(to, P.line_mint, P.line_token_program), dep.id, BigInt(coins) * 10n ** BigInt(P.line_decimals), P.line_decimals, P.line_token_program));
    await send(`fund ${to} with ${solAmount ?? "0"} SOL and ${coins ?? "0"} test coins`, dep, ixs);
  }
}

async function close() {
  const dep = deployer();
  if (flag("--confirm") !== IDS.registry) throw new Error(`close ends the test for good: pass --confirm ${IDS.registry} (a closed program id can never be deployed again)`);
  const b0 = await rpc.getBalance(dep.id);
  const back: Record<string, string> = {};
  for (const n of ["core-authority", "runtime-authority"] as const)
    if (existsSync(keyPath(n))) back[n] = (await sweepKey(rpc, send, loadKeypair(keyPath(n)), dep.id, n)).toString();
  if (has("--sell-coin") && existsSync(keyPath("test-coin-mint"))) {
    const b = await rpc.getBalance(dep.id);
    await sellTestCoin(rpc, send, dep, loadKeypair(keyPath("test-coin-mint")).id, Number(flag("--slippage-bps") ?? 300), "deployer");
    back["test coin sold"] = ((await rpc.getBalance(dep.id)) - b).toString();
  }
  for (const p of PROGRAMS) {
    const now = await programCode(p.id);
    if (!now) {
      say(`${p.name}: nothing to close at ${p.id}`);
      continue;
    }
    if (now.authority !== dep.id) throw new Error(`${p.name}: the upgrade authority is ${now.authority}, not the deployer; it cannot be closed with this key`);
    const b = await rpc.getBalance(dep.id);
    cli(["program", "close", p.id, "--authority", keyPath("deployer"), "--recipient", dep.id, "--bypass-warning"]);
    let gone = await programCode(p.id);
    for (let i = 0; i < 20 && gone; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      gone = await programCode(p.id);
    }
    back[`${p.name} ProgramData`] = ((await rpc.getBalance(dep.id)) - b).toString();
    check(`${p.name}: closed, its ProgramData rent returned to the deployer`, !gone, sol(BigInt(back[`${p.name} ProgramData`]!)));
    record({ what: `close ${p.name}`, program: p.id, returned_lamports: back[`${p.name} ProgramData`] });
  }
  const b = await rpc.getBalance(dep.id);
  const buffers = cli(["program", "close", "--buffers", "--authority", keyPath("deployer"), "--recipient", dep.id], { allowFail: true });
  back["buffers"] = ((await rpc.getBalance(dep.id)) - b).toString();
  if (!buffers.ok && !/no buffer|not found|No buffers/i.test(buffers.out)) say(`closing buffers: ${buffers.out.trim().split("\n").pop()}`);
  const b1 = await rpc.getBalance(dep.id);
  record({ what: "close summary", returned: back, deployer_before: b0.toString(), deployer_after: b1.toString() });
  say(`returned to the deployer: ${Object.entries(back).map(([k, v]) => `${k} ${sol(BigInt(v))}`).join(", ")}; the deployer now holds ${sol(b1)}`);
}

const commands: Record<string, () => Promise<void>> = {
  keys, status, coin, deploy, init, fund, close,
  check: async () => checkTest(rpc, check, deployer().id, loadParams(), flag("--lookup-table") ?? priorState()?.launch_lookup_table),
};
if (!commands[cmd]) {
  console.log("usage: see the header of scripts/mainnet/test.ts");
  process.exit(2);
}
try {
  await commands[cmd]!();
} catch (e) {
  console.error(`[test] ${cmd} stopped: ${scrub((e as Error).message)}`);
  process.exit(1);
}
if (failed) process.exit(1);

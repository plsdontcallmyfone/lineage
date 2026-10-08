#!/usr/bin/env bun
// Headless check of the Wallet page against REAL devnet (wallet UI lane). A mock Wallet Standard
// wallet is injected into the page; it signs with a local devnet test key held by this process
// (~/.config/lineage/devnet/wallet-ui-test.json; the page only ever sees signatures). The script
// drives the page like a person: connect, faucet, launch an agent token, buy on its curve, crank
// fees, register a verifier whose key the worker CLI co-signs, bond, request an unbond, manage the
// verifier's identity (rotate its signing key with the new key co-signing through the worker CLI,
// revoke it, propose an owner transfer, and accept one back), and claim an epoch leaf. After each step it reads the result back from chain itself and checks it.
//
// Claims need an epoch with a leaf for this wallet, which only exists after real work. The script
// posts one small test epoch with the devnet Core authority key (as scripts/devnet/setup.ts step f
// does) and serves it from a stand-in for Core's two read routes, in Core's exact proof format
// (GET /v1/epochs, GET /v1/epochs/:n/proofs/:agent); everything else is the real page on devnet.
//
// playwright-core is not a repo dependency: pass its location.
// Usage: bun apps/web/scripts/wallet-e2e.ts --pw <dir containing node_modules/playwright-core> [--port 9665] [--core-port 9666] [--shots <dir>]
import { devnetRpcUrl } from "../../../packages/chain/src/endpoint.ts";
import { spawn, spawnSync } from "bun";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, H, merkleProof, merkleRoot } from "@lineage/protocol";
import {
  ata,
  registryPdas,
  ChainReader,
  decodeT22Metadata,
  IDENTITY_MODE,
  launchPdas,
  loadKeypair,
  loadOrCreateKeypair,
  payoutLeaf,
  registry,
  Rpc,
  sendAndConfirm,
  signBytes,
  system,
  TOKEN_2022_PROGRAM,
  type Signer,
} from "@lineage/chain";
import { assertDevnet } from "../../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature } from "../../../packages/chain/src/browser/wire.ts";
import { units } from "../wallet/chain.ts";
import { logWalletTx } from "./devnet-log.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const PORT = Number(arg("port", "9665"));
const CORE_PORT = Number(arg("core-port", "9666"));
const SHOTS = arg("shots");
const ROOT = join(import.meta.dir, "..", "..", "..");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const T0 = Date.now();
const log = (m: string) => console.log(`[wallet-e2e +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
for (const p of [PORT, CORE_PORT]) {
  const busy = spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${p} busy (pid ${busy}); pick others in 9662-9669`);
}

const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const mint = state.line_mint as string;
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const wallet = loadOrCreateKeypair(join(KEYS, "wallet-ui-test.json")).key;
// a fresh worker key per run, so every run exercises register and the worker's co-signature
const workerKeyPath = join(KEYS, "wallet-ui-verifiers", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const workerKey = loadOrCreateKeypair(workerKeyPath).key;
const core = loadKeypair(join(KEYS, "core-authority.json"));
const extraSigs: { step: string; what: string; sig: string }[] = [];
log(`test wallet ${wallet.id}, worker key ${workerKey.id}`);

// ---------------------------------------------------------------- SOL for the test wallet
const MIN = 120_000_000n;
const solBal = await rpc.getBalance(wallet.id);
if (solBal < MIN) {
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 150_000_000n - solBal)]);
  logWalletTx("e2e", `fund the test wallet ${wallet.id} with ${Number(150_000_000n - solBal) / 1e9} SOL from the deployer`, r.signature, r.fee);
  log(`funded test wallet: ${r.signature}`);
}

// ---------------------------------------------------------------- Core stand-in (proof routes only)
const stubEpochs: { n: number; leaves: { agent: string; dest: string; amount: string; leaf: string }[] }[] = [];
const coreStub = Bun.serve({
  port: CORE_PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/v1/epochs") return Response.json(stubEpochs.map((e) => ({ n: e.n, status: "closed", root: merkleRoot(e.leaves.map((l) => l.leaf)) })));
    const m = /^\/v1\/epochs\/(\d+)\/proofs\/([1-9A-HJ-NP-Za-km-z]+)$/.exec(p);
    if (m) {
      const e = stubEpochs.find((x) => x.n === Number(m[1]));
      if (!e) return Response.json({ error: "not_found", message: "epoch" }, { status: 404 });
      const all = e.leaves.map((l) => l.leaf);
      const root = merkleRoot(all);
      return Response.json(e.leaves.map((l, i) => ({ ...l, i })).filter((l) => l.agent === m[2]).map((l) => ({ epoch: e.n, agent: l.agent, dest: l.dest, amount: l.amount, leaf: l.leaf, proof: merkleProof(all, l.i), root, claimed: false })));
    }
    if (p === "/v1/lineages") return Response.json([]);
    if (p === "/v1/config") return Response.json({ network: { token_decimals: state.line_decimals, quorum: 2 } });
    return Response.json({ error: "not_found", message: "this stand-in serves only the proof routes" }, { status: 404 });
  },
});

// ---------------------------------------------------------------- web server
const web = spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(PORT), "--core", `http://127.0.0.1:${CORE_PORT}`], { stdout: "pipe", stderr: "pipe", cwd: ROOT });
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/chain/config`).then((r) => r.ok).catch(() => false)) break;
  await Bun.sleep(500);
}
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- browser with a mock Wallet Standard wallet
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
const signRequests: string[] = [];
await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
  // The "person" approves: sign the message as the test key. The page never sees this key.
  const wire = new Uint8Array(Buffer.from(b64, "base64"));
  const { message } = parseWire(wire);
  const d = decodeMessage(message);
  signRequests.push(d.instructions.map((i) => i.programId.slice(0, 6)).join(","));
  return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
});
await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction"], label: "test" };
  const w = {
    version: "1.0.0",
    name: "Lineage Test Wallet",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
    chains: ["solana:devnet"],
    accounts: [] as unknown[],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__lineageMockSign(b64(i.transaction))) }))),
      },
    },
  };
  window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
}, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
page.on("console", (m: any) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
const T = 120_000;

let launchedMint = "";
try {
  // ------------------------------------------------------------ connect
  await page.goto(`${BASE}/wallet`);
  await page.locator('[data-act="connect"][data-name="Lineage Test Wallet"]').click({ timeout: 30_000 });
  await page.locator(".wl-bal").waitFor({ timeout: T });
  await page.waitForFunction(() => !document.querySelector(".wl-bal")?.textContent?.includes("TBA"), null, { timeout: T });
  const gate = await page.locator("#w-gate").innerText();
  check("page states devnet only and the cluster was checked", /Devnet only/.test(gate) && /genesis hash/.test(gate));
  const balText = await page.locator(".wl-bal").innerText();
  const [chainSol, chainLine] = await Promise.all([rpc.getBalance(wallet.id), reader.tokenBalance(ata(wallet.id, mint, T22))]);
  check("balances shown equal chain", balText.includes(units(chainSol, 9)) && balText.includes(units(chainLine ?? 0n, state.line_decimals)), `${balText.replace(/\s+/g, " ")} vs ${chainSol} lamports, ${chainLine ?? 0} tLINE base units`);

  // ------------------------------------------------------------ faucet
  const faucetBtn = page.locator('[data-act="faucet"]');
  if (await faucetBtn.isEnabled()) {
    const before = (await reader.tokenBalance(ata(wallet.id, mint, T22))) ?? 0n;
    await faucetBtn.click();
    await page.locator("text=/Received .* tLINE/").waitFor({ timeout: T });
    const after = (await reader.tokenBalance(ata(wallet.id, mint, T22))) ?? 0n;
    check("faucet transferred 1,000 tLINE (read back)", after - before === 1_000_000_000n, `${before} -> ${after}`);
    const again = await fetch(`${BASE}/chain/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.id }) });
    check("faucet refuses a second drip to the same wallet", again.status === 429, `HTTP ${again.status}`);
  } else log(`faucet disabled for this wallet: ${await page.locator("#w-conn .wl-why").first().innerText().catch(() => "")}`);
  await shot("e2e-01-connected");

  // ------------------------------------------------------------ launch
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  await page.fill('[name="l_name"]', `ui check ${stamp}`);
  await page.fill('[name="l_repo"]', "https://github.com/karpathy/minbpe");
  await page.selectOption('[name="l_class"]', "python");
  await page.check('input[name="l_hosted"][value="self"]');
  await page.check('input[name="l_identity"][value="app"]');
  await page.locator("#w-repo >> text=public on GitHub").waitFor({ timeout: 30_000 });
  check("repository validated against the GitHub API", true, await page.locator("#w-repo").innerText());
  await page.click('[data-act="launch-review"]');
  await page.locator("text=simulation succeeded on devnet").waitFor({ timeout: T });
  const review = await page.locator("#w-launch-out").innerText();
  check("review lists the accounts and the rent the wallet pays", /Rent deposits/i.test(review) && /AgentLaunch \(new\)/i.test(review) && /compute vault \(new\)/i.test(review), review.split("\n").slice(0, 8).join(" | "));
  await shot("e2e-02-launch-review");
  const solBefore = await rpc.getBalance(wallet.id);
  await page.click('[data-act="launch-sign"]');
  await page.locator("text=Launched.").waitFor({ timeout: T });
  await shot("e2e-03-launched");
  const mine = (await reader.launches()).filter((l) => l.launcher === wallet.id).sort((a, b) => Number(b.createdAt - a.createdAt));
  const l = mine[0]!;
  launchedMint = l.mint;
  const meta = decodeT22Metadata((await rpc.getAccountInfo(l.mint))!.data);
  check("AgentLaunch read back: repo, identity app, self-hosted", l.repoUrl === "https://github.com/karpathy/minbpe" && l.identityMode === IDENTITY_MODE.app && !l.hosted, l.mint);
  check("token metadata: TEST name, class in the URI", !!meta && meta.name === `TEST ui check ${stamp}` && /class=python/.test(meta.uri), JSON.stringify(meta));
  const rec = await reader.agent(l.agent);
  check("registry Agent (launched) owned by the wallet", !!rec && rec.kind === "launched" && rec.owner === wallet.id);
  const shown = await page.locator("#w-launch-out").innerText();
  check("page shows the mint, pool and compute vault read back", shown.includes(l.mint.slice(0, 4)) && /DBC pool/.test(shown) && /Compute vault/.test(shown));
  log(`launch cost the wallet ${Number(solBefore - (await rpc.getBalance(wallet.id))) / 1e9} SOL`);

  // ------------------------------------------------------------ trade and crank
  await page.click('[data-act="goto-trade"]');
  await page.locator("#w-trade >> text=Quote reserve").waitFor({ timeout: T });
  await page.fill('[name="t_amount"]', "200");
  await page.click('[data-act="trade-review"]');
  await page.locator("text=Simulated on devnet").waitFor({ timeout: T });
  await shot("e2e-04-trade-quote");
  const myAgent = ata(wallet.id, l.mint, T22);
  await page.click('[data-act="trade-sign"]');
  await page.locator("text=Bought:").waitFor({ timeout: T });
  const got = (await reader.tokenBalance(myAgent)) ?? 0n;
  check("buy: wallet holds agent tokens (read back)", got > 0n, `${got} base units`);
  const la0 = (await reader.agentLaunch(l.mint))!;
  await page.click('[data-act="crank"]');
  await page.locator("text=Cranked:").waitFor({ timeout: T });
  await shot("e2e-05-cranked");
  const la1 = (await reader.agentLaunch(l.mint))!;
  const fees = la1.feesClaimed - la0.feesClaimed;
  const lc = (await reader.launchConfig())!;
  const want = (fees * BigInt(lc.agentComputeBps)) / 10_000n;
  check("crank_fees split exactly by agent_compute_bps", fees > 0n && la1.toCompute - la0.toCompute === want && la1.toProtocol - la0.toProtocol === fees - want, `fees ${fees}, compute ${la1.toCompute - la0.toCompute}, protocol ${la1.toProtocol - la0.toProtocol}`);

  // ------------------------------------------------------------ verifier: register (worker co-signs), bond, unbond
  await page.click('[data-tab="verify"]');
  await page.fill('[name="v_key"]', workerKey.id);
  await page.click('[data-act="v-lookup"]');
  const existing = await reader.agent(workerKey.id);
  if (!existing) {
    await page.locator('[data-act="v-register"]').waitFor({ timeout: T });
    const caps = spawnSync(["bun", join(ROOT, "packages/worker/src/main.ts"), "doctor"], { cwd: ROOT }).stdout.toString();
    await page.fill('[name="v_caps"]', caps);
    const supply0 = (await reader.mint(mint))!.supply;
    await page.click('[data-act="v-register"]');
    await page.locator("text=Now the worker co-signs").waitFor({ timeout: T });
    await shot("e2e-06-cosign");
    const cmd = await page.locator("#w-cosign [data-copy]").getAttribute("data-copy");
    const b64 = /--tx (\S+)/.exec(cmd ?? "")![1]!;
    const run = spawnSync(["bun", join(ROOT, "packages/worker/src/main.ts"), "cosign", "--key", workerKeyPath, "--tx", b64], { cwd: ROOT });
    const out = run.stdout.toString() + run.stderr.toString();
    const sig = /registered: (\S+)/.exec(out)?.[1];
    check("worker CLI co-signed and sent register", run.exitCode === 0 && !!sig, out.trim().split("\n").slice(-3).join(" | "));
    await page.locator("text=Registered by the worker's co-signature.").waitFor({ timeout: T });
    check("page logged the worker-sent register signature", (await page.locator(`tr[data-sig="${sig}"]`).count()) === 1);
    const r1 = (await reader.agent(workerKey.id))!;
    const supply1 = (await reader.mint(mint))!.supply;
    const cfg = (await reader.registryConfig())!;
    check("register burned register_burn (supply and Agent.burned)", supply0 - supply1 === cfg.params.registerBurn && r1.burned === cfg.params.registerBurn && r1.owner === wallet.id, `${supply0 - supply1}`);
  } else log("worker key already registered; skipping register");
  await page.locator('[data-act="v-bond"]').waitFor({ timeout: T });
  const cfg = (await reader.registryConfig())!;
  const b0 = (await reader.agent(workerKey.id))!.bond;
  await page.fill('[name="v_bond"]', "5");
  await page.click('[data-act="v-bond"]');
  await page.locator("#w-vout >> text=bond 5 tLINE").waitFor({ timeout: T });
  const b1 = (await reader.agent(workerKey.id))!.bond;
  check("bond moved 5 tLINE into the bond (read back)", b1 - b0 === 5_000_000n, `${b0} -> ${b1}; min_bond ${cfg.params.minBond}`);
  await page.fill('[name="v_unbond"]', "1");
  await page.click('[data-act="v-unbond"]');
  await page.locator("#w-vout >> text=request_unbond 1 tLINE").waitFor({ timeout: T });
  const r2 = (await reader.agent(workerKey.id))!;
  check("request_unbond recorded with its cooldown", r2.unbondAmount === 1_000_000n && Number(r2.unbondReadyAt) - Number(r2.unbondRequestedAt) === Number(cfg.params.unbondCooldownS), `ready at ${r2.unbondReadyAt}`);
  await shot("e2e-07-verifier");

  // ------------------------------------------------------------ identity: rotate (new key co-signs), revoke, two-step owner transfer
  const nextKeyPath = workerKeyPath.replace(/\.json$/, "-next.json");
  const nextKey = loadOrCreateKeypair(nextKeyPath).key;
  const owner2 = loadOrCreateKeypair(join(KEYS, "wallet-ui-owner2.json")).key;
  await page.click('[data-tab="identity"]');
  await page.fill('[name="i_key"]', workerKey.id);
  await page.click('[data-act="i-lookup"]');
  await page.locator('[data-act="i-rotate"]').waitFor({ timeout: T });
  const idText = await page.locator("#w-id").innerText();
  const a0 = (await reader.agent(workerKey.id))!;
  check("identity tab reads the Agent v2 record: signing key is the agent key, owner is this wallet", /Agent v2/.test(idText) && /the agent key/.test(idText) && /your wallet/.test(idText) &&
    a0.version === 2 && a0.signingKey === workerKey.id && a0.owner === wallet.id, `key_seq ${a0.keySeq}`);
  await page.fill('[name="i_newkey"]', nextKey.id);
  await page.click('[data-act="i-rotate"]');
  await page.locator("text=Now the new key co-signs").waitFor({ timeout: T });
  await shot("e2e-08-rotate-cosign");
  const rcmd = await page.locator("#w-id-cosign [data-copy]").getAttribute("data-copy");
  const rb64 = /--tx (\S+)/.exec(rcmd ?? "")![1]!;
  const rrun = spawnSync(["bun", join(ROOT, "packages/worker/src/main.ts"), "cosign", "--key", nextKeyPath, "--tx", rb64], { cwd: ROOT });
  const rout = rrun.stdout.toString() + rrun.stderr.toString();
  const rsig = /rotated: (\S+)/.exec(rout)?.[1];
  check("the new key co-signed and sent rotate_agent_key with the worker CLI", rrun.exitCode === 0 && !!rsig, rout.trim().split("\n").slice(-2).join(" | "));
  await page.locator("text=Rotated: the new key co-signed.").waitFor({ timeout: T });
  const a1 = (await reader.agent(workerKey.id))!;
  check("rotation read back: signing key is the new key, the agent id is unchanged", a1.agent === workerKey.id && a1.signingKey === nextKey.id && a1.keySeq === a0.keySeq + 1,
    `${a1.signingKey}, key_seq ${a1.keySeq}`);
  check("page logged the cosign-sent rotation", (await page.locator(`tr[data-sig="${rsig}"]`).count()) === 1);
  await page.click('[data-act="i-revoke"]');
  await page.locator("#w-iout >> text=revoke_agent_key").waitFor({ timeout: T });
  const a2 = (await reader.agent(workerKey.id))!;
  check("revoke read back: no signing key until a rotation", a2.signingKey === null && a2.keySeq === a1.keySeq + 1, `key_seq ${a2.keySeq}`);
  await page.fill('[name="i_owner"]', owner2.id);
  await page.click('[data-act="i-propose"]');
  await page.locator("#w-iout >> text=propose_owner").waitFor({ timeout: T });
  const a3 = (await reader.agent(workerKey.id))!;
  check("propose_owner read back: pending, the owner unchanged until acceptance", a3.pendingOwner === owner2.id && a3.owner === wallet.id);
  // the proposed owner accepts with its own key (the deployer pays the fee), then proposes the agent back to this wallet
  const acc = await sendAndConfirm(rpc, dep, [registry.acceptOwner({ newOwner: owner2.id, agent: workerKey.id })], { signers: [owner2] });
  extraSigs.push({ step: "e2e", what: `accept_owner ${workerKey.id} by ${owner2.id} (deployer pays the fee)`, sig: acc.signature });
  const a4 = (await reader.agent(workerKey.id))!;
  check("accept_owner: owner changed and controller-since restarted", a4.owner === owner2.id && a4.pendingOwner === null && a4.ownerSince >= a3.ownerSince, `owner_since ${a4.ownerSince}`);
  const back = await sendAndConfirm(rpc, dep, [registry.proposeOwner({ owner: owner2.id, agent: workerKey.id, newOwner: wallet.id })], { signers: [owner2] });
  extraSigs.push({ step: "e2e", what: `propose_owner ${workerKey.id} back to the test wallet by ${owner2.id} (deployer pays the fee)`, sig: back.signature });
  await page.click('[data-act="i-lookup"]');
  await page.locator('[data-act="i-accept"]').waitFor({ timeout: T });
  await page.click('[data-act="i-accept"]');
  await page.locator("#w-iout >> text=accept_owner").waitFor({ timeout: T });
  const a5 = (await reader.agent(workerKey.id))!;
  check("the page accepted the transfer back: this wallet owns the agent again", a5.owner === wallet.id && a5.pendingOwner === null && a5.ownerSince >= a4.ownerSince, `owner_since ${a5.ownerSince}`);
  await shot("e2e-09-identity");

  // ------------------------------------------------------------ claims: a test epoch with one leaf for this wallet's verifier
  const c0 = (await reader.registryConfig())!;
  const n = c0.epochsPosted === 0n ? 0 : Number(c0.lastEpoch) + 1;
  // fees cranked above sit in the treasury: split them (permissionless) so the pool can fund the test leaf
  const treasury = (await reader.tokenBalance(registryPdas.treasury())) ?? 0n;
  if (treasury > 0n) {
    const sp = await sendAndConfirm(rpc, wallet, [registry.split({ mint, tokenProgram: T22 })]);
    extraSigs.push({ step: "e2e", what: `split: treasury ${treasury} to reserve and pool (test wallet pays the fee)`, sig: sp.signature });
  }
  const poolNow = (await reader.tokenBalance(registryPdas.pool())) ?? 0n;
  const amount = poolNow < 1_000_000n ? poolNow : 1_000_000n;
  if (amount === 0n) throw new Error("the registry pool is empty even after split");
  const dest = `agent:${workerKey.id}:wallet`;
  const leaf = payoutLeaf(n, workerKey.id, dest, amount);
  const root = merkleRoot([leaf]);
  const post = await sendAndConfirm(rpc, core, [
    registry.postEpoch({ coreAuthority: core.id, mint, epoch: n, payoutRoot: root, lineageRoot: merkleRoot([]), totalUnitsMicro: 1_000_000n, poolAmount: amount, rebateAmount: 0n, tokenProgram: T22 }),
  ]);
  extraSigs.push({ step: "e2e", what: `post_epoch ${n} (test epoch for the Claims tab: one leaf ${dest} amount ${amount}, root ${root.slice(0, 16)}...)`, sig: post.signature });
  stubEpochs.push({ n, leaves: [{ agent: workerKey.id, dest, amount: amount.toString(), leaf }] });
  await page.click('[data-tab="claims"]');
  await page.click('[data-act="claims-reload"]');
  await page.locator('#w-claims [data-act="claim"]').waitFor({ timeout: T });
  await shot("e2e-10-claims");
  const destToken = ata(wallet.id, mint, T22);
  const d0 = (await reader.tokenBalance(destToken)) ?? 0n;
  await page.click('#w-claims [data-act="claim"]');
  await page.locator(`text=Claimed epoch ${n}`).waitFor({ timeout: T });
  const d1 = (await reader.tokenBalance(destToken)) ?? 0n;
  const [receipt] = await reader.claimReceipts(n, [Uint8Array.from(Buffer.from(leaf, "hex"))]);
  check("claim paid exactly the leaf to the owner's tLINE account, receipt on chain", d1 - d0 === amount && !!receipt, `${d1 - d0}`);
  await shot("e2e-11-claimed");

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" ; "));
  check("every wallet signature was requested through the Wallet Standard mock", signRequests.length >= 6, `${signRequests.length} requests`);
} catch (e) {
  check("flow completed", false, (e as Error).message.split("\n")[0]!);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "e2e-failure.png"), fullPage: true }).catch(() => undefined);
  console.error(errors.join("\n"));
} finally {
  // every signature the page sent, from its session table
  const rows: { what: string; sig: string }[] = await page
    .$$eval("tr[data-sig]", (trs: Element[]) => trs.map((t) => ({ what: (t.children[1] as HTMLElement).innerText, sig: t.getAttribute("data-sig")! })))
    .catch(() => []);
  for (const r of rows.reverse()) {
    const t = await rpc.getTransaction(r.sig).catch(() => null);
    logWalletTx("e2e", `page: ${r.what.trim()}${launchedMint && r.what.includes("launch_agent") ? ` (mint ${launchedMint})` : ""}`, r.sig, t?.meta?.fee);
  }
  for (const x of extraSigs) {
    const t = await rpc.getTransaction(x.sig).catch(() => null);
    logWalletTx(x.step, x.what, x.sig, t?.meta?.fee);
  }
  await browser.close();
  web.kill();
  coreStub.stop(true);
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed; deployer ${Number(await rpc.getBalance(dep.id)) / 1e9} SOL; test wallet ${Number(await rpc.getBalance(wallet.id)) / 1e9} SOL`);
  await Bun.write(join(ROOT, "apps/web/scripts/WALLET-E2E-LAST.json"), JSON.stringify({ at: new Date().toISOString(), wallet: wallet.id, worker_key: workerKey.id, mint: launchedMint, results }, null, 2) + "\n");
  process.exit(failed.length ? 1 : 0);
}

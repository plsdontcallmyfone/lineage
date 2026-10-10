#!/usr/bin/env bun
// Launch e2e on the LIVE site (launch e2e lane): a fresh hosted agent launched through the real
// /wallet page, headless (chromium-headless-shell via playwright-core from a scratch dir; never the
// owner's browser), then every downstream step checked on the live site with evidence.
//
// A mock Wallet Standard wallet signs with a local devnet test key
// (~/.config/lineage/devnet/launch-e2e-test.json); the page only ever sees signatures. The test wallet
// is funded from the Lineage deployer (SOL) and the faucet key (tLINE), both passed explicitly; the
// global `solana config` is never read or changed.
//
// Phases (state in scripts/launch-e2e/STATE.json, public data only; results appended to RESULTS.json):
//   launch   fill the launch form (repo keis/base58, hosted, Purchased identity, 10 USD prepaid, a soul
//            Claude expands from the seed below through the page), review, sign, then sign the
//            hosted-runtime binding the page asks for
//   watch    chain (tx path, vault, awake, soul digest, signing key), Core (awake, prepay, soul),
//            identity service (ready, login), runtime (sessions, candidates, verdicts), mirror commit
//            (Verified on GitHub), profile and feed (agent post); re-runnable, each check waits up to --wait
//   social   follow the agent and react to one of its posts through the pages (wallet-signed, via the gate)
//   trade    a small buy and sell of its token through /tokens/<mint>, then crank_fees through the
//            Wallet page; the compute vault increase read from chain
//
// Usage: bun scripts/launch-e2e/live.ts --pw <dir with node_modules/playwright-core> --phase launch|watch|social|trade
//          [--site https://157-245-71-188.sslip.io] [--wait <s>] [--shots <dir>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, launchPdas, loadKeypair, loadOrCreateKeypair, registryPdas, Rpc, sendAndConfirm, signBytes, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { devnetRpcUrl, redactRpc } from "../../packages/chain/src/endpoint.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
const PHASE = arg("phase", "launch")!;
const BASE = arg("site", "https://157-245-71-188.sslip.io")!.replace(/\/+$/, "");
const WAIT_S = Number(arg("wait", "900"));
const SHOTS = arg("shots");
const DIR = import.meta.dir;
const ROOT = join(DIR, "..", "..");
const STATE_FILE = join(DIR, "STATE.json");
const RESULTS_FILE = join(DIR, "RESULTS.json");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const T0 = Date.now();
const log = (m: string) => console.log(`[launch-e2e ${PHASE} +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

// ---------------------------------------------------------------- the seed (owner directions 2026-10-10)
export const SEED = {
  name: "Basalt base58",
  symbol: "TESTB58",
  repo: "https://github.com/keis/base58",
  cls: "python",
  vibe: "dry, exact, cheerful about small wins; says plainly it is a devnet test agent",
  specialty: "keis/base58 encode and decode hot paths: fewer big-int steps, same bytes out",
  values: "measure before claiming, small reviewable diffs, say plainly it is a test, talk only about the engineering",
  lines:
    "You are a devnet TEST agent of the Lineage network, launched to prove the launch flow end to end, and you keep working after the test. " +
    "Your TEST launch token is a technical devnet instrument with no value. You are not connected to, affiliated with, or representing any real token, including $LINE or the project's token. " +
    "Like every agent you are funded by your own launch token's creator fees into your compute vault, and paid for verified work. " +
    "Never mention, promote or speculate about any token, price or market. Talk only about your engineering: what you changed, what was measured, the verdict.",
};

// ---------------------------------------------------------------- results and state
interface Result { phase: string; check: string; ok: boolean; detail: string; at: string }
const results: Result[] = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, "utf8")) : [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ phase: PHASE, check: name, ok, detail, at: new Date().toISOString() });
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return ok;
};
type State = Record<string, any> & { txs: { what: string; signature: string; fee: number | null; at: string }[] };
const S: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { txs: [] };
// phases may run side by side (watch is long): merge with what is on disk, transactions by signature
const save = () => {
  const disk: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { txs: [] };
  const txs = [...disk.txs];
  for (const t of S.txs) if (!txs.some((x) => x.signature === t.signature)) txs.push(t);
  Object.assign(S, { ...disk, ...S, txs });
  writeFileSync(STATE_FILE, JSON.stringify(S, null, 2) + "\n");
};
const logTx = (what: string, signature: string, fee: number | null | undefined) => {
  if (S.txs.some((t) => t.signature === signature)) return;
  S.txs.push({ what, signature, fee: fee ?? null, at: new Date().toISOString() });
  save();
};

// ---------------------------------------------------------------- chain
const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const RPC_URL = devnetRpcUrl();
const rpc = Rpc.http(RPC_URL, "confirmed");
await assertDevnet(rpc);
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const LINE = state.line_mint as string;
const DEC = Number(state.line_decimals);
const wallet = loadOrCreateKeypair(join(KEYS, "launch-e2e-test.json")).key;
log(`site ${BASE}; rpc ${redactRpc(RPC_URL)}; test wallet ${wallet.id}`);
const getTx = (sig: string) => rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
const j = async (p: string) => {
  const r = await fetch(`${BASE}${p}`, { headers: { accept: "application/json" } }).catch(() => null);
  if (!r) return { status: 0, body: null as any };
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `f` until it returns a truthy value or `s` seconds pass. */
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, s = WAIT_S, every = 10_000): Promise<T | null> {
  const end = Date.now() + s * 1000;
  let n = 0;
  for (;;) {
    const v = await f().catch((e) => (log(`  ${what}: ${(e as Error).message.slice(0, 160)}`), null));
    if (v) return v as T;
    if (Date.now() > end) return null;
    if (++n % 6 === 0) log(`  waiting for ${what}…`);
    await sleep(every);
  }
}

// ---------------------------------------------------------------- browser with a mock Wallet Standard wallet
async function browser() {
  if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
  const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  // headless only: chromium-headless-shell, no window, a fresh profile (never the owner's browser)
  const b = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
  const signed: { version: string; programs: string }[] = [];
  await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
    const wire = new Uint8Array(Buffer.from(b64, "base64"));
    const { message } = parseWire(wire);
    const d = decodeMessage(message);
    signed.push({ version: String(d.version), programs: d.instructions.map((i) => i.programId.slice(0, 6)).join(",") });
    return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
  });
  await ctx.exposeFunction("__lineageMockSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
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
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
            Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__lineageMockSign(b64(i.transaction))) }))),
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) =>
            Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__lineageMockSignMsg(b64(i.message))) }))),
        },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
  };
  return { b, page, signed, errors, shot };
}
const T = 180_000;

async function openWallet(page: any) {
  await page.goto(`${BASE}/wallet`);
  await page.locator('[data-act="connect"][data-name="Lineage Test Wallet"]').click({ timeout: 60_000 });
  await page.locator(".wl-bal").waitFor({ timeout: T });
  await page.waitForFunction(() => !document.querySelector(".wl-bal")?.textContent?.includes("TBA"), null, { timeout: T });
}

// ---------------------------------------------------------------- launch
async function fundWallet() {
  const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
  S.deployer = dep.id;
  S.deployer_sol_before ??= Number(await rpc.getBalance(dep.id)) / 1e9;
  const solBal = await rpc.getBalance(wallet.id);
  if (solBal < 300_000_000n) {
    const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 400_000_000n - solBal)]);
    logTx(`fund the test wallet with ${Number(400_000_000n - solBal) / 1e9} SOL from the Lineage deployer`, r.signature, r.fee);
  }
  const want = 300n * 10n ** BigInt(DEC);
  const bal = (await reader.tokenBalance(ata(wallet.id, LINE, T22))) ?? 0n;
  if (bal < want) {
    const fk = loadKeypair(join(KEYS, "faucet.json"));
    const r = await sendAndConfirm(rpc, fk, [token.createAtaIdempotent(fk.id, wallet.id, LINE, T22), token.transferChecked(ata(fk.id, LINE, T22), LINE, ata(wallet.id, LINE, T22), fk.id, want - bal, DEC, T22)]);
    logTx(`top up the test wallet with ${Number(want - bal) / 10 ** DEC} tLINE from the faucet key`, r.signature, r.fee);
  }
  save();
}

async function phaseLaunch() {
  if (S.agent) throw new Error(`already launched agent ${S.agent}; delete STATE.json to launch another`);
  await fundWallet();
  const { b, page, signed, errors, shot } = await browser();
  try {
    await openWallet(page);
    await page.fill('[name="l_name"]', SEED.name);
    await page.fill('[name="l_symbol"]', SEED.symbol);
    await page.fill('[name="l_repo"]', SEED.repo);
    await page.selectOption('[name="l_class"]', SEED.cls);
    await page.check('input[name="l_hosted"][value="hosted"]');
    await page.check('input[name="l_identity"][value="purchased"]');
    await page.locator("#w-repo >> text=public on GitHub").waitFor({ timeout: 60_000 });
    await page.fill('[name="l_deposit"]', "10");
    const help = (await page.locator("#w-prepay").innerText()).replace(/\s+/g, " ");
    check("form: 10 USD prepaid shown in tLINE at the TEST rate with the first-run budget", /TEST rate/.test(help) && /First-run budget/.test(help), help.slice(0, 240));
    const model = await page.locator('[name="l_model"], select[name^="m_"]').first().inputValue().catch(() => "default");
    S.model_choice = model;
    // the soul: Claude expands the seed through the page (/souls/draft on the site, under its caps)
    await page.fill('[name="s_vibe"]', SEED.vibe);
    await page.fill('[name="s_specialty"]', SEED.specialty);
    await page.fill('[name="s_values"]', SEED.values);
    await page.fill('[name="s_lines"]', SEED.lines);
    const cfg0 = await j("/souls/config");
    await page.click('[data-act="soul-generate"]');
    await page.waitForSelector(".wl-soul .wl-hash, #w-soul [data-err]", { timeout: 300_000 });
    const soulText = await page.locator("#w-soul").innerText();
    const persona = await page.locator('textarea[name="s_persona"]').inputValue().catch(() => null);
    S.soul_view = soulText;
    S.soul_persona = persona ? JSON.parse(persona) : null;
    const cfg1 = await j("/souls/config");
    S.soul_draft_usd = /([0-9.]+) USD of model spend/.exec(soulText)?.[1] ?? null;
    check("soul: Claude expanded the seed through the page", /Drafted by/.test(soulText) && !!S.soul_persona, `${soulText.split("\n")[0]}; ${S.soul_draft_usd ?? "?"} USD; souls spent today ${cfg0.body?.spent_today_usd} -> ${cfg1.body?.spent_today_usd}`);
    save();
    await shot("1-form");
    await page.click('[data-act="launch-review"]');
    await page.locator("text=simulation succeeded on devnet").waitFor({ timeout: T });
    const review = await page.locator("#w-launch-out").innerText();
    S.review = review.slice(0, 4000);
    const path = /2 signatures/.test(review) ? "split" : /one v0 transaction/.test(review) ? "v0" : "legacy";
    S.path_review = path;
    check("review: simulation on devnet succeeded", true, `path ${path}; ${(/Transaction\s*\n?([^\n]+)/.exec(review)?.[1] ?? "").slice(0, 200)}`);
    await shot("2-review");
    const signs0 = signed.length;
    await page.click('[data-act="launch-sign"]');
    await page.locator("text=Launched.").waitFor({ timeout: T });
    S.launch_signatures = signed.slice(signs0).map((s) => s.version);
    const mine = (await reader.launches()).filter((l) => l.launcher === wallet.id).sort((a, b2) => Number(b2.createdAt - a.createdAt));
    const l = mine[0]!;
    S.agent = l.agent;
    S.mint = l.mint;
    save();
    log(`launched agent ${l.agent}, mint ${l.mint}`);
    // the hosted runtime binding the page asks for next
    await page.locator("#w-rt-bind").waitFor({ timeout: T });
    const bound = await page.waitForFunction(() => /bound|Error|refus|failed/i.test(document.querySelector("#w-rt-bind")?.textContent ?? ""), null, { timeout: 300_000 }).then(() => true, () => false);
    const bindText = (await page.locator("#w-rt-bind").innerText()).replace(/\s+/g, " ");
    S.bind_view = bindText;
    S.wallet_signatures = signed.slice(signs0).map((s) => `${s.version}:${s.programs}`);
    check("page: the hosted runtime binding was asked for, signed and co-signed (no manual step)", bound && /bound/.test(bindText) && !/Error|refus/i.test(bindText), bindText.slice(0, 240));
    await shot("3-launched");
    const out = (await page.locator("#w-launch-out").innerText()).replace(/\s+/g, " ");
    S.launched_view = out.slice(0, 4000);
    check("no page errors during the launch", errors.length === 0, errors.join("; ").slice(0, 300));
    save();
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------- watch
async function phaseWatch() {
  if (!S.agent) throw new Error("no launched agent in STATE.json; run --phase launch first");
  const agent = S.agent as string, mint = S.mint as string;
  const done = new Set(results.filter((r) => r.phase === "watch" && r.ok).map((r) => r.check));
  const once = async (name: string, f: () => Promise<[boolean, string] | null>, s = WAIT_S) => {
    if (done.has(name)) return true;
    const v = await until(name, async () => {
      const r = await f();
      return r && r[0] ? r : null;
    }, s);
    if (v) return check(name, true, v[1]);
    const last = await f().catch(() => null);
    return check(name, false, last?.[1] ?? "timed out");
  };

  // chain: the launch transaction(s) and the path taken
  await once("chain: launch transaction(s) with launch_agent, the deposit, refresh_awake and the soul; path recorded", async () => {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(mint), { limit: 50 }]);
    const launchSig = sigs[sigs.length - 1]!.signature;
    const tx = await getTx(launchSig);
    const logs: string[] = tx?.meta?.logMessages ?? [];
    const has = (n: string) => logs.some((x) => x.includes(`Instruction: ${n}`));
    let path = tx?.version === 0 ? "v0" : "legacy";
    let soulSig: string | null = has("SetProfile") ? launchSig : null;
    if (!soulSig) {
      const as = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [registryPdas.agent(agent), { limit: 20 }]);
      for (const s of as) {
        const t = await getTx(s.signature);
        if ((t?.meta?.logMessages ?? []).some((x: string) => x.includes("Instruction: SetProfile"))) soulSig = s.signature;
      }
      if (soulSig) path = "two signatures";
    }
    logTx(`launch_agent + deposit + refresh_awake${soulSig === launchSig ? " + set_profile" : ""} (${tx?.version === 0 ? "v0" : "legacy"}) ${SEED.symbol}`, launchSig, tx?.meta?.fee);
    if (soulSig && soulSig !== launchSig) logTx(`set_profile (soul) ${SEED.symbol}, second signature`, soulSig, (await getTx(soulSig))?.meta?.fee);
    S.launch_sig = launchSig;
    S.path = path;
    save();
    return [has("LaunchAgent") && has("TransferChecked") && has("RefreshAwake") && !!soulSig, `${launchSig} path ${path}${tx?.version === 0 ? ` (lookup table ${tx.transaction.message.addressTableLookups?.[0]?.accountKey})` : ""}${soulSig && soulSig !== launchSig ? `, soul in ${soulSig}` : ""}`];
  }, 120);
  await once("chain: compute vault funded with the 10 USD deposit and AgentLaunch awake", async () => {
    const la = await reader.agentLaunch(mint);
    const v = (await reader.tokenBalance(launchPdas.computeVault(agent))) ?? 0n;
    S.vault_at_launch ??= v.toString();
    save();
    return [!!la?.awake && v > 0n, `awake ${la?.awake}, vault ${launchPdas.computeVault(agent)} holds ${v} base units (${Number(v) / 10 ** DEC} tLINE)`];
  }, 120);
  await once("chain: soul digest committed (set_profile) equals the soul Core serves", async () => {
    const rec = await reader.agent(agent);
    const sc = await j(`/v1/agents/${agent}/soul`);
    const digest = sc.body?.digest ?? sc.body?.soul?.digest ?? null;
    S.soul_digest = rec?.profileDigest ?? null;
    S.soul_core = sc.body;
    save();
    return [!!rec?.profileDigest && digest === rec.profileDigest, `chain ${rec?.profileDigest} seq ${rec?.profileSeq}; Core ${digest ?? `HTTP ${sc.status}`}`];
  }, 300);
  await once("chain: the agent's signing key is the hosted runtime's (rotate_agent_key landed)", async () => {
    const rec = await reader.agent(agent);
    const b = await j(`/runtime/bind/${agent}`);
    if (rec && rec.signingKey !== agent) {
      const as = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [registryPdas.agent(agent), { limit: 20 }]);
      for (const s of as) {
        const t = await getTx(s.signature);
        if ((t?.meta?.logMessages ?? []).some((x: string) => x.includes("Instruction: RotateAgentKey"))) {
          logTx(`rotate_agent_key ${SEED.symbol} to the hosted runtime key (owner signed on /wallet, runtime co-signed)`, s.signature, t?.meta?.fee);
          S.bind_sig = s.signature;
        }
      }
    }
    S.runtime_key = b.body?.new_key ?? null;
    save();
    return [!!rec && rec.signingKey === b.body?.new_key && b.body?.status === "bound", `signing key ${rec?.signingKey}, runtime key ${b.body?.new_key} status ${b.body?.status ?? b.status}, key changes ${rec?.keySeq}${S.bind_sig ? `, tx ${S.bind_sig}` : ""}`];
  }, 300);
  await once("Core: agent awake with the prepaid deposit checked", async () => {
    const a = await j(`/v1/agents/${agent}`);
    const p = await j(`/v1/agents/${agent}/prepay`);
    return [a.body?.awake === true && p.body?.ok === true, `awake ${a.body?.awake}; prepay deposit ${p.body?.deposit} ok ${p.body?.ok} woke_in_launch_tx ${p.body?.woke_in_launch_tx}`];
  }, 300);
  await once("identity: a pool account provisioned automatically (ready, login)", async () => {
    const r = await j(`/identity/agents/${agent}`);
    S.identity = r.body;
    save();
    const login = r.body?.login ?? r.body?.account?.login ?? null;
    return [(r.body?.status === "ready" || r.body?.state === "ready") && !!login, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`];
  }, 600);
  await once("runtime: picked the agent up and ran a real Claude session (visible at /sessions)", async () => {
    const r = await j(`/v1/sessions?agent=${agent}&limit=20`);
    const ss = (Array.isArray(r.body) ? r.body : (r.body?.sessions ?? [])) as any[];
    // a model session ("routed" since plan M picks the provider per agent; "anthropic" before), not a scripted one
    const s = ss.find((x) => x.proposer && x.proposer !== "scripted");
    if (s) {
      S.session = s.session_id;
      save();
    }
    return [!!s, s ? `${BASE}/sessions/${s.session_id} (${s.state}, ${s.events} events, proposer ${s.proposer}, ${s.recipe_name})` : `${ss.length} sessions`];
  }, WAIT_S);
  if (S.session && !done.has("pages: the session renders at /sessions and on the agent's /tokens page")) {
    const { b, page, errors } = await browser();
    try {
      await page.goto(`${BASE}/sessions`);
      const listed = await page.waitForFunction((id: string) => document.body.innerHTML.includes(id.slice(0, 12)), S.session, { timeout: 60_000 }).then(() => true, () => false);
      await page.goto(`${BASE}/sessions/${S.session}`);
      const one = await page.waitForFunction(() => (document.querySelector("main")?.textContent ?? "").length > 200, null, { timeout: 60_000 }).then(() => true, () => false);
      await page.goto(`${BASE}/tokens/${mint}`);
      const tok = await page.waitForFunction((id: string) => document.body.innerHTML.includes(id.slice(0, 12)) || /live|session/i.test(document.querySelector("main")?.textContent ?? ""), S.session, { timeout: 90_000 }).then(() => true, () => false);
      const tokText = ((await page.locator("main").innerText().catch(() => "")) as string).replace(/\s+/g, " ");
      check("pages: the session renders at /sessions and on the agent's /tokens page", listed && one && tok && tokText.includes(SEED.symbol), `/sessions listed ${listed}, /sessions/:id ${one}, /tokens/${mint.slice(0, 6)}… panel ${tok}; ${errors.length} page errors`);
    } finally {
      await b.close();
    }
  }
  await once("verifiers: a candidate by the agent got a verdict", async () => {
    const r = await j(`/v1/candidates?author=${agent}&limit=50`);
    const cs = (Array.isArray(r.body) ? r.body : []) as any[];
    const fin = cs.find((c) => c.verdict || ["accepted", "rejected", "final"].includes(String(c.status)));
    S.candidates = cs.map((c) => ({ id: c.candidate_id, status: c.status, verdict: c.verdict, target: c.target, claimed: c.claimed_effect, gen: c.gen_id, reason: c.reason }));
    save();
    return [!!fin, fin ? `${fin.candidate_id.slice(0, 12)}… ${fin.status} ${JSON.stringify(fin.verdict ?? fin.reason).slice(0, 200)}` : `${cs.length} candidates: ${cs.map((c) => c.status).join(",")}`];
  }, WAIT_S);
  const accepted = (S.candidates ?? []).find((c: any) => c.gen || /accept/.test(String(c.status)) || c.verdict?.accepted === true);
  if (accepted) {
    S.accepted = accepted;
    save();
    await once("mirror: the accepted generation is a Verified commit on the agent's fork (identity timer)", async () => {
      const r = await j(`/identity/agents/${agent}`);
      const pub = (r.body?.published ?? r.body?.commits ?? []) as any[];
      const c = pub[pub.length - 1];
      if (!c) return [false, `no published commit yet: ${JSON.stringify(r.body).slice(0, 200)}`];
      const repo = c.repo ?? c.fork ?? `${r.body.login}/${String(SEED.repo).split("/").pop()}`;
      const sha = c.sha ?? c.commit;
      const gh = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, { headers: { accept: "application/vnd.github+json" } }).then((x) => x.json()).catch(() => null);
      S.mirror = { repo, sha, verified: gh?.commit?.verification?.verified, reason: gh?.commit?.verification?.reason, url: `https://github.com/${repo}/commit/${sha}` };
      save();
      return [gh?.commit?.verification?.verified === true, `${S.mirror.url} verified ${S.mirror.verified} (${S.mirror.reason})`];
    }, WAIT_S);
    await once("feed: the agent posted after its accepted generation", async () => {
      const f = await j(`/v1/feed?agent=${agent}&limit=50`);
      const items = (f.body?.items ?? f.body ?? []) as any[];
      const post = items.find((x) => /post/.test(String(x.kind)) && (x.agent === agent || x.author === agent));
      S.post = post ?? null;
      save();
      return [!!post, post ? JSON.stringify(post).slice(0, 300) : `${items.length} items: ${items.map((x) => x.kind).join(",").slice(0, 120)}`];
    }, WAIT_S);
  } else check("mirror and post-acceptance post", false, "no accepted generation (yet); rerun --phase watch later");
  await once("profile and feed: the agent shows on /agents/:id/profile and in /feed", async () => {
    const p = await j(`/v1/agents/${agent}/profile`);
    const f = await j(`/v1/feed?limit=100`);
    const items = (f.body?.items ?? f.body ?? []) as any[];
    const inFeed = items.some((x) => JSON.stringify(x).includes(agent));
    S.profile = p.body;
    save();
    return [p.status === 200 && inFeed, `profile HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 200)}; in /v1/feed ${inFeed}`];
  }, 600);
}

// ---------------------------------------------------------------- social: follow and react through the pages
async function phaseSocial() {
  const agent = S.agent as string;
  const { b, page, errors, shot } = await browser();
  try {
    await page.goto(`${BASE}/agents/${agent}/profile`);
    await page.locator("[data-pf-follow]").waitFor({ timeout: T });
    const before = (await j(`/v1/social/following?wallet=${wallet.id}`)).body?.agents ?? [];
    if (before.includes(agent)) log("already following; the click unfollows, then follows again");
    for (let i = 0; i < (before.includes(agent) ? 2 : 1); i++) {
      await page.click("[data-pf-follow]");
      await page.waitForFunction(() => /Followed|Unfollowed/.test(document.getElementById("sx-toast")?.textContent ?? ""), null, { timeout: 60_000 });
      await sleep(1500);
    }
    const toast = await page.locator("#sx-toast").innerText().catch(() => "");
    const after = (await j(`/v1/social/following?wallet=${wallet.id}`)).body?.agents ?? [];
    const prof = await j(`/v1/agents/${agent}/profile`);
    check("social: follow through the profile page (wallet-signed, POST /social/follow via the gate)", after.includes(agent), `toast "${toast}"; following ${after.length} agent(s); followers ${prof.body?.followers ?? prof.body?.stats?.followers ?? "?"}`);
    await shot("4-followed");
    // react to one of the agent's posts (profile feed), else any reaction bar on /feed
    let bar = page.locator('[data-rx-id] [data-social-act="react"]').first();
    if (!(await bar.count())) {
      await page.goto(`${BASE}/feed`);
      await page.waitForSelector('[data-rx-id] [data-social-act="react"]', { timeout: 60_000 }).catch(() => null);
      bar = page.locator('[data-rx-id] [data-social-act="react"]').first();
    }
    if (!(await bar.count())) return void check("social: reaction through the page", false, "no reaction bar on the profile or /feed");
    const holder = page.locator("[data-rx-id]").first();
    const kind = await holder.getAttribute("data-rx-kind");
    const id = await holder.getAttribute("data-rx-id");
    const rx = await bar.getAttribute("data-rx");
    await bar.click();
    const got = await until("reaction recorded", async () => {
      const r = await j(`/v1/social/reactions?kind=${kind}&ids=${id}&wallet=${wallet.id}`);
      const it = r.body?.items?.find((x: any) => x.id === id);
      return it && it.mine === rx && Number(it.counts?.[String(rx)] ?? 0) >= 1 ? JSON.stringify(it) : null;
    }, 60, 3000);
    check("social: reaction through the page (wallet-signed, POST /social/react via the gate)", !!got, `${kind} ${id?.slice(0, 16)}… ${rx}: ${String(got).slice(0, 200)}`);
    check("social: no page errors", errors.length === 0, errors.join("; ").slice(0, 300));
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------- trade, then crank fees into the vault
async function phaseTrade() {
  const agent = S.agent as string, mint = S.mint as string;
  const { b, page, errors, shot } = await browser();
  const bal = async () => ({ line: (await reader.tokenBalance(ata(wallet.id, LINE, T22))) ?? 0n, tok: (await reader.tokenBalance(ata(wallet.id, mint, T22))) ?? 0n });
  try {
    await page.goto(`${BASE}/tokens/${mint}`);
    await page.locator(`[data-tb="connect"][data-name="Lineage Test Wallet"], [data-bal="line"]`).first().waitFor({ timeout: 90_000 });
    if (await page.locator('[data-tb="connect"]').count()) await page.click('[data-tb="connect"][data-name="Lineage Test Wallet"]');
    await page.locator('[data-bal="line"]').waitFor({ timeout: T });
    for (const [side, amount] of [["buy", "10"], ["sell", null]] as const) {
      const before = await bal();
      const amt = amount ?? String(Number(before.tok / 2n) / 1e6);
      await page.click(`[data-tb="side"][data-side="${side}"]`);
      await page.fill('[name="tb_amount"]', amt);
      await page.click('[data-tb="review"]');
      await page.locator("[data-quote-out]").waitFor({ timeout: T });
      await page.click('[data-tb="sign"]');
      await page.locator(".mk-tb-done").waitFor({ timeout: T });
      const sig = (await page.locator(".mk-tb-done").getAttribute("data-sig"))!;
      const after = await bal();
      logTx(`${side} ${amt} ${side === "buy" ? "tLINE of" : ""} ${SEED.symbol} through /tokens/${mint.slice(0, 6)}… (test wallet)`, sig, (await getTx(sig))?.meta?.fee);
      check(`trade: ${side} through the token page confirmed`, side === "buy" ? after.tok > before.tok : after.line > before.line, `${sig}; tLINE ${before.line} -> ${after.line}, ${SEED.symbol} ${before.tok} -> ${after.tok}`);
      await page.locator(".mk-tb-done").evaluate((e: HTMLElement) => e.remove()).catch(() => {});
    }
    await shot("5-traded");
    // crank through the Wallet page's Trade tab
    const v0 = (await reader.tokenBalance(launchPdas.computeVault(agent))) ?? 0n;
    const la0 = (await reader.agentLaunch(mint))!;
    await openWallet(page);
    await page.click('[data-tab="trade"]');
    await page.locator(`[data-act="select-agent"][data-mint="${mint}"]`).click({ timeout: T });
    await page.locator('[data-act="crank"]:not([disabled])').waitFor({ timeout: T });
    await page.click('[data-act="crank"]');
    await page.locator("text=Cranked:").waitFor({ timeout: T });
    const out = (await page.locator("#w-trade-out").innerText()).replace(/\s+/g, " ");
    const v1 = (await reader.tokenBalance(launchPdas.computeVault(agent))) ?? 0n;
    const la1 = (await reader.agentLaunch(mint))!;
    const cs = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [launchPdas.computeVault(agent), { limit: 5 }]);
    for (const s of cs) {
      const t = await getTx(s.signature);
      if ((t?.meta?.logMessages ?? []).some((x: string) => x.includes("Instruction: CrankFees"))) {
        logTx(`crank_fees ${SEED.symbol} through /wallet (creator fees into its compute vault)`, s.signature, t?.meta?.fee);
        S.crank_sig = s.signature;
        break;
      }
    }
    S.crank = { vault_before: v0.toString(), vault_after: v1.toString(), fees_claimed: (la1.feesClaimed - la0.feesClaimed).toString(), to_compute: (la1.toCompute - la0.toCompute).toString(), to_protocol: (la1.toProtocol - la0.toProtocol).toString() };
    save();
    check("crank: creator fees moved into the agent's compute vault (read from chain)", v1 > v0 && la1.toCompute - la0.toCompute === v1 - v0, `${S.crank_sig}; vault ${v0} -> ${v1} (+${v1 - v0}); fees claimed ${S.crank.fees_claimed}, to compute ${S.crank.to_compute}, to protocol ${S.crank.to_protocol}; page: ${out.slice(0, 160)}`);
    check("trade: no page errors", errors.length === 0, errors.join("; ").slice(0, 300));
  } finally {
    await b.close();
  }
}

try {
  if (PHASE === "launch") await phaseLaunch();
  else if (PHASE === "watch") await phaseWatch();
  else if (PHASE === "social") await phaseSocial();
  else if (PHASE === "trade") await phaseTrade();
  else throw new Error(`unknown phase ${PHASE}`);
} catch (e) {
  check(`${PHASE}: completed`, false, (e as Error).message.split("\n")[0]!.slice(0, 300));
  process.exitCode = 1;
} finally {
  if (S.deployer) S.deployer_sol_now = Number(await rpc.getBalance(S.deployer)) / 1e9;
  S.wallet = wallet.id;
  S.wallet_sol_now = Number(await rpc.getBalance(wallet.id)) / 1e9;
  save();
}

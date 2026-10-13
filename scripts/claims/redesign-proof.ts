#!/usr/bin/env bun
// The redesigned Claim page (owner 2026-10-13, "a more seamless design ... for claiming fees") in headless
// Chromium at 1280 and 390: every state of the claim card, the repository search, the board, "How this
// works", the page of one repository and the project page's line, each with a screenshot and the checks
// that go with it. No transaction on any network.
//
// What is real: the Core module and its HTTP routes (the sign-in, the wallet statement, the attestation),
// the dashboard server and the page bundles, the mock GitHub's OAuth and repository permissions, and a
// Wallet Standard test wallet that really signs the statement and the claim transaction.
// What is staged: the chain Core reads is a set of accounts built here; the dollar price Core holds
// (0.0004 USD a coin, 6 decimals); and the SENDING of the claim: the page's RPC calls that would send
// and confirm the signed transaction are answered here, and the staged accounts are moved as the program
// moves them (the vault emptied, the amount counted as claimed, the wallet pinned). The claim on a real
// chain through this page is scripts/pools/devnet-proof.ts, which this script does not run. Three failures
// are injected in the browser (GitHub not answering a search, the site not answering, the wallet refusing).
//
//   bun scripts/claims/redesign-proof.ts [--shots <dir>]      (CLAIM_PROOF_PORTS=web,core; default 9668,9669)
// The dashboard must not run on 9667: that is where it looks for a hosted runtime by default, and a connected wallet
// makes the page ask it (/runtime/unbound/<wallet>), which would then call itself without end.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { accountDisc, claimPdas, LAUNCH_PROGRAM_ID, Rpc, signBytes, Writer, type Address, type Signer } from "@units/chain";
import { generateAgentKey } from "@units/protocol";
import sites from "../../config/sites.json" with { type: "json" };
import { base58Encode } from "../../packages/chain/src/browser/index.ts";
import { parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { feeClaimsOf } from "../../packages/core/src/fee-claims.ts";
import { serve } from "../../packages/core/src/http.ts";
import { startMockGithub } from "./mock-github.ts";
import { startWeb } from "./page-proof.ts";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const [WEB_PORT, CORE_PORT] = (process.env.CLAIM_PROOF_PORTS ?? "9668,9669").split(",").map(Number) as [number, number];
const SHOTS = arg("shots", join(tmpdir(), `units-claim-redesign-${Date.now()}`));
mkdirSync(SHOTS, { recursive: true });
for (const p of [WEB_PORT, CORE_PORT]) {
  let pid = "";
  try { pid = execFileSync("lsof", ["-ti", `:${p}`], { encoding: "utf8" }).trim(); } catch { /* free */ }
  if (pid) throw new Error(`port ${p} is in use by pid ${pid.replace(/\n/g, " ")}; not binding`);
}

const checks: { name: string; ok: boolean; note: string }[] = [];
const check = (name: string, ok: boolean, note = "") => { checks.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && note ? `  (${note.slice(0, 400)})` : ""}`); };

// ---- the mock GitHub: Mona administers three repositories; octocat owns one and only pushes to the organisation's; Quinn administers
// one that has earned nothing; Nemo administers nothing that receives fees
const MONA = { id: 2, login: "mona", name: "Mona" }, OCTO = { id: 583231, login: "octocat" }, QUINN = { id: 77, login: "quinn" }, NEMO = { id: 78, login: "nemo" }, ACME = { id: 9919, login: "acme", type: "Organization" as const };
const ENGINE = { id: 5000001, full_name: "acme/engine", admins: ["mona"], members: ["octocat"] }, TOOLS = { id: 5000002, full_name: "mona/tools", admins: ["mona"] };
const HELLO = { id: 1296269, full_name: "octocat/Hello-World", admins: ["octocat"] }, QUIET = { id: 5000003, full_name: "acme/quiet", admins: ["mona", "quinn"] };
const mock = startMockGithub({ port: 0, users: [MONA, OCTO, QUINN, NEMO, ACME], repos: [ENGINE, TOOLS, HELLO, QUIET, { id: OCTO.id, full_name: "mona/unrelated", admins: ["mona"] }], clientId: "units-proof", clientSecret: "proof-secret" });

// ---- the staged chain
type Accounts = Map<Address, { owner: string; data: Uint8Array }>;
const acct = (name: string, w: Writer) => ({ owner: LAUNCH_PROGRAM_ID, data: new Writer().bytes(accountDisc(name)).bytes(w.done()).done() });
const ZERO = "11111111111111111111111111111111";
const tokenAccount = (amount: bigint) => { const d = new Uint8Array(165); new DataView(d.buffer).setBigUint64(64, amount, true); return { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: d }; };
const chainOf = (accounts: Accounts) => {
  const raw = (a: Address) => { const x = accounts.get(a); return x ? { lamports: 1, owner: x.owner, executable: false, data: [Buffer.from(x.data).toString("base64"), "base64"] as [string, string] } : null; };
  return new Rpc(async (method, params) => {
    if (method === "getAccountInfo") return { value: raw(params[0] as Address) };
    if (method === "getMultipleAccounts") return { value: (params[0] as Address[]).map(raw) };
    if (method === "getProgramAccounts") {
      const filters = ((params[1] as { filters: { memcmp?: { offset: number; bytes: string } }[] }).filters ?? []).filter((f) => f.memcmp).map((f) => f.memcmp!);
      return [...accounts].filter(([, v]) => v.owner === params[0] && filters.every((f) => Buffer.from(v.data.subarray(f.offset)).subarray(0, Buffer.from(f.bytes, "base64").length).equals(Buffer.from(f.bytes, "base64"))))
        .map(([pubkey, v]) => ({ pubkey, account: raw(pubkey)! }));
    }
    throw new Error(`staged chain: ${method}`);
  });
};
const attestor = generateAgentKey();
const config = (a: Accounts) => a.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(attestor.id).u16(2000).u16(2000).i64(604_800).i64(86_400).i64(600).bool(false).u8(255)));
const seeded: Accounts = new Map();
config(seeded);
const HOUR = 3600, now = Math.floor(Date.now() / 1000);
const held = new Map<number, { accrued: bigint; claimed: bigint; seq: bigint; wallet: string }>();
const route = (id: number, repoUrl: string, routed: bigint, setAt: number) => {
  const agent = generateAgentKey().id;
  seeded.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(id).u16(2000).i64(setAt).u64(0).u16(0).i64(0).u64(routed).u64(routed).u32(0).u8(254)));
  seeded.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(generateAgentKey().id).address(generateAgentKey().id).fixed32("ab".repeat(32)).string(repoUrl)));
};
const escrow = (id: number, accrued: bigint, claimed: bigint, seq: bigint, wallet = claimed ? generateAgentKey().id : ZERO) => {
  held.set(id, { accrued, claimed, seq, wallet });
  seeded.set(claimPdas.escrow(id), acct("ClaimEscrow", new Writer().u64(id).address(wallet).address(ZERO).i64(0).u64(accrued).u64(claimed).u64(seq).u8(255).u8(254)));
  seeded.set(claimPdas.vault(id), tokenAccount(accrued - claimed));
};
/** What the program does to an escrow when a claim by `wallet` lands: everything waiting is paid, the wallet is pinned, the claim number moves on. */
const land = (id: number, wallet: string) => { const e = held.get(id)!; escrow(id, e.accrued, e.accrued, e.seq + 1n, wallet); };
// base units, 6 decimals, at 0.0004 USD a coin: 1,327,407.4 coins = $530.96 from two agents; 829,696.1 = $331.88; 100,000 shared and 40,000 claimed = $24.00 waiting
route(ENGINE.id, "https://github.com/acme/engine", 912_592_600_000n, now - 30 * HOUR);
route(ENGINE.id, "https://github.com/acme/engine", 414_814_800_000n, now - 6 * HOUR);
escrow(ENGINE.id, 1_327_407_400_000n, 0n, 0n);
route(TOOLS.id, "https://github.com/mona/tools", 829_696_100_000n, now - 20 * HOUR);
escrow(TOOLS.id, 829_696_100_000n, 0n, 0n);
route(HELLO.id, "https://github.com/octocat/hello-world", 100_000_000_000n, now - 50 * HOUR);
escrow(HELLO.id, 100_000_000_000n, 40_000_000_000n, 1n);
route(QUIET.id, "https://github.com/acme/quiet", 0n, now - HOUR);
escrow(QUIET.id, 0n, 0n, 0n);
const bare: Accounts = new Map();
config(bare);

process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
const dirs: string[] = [];
function startCore(accounts: Accounts) {
  const dataDir = mkdtempSync(join(tmpdir(), "units-claim-redesign-core-"));
  dirs.push(dataDir);
  const core = new Core({ dataDir, network: loadNetworkConfig("config/network.json"), adminId: generateAgentKey().id, clock: systemClock, trees: null, chainMode: true });
  feeClaimsOf(core).configure({ githubApi: mock.url, githubToken: null, rpc: chainOf(accounts), lineMint: generateAgentKey().id, attestor, network: "devnet", claimPage: `http://127.0.0.1:${WEB_PORT}/claim`,
    oauth: { clientId: "units-proof", clientSecret: "proof-secret", authorizeUrl: `${mock.url}/login/oauth/authorize`, tokenUrl: `${mock.url}/login/oauth/access_token`, redirectUri: `http://127.0.0.1:${CORE_PORT}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" },
    usd: () => ({ ok: true, quote_usd: 0.0004, read_at: now, decimals: 6 }) });
  const server = serve(core, { port: CORE_PORT });
  return { stop: () => { server.stop(true); core.close(); } };
}

// ---- the test wallet: it really signs; the script can make it wait (to photograph a step) or refuse
interface Hand { wallet: Signer; msgs: number; txs: number; refuse: boolean; holdMsg: Promise<void> | null; holdTx: Promise<void> | null; landing: number | null; sent: string[] }
async function testWallet(ctx: BrowserContext): Promise<Hand> {
  const h: Hand = { wallet: generateAgentKey() as unknown as Signer, msgs: 0, txs: 0, refuse: false, holdMsg: null, holdTx: null, landing: null, sent: [] };
  await ctx.exposeFunction("__unitsSignMsg", async (b64: string) => {
    h.msgs++;
    await h.holdMsg;
    if (h.refuse) throw new Error("User rejected the request.");
    return Buffer.from(signBytes(h.wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64");
  });
  await ctx.exposeFunction("__unitsSignTx", async (b64: string) => {
    h.txs++;
    await h.holdTx;
    const wire = new Uint8Array(Buffer.from(b64, "base64"));
    return Buffer.from(placeSignature(wire, h.wallet.id, signBytes(h.wallet, parseWire(wire).message))).toString("base64");
  });
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "claimer" };
    const w: any = {
      version: "1.0.0", name: "units Test Wallet", chains: ["solana:devnet"], accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__unitsSignTx(b64(i.transaction))) }))) },
        "solana:signMessage": { version: "1.0.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__unitsSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: h.wallet.id, pub: Array.from(h.wallet.secret.subarray(32)) });
  return h;
}

/** The page's own rules, on what is rendered under `sel`. */
async function rules(page: Page, sel: string) {
  return page.evaluate((s) => {
    const root = document.querySelector(s) as HTMLElement | null;
    if (!root) return { mono: 0, emDash: false, wide: false, text: "", status: "nothing rendered" as string | null, words: null as string | null };
    const mono = [...root.querySelectorAll("*")].filter((e) => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).length;
    const text = root.innerText.replace(/\s+/g, " ");
    return { mono, emDash: text.includes(String.fromCharCode(0x2014)), wide: document.documentElement.scrollWidth > window.innerWidth + 1, text,
      status: /devnet|testnet|\bmock\b|\btest\b|not open yet|coming soon|\bbeta\b|\bTBA\b/i.exec(text)?.[0] ?? null,
      // the builders' words, and the old page's dead placeholders
      words: /escrow|\bCore\b|attest|read from chain|on chain|\bbind\b|\bbound\b|After steps?\b/i.exec(text)?.[0] ?? null };
  }, sel);
}
const clean = (r: Awaited<ReturnType<typeof rules>>) => r.mono === 0 && !r.emDash && !r.wide && !r.status && !r.words;
const why = (r: Awaited<ReturnType<typeof rules>>) => `mono ${r.mono}, em dash ${r.emDash}, sideways scroll ${r.wide}, status wording ${r.status}, builders' word ${r.words}: ${r.text.slice(0, 240)}`;
const PROJECT = (name: string) => ({ key: name, repo: `https://github.com/${name}`, github: true, classes: ["python"], live_agents: [], accepted: 0, reverted: 0, last_improvement_at: null, open_candidates: 0, lineages: [] });
const T = 60_000;

let core = startCore(seeded);
let web: Awaited<ReturnType<typeof startWeb>> | null = null;
const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  // every market read of the pages goes to the public site's indexer, read only; everything else stays on this machine
  web = await startWeb(WEB_PORT, `http://127.0.0.1:${CORE_PORT}`, sites.mainnet_site_url.replace(/\/+$/, ""));
  const base = web.base;
  const genesis = ((await (await fetch(`${base}/chain/config`)).json()) as { profile?: { genesis?: string }; genesis?: string }).profile?.genesis ?? "";

  for (const width of (process.env.CLAIM_PROOF_WIDTHS ?? "1280,390").split(",").map(Number)) {
    const W = `${width}`;
    const errors: string[] = [];
    const posts: string[] = [];
    /** A fresh browser with its own test wallet; `login` picks who the mock GitHub signs in. */
    const open = async (login: string) => {
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      const hand = await testWallet(ctx);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
      page.on("request", (r) => { if (r.method() === "POST" && /\/api\/fee-claims\//.test(r.url())) posts.push(new URL(r.url()).pathname.replace("/api/fee-claims/", "")); });
      await page.route("**/login/oauth/authorize*", (r) => { const u = new URL(r.request().url()); u.searchParams.set("login", login); return r.continue({ url: u.toString() }); });
      await page.route("**/api/analytics/project*", (r) => r.fulfill({ json: PROJECT(new URL(r.request().url()).searchParams.get("repo") ?? "") }));
      // the claim is signed by the test wallet and goes no further: these calls are answered here, and the staged chain moves as the program moves it
      await page.route("**/chain/rpc", async (r) => {
        const b = JSON.parse(r.request().postData() ?? "{}") as { id?: unknown; method?: string; params?: unknown[] };
        const ok = (result: unknown) => r.fulfill({ json: { jsonrpc: "2.0", id: b.id ?? 1, result } });
        if (b.method === "getGenesisHash" && genesis) return ok(genesis);
        if (b.method === "getLatestBlockhash") return ok({ context: { slot: 1 }, value: { blockhash: ZERO, lastValidBlockHeight: 1000 } });
        if (b.method === "getBlockHeight") return ok(1);
        if (b.method === "sendTransaction") {
          const sig = base58Encode(new Uint8Array(Buffer.from(String(b.params?.[0]), "base64")).subarray(1, 65));
          if (!hand.sent.includes(sig) && hand.landing !== null) land(hand.landing, hand.wallet.id);
          hand.sent.push(sig);
          return ok(sig);
        }
        if (b.method === "getSignatureStatuses") return ok({ context: { slot: 2 }, value: (b.params?.[0] as string[]).map((s) => (hand.sent.includes(s) ? { slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null)) });
        if (b.method === "getTransaction") return ok(null);
        return r.continue();
      });
      const shot = (name: string, full = true) => page.screenshot({ path: join(SHOTS, `claim-${W}-${name}.png`), fullPage: full });
      const state = (s: string) => page.waitForSelector(`[data-claim-card][data-claim-state="${s}"]`, { timeout: T });
      const lead = async () => (await page.locator("[data-claim-lead]").innerText()).replace(/\s+/g, " ");
      const steps = () => page.locator(".cl-steps li").evaluateAll((els) => els.map((e) => `${e.textContent!.replace(/\s+/g, " ").trim()}:${(e as HTMLElement).dataset.s}`).join(" "));
      const signIn = async () => { await page.click('[data-claim="oauth"], [data-claim="oauth-repo"]'); await page.waitForSelector("[data-claim-login]", { timeout: T }); };
      return { ctx, page, hand, shot, state, lead, steps, signIn };
    };

    // ================================================= a visitor who is not signed in
    {
      const { ctx, page, hand, shot, state, lead, steps } = await open("mona");
      await page.goto(`${base}/claim`, { waitUntil: "domcontentloaded" });
      await state("signed-out");
      await page.waitForSelector("[data-fees-list]", { timeout: T });
      const r = await rules(page, "#claim-root");
      check(`${W} signed out: one card, the headline, one sentence, one button`, (await page.locator("[data-claim-card] h2").innerText()) === "Claim fees for your repository"
        && (await lead()) === "Sign in with GitHub to see what is waiting for the repositories you have admin on."
        && (await page.locator("[data-claim-card] .cl-act .wl-btn").evaluateAll((els) => els.map((e) => e.textContent!.trim())).then((b) => JSON.stringify(b))) === JSON.stringify(["Sign in with GitHub"]), await lead());
      check(`${W} signed out: the steps are one line (GitHub, Wallet, Claim), GitHub in hand, and no panel waits for a step`, (await steps()) === "1GitHub:now 2Wallet:todo 3Claim:todo" && (await page.locator("#claim-root .panel").count()) === 0, await steps());
      check(`${W} signed out: the true and short facts are on the page`, /It asks for no access to your code, and no token is kept\.|The sign-in asks for no access to your code, and no token is kept\./.test(r.text) && r.text.includes("Only someone with admin on the repository can claim."), r.text.slice(0, 300));
      const tiles = (await page.locator("[data-claim-stats] .stat").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ")))).join(" | ");
      check(`${W} the four tiles are Core's own figures, US dollars first`, tiles === "Waiting now $886.84 2,217,104 $UNITS | Claimed so far $16.00 40,000 $UNITS, at today's price | Repositories receiving fees 4 3 with fees waiting | Agents sharing fees 5 20% of their fees each", tiles);
      const rows = await page.locator("[data-fees-repo]").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ")));
      check(`${W} the board lists what waits, largest first: repository, agents, since when, the amount, and a Claim`, rows.length === 3 && /^acme\/engine 2 agents, waiting since .+ \$530\.96 1,327,407 \$UNITS Details Claim$/.test(rows[0]!) && /^mona\/tools 1 agent, .+\$331\.88/.test(rows[1]!) && /^octocat\/Hello-World .+\$24\.00 60,000 \$UNITS/.test(rows[2]!), rows.join(" | "));
      check(`${W} signed out: the page's rules and a maintainer's words`, clean(r), why(r));
      const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
      const [card, how, pageBox] = [await box("[data-claim-card]"), await box("[data-claim-how]"), await box(".cl-page")];
      const maxW = await page.evaluate(() => { const probe = document.createElement("div"); probe.style.cssText = "max-width:calc(1440px - 2 * var(--pad-x));width:100000px"; document.body.appendChild(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return [w, parseFloat(getComputedStyle(document.querySelector(".cl-page")!).maxWidth)]; });
      check(`${W} the content width is the other pages' (1440 less the two gutters), centred`, Math.abs(maxW[0]! - maxW[1]!) < 0.5 && pageBox.width <= maxW[0]! + 0.5 && Math.abs(pageBox.x - (width - pageBox.x - pageBox.width)) <= 1, `${maxW.join(" vs ")}, page ${pageBox.x}+${pageBox.width}`);
      check(width >= 1100 ? `${W} two columns: the card and the board left, How this works right` : `${W} one column, the card above How this works`, width >= 1100 ? how.x > card.x + card.width && Math.abs(how.y - card.y) < 4 : how.y > card.y + card.height && Math.abs(how.x - card.x) < 2, `card ${JSON.stringify(card)} how ${JSON.stringify(how)}`);
      await shot("01-signed-out");

      // "How this works" opens in place with the bounty explanation's toggle
      await page.click("[data-claim-how] [data-rq-toggle]");
      const panel = page.locator("[data-claim-how] .rq-panel");
      const howText = (await panel.innerText()).replace(/\s+/g, " ");
      check(`${W} How this works opens in place and says where the money comes from, who claims, the proof, the cost and the team rule`, (await panel.isVisible()) && howText.includes("share 20% of the agent's fees with the owners of the repository it works on") && howText.includes("Anyone GitHub says has admin on the repository")
        && howText.includes("The sign-in asks for no access to your code, and the answer is used once: no token is kept.") && howText.includes("You pay the network fee") && howText.includes("Any one admin can claim all of it, first come.") && howText.includes("a team should agree on one wallet"), howText.slice(0, 300));
      const hr = await rules(page, "[data-claim-how]");
      check(`${W} How this works follows the page's rules`, clean(hr), why(hr));
      await shot("02-how-this-works");
      await page.click("[data-claim-how] [data-rq-toggle]");

      // the search in the heading: the result is a small card, no panel
      await page.fill('[name="cl_lookup"]', "octocat/Hello-World");
      await page.press('[name="cl_lookup"]', "Enter");
      await page.waitForSelector(`[data-claim-lookup="${HELLO.id}"]`, { timeout: T });
      const res = (await page.locator("[data-claim-lookup]").innerText()).replace(/\s+/g, " ");
      check(`${W} search: the result shows what waits, what was claimed, who shares and the page to share`, /^octocat\/Hello-World Fees waiting Waiting \$24\.00 60,000 \$UNITS Claimed so far \$16\.00 40,000 \$UNITS From 1 agent: .+, 20% of its fees\. Only someone with admin on it can claim\. Page to share Clear$/.test(res)
        && (await page.locator("[data-claim-share]").getAttribute("href")) === "/claim/octocat/Hello-World", res);
      check(`${W} search: the address names the repository and the card's sign-in asks GitHub about it`, new URL(page.url()).searchParams.get("repo") === "octocat/Hello-World" && (await page.locator('[data-claim="oauth-repo"]').getAttribute("data-repo")) === "octocat/Hello-World"
        && (await lead()) === "Sign in with GitHub to claim the fees waiting for octocat/Hello-World.", await lead());
      await shot("03-search-result");
      await page.fill('[name="cl_lookup"]', "mona/unrelated");
      await page.click('[data-claim="lookup"]');
      await page.waitForSelector(`[data-claim-lookup="${OCTO.id}"]`, { timeout: T });
      const un = (await page.locator("[data-claim-lookup]").innerText()).replace(/\s+/g, " ");
      check(`${W} search: a repository no agent shares fees with says so, names no figure, and the sign-in is the plain one`, /No fees shared No agent shares fees with this repository, so there is nothing to claim for it\. Launch an agent on it Clear/.test(un) && !/\$\d/.test(un) && (await page.locator('[data-claim="oauth"]').count()) === 1, un);
      await shot("04-search-nothing-shared", false);
      for (const [typed, said] of [["nobody/nothing", "GitHub has no public repository named nobody/nothing."], ["not a repo", "Type a repository as owner/name."]] as const) {
        await page.fill('[name="cl_lookup"]', typed);
        await page.press('[name="cl_lookup"]', "Enter");
        await page.waitForFunction((t) => document.querySelector("[data-claim-lookup-err]")?.textContent === t, said, { timeout: T }).catch(() => undefined);
        check(`${W} search: "${typed}" answers "${said}"`, (await page.locator("[data-claim-lookup-err]").innerText().catch(() => "")) === said, await page.locator('[data-cl-slot="result"]').innerText());
      }
      await page.route("**/api/fee-claims/recipients?*", (r) => r.fulfill({ status: 502, json: { error: "github_unreachable", message: "GitHub answered HTTP 503" } }));
      await page.fill('[name="cl_lookup"]', "acme/engine");
      await page.press('[name="cl_lookup"]', "Enter");
      await page.waitForFunction(() => document.querySelector("[data-claim-lookup-err]")?.textContent === "GitHub did not answer. Try again.", null, { timeout: T }).catch(() => undefined);
      check(`${W} search: GitHub not answering is said in words`, (await page.locator("[data-claim-lookup-err]").innerText().catch(() => "")) === "GitHub did not answer. Try again.");
      await shot("05-search-github-did-not-answer", false);
      await page.unroute("**/api/fee-claims/recipients?*");

      // a Claim button of the board opens the repository here, without loading the page again
      await page.evaluate(() => ((window as any).__same = true));
      await page.click('[data-fees-repo="acme/engine"] [data-fees-claim]');
      await page.waitForSelector(`[data-claim-lookup="${ENGINE.id}"]`, { timeout: T });
      check(`${W} the board's Claim lands in the flow on that repository, on the same page`, (await page.evaluate(() => (window as any).__same === true)) && (await page.locator('[data-claim="oauth-repo"]').getAttribute("data-repo")) === "acme/engine" && new URL(page.url()).searchParams.get("repo") === "acme/engine");
      await page.click('[data-claim="lookup-clear"]');

      // the gist alternative: one small link that opens in place
      const gist = page.locator("details.cl-gist");
      check(`${W} the gist alternative is one link, closed`, (await gist.locator("summary").innerText()) === "Another way to prove it" && !(await gist.evaluate((d) => (d as HTMLDetailsElement).open)));
      // the board's Claim scrolled the page to the card with an animation: a click sent while it still moves can miss, so it is sent until it lands
      for (let i = 0; i < 5 && !(await gist.evaluate((d) => (d as HTMLDetailsElement).open)); i++) {
        await page.waitForTimeout(600);
        await gist.locator("summary").click();
      }
      await page.click('details.cl-gist [data-claim="connect"]');
      await page.waitForSelector('[name="cl_login"]', { timeout: T });
      check(`${W} a wallet connected before the sign-in already counts`, (await steps()) === "1GitHub:now Wallet:done 3Claim:todo", await steps());
      await page.fill('[name="cl_login"]', "mona");
      await page.click('[data-claim="gist-sign"]');
      await page.waitForSelector("[data-claim-gist-text]", { timeout: T });
      check(`${W} the gist alternative opens in place and gives the text to post`, (await page.locator("[data-claim-gist-text]").inputValue()).includes(`claims units fees with the Solana wallet ${hand.wallet.id}`) && (await gist.evaluate((d) => (d as HTMLDetailsElement).open)));
      await page.fill('[name="cl_gist"]', "https://example.com/not-a-gist");
      await page.click('[data-claim="gist-verify"]');
      await page.waitForSelector("[data-claim-err]", { timeout: T });
      check(`${W} a wrong gist address is refused in words`, (await page.locator("[data-claim-err]").innerText()).trim() === "That is not a gist address. It looks like https://gist.github.com/you/0123abcd.", await page.locator("[data-claim-err]").innerText());
      const gr = await rules(page, "#claim-root");
      check(`${W} the gist alternative follows the page's rules`, clean(gr), why(gr));
      await page.locator("[data-claim-card]").scrollIntoViewIfNeeded();
      await shot("06-another-way-to-prove-it");

      // the visitor pressed Cancel at GitHub: the callback sends them back with the reason
      const start = await (await fetch(`${base}/api/fee-claims/oauth/start?json=1`)).json() as { state: string };
      await page.goto(`http://127.0.0.1:${CORE_PORT}/v1/fee-claims/oauth/callback?error=access_denied&state=${start.state}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-claim-err]", { timeout: T });
      check(`${W} a sign-in cancelled at GitHub comes back to the page with a sentence, and the address is clean`, (await page.locator("[data-claim-err]").innerText()).trim() === "You cancelled the GitHub sign-in. Nothing was shared." && new URL(page.url()).pathname === "/claim" && new URL(page.url()).hash === ""
        && (await page.locator('[data-claim="oauth"]').count()) === 1, page.url());
      await shot("07-sign-in-cancelled", false);

      // the site not answering
      await page.route("**/api/fee-claims/providers*", (r) => r.abort());
      await page.goto(`${base}/claim`, { waitUntil: "domcontentloaded" });
      await state("unreachable");
      check(`${W} the site not answering: a sentence and Try again`, (await lead()) === "The site did not answer, so this page cannot tell what is waiting. Try again." && (await page.locator('[data-claim="retry"]').innerText()) === "Try again");
      await shot("08-site-did-not-answer", false);
      await page.unroute("**/api/fee-claims/providers*");
      await page.click('[data-claim="retry"]');
      await state("signed-out");
      check(`${W} Try again brings the card back`, (await page.locator('[data-claim="oauth"]').count()) === 1);
      await ctx.close();
    }

    // ================================================= the page of one repository, and the project page's line
    {
      const { ctx, page, shot, state } = await open("mona");
      await page.goto(`${base}/claim/acme/engine`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-fees-page="waiting"]', { timeout: T });
      const one = await rules(page, ".fw-page");
      check(`${W} /claim/acme/engine: the amount leads, with the figures, the agents and a primary Claim that names the amount`, (await page.locator("[data-fees-h]").innerText()).replace(/\s+/g, " ") === "$530.96 is waiting for the owners of acme/engine"
        && /Waiting \$530\.96 1,327,407 \$UNITS since .+ Claimed so far nothing yet Agents sharing fees 2/.test(one.text) && /20% of its fees, shared since/.test(one.text)
        && (await page.locator(".fw-page [data-fees-claim]").innerText()) === "Claim $530.96" && /primary/.test((await page.locator(".fw-page [data-fees-claim]").getAttribute("class")) ?? ""), one.text);
      check(`${W} /claim/acme/engine follows the page's rules and has the Claim page's width`, clean(one) && (await page.evaluate(() => getComputedStyle(document.querySelector(".fw-page")!).maxWidth)) !== "none", why(one));
      await shot("09-repository-page");
      await page.click(".fw-page [data-fees-claim]");
      await state("signed-out");
      await page.waitForSelector(`[data-claim-lookup="${ENGINE.id}"]`, { timeout: T });
      check(`${W} its Claim lands in the flow with the repository preselected`, new URL(page.url()).pathname === "/claim" && new URL(page.url()).searchParams.get("repo") === "acme/engine" && (await page.locator('[data-claim="oauth-repo"]').getAttribute("data-repo")) === "acme/engine"
        && (await page.locator('[name="cl_lookup"]').inputValue()) === "acme/engine");
      await shot("10-preselected-signed-out");
      await page.goto(`${base}/claim/acme/quiet`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-fees-page="empty"]', { timeout: T });
      const q = await rules(page, ".fw-page");
      check(`${W} /claim/acme/quiet: nothing waiting is said plainly, with no figure made up and a quiet Claim`, /Nothing is waiting for the owners of acme\/quiet/.test(q.text) && /1 agent shares fees with/.test(q.text) && clean(q) && (await page.locator(".fw-page [data-fees-claim]").innerText()) === "Claim", why(q));
      await shot("11-repository-page-nothing-waiting");
      await page.goto(`${base}/claim/nobody/nothing`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-fees-page="none"]', { timeout: T });
      const n = await rules(page, ".fw-page");
      check(`${W} /claim/nobody/nothing: no fees are shared with it, and what would change that`, /No fees are shared with nobody\/nothing/.test(n.text) && /Launch an agent on it/.test(n.text) && !/\$\d/.test(n.text) && clean(n), why(n));
      await shot("12-repository-page-nothing-shared", false);
      await page.goto(`${base}/projects/acme/engine`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#fees-waiting", { timeout: T });
      const s = await rules(page, "#fees-waiting");
      check(`${W} the project page: the line for the owners, and a primary Claim with the amount that opens the flow on it`, s.text.includes("$530.96 1,327,407 $UNITS is waiting for the owners of acme/engine. Anyone with admin on the repository can claim it.")
        && (await page.locator("#fees-waiting [data-fees-claim]").innerText()) === "Claim $530.96" && (await page.locator("#fees-waiting [data-fees-claim]").getAttribute("href")) === "/claim?repo=acme%2Fengine" && clean(s), why(s));
      await page.locator("#fees-waiting").scrollIntoViewIfNeeded();
      await shot("13-project-page", false);
      await ctx.close();
    }

    // ================================================= signed in: nothing shared, nothing waiting, not an admin, another wallet's turn
    {
      const { ctx, page, shot, state, lead, signIn, steps } = await open("nemo");
      await page.goto(`${base}/claim`, { waitUntil: "domcontentloaded" });
      await state("signed-out");
      await signIn();
      await state("none");
      const t = (await page.locator("[data-claim-card]").innerText()).replace(/\s+/g, " ");
      check(`${W} signed in, no repository of theirs receives fees: one quiet line, what would change it, and the way to do it`, (await lead()) === "None of your repositories receive fees yet." && t.includes("That changes when someone launches an agent on one of them and shares its fees with the owners.")
        && t.includes("Signed in as nemo Sign out") && (await page.locator("[data-claim-none] a").getAttribute("href")) === "/launch" && (await page.locator("[data-claim-card] .wl-btn").count()) === 0, t);
      check(`${W} signed in: GitHub is ticked`, (await steps()).startsWith("GitHub:done"), await steps());
      await shot("14-signed-in-none-receive-fees", false);
      await page.click('[data-claim="signout"]');
      await state("signed-out");
      check(`${W} Sign out returns to the sign-in`, (await page.locator('[data-claim="oauth"]').count()) === 1);
      await ctx.close();
    }
    {
      const { ctx, page, shot, state, lead, signIn } = await open("quinn");
      await page.goto(`${base}/claim`, { waitUntil: "domcontentloaded" });
      await state("signed-out");
      await signIn();
      await state("connect");
      await page.click('[data-claim="connect"]');
      await state("empty");
      const t = (await page.locator("[data-claim-card]").innerText()).replace(/\s+/g, " ");
      check(`${W} signed in with a wallet, fees shared but nothing waiting: said plainly, the repository listed with no button`, (await lead()) === "Nothing is waiting right now. Fees arrive here as the agents working on your repositories earn them." && /acme\/quiet From 1 agent Nothing waiting/.test(t) && (await page.locator('[data-claim="claim"]').count()) === 0, t);
      await shot("15-signed-in-nothing-waiting", false);
      await ctx.close();
    }
    {
      const { ctx, page, hand, shot, state, lead, signIn } = await open("octocat");
      // octocat pushes to acme/engine without admin: GitHub does not report admin, as for an organisation that has not approved the app
      await page.goto(`${base}/claim?repo=acme/engine`, { waitUntil: "domcontentloaded" });
      await state("signed-out");
      await page.waitForSelector(`[data-claim-lookup="${ENGINE.id}"]`, { timeout: T });
      await signIn();
      await state("connect");
      const note = (await page.locator("[data-claim-note]").innerText()).replace(/\s+/g, " ");
      const mine = await page.locator("[data-claim-repo]").evaluateAll((els) => els.map((e) => e.textContent!.trim()));
      check(`${W} signed in for a repository GitHub does not report admin on: the organisation sentence, and only their own repository listed`, note === "GitHub did not say this account has admin on acme/engine. For an organisation's repository, an owner of the organisation may first have to approve the units app on GitHub's sign-in screen."
        && JSON.stringify(mine) === JSON.stringify(["octocat/Hello-World"]) && (await page.locator('[data-claim="oauth-repo"]').innerText()) === "Sign in again for this repository", note);
      check(`${W} signed in without a wallet: Connect wallet is the one primary button, with what waits already said`, (await lead()) === "$24.00 is waiting for octocat/Hello-World. Connect the wallet it should go to."
        && JSON.stringify(await page.locator("[data-claim-card] .wl-btn.primary").evaluateAll((els) => els.map((e) => e.textContent!.trim()))) === JSON.stringify(["Connect wallet"]), await lead());
      await page.locator("[data-claim-card]").scrollIntoViewIfNeeded();
      await shot("16-signed-in-connect-wallet-not-admin");
      await page.click('[data-claim="connect"]');
      await page.waitForSelector('[data-claim-balances][data-state="move"]', { timeout: T });
      const row = (await page.locator("[data-claim-balances]").innerText()).replace(/\s+/g, " ");
      check(`${W} earlier claims went to another wallet: the row says so and offers the move, not a claim`, /Earlier claims for octocat\/Hello-World were paid to .{4}….{4}\./.test(row) && (await page.locator('[data-claim="claim"]').innerText()) === "Move claims to this wallet" && /\$16\.00 claimed so far/.test(row), row);
      const mr = await rules(page, "#claim-root");
      check(`${W} that state follows the page's rules`, clean(mr), why(mr));
      await shot("17-another-wallet-was-paid", false);
      // the sign-in ran out (here: a session Core no longer accepts): one sentence, and the card offers the sign-in again
      // a session whose signature does not check out (here: altered in the tab's storage) is refused by Core and dropped on load
      await page.evaluate(() => { const k = "units.fee-claim.session"; const s = JSON.parse(sessionStorage.getItem(k)!); s.session = `${s.session.split(".")[0]}.AAAA`; sessionStorage.setItem(k, JSON.stringify(s)); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await state("signed-out");
      check(`${W} a sign-in Core does not accept is dropped on load and the card offers the sign-in again`, (await page.locator("[data-claim-err]").count()) === 0 && (await page.locator('[data-claim-card] .cl-act [data-claim="oauth-repo"]').count()) === 1 && hand.msgs === 0);
      await ctx.close();
    }

    // ================================================= signed in with money waiting: one press per repository
    {
      const { ctx, page, hand, shot, state, lead, signIn, steps } = await open("mona");
      await page.goto(`${base}/claim`, { waitUntil: "domcontentloaded" });
      await state("signed-out");
      const tokensBefore = mock.tokenCalls.length;
      await signIn();
      await state("connect");
      const tokenCalls = mock.tokenCalls.slice(tokensBefore);
      check(`${W} the sign-in is the one Core always made: the user and the repositories that receive fees, nothing else`, tokenCalls.includes("GET /user") && tokenCalls.every((c) => c === "GET /user" || /^GET \/repositories\/\d+$/.test(c)) && mock.scopes.every((s) => s === ""), tokenCalls.join(", "));
      check(`${W} signed in, no wallet: the amounts show, no row has a button yet, Wallet is the step in hand`, (await lead()) === "$862.84 is waiting for 2 of your repositories. Connect the wallet it should go to." && (await page.locator('[data-claim="claim"]').count()) === 0 && (await steps()) === "GitHub:done 2Wallet:now 3Claim:todo", `${await lead()} | ${await steps()}`);
      await shot("18-signed-in-connect-wallet");
      await page.click('[data-claim="connect"]');
      await state("ready");
      const names = await page.locator("[data-claim-repo]").evaluateAll((els) => els.map((e) => e.textContent!.trim()));
      const buttons = await page.locator('[data-claim="claim"]').evaluateAll((els) => els.map((e) => e.textContent!.trim()));
      const t = (await page.locator("[data-claim-card]").innerText()).replace(/\s+/g, " ");
      check(`${W} ready: the repositories with money first with one button each, then the one with nothing waiting`, JSON.stringify(names) === JSON.stringify(["acme/engine", "mona/tools", "acme/quiet"]) && JSON.stringify(buttons) === JSON.stringify(["Claim $530.96", "Claim $331.88"])
        && (await lead()) === "$862.84 is waiting for 2 of your repositories." && /acme\/engine From 2 agents \$530\.96 1,327,407 \$UNITS Claim \$530\.96/.test(t) && /acme\/quiet From 1 agent Nothing waiting/.test(t), t);
      check(`${W} ready: who is signed in, the connected wallet that receives, and how often the wallet will ask`, t.includes("Signed in as mona Sign out") && t.includes(`Fees go to ${hand.wallet.id.slice(0, 4)}…${hand.wallet.id.slice(-4)} Change`) && t.includes("A claim asks your wallet twice: a free signature that shows the wallet is yours, then the claim itself.")
        && (await page.locator("[data-claim-wallet]").getAttribute("data-claim-wallet")) === hand.wallet.id && (await steps()) === "GitHub:done Wallet:done 3Claim:now", t);
      const rr = await rules(page, "#claim-root");
      check(`${W} ready: the page's rules and a maintainer's words`, clean(rr), why(rr));
      await shot("19-ready-to-claim");
      // where each amount came from stays one press away
      await page.locator('[data-claim-balances="5000001"] details.cl-from summary').click();
      const from = await page.locator('[data-claim-balances="5000001"] tr[data-claim-agent]').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ")));
      check(`${W} ready: each agent's share and what it has shared, behind "From 2 agents"`, from.length === 2 && from.every((x) => /^.{4}….{4} 20% \$[\d.]+ [\d,]+ \$UNITS$/.test(x)), from.join(" | "));
      await page.locator('[data-claim-balances="5000001"] details.cl-from summary').click();
      // Change opens the header's own account menu
      await page.click('[data-claim="wallet-change"]');
      await page.waitForFunction(() => document.querySelector("#cn-menu") && !(document.querySelector("#cn-menu") as HTMLElement).hidden, null, { timeout: 10_000 }).catch(() => undefined);
      check(`${W} Change opens the header's account menu`, await page.evaluate(() => !!document.querySelector("#cn-menu") && !(document.querySelector("#cn-menu") as HTMLElement).hidden));
      await page.keyboard.press("Escape");

      // the wallet refuses the first request: nothing is sent, the row says so, the button is back
      posts.length = 0;
      hand.refuse = true;
      await page.click('[data-claim="claim"][data-repo="5000001"]');
      await page.waitForSelector("[data-claim-err]", { timeout: T });
      check(`${W} the wallet refusing: one sentence in the row, nothing sent, the button back`, (await page.locator('[data-claim-balances="5000001"] [data-claim-err]').innerText()).trim() === "You declined in the wallet. Nothing was sent." && posts.length === 0 && (await page.locator('[data-claim="claim"][data-repo="5000001"]').isEnabled()), posts.join(","));
      await shot("20-wallet-declined", false);
      hand.refuse = false;

      // the sign-in ran out between the two requests (injected: the answer Core gives after its 15 minutes): one sentence, and the sign-in again
      await page.route("**/api/fee-claims/attest", (r) => r.fulfill({ status: 401, json: { error: "session_expired", message: "session expired; prove the account again" } }));
      await page.click('[data-claim="claim"][data-repo="5000001"]');
      await state("signed-out");
      check(`${W} the sign-in running out: one sentence, and Sign in with GitHub is the button again`, (await page.locator("[data-claim-err]").innerText()).trim() === "Your sign-in has run out. Sign in with GitHub again." && (await page.locator('[data-claim-card] .cl-act [data-claim="oauth"]').count()) === 1, await page.locator("[data-claim-card]").innerText());
      await shot("20b-sign-in-ran-out", false);
      await page.unroute("**/api/fee-claims/attest");
      await signIn();
      await state("ready");
      posts.length = 0;

      // one press: the free signature that shows the wallet is theirs, then the claim
      let release!: () => void;
      hand.holdMsg = new Promise<void>((r) => (release = r));
      const [m0, t0] = [hand.msgs, hand.txs];
      hand.landing = ENGINE.id;
      await page.click('[data-claim="claim"][data-repo="5000001"]');
      await page.waitForSelector('[data-claim-phase="prove"]', { timeout: T });
      const p1 = (await page.locator("[data-claim-busy]").innerText()).replace(/\s+/g, " ");
      check(`${W} claiming, part one: "Proving your wallet" in hand, "Claiming" next, and what the wallet is asking`, p1 === "Proving your wallet 2 Claiming Approve the message in your wallet. It is free and moves nothing." && (await page.locator('[data-claim="claim"]:not([disabled])').count()) === 0, p1);
      await shot("21-proving-your-wallet", false);
      let releaseTx!: () => void;
      hand.holdTx = new Promise<void>((r) => (releaseTx = r));
      release();
      await page.waitForSelector('[data-claim-phase="claim"]', { timeout: T });
      await page.waitForFunction(() => /Approve the claim/.test(document.querySelector("[data-claim-busy]")?.textContent ?? ""), null, { timeout: T });
      const p2 = (await page.locator("[data-claim-busy]").innerText()).replace(/\s+/g, " ");
      check(`${W} claiming, part two: the first part ticked, "Claiming" in hand, with no second press in between`, p2 === "Proving your wallet Claiming Approve the claim in your wallet. It costs only the network fee." && hand.msgs === m0 + 1, p2);
      await shot("22-claiming", false);
      releaseTx();
      await page.waitForSelector("[data-claim-tx]", { timeout: T });
      await page.waitForFunction(() => !document.querySelector("[data-claim-busy]"), null, { timeout: T });
      hand.holdMsg = hand.holdTx = null;
      const ok = (await page.locator("[data-claim-done]").innerText()).replace(/\s+/g, " ");
      const sig = (await page.locator("[data-claim-tx]").getAttribute("data-claim-tx"))!;
      check(`${W} claimed: what arrived and where, the transaction link, and that the next fees arrive here`, new RegExp(`^\\$530\\.96 arrived in ${hand.wallet.id.slice(0, 4)}…${hand.wallet.id.slice(-4)}\\. 1,327,407 \\$UNITS See the transaction · The next fees arrive here as agents earn them\\.$`).test(ok)
        && (await page.locator("[data-claimed]").getAttribute("data-claimed")) === "1327407400000" && hand.sent.includes(sig) && (await page.locator("[data-claim-tx]").getAttribute("href"))!.startsWith(`https://explorer.solana.com/tx/${sig}`)
        && (await page.locator('[data-claim-balances="5000001"] [data-claimable]').getAttribute("data-claimable")) === "0", ok);
      check(`${W} the first claim took two wallet approvals (a message, then the transaction) and the same two requests as before, in order`, hand.msgs === m0 + 1 && hand.txs === t0 + 1 && JSON.stringify(posts) === JSON.stringify(["wallet", "attest"]), `${hand.msgs - m0} message, ${hand.txs - t0} transaction; ${posts.join(",")}`);
      check(`${W} after it the page says one approval, and the other repository still leads with its button`, (await page.locator("[data-claim-prompts]").getAttribute("data-claim-prompts")) === "1" && (await page.locator("[data-claim-prompts]").innerText()) === "A claim asks your wallet once."
        && (await lead()) === "$331.88 is waiting for mona/tools." && (await page.locator("[data-claim-wallet]").getAttribute("data-claim-proved")) === "1");
      await shot("23-claimed");
      // the second repository: one approval
      posts.length = 0;
      hand.landing = TOOLS.id;
      const [m1, t1] = [hand.msgs, hand.txs];
      await page.click('[data-claim="claim"][data-repo="5000002"]');
      await page.waitForSelector('[data-claim-balances="5000002"] [data-claim-tx]', { timeout: T });
      await page.waitForFunction(() => !document.querySelector("[data-claim-busy]"), null, { timeout: T });
      check(`${W} the second claim took one wallet approval (the transaction) and one request`, hand.msgs === m1 && hand.txs === t1 + 1 && JSON.stringify(posts) === JSON.stringify(["attest"]), `${hand.msgs - m1} message, ${hand.txs - t1} transaction; ${posts.join(",")}`);
      check(`${W} everything claimed: the card says so and the Claim step is ticked`, (await lead()) === "Claimed. The next fees arrive here as agents earn them." && (await steps()) === "GitHub:done Wallet:done Claim:done", `${await lead()} | ${await steps()}`);
      const dr = await rules(page, "#claim-root");
      check(`${W} claimed: the page's rules and a maintainer's words`, clean(dr), why(dr));
      await shot("24-all-claimed");
      await ctx.close();
    }
    check(`${W} no page error in any state`, errors.length === 0, errors.join(" | "));
    // the staged chain goes back to what it was for the next width
    escrow(ENGINE.id, 1_327_407_400_000n, 0n, 0n);
    escrow(TOOLS.id, 829_696_100_000n, 0n, 0n);
    core.stop();
    core = startCore(seeded);
  }

  // ---- nothing shared anywhere: a Core whose chain holds no route
  core.stop();
  core = startCore(bare);
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await ctx.newPage();
    await page.goto(`${web.base}/claim`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-fees-empty]", { timeout: T });
    await page.waitForSelector('[data-claim-card][data-claim-state="signed-out"]', { timeout: T });
    const e = await rules(page, "#claim-root");
    const empty = (await page.locator("[data-fees-empty]").innerText()).replace(/\s+/g, " ");
    check(`${width} nothing shared anywhere: one short line and what fills the board, linked to the wizard`, empty === "No repository has fees waiting right now. This fills when an agent earns fees for a repository. Launch an agent with fees shared to its repository's owners." && (await page.locator("[data-fees-empty] a").getAttribute("href")) === "/launch", empty);
    const tiles = (await page.locator("[data-claim-stats] .stat").evaluateAll((els) => els.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " ")))).join(" | ");
    check(`${width} nothing shared anywhere: the tiles say zero and invent nothing`, tiles === "Waiting now $0 0 $UNITS | Claimed so far $0 0 $UNITS, at today's price | Repositories receiving fees 0 none yet | Agents sharing fees 0 none yet" && !/\d%/.test(e.text) && clean(e), `${tiles} ${why(e)}`);
    await page.screenshot({ path: join(SHOTS, `claim-${width}-25-nothing-shared-anywhere.png`), fullPage: true });
    await ctx.close();
  }
} catch (e) {
  failed = true;
  console.error(`FAIL  the run stopped: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  await browser.close();
  web?.stop();
  core.stop();
  mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
const bad = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - bad}/${checks.length} checks pass; screenshots in ${SHOTS}`);
process.exit(bad || failed ? 1 : 0);

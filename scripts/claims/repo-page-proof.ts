#!/usr/bin/env bun
// The Claim page and the wizard's fee tick under the repository model (docs/plans/GITHUB-FEE-CLAIMS.md
// section 11), in headless Chromium at 1280 and 390, with no transaction on any network.
//
// What is real: the Core module, its HTTP routes, the dashboard server, the page bundles, the wallet
// statement (a test wallet that really signs), the mock GitHub's OAuth and repository permissions.
// What is staged: the chain Core reads is a set of accounts built here (two routed repositories, one
// escrow keyed by an ACCOUNT id as the first build made them), so the page shows balances without a
// devnet transaction; the claim transaction itself is not sent (the program and the attested bytes
// are unchanged, and unit-tested in packages/core/test/fee-claims.test.ts).
//
//   bun scripts/claims/repo-page-proof.ts [--shots <dir>]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { accountDisc, claimPdas, decodeLaunchConfig, LAUNCH_PROGRAM_ID, launchPdas, Rpc, signBytes, Writer, type Address, type Signer } from "@units/chain";
import { generateAgentKey } from "@units/protocol";
import sites from "../../config/sites.json" with { type: "json" };
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { feeClaimsOf } from "../../packages/core/src/fee-claims.ts";
import { serve } from "../../packages/core/src/http.ts";
import { startMockGithub } from "./mock-github.ts";
import { startWeb } from "./page-proof.ts";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
// the dashboard never on 9667: it looks for a hosted runtime there by default and would call itself once a wallet connects
const [WEB, CORE_P] = (process.env.REPO_PAGE_PROOF_PORTS ?? "9668,9669").split(",").map(Number) as [number, number];
const PORTS = { web: WEB, mock: 0, core: CORE_P };
const SHOTS = arg("shots", join(tmpdir(), `units-repo-claim-proof-${Date.now()}`));
mkdirSync(SHOTS, { recursive: true });
for (const p of [PORTS.web, PORTS.core]) {
  let pid = "";
  try { pid = execFileSync("lsof", ["-ti", `:${p}`], { encoding: "utf8" }).trim(); } catch { /* free */ }
  if (pid) throw new Error(`port ${p} is in use by pid ${pid}; not binding`);
}

const checks: { name: string; ok: boolean; note: string }[] = [];
const check = (name: string, ok: boolean, note = "") => { checks.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`); };

// ---- the mock GitHub: Mona administers an organisation's repository and owns one herself; octocat only pushes to the organisation's
const MONA = { id: 2, login: "mona", name: "Mona" }, OCTO = { id: 583231, login: "octocat" }, ACME = { id: 9919, login: "acme", type: "Organization" as const };
const ENGINE = { id: 5000001, full_name: "acme/engine", admins: ["mona"], members: ["octocat"] };
const TOOLS = { id: 5000002, full_name: "mona/tools", admins: ["mona"] };
const HELLO = { id: 1296269, full_name: "octocat/Hello-World", admins: ["octocat"] };
const mock = startMockGithub({ port: PORTS.mock, users: [MONA, OCTO, ACME], repos: [ENGINE, TOOLS, HELLO, { id: OCTO.id, full_name: "mona/unrelated", admins: ["mona"] }], clientId: "units-proof", clientSecret: "proof-secret" });

// ---- the staged chain
const accounts = new Map<Address, { owner: string; data: Uint8Array }>();
const acct = (name: string, w: Writer) => ({ owner: LAUNCH_PROGRAM_ID, data: new Writer().bytes(accountDisc(name)).bytes(w.done()).done() });
const ZERO = "11111111111111111111111111111111";
const tokenAccount = (amount: bigint) => { const d = new Uint8Array(165); new DataView(d.buffer).setBigUint64(64, amount, true); return { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: d }; };
const attestor = generateAgentKey();
const SHARE_BPS = 2000; // the staged ClaimConfig: min = max, the owner's one share
accounts.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(attestor.id).u16(SHARE_BPS).u16(SHARE_BPS).i64(604_800).i64(86_400).i64(600).bool(false).u8(255)));
const escrows = new Map<number, bigint>();
function routed(id: number, repoUrl: string, accrued: bigint) {
  const agent = generateAgentKey().id;
  accounts.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(id).u16(SHARE_BPS).i64(Math.floor(Date.now() / 1000) - 3600).u64(0).u16(0).i64(0).u64(accrued).u64(accrued).u32(0).u8(254)));
  accounts.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(generateAgentKey().id).address(generateAgentKey().id).fixed32("ab".repeat(32)).string(repoUrl)));
  const total = (escrows.get(id) ?? 0n) + accrued;
  escrows.set(id, total);
  accounts.set(claimPdas.escrow(id), acct("ClaimEscrow", new Writer().u64(id).address(ZERO).address(ZERO).i64(0).u64(total).u64(0).u64(0).u8(255).u8(254)));
  accounts.set(claimPdas.vault(id), tokenAccount(total));
  return agent;
}
// staged amounts in base units (6 decimals); two agents work on acme/engine
routed(ENGINE.id, "https://github.com/acme/engine", 912_592_600_000n);
routed(ENGINE.id, "https://github.com/acme/engine", 414_814_800_000n);
routed(TOOLS.id, "https://github.com/mona/tools", 829_696_100_000n);
routed(HELLO.id, "https://github.com/octocat/hello-world", 100_000_000_000n);
routed(OCTO.id, "https://github.com/someone/else", 500_000_000_000n); // an account-keyed escrow of the first build
const raw = (a: Address) => { const x = accounts.get(a); return x ? { lamports: 1, owner: x.owner, executable: false, data: [Buffer.from(x.data).toString("base64"), "base64"] as [string, string] } : null; };
const chain = new Rpc(async (method, params) => {
  if (method === "getAccountInfo") return { value: raw(params[0] as Address) };
  if (method === "getMultipleAccounts") return { value: (params[0] as Address[]).map(raw) };
  if (method === "getProgramAccounts") {
    const filters = ((params[1] as { filters: { memcmp?: { offset: number; bytes: string } }[] }).filters ?? []).filter((f) => f.memcmp).map((f) => f.memcmp!);
    return [...accounts].filter(([, v]) => v.owner === params[0] && filters.every((f) => Buffer.from(v.data.subarray(f.offset)).subarray(0, Buffer.from(f.bytes, "base64").length).equals(Buffer.from(f.bytes, "base64"))))
      .map(([pubkey, v]) => ({ pubkey, account: raw(pubkey)! }));
  }
  throw new Error(`staged chain: ${method}`);
});

// ---- Core (this process) and the dashboard (a child)
process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
const dataDir = mkdtempSync(join(tmpdir(), "units-repo-claim-core-"));
const core = new Core({ dataDir, network: loadNetworkConfig("config/network.json"), adminId: generateAgentKey().id, clock: systemClock, trees: null, chainMode: true });
feeClaimsOf(core).configure({
  githubApi: mock.url, githubToken: null, rpc: chain, lineMint: generateAgentKey().id, attestor, network: "devnet", claimPage: `http://127.0.0.1:${PORTS.web}/claim`,
  oauth: { clientId: "units-proof", clientSecret: "proof-secret", authorizeUrl: `${mock.url}/login/oauth/authorize`, tokenUrl: `${mock.url}/login/oauth/access_token`,
    redirectUri: `http://127.0.0.1:${PORTS.core}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" },
});
const server = serve(core, { port: PORTS.core });
let web: Awaited<ReturnType<typeof startWeb>> | null = null;
const browser = await chromium.launch({ headless: true });

async function testWallet(ctx: Awaited<ReturnType<typeof browser.newContext>>, wallet: Signer) {
  await ctx.exposeFunction("__unitsSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
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
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async () => { throw new Error("this proof sends no transaction"); } },
        "solana:signMessage": { version: "1.0.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__unitsSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
}

/** The page's own rules, on what is rendered under `sel`. */
async function pageRules(page: import("@playwright/test").Page, sel: string) {
  return page.evaluate((s) => {
    const root = document.querySelector(s)!;
    const mono = [...root.querySelectorAll("*")].filter((e) => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).length;
    const text = (root as HTMLElement).innerText;
    return { mono, emDash: text.includes(String.fromCharCode(0x2014)), wide: document.documentElement.scrollWidth > window.innerWidth + 1, text,
      status: /devnet|testnet|\bmock\b|\btest\b|not open yet|coming soon|\bbeta\b/i.exec(text)?.[0] ?? null };
  }, sel);
}

try {
  // the dollar price is the public site's live indexer reading (a read-only GET); every other request stays on this machine
  web = await startWeb(PORTS.web, `http://127.0.0.1:${PORTS.core}`, sites.mainnet_site_url.replace(/\/+$/, ""));
  for (const width of [1280, 390]) {
    // ---- /claim as Mona (the mock signs in as its first user)
    const wallet = generateAgentKey() as unknown as Signer;
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await testWallet(ctx, wallet);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${web.base}/claim`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-claim="oauth"]', { timeout: 60_000 });
    const first = await pageRules(page, "#claim-root");
    check(`${width}: signed out, the page offers "Sign in with GitHub" and a repository search`, /Sign in with GitHub/.test(first.text) && /Check any repository/.test(first.text) && !first.status, first.status ?? "");
    await page.screenshot({ path: join(SHOTS, `claim-${width}-1-signed-out.png`), fullPage: true });
    const tokensBefore = mock.tokenCalls.length;
    await page.click('[data-claim="oauth"]');
    await page.waitForSelector("[data-claim-login]", { timeout: 60_000 });
    const tokenCalls = mock.tokenCalls.slice(tokensBefore);
    await page.waitForSelector('[data-claim="connect"]', { timeout: 30_000 });
    await page.click('[data-claim="connect"]');
    await page.waitForSelector("[data-claim-wallet]", { timeout: 60_000 });
    await page.waitForSelector("[data-claim-balances]", { timeout: 60_000 });
    const repos = await page.locator("[data-claim-repo]").evaluateAll((els) => els.map((e) => e.textContent!.trim()));
    check(`${width}: after the sign-in the page lists the repositories Mona has admin on that have fees routed to them, and no other`,
      JSON.stringify([...repos].sort()) === JSON.stringify(["acme/engine", "mona/tools"]), repos.join(", "));
    const claimable = await page.locator("[data-claim-balances]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-claim-balances"), e.querySelector("[data-claimable]")!.getAttribute("data-claimable")]));
    check(`${width}: each repository shows its escrow's balance read from chain`, JSON.stringify(Object.fromEntries(claimable)) === JSON.stringify({ [ENGINE.id]: "1327407400000", [TOOLS.id]: "829696100000" }), JSON.stringify(claimable));
    const r = await pageRules(page, "#claim-root");
    const moneyCells = await page.locator("tr[data-claim-agent] td:last-child").evaluateAll((els) => els.map((e) => e.textContent!.trim().replace(/\s+/g, " ")));
    const amountCells = await page.locator("[data-claim-balances] .cl-r-amt").evaluateAll((els) => els.map((e) => `${e.querySelector("b")!.textContent!.trim()} | ${e.querySelector("i")!.textContent!.trim()}`));
    check(`${width}: every amount is in US dollars (the live indexer price) with the coin amount beside it`,
      moneyCells.length === 3 && moneyCells.every((t) => /^\$[\d,.]+ [\d,.]+ \$UNITS$/.test(t)) && amountCells.length === 2 && amountCells.every((t) => /^\$[\d,.]+ \| [\d,.]+ \$UNITS/.test(t)), `${moneyCells[0]}; ${amountCells[0]}`);
    check(`${width}: the page says that any one admin can claim everything waiting`, r.text.includes("Any one admin of a repository can claim everything waiting for it, to the wallet they connect."));
    const buttons = await page.locator('[data-claim="claim"]').evaluateAll((els) => els.map((e) => [(e as HTMLButtonElement).dataset.repo, (e as HTMLButtonElement).disabled]));
    check(`${width}: a claim button per repository, enabled once a wallet is connected`, buttons.length === 2 && buttons.every((b) => b[1] === false), JSON.stringify(buttons));
    check(`${width}: Core used the sign-in token for the user and the routed repositories only`, tokenCalls.every((c) => c === "GET /user" || /^GET \/repositories\/\d+$/.test(c)) && tokenCalls.includes("GET /user"), tokenCalls.join(", "));
    const maxWidth = await page.evaluate(() => getComputedStyle(document.querySelector(".cl-page")!).maxWidth);
    check(`${width}: the content width of .cl-page is the one already set`, /px$/.test(maxWidth), maxWidth);
    check(`${width}: no console error, no monospace, no em dash, no horizontal scroll, no status wording`, !errors.length && !r.mono && !r.emDash && !r.wide && !r.status,
      [errors.join(" | ").slice(0, 200), r.mono ? `${r.mono} monospace` : "", r.emDash ? "em dash" : "", r.wide ? "horizontal scroll" : "", r.status ?? ""].filter(Boolean).join("; "));
    await page.screenshot({ path: join(SHOTS, `claim-${width}-2-repositories.png`), fullPage: true });
    // ---- lookup by repository: one Mona does not administer, and the account-keyed number
    await page.fill('[name="cl_lookup"]', "octocat/Hello-World");
    await page.click('[data-claim="lookup"]');
    await page.waitForSelector(`[data-claim-lookup="${HELLO.id}"]`, { timeout: 30_000 });
    check(`${width}: a search shows any repository's balance and offers the sign-in for it`, (await page.locator('[data-claim="oauth-repo"]').getAttribute("data-repo")) === "octocat/Hello-World");
    await page.fill('[name="cl_lookup"]', "mona/unrelated");
    await page.click('[data-claim="lookup"]');
    await page.waitForSelector(`[data-claim-lookup="${OCTO.id}"]`, { timeout: 30_000 }).catch(async (e) => { throw new Error(`lookup of mona/unrelated: ${(await page.locator(".cl-page").innerText()).slice(-600)} ${(e as Error).message.slice(0, 80)}`); });
    const lookedUp = await pageRules(page, "#claim-root");
    check(`${width}: a repository whose number equals an account-keyed escrow shows nothing to claim`, lookedUp.text.includes("No agent shares fees with this repository, so there is nothing to claim for it.") && !(await page.locator('[data-claim="oauth-repo"]').count()));
    await page.screenshot({ path: join(SHOTS, `claim-${width}-3-lookup.png`), fullPage: true });
    await ctx.close();

    // ---- /claim as octocat: a member of acme/engine without admin sees only the repository octocat owns
    const ctx2 = await browser.newContext({ viewport: { width, height: 1000 } });
    await testWallet(ctx2, generateAgentKey() as unknown as Signer);
    const p2 = await ctx2.newPage();
    await p2.route("**/login/oauth/authorize*", (route) => { const u = new URL(route.request().url()); u.searchParams.set("login", "octocat"); return route.continue({ url: u.toString() }); });
    await p2.goto(`${web.base}/claim`, { waitUntil: "domcontentloaded" });
    await p2.waitForSelector('[data-claim="oauth"]', { timeout: 60_000 });
    await p2.click('[data-claim="oauth"]');
    await p2.waitForSelector("[data-claim-login]", { timeout: 60_000 });
    await p2.waitForSelector("[data-claim-repo]", { timeout: 60_000 });
    const octoRepos = await p2.locator("[data-claim-repos] ~ .panel [data-claim-repo], [data-claim-repo]").evaluateAll((els) => [...new Set(els.map((e) => e.textContent!.trim()))]);
    check(`${width}: a member of acme/engine who is not an admin is not offered it`, JSON.stringify(octoRepos) === JSON.stringify(["octocat/Hello-World"]), octoRepos.join(", "));
    await ctx2.close();

    // ---- the wizard's tick: Core resolves the repository, the figure comes from the chain's ClaimConfig
    const ctx3 = await browser.newContext({ viewport: { width, height: 1000 } });
    await testWallet(ctx3, generateAgentKey() as unknown as Signer);
    const p3 = await ctx3.newPage();
    const errors3: string[] = [];
    p3.on("pageerror", (e) => errors3.push(e.message));
    // the browser reads LaunchConfig and ClaimConfig through the dashboard's RPC proxy. LaunchConfig is devnet's own (its feature
    // bit decides whether the tick shows at all); ClaimConfig is answered from the staged chain, so the figure on the page is the
    // staged one and the check below proves the page follows it
    // this proof's Core runs without the chain bridge, so its /v1/chain says it has read nothing; the Launch page waits on that
    await p3.route("**/api/chain", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ mode: "sim" }) }));
    const live = { features: null as number | null };
    await p3.route("**/chain/rpc", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (process.env.PAGE_PROOF_DEBUG) console.log("[rpc]", JSON.stringify(body).slice(0, 200));
      const one = (b: any) => {
        if (b?.method !== "getAccountInfo") return null;
        if (b.params?.[0] === claimPdas.config()) return { jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: raw(claimPdas.config()) } };
        return null;
      };
      if (!Array.isArray(body)) {
        const hit = one(body);
        if (hit) return route.fulfill({ contentType: "application/json", body: JSON.stringify(hit) });
        if (body?.method === "getAccountInfo" && body.params?.[0] === launchPdas.config()) {
          const res = await route.fetch();
          const j = await res.json();
          const d = j?.result?.value?.data?.[0];
          if (d) live.features = decodeLaunchConfig(new Uint8Array(Buffer.from(d, "base64"))).features;
          return route.fulfill({ response: res, body: JSON.stringify(j) });
        }
      }
      return route.continue();
    });
    if (process.env.PAGE_PROOF_DEBUG) p3.on("response", (r) => { if (/api\/(fee-claims|pools|github)|chain\//.test(r.url())) console.log("[net]", r.status(), r.url().slice(0, 110)); });
    await p3.goto(`${web.base}/launch?repo=octocat/Hello-World`, { waitUntil: "domcontentloaded" });
    const field = await p3.waitForSelector("[data-fee-route-field]", { state: "attached", timeout: 150_000 }).catch(() => null);
    if (!field) {
      check(`${width}: the wizard shows the fee tick`, false, `not rendered; devnet LaunchConfig.features = ${live.features} (bit 2 is the GitHub fee route), page errors: ${errors3.join(" | ").slice(0, 200)}; the page reads: ${(await p3.locator("#wallet-root").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 240)}`);
    } else {
      await p3.waitForFunction(() => !(document.querySelector('[name="l_fee_on"]') as HTMLInputElement).disabled, null, { timeout: 30_000 });
      const before = await p3.evaluate(() => ({ text: document.querySelector("#w-fee-text")!.textContent, checked: (document.querySelector('[name="l_fee_on"]') as HTMLInputElement).checked,
        repo: (document.querySelector('[name="l_fee_on"]') as HTMLInputElement).dataset.feeRepo, bps: (document.querySelector("[data-fee-route-field]") as HTMLElement).dataset.feeBps,
        inputs: [...document.querySelectorAll("[data-fee-route-field] input")].map((i) => (i as HTMLInputElement).type) }));
      check(`${width}: the wizard offers one tick, unticked, naming the repository and the share read from chain`,
        before.text === `Route ${SHARE_BPS / 100}% of this agent's fees to the owners of octocat/Hello-World` && before.checked === false && before.repo === String(HELLO.id) && before.bps === String(SHARE_BPS), JSON.stringify(before));
      check(`${width}: nothing to type and nothing to slide: the only control is the tick`, JSON.stringify(before.inputs) === JSON.stringify(["checkbox"]), before.inputs.join(","));
      // the tick is on the wizard's second step, The work
      await p3.fill('[name="l_name"]', "page proof");
      await p3.fill('[name="l_symbol"]', "PROOF");
      await p3.click('[data-act="lz-next"]');
      await p3.locator("#w-fee-text").click({ timeout: 15_000 });
      check(`${width}: the launcher ticks it`, await p3.locator('[name="l_fee_on"]').isChecked());
      await p3.screenshot({ path: join(SHOTS, `wizard-${width}-the-work.png`), fullPage: true });
      await p3.locator("[data-fee-route-field]").scrollIntoViewIfNeeded();
      const wr = await pageRules(p3, "[data-fee-route-field]");
      check(`${width}: the wizard field has no monospace, no em dash, no horizontal scroll, no status wording`, !wr.mono && !wr.emDash && !wr.wide && !wr.status, wr.status ?? "");
      await p3.locator("[data-fee-route-field]").screenshot({ path: join(SHOTS, `wizard-${width}-tick.png`) });
      // another repository in the field: the tick clears and names the new one
      await p3.fill('[name="l_repo"]', "https://github.com/acme/engine");
      await p3.waitForFunction(() => document.querySelector("#w-fee-text")!.textContent!.endsWith("acme/engine") && !(document.querySelector('[name="l_fee_on"]') as HTMLInputElement).disabled, null, { timeout: 30_000 });
      const after = await p3.evaluate(() => ({ checked: (document.querySelector('[name="l_fee_on"]') as HTMLInputElement).checked, repo: (document.querySelector('[name="l_fee_on"]') as HTMLInputElement).dataset.feeRepo }));
      check(`${width}: changing the repository clears the tick and points it at the new repository`, after.checked === false && after.repo === String(ENGINE.id), JSON.stringify(after));
    }
    await ctx3.close();
  }
} finally {
  await browser.close();
  web?.stop();
  server.stop(true);
  core.close();
  mock.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);

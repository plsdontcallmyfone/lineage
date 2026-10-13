#!/usr/bin/env bun
// Fees waiting for the owners (docs/plans/GITHUB-FEE-CLAIMS.md 12) in headless Chromium at 1280 and 390:
// the list on the Claim page, the section on a repository's project page, the page of one repository with
// the title and description a posted link previews with, and the empty states. No transaction on any
// network, no sign-in.
//
// What is real: the Core module and its HTTP route, the dashboard server (its preview tags included) and
// the page bundles. What is staged: the chain Core reads is a set of accounts built here (an escrow two
// agents route to, one partly claimed, one route that has earned nothing, and one keyed by an ACCOUNT id
// as the first build made them), the dollar price Core holds (0.0004 USD a coin, 6 decimals), GitHub (the
// mock), and the project page's own data (this Core has no unit; one answer of analytics/project is
// written here). The second half runs against a Core whose chain holds no route at all.
//
//   bun scripts/claims/waiting-proof.ts [--shots <dir>]      (WAITING_PROOF_PORTS=web,core; default 9666,9668)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { accountDisc, claimPdas, LAUNCH_PROGRAM_ID, Rpc, Writer, type Address } from "@units/chain";
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
const [WEB_PORT, CORE_PORT] = (process.env.WAITING_PROOF_PORTS ?? "9666,9668").split(",").map(Number) as [number, number];
const SHOTS = arg("shots", join(tmpdir(), `units-fees-waiting-proof-${Date.now()}`));
mkdirSync(SHOTS, { recursive: true });
for (const p of [WEB_PORT, CORE_PORT]) {
  let pid = "";
  try { pid = execFileSync("lsof", ["-ti", `:${p}`], { encoding: "utf8" }).trim(); } catch { /* free */ }
  if (pid) throw new Error(`port ${p} is in use by pid ${pid.replace(/\n/g, " ")}; not binding`);
}

const checks: { name: string; ok: boolean; note: string }[] = [];
const check = (name: string, ok: boolean, note = "") => { checks.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note.slice(0, 300)})` : ""}`); };

const MONA = { id: 2, login: "mona", name: "Mona" }, OCTO = { id: 583231, login: "octocat" }, ACME = { id: 9919, login: "acme", type: "Organization" as const };
const ENGINE = { id: 5000001, full_name: "acme/engine", admins: ["mona"] }, HELLO = { id: 1296269, full_name: "octocat/Hello-World", admins: ["octocat"] }, QUIET = { id: 5000003, full_name: "acme/quiet", admins: ["mona"] };
const mock = startMockGithub({ port: 0, users: [MONA, OCTO, ACME], repos: [ENGINE, HELLO, QUIET, { id: OCTO.id, full_name: "mona/unrelated", admins: ["mona"] }], clientId: "units-proof", clientSecret: "proof-secret" });

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
const config = (a: Accounts) => a.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(generateAgentKey().id).u16(2000).u16(2000).i64(604_800).i64(86_400).i64(600).bool(false).u8(255)));
const seeded: Accounts = new Map();
config(seeded);
const HOUR = 3600, now = Math.floor(Date.now() / 1000);
const route = (id: number, repoUrl: string, routed: bigint, setAt: number) => {
  const agent = generateAgentKey().id;
  seeded.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(id).u16(2000).i64(setAt).u64(0).u16(0).i64(0).u64(routed).u64(routed).u32(0).u8(254)));
  seeded.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(generateAgentKey().id).address(generateAgentKey().id).fixed32("ab".repeat(32)).string(repoUrl)));
};
const escrow = (id: number, accrued: bigint, claimed: bigint, seq: bigint) => {
  seeded.set(claimPdas.escrow(id), acct("ClaimEscrow", new Writer().u64(id).address(claimed ? generateAgentKey().id : ZERO).address(ZERO).i64(0).u64(accrued).u64(claimed).u64(seq).u8(255).u8(254)));
  seeded.set(claimPdas.vault(id), tokenAccount(accrued - claimed));
};
// base units, 6 decimals, at 0.0004 USD a coin: 1,327,407.4 coins = $530.96 from two agents; 100,000 routed and 40,000 claimed = $24.00 waiting
route(ENGINE.id, "https://github.com/acme/engine", 912_592_600_000n, now - 30 * HOUR);
route(ENGINE.id, "https://github.com/acme/engine", 414_814_800_000n, now - 6 * HOUR);
escrow(ENGINE.id, 1_327_407_400_000n, 0n, 0n);
route(HELLO.id, "https://github.com/octocat/hello-world", 100_000_000_000n, now - 50 * HOUR);
escrow(HELLO.id, 100_000_000_000n, 40_000_000_000n, 1n);
route(QUIET.id, "https://github.com/acme/quiet", 0n, now - HOUR);
escrow(QUIET.id, 0n, 0n, 0n);
route(OCTO.id, "https://github.com/someone/else", 500_000_000_000n, now - HOUR); // keyed by an ACCOUNT id: never listed
escrow(OCTO.id, 500_000_000_000n, 0n, 0n);
const bare: Accounts = new Map();
config(bare);

process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
const dirs: string[] = [];
function startCore(accounts: Accounts) {
  const dataDir = mkdtempSync(join(tmpdir(), "units-fees-waiting-core-"));
  dirs.push(dataDir);
  const core = new Core({ dataDir, network: loadNetworkConfig("config/network.json"), adminId: generateAgentKey().id, clock: systemClock, trees: null, chainMode: true });
  feeClaimsOf(core).configure({ githubApi: mock.url, githubToken: null, rpc: chainOf(accounts), lineMint: generateAgentKey().id, attestor: generateAgentKey(), network: "devnet", claimPage: `http://127.0.0.1:${WEB_PORT}/claim`,
    oauth: { clientId: "units-proof", clientSecret: "proof-secret", authorizeUrl: `${mock.url}/login/oauth/authorize`, tokenUrl: `${mock.url}/login/oauth/access_token`, redirectUri: `http://127.0.0.1:${CORE_PORT}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" }, usd: () => ({ ok: true, quote_usd: 0.0004, read_at: now, decimals: 6 }) });
  const server = serve(core, { port: CORE_PORT });
  return { stop: () => { server.stop(true); core.close(); } };
}

/** The page's own rules, on what is rendered under `sel`. */
async function rules(page: Page, sel: string) {
  return page.evaluate((s) => {
    const root = document.querySelector(s) as HTMLElement | null;
    if (!root) return { mono: 0, emDash: false, wide: false, text: "", status: "nothing rendered" as string | null };
    const mono = [...root.querySelectorAll("*")].filter((e) => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).length;
    const text = root.innerText.replace(/\s+/g, " ");
    return { mono, emDash: text.includes(String.fromCharCode(0x2014)), wide: document.documentElement.scrollWidth > window.innerWidth + 1, text,
      status: /devnet|testnet|\bmock\b|\btest\b|not open yet|coming soon|\bbeta\b|\bTBA\b/i.exec(text)?.[0] ?? null };
  }, sel);
}
const clean = (r: Awaited<ReturnType<typeof rules>>) => r.mono === 0 && !r.emDash && !r.wide && !r.status;
const why = (r: Awaited<ReturnType<typeof rules>>) => `mono ${r.mono}, em dash ${r.emDash}, sideways scroll ${r.wide}, wording ${r.status}: ${r.text.slice(0, 200)}`;
const PROJECT = (name: string) => ({ key: name, repo: `https://github.com/${name}`, github: true, classes: ["python"], live_agents: [], accepted: 0, reverted: 0, last_improvement_at: null, open_candidates: 0, lineages: [] });

let core = startCore(seeded);
let web: Awaited<ReturnType<typeof startWeb>> | null = null;
const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  // every market read of the pages goes to the public site's indexer, read only; everything else stays on this machine
  web = await startWeb(WEB_PORT, `http://127.0.0.1:${CORE_PORT}`, sites.mainnet_site_url.replace(/\/+$/, ""));
  const api = await (await fetch(`${web.base}/api/fee-claims/waiting`)).json() as any;
  check("Core through the dashboard: three repositories, largest first, none keyed by an account id", JSON.stringify(api.repositories.map((r: any) => r.repository.full_name)) === JSON.stringify(["acme/engine", "octocat/Hello-World", "acme/quiet"]), JSON.stringify(api.repositories.map((r: any) => [r.repository.full_name, r.waiting, r.waiting_usd])));
  const head = async (path: string) => { const t = await (await fetch(`${web!.base}${path}`)).text(); return { title: /<title>([^<]*)<\/title>/.exec(t)?.[1] ?? "", og: /property="og:title" content="([^"]*)"/.exec(t)?.[1] ?? "", desc: /name="description" content="([^"]*)"/.exec(t)?.[1] ?? "", card: /name="twitter:card"/.test(t) }; };
  const h = await head("/claim/acme/engine");
  check("a posted link to /claim/acme/engine previews with the amount and what it is", h.title === "$530.96 is waiting for the owners of acme/engine | units" && h.og === "$530.96 is waiting for the owners of acme/engine" && h.desc === "Fees from agents working on acme/engine, claimable by anyone with admin on the repository." && h.card, JSON.stringify(h));
  const hq = await head("/claim/acme/quiet");
  check("a repository with nothing waiting previews without a figure", hq.og === "Fees for the owners of acme/quiet" && !/\$/.test(hq.title), JSON.stringify(hq));
  check("no other page carries the tags", (await head("/claim")).og === "" && (await head("/projects/acme/engine")).og === "");

  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    const writes: string[] = [];
    page.on("request", (r) => { if (!["GET", "HEAD", "OPTIONS"].includes(r.method()) && !/\/chain\/rpc/.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
    await page.route("**/api/analytics/project*", (r) => { const name = new URL(r.request().url()).searchParams.get("repo") ?? ""; return r.fulfill({ json: PROJECT(name) }); });

    // the Claim page: the list under the claim steps
    await page.goto(`${web.base}/claim`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-fees-list]", { timeout: 60_000 });
    const names = await page.locator("[data-fees-repo]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.feesRepo));
    const l = await rules(page, "#claim-waiting");
    check(`${width}: the Claim page lists the repositories with fees waiting, largest first, and leaves out the empty one and the account-keyed one`, JSON.stringify(names) === JSON.stringify(["acme/engine", "octocat/Hello-World"]) && /Repositories with fees waiting/.test(l.text), JSON.stringify(names));
    check(`${width}: each row leads with US dollars and gives the coin amount after`, /\$530\.96 1,327,407 \$UNITS/.test(l.text) && /\$24\.00 60,000 \$UNITS/.test(l.text) && /2 agents, waiting since/.test(l.text), l.text);
    check(`${width}: the list follows the page's rules`, clean(l), why(l));
    const rowHref = await page.locator('[data-fees-repo="acme/engine"] a.fw-name').getAttribute("href");
    check(`${width}: a row links to the section on the repository's project page`, rowHref === "/projects/acme/engine#fees-waiting", String(rowHref));
    await page.locator("#claim-waiting").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `waiting-${width}-1-claim-list.png`), fullPage: true });

    // the project page section
    await page.goto(`${web.base}/projects/acme/engine`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#fees-waiting", { timeout: 60_000 });
    const s = await rules(page, "#fees-waiting");
    check(`${width}: the project page says what waits and who can claim it`, s.text.includes("$530.96 1,327,407 $UNITS is waiting for the owners of acme/engine. Anyone with admin on the repository can claim it.") && /From 2 agents:/.test(s.text) && /nothing claimed so far/.test(s.text) && /waiting since/.test(s.text), s.text);
    check(`${width}: its Claim button opens /claim on that repository, and the address to share is beside it`, (await page.locator("#fees-waiting [data-fees-claim]").getAttribute("href")) === "/claim?repo=acme%2Fengine" && (await page.locator("#fees-waiting [data-fees-share]").getAttribute("href")) === "/claim/acme/engine");
    check(`${width}: the section follows the page's rules`, clean(s), why(s));
    await page.locator("#fees-waiting").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `waiting-${width}-2-project.png`), fullPage: false });
    await page.goto(`${web.base}/projects/octocat/hello-world`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#fees-waiting", { timeout: 60_000 });
    const part = await rules(page, "#fees-waiting");
    check(`${width}: a partly claimed escrow shows what waits and what was claimed`, part.text.includes("$24.00 60,000 $UNITS is waiting for the owners of octocat/Hello-World") && part.text.includes("$16.00 40,000 $UNITS claimed so far"), part.text);
    await page.goto(`${web.base}/projects/mona/unrelated`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pjd-page", { timeout: 60_000 });
    await page.waitForTimeout(800);
    check(`${width}: a repository nothing is routed to has no such section`, (await page.locator("#fees-waiting").count()) === 0);

    // the page of one repository
    await page.goto(`${web.base}/claim/acme/engine`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-fees-page="waiting"]', { timeout: 60_000 });
    const one = await rules(page, ".fw-page");
    check(`${width}: /claim/acme/engine leads with the amount`, (await page.locator("[data-fees-h]").innerText()).replace(/\s+/g, " ") === "$530.96 is waiting for the owners of acme/engine" && /Agents routing to it 2/.test(one.text) && /20% of its fees/.test(one.text) && /Claimed so far nothing yet/.test(one.text), one.text);
    check(`${width}: its Claim button opens /claim on that repository`, (await page.locator(".fw-page [data-fees-claim]").getAttribute("href")) === "/claim?repo=acme%2Fengine");
    check(`${width}: the page of one repository follows the page's rules`, clean(one), why(one));
    await page.screenshot({ path: join(SHOTS, `waiting-${width}-3-repository.png`), fullPage: true });
    await page.click(".fw-page [data-fees-claim]");
    await page.waitForSelector("[data-claim-lookup]", { timeout: 60_000 });
    check(`${width}: Claim lands on the Claim page with the repository looked up`, new URL(page.url()).pathname === "/claim" && new URL(page.url()).searchParams.get("repo") === "acme/engine" && (await page.locator("[data-claim-lookup]").getAttribute("data-claim-lookup")) === String(ENGINE.id));
    await page.goto(`${web.base}/claim/acme/quiet`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-fees-page="empty"]', { timeout: 60_000 });
    const q = await rules(page, ".fw-page");
    check(`${width}: a route that has earned nothing says so, with no figure made up`, /Nothing is waiting for the owners of acme\/quiet/.test(q.text) && /1 agent routes a share of fees to/.test(q.text) && clean(q), why(q));
    await page.goto(`${web.base}/claim/nobody/nothing`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-fees-page="none"]', { timeout: 60_000 });
    const n = await rules(page, ".fw-page");
    check(`${width}: a repository nothing is routed to says so`, /No fees are routed to nobody\/nothing/.test(n.text) && !/\$/.test(n.text) && clean(n), why(n));
    await page.screenshot({ path: join(SHOTS, `waiting-${width}-4-none.png`), fullPage: false });
    check(`${width}: no page error and nothing written anywhere`, errors.length === 0 && writes.length === 0, [...errors, ...writes].join(" | "));
    await ctx.close();
  }

  // ---- the empty state: a Core whose chain holds no route
  core.stop();
  core = startCore(bare);
  const none = await (await fetch(`${web.base}/api/fee-claims/waiting`)).json() as any;
  check("with no route on chain Core serves an empty list and a zero total", none.repositories.length === 0 && none.total_waiting === "0", JSON.stringify(none).slice(0, 200));
  check("and a link previews without a figure", (await head("/claim/octocat/Hello-World")).og === "Fees for the owners of octocat/Hello-World");
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await ctx.newPage();
    await page.route("**/api/analytics/project*", (r) => r.fulfill({ json: PROJECT(new URL(r.request().url()).searchParams.get("repo") ?? "") }));
    await page.goto(`${web.base}/claim`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-fees-empty]", { timeout: 60_000 });
    const e = await rules(page, "#claim-waiting");
    check(`${width}: the Claim page's empty state is plain and names no figure`, /No repository has fees waiting\./.test(e.text) && /No agent routes fees to a repository yet\./.test(e.text) && !/\$\d/.test(e.text) && clean(e), why(e));
    await page.locator("#claim-waiting").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `waiting-${width}-5-empty-list.png`), fullPage: true });
    await page.goto(`${web.base}/projects/acme/engine`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pjd-page", { timeout: 60_000 });
    await page.waitForTimeout(800);
    check(`${width}: the project page has no section then`, (await page.locator("#fees-waiting").count()) === 0);
    await page.goto(`${web.base}/claim/acme/engine`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-fees-page="none"]', { timeout: 60_000 });
    check(`${width}: the page of one repository says nothing is routed to it`, /No fees are routed to acme\/engine/.test((await rules(page, ".fw-page")).text));
    await ctx.close();
  }
} catch (e) {
  failed = true;
  console.error(`FAIL  the run stopped: ${e instanceof Error ? e.message : String(e)}`);
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

// "Request a repository" in headless Chromium at 1280 and 390 (docs/plans/OPEN-BOUNTIES.md 10), with
// no transaction on any network:   bun test ./scripts/bounties/repo-request-ui.proof.ts
//
// Real: Core (a unit on github.com/example/fx, the board open), its routes, the repository check, the
// web server, the page bundles, the request statement (test wallets that really sign). Staged: the
// network behind the free reading (a stand-in that hands the reading a small tree per repository).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { generateAgentKey, repoId } from "@units/protocol";
import { openBountiesOf } from "../../packages/core/src/open-bounties.ts";
import { repoCheckOf, type RepoWork } from "../../packages/core/src/repo-check.ts";
import { repoRequestsOf } from "../../packages/core/src/repo-requests.ts";
import { setup, type Env } from "../../packages/core/test/helpers.ts";
import { startWeb } from "../claims/page-proof.ts";
import { CLEAN, freePort, pageRules, testWallet } from "./ui-kit.ts";

const CONFIG = { program: "Prog" + "1".repeat(28), admin: "A" + "1".repeat(31), pendingAdmin: null, mint: "M" + "1".repeat(31), tokenProgram: "T" + "1".repeat(31), launchProgram: "L" + "1".repeat(31), opened: 0n,
  settings: { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 7200, contestS: 1800, feeBps: 0, paused: false } };
const TREES: Record<string, Record<string, string>> = {
  "https://github.com/acme/parser": { "src/lib.rs": "pub fn f() {}\n", "tests/a.rs": "#[test]\nfn a() {}\n", "tests/b.rs": "#[test]\nfn b() {}\n" },
  "https://github.com/acme/notes": { "src/lib.rs": "pub fn f() {}\n" },
};
const first = generateAgentKey(), second = generateAgentKey();
let e: Env, web: Awaited<ReturnType<typeof startWeb>>, browser: Browser;

beforeAll(async () => {
  for (const k of ["UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES"]) process.env[k] = "1";
  e = await setup({ verifiers: 0 });
  e.clock.advance(Date.now() - e.clock.now()); // the browser signs with the real time
  const work: RepoWork = {
    async head(repo) { if (!TREES[repo]) throw new Error("the repository could not be read (it must be public and have a default branch)"); return "a".repeat(40); },
    async tree(repo, _c, dir) { for (const [p, c] of Object.entries(TREES[repo]!)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } },
  };
  repoCheckOf(e.core).work = work;
  repoRequestsOf(e.core); // its tables
  openBountiesOf(e.core).sync(CONFIG as never, [] as never); // the escrow program is configured: the board is open
  web = await startWeb(freePort(), e.base);
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  web?.stop();
  e?.close();
});

async function open(width: number, wallet: typeof first) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 } });
  const log: string[] = [];
  await testWallet(ctx, wallet, log);
  const page = await ctx.newPage();
  await page.goto(`${web.base}/bounties`);
  await page.locator("[data-repo-request]").waitFor({ timeout: 90_000 });
  return { ctx, page, log };
}
async function checkRepo(page: Page, repo: string, state: string) {
  await page.locator('[name="rq_repo"]').fill(repo);
  await page.locator('[data-request-act="check"]').click();
  await page.locator(`[data-request-state="${state}"]`).waitFor({ timeout: 60_000 });
  return (await page.locator("[data-repo-request]").innerText()).replace(/\s+/g, " ");
}
const text = async (page: Page, sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, " ").trim();

for (const width of [1280, 390]) {
  test(`check, request, +1 by a second wallet, and ready once a unit exists, at ${width}`, async () => {
    e.core.db.exec("DELETE FROM repo_request_signers; DELETE FROM repo_requests;");
    e.core.db.query("UPDATE lineages SET repo_id = ?").run(repoId("https://github.com/example/fx"));
    const a = await open(width, first);
    expect(await a.page.locator("[data-repo-requests]").count()).toBe(0); // nothing requested: no empty list
    expect(await text(a.page, "[data-repo-request]")).toContain("Want a bounty on a repository that is not in the list? Ask for it here.");
    // a repository that already has a unit: go and post
    expect(await checkRepo(a.page, "example/fx", "has_units")).toContain("example/fx can already be measured. Post a bounty on example/fx");
    expect(await a.page.locator("[data-request-post]").getAttribute("href")).toBe("/bounties?repo=example%2Ffx");
    expect(await a.page.locator('[data-request-act="send"]').count()).toBe(0);
    // one agents cannot work on: the reason, and no request is taken
    const no = await checkRepo(a.page, "https://github.com/acme/notes", "cannot");
    expect(no).toContain("Agents cannot work on acme/notes yet: it has no tests");
    expect(no).toContain("No request is taken for it.");
    expect(await a.page.locator('[data-request-act="send"]').count()).toBe(0);
    expect(await pageRules(a.page, ".bo-page")).toMatchObject(CLEAN);
    // one that can be measured: the request, with a note and a pledge that is called interest
    const can = await checkRepo(a.page, "acme/parser", "can_measure");
    expect(can).toContain("Agents can work on acme/parser: Rust, with tests of its own (2 test files found). It has no measurement yet.");
    expect(can).toContain("Nothing leaves your wallet and nothing is owed.");
    expect(can).toContain("A request is a message your wallet signs. No transaction, no cost.");
    await a.page.locator('[name="rq_pledge"]').fill("lots");
    await a.page.locator('[data-request-act="send"]').click();
    expect(await text(a.page, "[data-request-err]")).toBe("Enter the pledge as a number of US dollars, or leave it empty.");
    expect(a.log).toEqual([]); // nothing was signed for a figure that is not one
    await a.page.locator('[name="rq_note"]').fill("Faster parsing of <large> files");
    await a.page.locator('[name="rq_pledge"]').fill("250");
    await a.page.locator('[data-request-act="send"]').click();
    await a.page.locator("[data-request-done]").waitFor({ timeout: 60_000 });
    expect(await text(a.page, "[data-request-done]")).toContain("Your request for acme/parser is recorded.");
    expect(await text(a.page, "[data-request-ways]")).toBe("A repository gets its measurement when an agent is launched on it: the agent sets it up by itself before it starts work. Launch an agent on acme/parser.");
    expect(await a.page.locator("[data-request-launch]").getAttribute("href")).toBe("/launch?repo=acme%2Fparser");
    expect(a.log).toEqual(["signMessage"]);
    // the list: one request, the interest named as interest, the note cleaned, and this wallet marked
    const row = a.page.locator('[data-request="acme/parser"]');
    await row.waitFor({ timeout: 60_000 });
    expect(await row.getAttribute("data-request-row")).toBe("open");
    expect(await text(a.page, '[data-request="acme/parser"] [data-request-n]')).toBe("1");
    expect(await row.locator("[data-request-interest]").getAttribute("data-request-interest")).toBe("250");
    expect(await text(a.page, '[data-request="acme/parser"] [data-request-interest]')).toMatch(/^\$250/);
    expect(await text(a.page, '[data-request="acme/parser"]')).toContain("stated interest");
    expect(await text(a.page, '[data-request="acme/parser"] .bo-note')).toBe("Faster parsing of large files");
    expect(await row.locator("[data-request-mine]").count()).toBe(1);
    expect(await text(a.page, "[data-repo-requests]")).toContain("It is not escrowed and is not a reward on offer.");
    expect(await pageRules(a.page, ".bo-page")).toMatchObject(CLEAN);
    await a.ctx.close();

    // a second wallet: +1 from the list
    const b = await open(width, second);
    const row2 = b.page.locator('[data-request="acme/parser"]');
    await row2.waitFor({ timeout: 60_000 });
    await row2.locator("[data-request-plus]").click();
    await b.page.locator('[data-request-state="can_measure"]').waitFor({ timeout: 60_000 });
    expect(await text(b.page, "[data-request-count]")).toMatch(/^1 person has asked for it, with \$250(\.00)? of stated interest\.$/);
    expect(await text(b.page, '[data-request-act="send"]')).toBe("Add my request");
    await b.page.locator('[data-request-act="send"]').click();
    await b.page.locator("[data-request-done]").waitFor({ timeout: 60_000 });
    await b.page.locator('[data-request="acme/parser"] [data-request-mine]').waitFor({ timeout: 60_000 });
    expect(await text(b.page, '[data-request="acme/parser"] [data-request-n]')).toBe("2");
    expect(b.log).toEqual(["signMessage"]);
    expect(e.core.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM repo_request_signers").get()!.c).toBe(2);

    // a unit goes live on the repository: every requester sees it ready, and the request takes no more
    e.core.db.query("UPDATE lineages SET repo_id = ?").run(repoId("https://github.com/acme/parser"));
    await b.page.reload();
    const ready = b.page.locator('[data-request="acme/parser"] [data-request-ready]');
    await ready.waitFor({ timeout: 90_000 });
    expect(await text(b.page, '[data-request="acme/parser"] [data-request-ready]')).toBe("Ready: post your bounty");
    expect(await ready.getAttribute("href")).toBe("/bounties?repo=acme%2Fparser");
    expect(await b.page.locator('[data-request="acme/parser"] [data-request-plus]').count()).toBe(0);
    expect(await checkRepo(b.page, "acme/parser", "has_units")).toContain("acme/parser can already be measured");
    expect(await pageRules(b.page, ".bo-page")).toMatchObject(CLEAN);
    expect([...a.log, ...b.log].filter((x) => x.startsWith("signTransaction"))).toEqual([]);
    await b.ctx.close();
  }, 300_000);
}

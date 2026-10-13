// "Posted by an owner of owner/repo" in headless Chromium at 1280 and 390 (docs/plans/OPEN-BOUNTIES.md 9),
// with no transaction on any network:   bun test ./scripts/bounties/owner-mark-ui.proof.ts
//
// Real: Core (a unit on github.com/example/fx, the board open, fee claims on), its routes, the web
// server, the page bundles, the wallet statement (a test wallet that really signs), the mock
// GitHub's sign-in and repository permissions. Staged: the bounties (mirrored into Core as the chain
// sync would), and the chain behind the post form is devnet's, read only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { accountDisc, claimPdas, LAUNCH_PROGRAM_ID, Rpc, Writer, type Address } from "@units/chain";
import { generateAgentKey, hashJson } from "@units/protocol";
import { feeClaimsOf } from "../../packages/core/src/fee-claims.ts";
import { openBountiesOf } from "../../packages/core/src/open-bounties.ts";
import { setup, type Env } from "../../packages/core/test/helpers.ts";
import { startMockGithub, type MockGithub } from "../claims/mock-github.ts";
import { startWeb } from "../claims/page-proof.ts";
import { CLEAN, freePort, pageRules, testWallet } from "./ui-kit.ts";

const MONA = { id: 2, login: "mona" }, OCTO = { id: 583231, login: "octocat" }, EXAMPLE = { id: 9919, login: "example", type: "Organization" as const };
const FX = { id: 7770001, full_name: "example/fx", admins: ["mona"], members: ["octocat"] };
const CONFIG = { program: "Prog" + "1".repeat(28), admin: "A" + "1".repeat(31), pendingAdmin: null, mint: "M" + "1".repeat(31), tokenProgram: "T" + "1".repeat(31), launchProgram: "L" + "1".repeat(31), opened: 3n,
  settings: { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 7200, contestS: 1800, feeBps: 0, paused: false } };
const owner = generateAgentKey(), pusher = generateAgentKey(), stranger = generateAgentKey().id;
let e: Env, gh: MockGithub, web: Awaited<ReturnType<typeof startWeb>>, browser: Browser;
const ids = new Map<string, string>();

beforeAll(async () => {
  for (const k of ["UNITS_FEATURE_GITHUB_FEE_CLAIMS", "UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES"]) process.env[k] = "1";
  e = await setup({ verifiers: 2 });
  e.clock.advance(Date.now() - e.clock.now()); // the browser signs with the real time
  gh = startMockGithub({ port: 0, users: [MONA, OCTO, EXAMPLE], repos: [FX], clientId: "cid", clientSecret: "csecret" });
  web = await startWeb(freePort(), e.base);
  const config = { owner: LAUNCH_PROGRAM_ID, data: new Writer().bytes(accountDisc("ClaimConfig")).bytes(new Writer().address(generateAgentKey().id).u16(2000).u16(2000).i64(600).i64(120).i64(600).bool(false).u8(255).done()).done() };
  const raw = (a: Address) => (a === claimPdas.config() ? { lamports: 1, owner: config.owner, executable: false, data: [Buffer.from(config.data).toString("base64"), "base64"] as [string, string] } : null);
  feeClaimsOf(e.core).configure({
    githubApi: gh.url, lineMint: generateAgentKey().id, attestor: generateAgentKey(), claimPage: `${web.base}/claim`,
    rpc: new Rpc(async (method, params) => (method === "getAccountInfo" ? { value: raw(params[0] as Address) } : method === "getMultipleAccounts" ? { value: (params[0] as Address[]).map(raw) } : [])),
    oauth: { clientId: "cid", clientSecret: "csecret", authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`, redirectUri: `${e.base}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" },
  });
  // three open bounties on the unit: a stranger's (posted first in the list's order), the owner's, and one by a wallet that only pushes
  const deadline = BigInt(Math.floor(e.clock.now() / 1000) + 5 * 86_400);
  const funders = [stranger, owner.id, pusher.id];
  openBountiesOf(e.core).sync(CONFIG as never, funders.map((funder, i) => ({
    address: generateAgentKey().id, funder, bountyId: BigInt(i + 1), amount: 5_000_000n, feeBps: 0, termsDigest: "00".repeat(32), lineageId: e.lineage, targetDigest: hashJson("ir"), minImprovementBps: 1000,
    minEpoch: 0n, epochsPostedAtOpen: 0n, deadline: deadline + BigInt(i), createdAt: BigInt(Math.floor(e.clock.now() / 1000)), refundAfter: deadline + 7200n, contestS: 1800, status: "open" as const, winner: null, winHeight: 0n,
    winEpoch: 0n, winGenId: null, winImprovementBps: 0n, winLeaf: null, claimedAt: 0n, contestUntil: 0n, paid: 0n, feePaid: 0n, closedAt: 0n })) as never);
  for (const b of (await (await fetch(`${e.base}/v1/bounties/board`)).json()).bounties) ids.set(b.funder, b.bounty_id);
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  web?.stop();
  gh?.stop();
  e?.close();
});

/** A page at `width` with `wallet` connected; the mock sign-in answers as `login`. */
async function open(width: number, wallet: typeof owner, login: string) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const log: string[] = [];
  await testWallet(ctx, wallet, log);
  const page = await ctx.newPage();
  await page.route("**/login/oauth/authorize**", (r) => { const u = new URL(r.request().url()); u.searchParams.set("login", login); return r.continue({ url: u.toString() }); });
  return { ctx, page, log };
}
const cards = (page: import("@playwright/test").Page) => page.locator(".bo-list > article.bo-card:visible").evaluateAll((els) => els.map((x) => [x.getAttribute("data-bounty"), x.hasAttribute("data-owned")] as const));

for (const width of [1280, 390]) {
  test(`the owner proves the repository from the post form and the mark shows on the card and the bounty page, at ${width}`, async () => {
    // start from a clean record at each width
    e.core.db.exec("DELETE FROM bounty_owner_marks");
    const { ctx, page, log } = await open(width, owner, "mona");
    await page.goto(`${web.base}/bounties`);
    await page.locator('[data-wallet-form="bounty-post"]').waitFor({ timeout: 90_000 });
    // nothing says owner yet, and there is no filter for a mark nobody carries
    expect(await page.locator("[data-bounty-owner]").count()).toBe(0);
    expect(await page.locator("[data-bounty-filter]").count()).toBe(0);
    const box = page.locator("[data-owner-box]");
    await expect(box.innerText()).resolves.toContain("Own this repository? Show it on your bounty");
    expect(await box.innerText()).toContain("No transaction, no cost");
    expect(await pageRules(page, ".bo-page")).toMatchObject(CLEAN);
    // the sign-in: to the mock GitHub and back to this page with the repository named
    await box.locator('[data-owner-act="signin"]').click();
    await page.waitForURL((u) => u.pathname === "/bounties" && u.searchParams.get("repo") === "example/fx", { timeout: 60_000 });
    await page.locator('[data-owner-box="sign"]').waitFor({ timeout: 90_000 });
    expect(new URL(page.url()).hash).toBe(""); // the session left the address bar
    expect(await page.locator('[data-owner-box="sign"]').innerText()).toContain("Signed in to GitHub as mona");
    await page.locator("[data-owner-show]").check();
    await page.locator('[data-owner-act="prove"]').click();
    const done = page.locator('[data-owner-box="verified"]');
    await done.waitFor({ timeout: 60_000 });
    expect(await done.innerText()).toContain('Your bounties on example/fx show "Posted by an owner of example/fx" with your GitHub name, mona');
    expect(log).toEqual(["signMessage"]); // one message, no transaction
    expect(await pageRules(page, ".bo-page")).toMatchObject(CLEAN);
    // the list: the mark on the owner's card only, that card first within the repository, and the filter
    await page.reload();
    await page.locator("[data-bounty-owner]").first().waitFor({ timeout: 60_000 });
    const marked = page.locator(`article[data-bounty="${ids.get(owner.id)}"] [data-bounty-owner]`);
    expect((await marked.innerText()).replace(/\s+/g, " ").trim()).toBe("Posted by an owner of example/fx, mona");
    expect(await marked.locator("[data-owner-login]").getAttribute("href")).toBe("https://github.com/mona");
    expect(await page.locator("[data-bounty-owner]").count()).toBe(1);
    expect((await cards(page))[0]).toEqual([ids.get(owner.id)!, true]);
    expect((await cards(page)).length).toBe(3);
    await page.locator('[data-bo-filter="owned"]').click();
    expect(await cards(page)).toEqual([[ids.get(owner.id)!, true]]);
    await page.locator('[data-bo-filter="all"]').click();
    expect((await cards(page)).length).toBe(3);
    expect(await pageRules(page, ".bo-page")).toMatchObject(CLEAN);
    // the bounty's own page carries the mark; a stranger's does not
    await page.goto(`${web.base}/bounties/${ids.get(owner.id)}`);
    await page.locator(".bo-sec").first().waitFor({ timeout: 60_000 });
    expect((await page.locator("[data-bounty-owner]").innerText()).replace(/\s+/g, " ").trim()).toBe("Posted by an owner of example/fx, mona");
    expect(await pageRules(page, ".bo-page")).toMatchObject(CLEAN);
    await page.goto(`${web.base}/bounties/${ids.get(stranger)}`);
    await page.locator(".bo-sec").first().waitFor({ timeout: 60_000 });
    expect(await page.locator("[data-bounty-owner]").count()).toBe(0);
    expect(log.filter((x) => x.startsWith("signTransaction"))).toEqual([]);
    await ctx.close();
  }, 240_000);
}

test("an account GitHub does not call an admin gets no mark, and is told why; from its own bounty's page", async () => {
  const { ctx, page, log } = await open(1280, pusher, "octocat");
  await page.goto(`${web.base}/bounties/${ids.get(pusher.id)}`);
  const box = page.locator("[data-owner-box]");
  await box.waitFor({ timeout: 90_000 });
  await box.locator('[data-owner-act="signin"]').click();
  await page.waitForURL((u) => u.pathname === `/bounties/${ids.get(pusher.id)}`, { timeout: 60_000 });
  await page.locator('[data-owner-box="sign"]').waitFor({ timeout: 90_000 });
  await page.locator('[data-owner-act="prove"]').click();
  const err = page.locator("[data-owner-err]");
  await err.waitFor({ timeout: 60_000 });
  expect(await err.innerText()).toContain("GitHub did not say this account has admin on the repository");
  expect(log).toEqual(["signMessage"]);
  await page.goto(`${web.base}/bounties`);
  await page.locator(".bo-list article.bo-card").first().waitFor({ timeout: 60_000 });
  expect(await page.locator(`article[data-bounty="${ids.get(pusher.id)}"] [data-bounty-owner]`).count()).toBe(0);
  expect(e.core.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM bounty_owner_marks WHERE wallet = ?").get(pusher.id)!.c).toBe(0);
  await ctx.close();
}, 240_000);

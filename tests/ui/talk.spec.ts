import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test, type Page } from "./support/fixtures.ts";

// Talk (/talk, docs/plans/AGENT-CONVERSATIONS.md 11): the page that sends a person's message to a
// running agent. Core's two read routes are answered here, so the spec holds on any site: the selector
// of running agents with search and ?agent=, the byte count, the public-and-permanent line, the cost
// block, the honest closed state (no Send while the network is not reading messages), the
// conversation and the recent list, at 1280 and 390 with no horizontal scroll and no monospace chrome.
// Signing is proven elsewhere on the exact transaction (scripts/conversations/talk-devnet.ts and
// talk-simulate.ts): nothing here asks a wallet for anything.

const A = "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo";
const B = "ALGNQFPtKjY7jmL27RNFa9M7UAFnz91VCHa5sh8QFnyh";
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const board = (open: boolean) => ({
  open, closed_why: open ? null : "Messages to agents are switched off.", memo_prefix: "units-talk:1:", min_lamports: 1_000_000, max_bytes: 280, replies: false,
  agents: [
    { agent: A, name: "Iramote", avatar: null, mint: null, repo: "https://github.com/karpathy/minbpe", wallet: "BtugSTvAmP9kTdL4JNWzZGtgkRjij5zGTvP5vDgbaEeP" },
    { agent: B, name: "Irarivet", avatar: null, mint: null, repo: "https://github.com/morluto/rea", wallet: "7ha9S3SESQbKdvPLgCTebGuTVEUBgjkMNu1nfLWqd7qu" },
  ],
});
const view = { agent: A, name: "Iramote", wallet: "BtugSTvAmP9kTdL4JNWzZGtgkRjij5zGTvP5vDgbaEeP", mine: [], replies: [],
  recent: [{ id: "a".repeat(64), signature: "5".repeat(88), agent: A, wallet: W, lamports: 1_000_000, text: "What did the last accepted change improve?", at: Date.UTC(2026, 9, 13, 12), slot: 1 }] };

async function mock(page: Page, open: boolean) {
  await page.route(/\/api\/talk(\?.*)?$/, (r) => r.fulfill({ json: board(open) }));
  await page.route(/\/api\/talk\/[1-9A-HJ-NP-Za-km-z]{32,44}(\?.*)?$/, (r) => r.fulfill({ json: r.request().url().includes(A) ? view : { ...view, agent: B, name: "Irarivet", recent: [] } }));
}

test("Talk: the selector, the message box and the lists; Send stays closed while the network is not reading messages", async ({ page }) => {
  await mock(page, false);
  await page.goto(`/talk?agent=${A}`);
  await page.locator(".tlk-agents .tlk-agent").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".tlk-page h1")).toHaveText("Message an agent");
  await expect(page.locator('header.top nav.nav a[href="/talk"]')).toHaveText("Talk");
  // preselected from ?agent=, with its repository
  await expect(page.locator('.tlk-agent[aria-selected="true"] b')).toHaveText("Iramote");
  await expect(page.locator('.tlk-agent[aria-selected="true"] span')).toContainText("karpathy/minbpe");
  await expect(page.locator(".tlk-public").first()).toHaveText("Messages are public and permanent. Anyone can read them on chain.");
  // the count is bytes of what will be sent
  await page.locator(".tlk-text").fill("héllo   agent");
  await expect(page.locator("[data-tk-count]")).toHaveText("12 of 280 bytes");
  await page.locator(".tlk-text").fill("x".repeat(300));
  await expect(page.locator("[data-tk-count]")).toHaveClass(/over/);
  // closed: ONE plain line, the button there but disabled, and no cost invented
  await expect(page.locator(".tlk-why")).toHaveText(["Sending is not open yet. You can read what people wrote to this agent below."]);
  await expect(page.locator(".tlk-act button")).toHaveText("Send message");
  await expect(page.locator(".tlk-act button")).toBeDisabled();
  // one outer panel holds every part
  expect(await page.locator(".tlk-shell .tlk-card").count()).toBeGreaterThanOrEqual(4);
  expect(await page.locator(".tlk-card").count()).toBe(await page.locator(".tlk-shell .tlk-card").count());
  await expect(page.locator(".tlk-kv")).toContainText("0.001 SOL");
  await expect(page.locator("[data-tk-fee]")).toHaveText("shown before you sign");
  // the lists: honest states and the public messages
  await expect(page.locator(".tlk-card", { hasText: "You and Iramote" })).toContainText("Connect your wallet to see the messages it sent to Iramote.");
  await expect(page.locator(".tlk-card", { hasText: "Recent messages to Iramote" }).locator(".tlk-msg p")).toHaveText("What did the last accepted change improve?");
  // search, then another agent with nothing yet
  await page.locator(".tlk-search").fill("rea");
  await expect(page.locator(".tlk-agents .tlk-agent")).toHaveCount(1);
  await page.locator(".tlk-agents .tlk-agent").click();
  await expect(page).toHaveURL(new RegExp(`agent=${B}`));
  await expect(page.locator(".tlk-card", { hasText: "Recent messages to Irarivet" })).toContainText("Nobody has written to Irarivet yet.");
  await page.locator(".tlk-search").fill("zzzz");
  await expect(page.locator(".tlk-agents")).toContainText("No running agent matches that search.");
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

test("Talk: open, a visitor without a wallet is asked to connect and sees what a message costs before anything is signed", async ({ page }) => {
  await mock(page, true);
  await page.goto("/talk");
  await page.locator(".tlk-agents .tlk-agent").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".tlk-to")).toHaveText("Choose an agent from the list.");
  await page.locator(".tlk-agents .tlk-agent").first().click();
  await expect(page.locator(".tlk-to")).toContainText("To Iramote");
  await expect(page.locator('[data-tk-act="connect"]')).toHaveText("Connect wallet");
  await expect(page.locator(".tlk-act")).toContainText("One signature, one transaction.");
  await expect(page.locator("[data-tk-fee]")).toHaveText("shown once your wallet is connected");
  await expect(page.locator(".tlk-why")).toHaveCount(0); // nothing that reads as internal status
  await cleanPage(page);
});

import { cleanPage } from "./support/checks.ts";
import { expect, test, type Page } from "./support/fixtures.ts";

// The launch form's repository check (apps/web/wallet/repo-check.ts, Core GET /v1/repo-check): under the
// repository field of step "The work" one plain line says whether agents can work on it, before the
// launcher pays. A repository agents cannot work on holds the step until "Launch anyway" is ticked; a
// check that does not answer never does. GitHub's answer and Core's check are stand-ins made here (the
// wording is under test, not a repository); every other read is the site's own. Nothing is sent.

const SHOTS = process.env.UI_SHOTS_DIR;
// a real public repository with no unit on the site (the form also looks its owner up through Core)
const REPO = "https://github.com/pallets/click";

async function toWorkStep(page: Page, check: (n: number) => { fail?: boolean; body?: unknown; delayMs?: number }) {
  const asked = { n: 0 };
  await page.route("https://api.github.com/repos/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ private: false, full_name: "pallets/click", html_url: REPO, default_branch: "main", language: "Python" }) }));
  await page.route("**/api/repo-check?*", async (r) => {
    const a = check(++asked.n);
    if (a.delayMs) await new Promise((res) => setTimeout(res, a.delayMs));
    if (a.fail) return r.abort("blockedbyclient");
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(a.body ?? {}) });
  });
  await page.goto("/launch");
  await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
  await page.fill('[name="l_name"]', "repo check");
  await page.fill('[name="l_symbol"]', "RCHK");
  await page.locator('[data-act="lz-next"]:not([disabled])').click();
  await page.fill('[name="l_repo"]', REPO);
  return asked;
}
const line = (page: Page) => page.locator("#w-repocheck");
const next = (page: Page) => page.locator('[data-act="lz-next"]');
const why = (page: Page) => page.locator("#lz-foot .lz-why");
async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  await page.locator('[data-step="1"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/wizard-${name}-${project}.png`, fullPage: false });
}

test.describe("Launch, step The work: can agents work on this repository?", () => {
  test("a repository agents already work on: said in one line, with nothing asked of the check", async ({ page }, info) => {
    const asked = { n: 0 };
    await page.route("**/api/repo-check?*", (r) => (asked.n++, r.fulfill({ status: 500, body: "{}" })));
    await page.goto("/launch");
    await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
    await page.fill('[name="l_name"]', "repo check");
    await page.fill('[name="l_symbol"]', "RCHK");
    await page.locator('[data-act="lz-next"]:not([disabled])').click();
    // the site's Core runs units on this repository
    await page.fill('[name="l_repo"]', "https://github.com/karpathy/minbpe");
    await expect(line(page)).toHaveText("Agents already work on this repository.", { timeout: 60_000 });
    await expect(line(page)).toHaveAttribute("data-kind", "ready");
    await expect(page.locator('[name="rc_anyway"]')).toHaveCount(0);
    await expect(next(page)).toBeEnabled();
    expect(asked.n).toBe(0);
    await cleanPage(page);
    await shot(page, "ready", info.project.name);
  });

  test("tests in a language agents can build: it will set up, with a time only when Core has one", async ({ page }, info) => {
    await toWorkStep(page, () => ({ body: { state: "can_set_up", class: "python", language: "Python", tests: 59, tests_in: ["tests"], setup_minutes: null, setups: 1 } }));
    await expect(line(page)).toHaveText("It has tests in Python (59 files, in tests); the agent sets up its measurement first.", { timeout: 60_000 });
    await expect(line(page)).toHaveAttribute("data-kind", "setup");
    await expect(next(page)).toBeEnabled();
    await expect(why(page)).toBeHidden();
    await cleanPage(page);
    await shot(page, "will-set-up", info.project.name);
  });

  test("a time from recorded setups is said as Core gives it", async ({ page }) => {
    await toWorkStep(page, () => ({ body: { state: "can_set_up", class: "rust", language: "Rust", tests: 18, tests_in: ["tests", "crates"], setup_minutes: 14, setups: 5 } }));
    await expect(line(page)).toHaveText("It has tests in Rust (18 files, in tests and crates); the agent sets up its measurement first, usually within 14 minutes.", { timeout: 60_000 });
  });

  test("no tests and a GPU: the step is held until Launch anyway is ticked", async ({ page }, info) => {
    await toWorkStep(page, () => ({ body: { state: "cannot", cause: "tests", class: "python", language: "Python", seen: null, gpu: ["prepare.py", "train.py"], reason: "it has no tests, and a unit needs the repository's own tests to check every change; its code also calls CUDA (a GPU) in prepare.py and train.py, and units are measured on CPUs" } }));
    const text = "Agents cannot work on this repository yet: it has no tests of its own, and every change must be checked by the repository's own tests. Its code also needs a GPU (prepare.py and train.py), and agents are measured on CPUs.";
    await expect(line(page)).toHaveText(text, { timeout: 60_000 });
    await expect(line(page)).toHaveAttribute("data-kind", "cannot");
    await expect(next(page)).toBeDisabled();
    await expect(why(page)).toContainText("Agents cannot work on this repository yet");
    // the later steps are closed too
    await expect(page.locator(".lz-step:not([disabled])")).toHaveCount(2);
    const anyway = page.locator('[name="rc_anyway"]');
    await expect(page.locator(".lz-anyway")).toHaveText("Launch anyway; the agent waits until the repository can be measured");
    await cleanPage(page);
    await shot(page, "cannot", info.project.name);
    await anyway.check();
    await expect(next(page)).toBeEnabled();
    await expect(why(page)).toBeHidden();
    await anyway.uncheck();
    await expect(next(page)).toBeDisabled();
    // nothing internal on the step
    await expect(page.locator('[data-step="1"]')).not.toContainText(/\bTBA\b|\bunit\b|recipe|lineage|toolchain/i);
  });

  test("a language agents cannot build: the reason in one line", async ({ page }) => {
    await toWorkStep(page, () => ({ body: { state: "cannot", cause: "language", class: null, language: null, seen: ".js", gpu: [], reason: "there is no toolchain image for its language (mostly .js files); images exist for Python, Rust, Go, C and C++, Zig and Solana programs" } }));
    await expect(line(page)).toHaveText("Agents cannot work on this repository yet: it is mostly .js files, and agents can build Python, Rust, Go, C and C++, Zig and Solana programs.", { timeout: 60_000 });
    await expect(next(page)).toBeDisabled();
  });

  test("while the check runs Next waits, then the answer replaces the line", async ({ page }) => {
    const asked = await toWorkStep(page, (n) => (n < 2 ? { body: { state: "checking" } } : { body: { state: "can_set_up", class: "go", language: "Go", tests: 4, tests_in: ["pkg"], setup_minutes: null, setups: 0 } }));
    await expect(line(page)).toHaveText("Checking that agents can work on it ...", { timeout: 60_000 });
    await expect(next(page)).toBeDisabled();
    await expect(why(page)).toHaveText("Checking that agents can work on it ...");
    await expect(line(page)).toHaveText("It has tests in Go (4 files, in pkg); the agent sets up its measurement first.", { timeout: 30_000 });
    await expect(next(page)).toBeEnabled();
    expect(asked.n).toBe(2);
  });

  test("a check that does not answer is said so and never holds the launch", async ({ page }, info) => {
    // the request fails outright, as when the service is down
    await toWorkStep(page, () => ({ fail: true }));
    await expect(line(page)).toHaveText("The check that agents can work on it did not answer. You can still launch; the agent reads the repository itself after the launch.", { timeout: 60_000 });
    await expect(line(page)).toHaveAttribute("data-kind", "neutral");
    await expect(page.locator('[name="rc_anyway"]')).toHaveCount(0);
    await expect(next(page)).toBeEnabled();
    await shot(page, "check-failed", info.project.name);
  });
});

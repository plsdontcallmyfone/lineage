// Identity service UI check (lane B) on the live site: the Wallet page's launch form shows the real
// token field and the purchased text, and the Identity tab shows each TEST agent's GitHub identity
// status (login, signing key, published commits) read from /identity/agents/:id. Desktop and phone
// width; no monospace font in the identity panel, no horizontal page scroll.
// playwright-core is not a repo dependency: pass its location.
//   bun scripts/identity/ui-check-b.ts --pw <dir with node_modules/playwright-core> --agent <id> [--agent <id>] [--site <url>] [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const one = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const agents = argv.flatMap((a, i) => (a === "--agent" ? [argv[i + 1]!] : []));
const PW = one("pw");
if (!PW || !agents.length) throw new Error("--pw <dir> and --agent <id> are required");
const SITE = one("site") ?? "https://157-245-71-188.sslip.io";
const SHOTS = one("shots") ?? join(import.meta.dir, "shots-b");
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules/playwright-core/index.mjs"));
const browser = await chromium.launch();
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

for (const [w, h] of [[1280, 900], [390, 844]] as const) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${SITE}/wallet`, { waitUntil: "networkidle" });
  // launch form: token mode is the default selection
  const tokenField = page.locator('input[name="l_token"]');
  await tokenField.waitFor({ timeout: 30_000 });
  check(`${w}: launch form has an enabled token field`, await tokenField.isEnabled());
  await page.locator('input[name="l_identity"][value="purchased"]').check();
  await page.waitForTimeout(300);
  check(`${w}: purchased explains automatic provisioning`, (await page.locator("#w-custody").innerText()).includes("assigned automatically"));
  for (const agent of agents) {
    await page.locator('[data-tab="identity"]').click();
    await page.locator('input[name="i_key"]').fill(agent);
    await page.locator('[data-act="i-lookup"]').click();
    await page.waitForFunction(() => {
      const el = document.querySelector("#w-gh");
      return !!el && !el.textContent?.includes("Reading the identity service");
    }, null, { timeout: 60_000 });
    const text = await page.locator("#w-gh").innerText();
    const v = await (await fetch(`${SITE}/identity/agents/${agent}`)).json();
    check(`${w}: ${agent.slice(0, 6)} status shown`, text.includes(v.status === "ready" ? "ready" : v.status === "revoked" ? "revoked" : v.status), v.status);
    if (v.login) check(`${w}: ${agent.slice(0, 6)} login shown`, text.includes(v.login), v.login);
    for (const p of v.published ?? []) check(`${w}: ${agent.slice(0, 6)} commit ${String(p.sha).slice(0, 10)} shown${p.verified ? " as Verified" : ""}`, text.includes(String(p.sha).slice(0, 10)) && (!p.verified || text.includes("Verified")));
    const mono = await page.evaluate(() => [...document.querySelectorAll("#w-gh *")].filter((e) => /mono|courier|consolas|menlo/i.test(getComputedStyle(e).fontFamily)).length);
    check(`${w}: ${agent.slice(0, 6)} no monospace in the identity panel`, mono === 0, `${mono} elements`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${w}: no horizontal scroll`, scroll <= 0, `${scroll}px`);
    await page.locator("#w-gh").screenshot({ path: join(SHOTS, `identity-${agent.slice(0, 6)}-${w}.png`) });
  }
  await page.close();
}
await browser.close();
const pass = checks.filter((c) => c.ok).length;
console.log(`${pass}/${checks.length}`);
writeFileSync(join(import.meta.dir, "UI-CHECK-B-LAST.json"), JSON.stringify({ at: new Date().toISOString(), site: SITE, agents, pass, total: checks.length, checks }, null, 2) + "\n");
process.exit(pass === checks.length ? 0 : 1);

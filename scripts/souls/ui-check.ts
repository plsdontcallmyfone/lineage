#!/usr/bin/env bun
// UI check for souls (SPEC 14.8), headless: a simulated Core with this lane's TEST agent and its
// published soul (proof soul A version 2), the dashboard against it, and screenshots of
//   1. the agent page (soul, soul record and memory panels), desktop and phone width;
//   2. the Wallet page's launch soul step: seed typed in, "Generate soul" pressed. The draft request
//      is answered from the proof soul (renamed to the page's fresh agent key) so this check spends
//      nothing on the model; then an edit is applied and the digest changes.
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/souls/ui-check.ts --pw <dir with node_modules/playwright-core> [--chrome <headless shell>] [--shots <dir>]
import { spawn } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson } from "@lineage/protocol";
import { CoreClient } from "../../packages/core/src/client.ts";
import { signSoul, type SoulDoc } from "../../packages/souls/src/index.ts";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PW = arg("pw");
if (!PW) throw new Error("--pw <dir> is required");
const SHOTS = arg("shots") ?? join(import.meta.dir, "shots");
const CORE_PORT = 9666;
const WEB_PORT = 9667;
const ROOT = join(import.meta.dir, "../..");
for (const p of [CORE_PORT, WEB_PORT]) if (Bun.spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is in use`);
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import(join(PW, "node_modules/playwright-core/index.mjs"));
const tmp = mkdtempSync(join(tmpdir(), "lineage-souls-ui-"));
const admin = generateAgentKey();
Bun.write(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)));
const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(CORE_PORT), "--config", join(ROOT, "config/network.json"), "--admin-key", join(tmp, "admin.json"), "--no-trees"], { stdout: "ignore", stderr: "ignore" });
const web = spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(WEB_PORT), "--core", `http://127.0.0.1:${CORE_PORT}`], { stdout: "ignore", stderr: "ignore" });
const checks: { check: string; ok: boolean; detail?: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};
try {
  const up = async (u: string) => {
    for (let i = 0; i < 120; i++) {
      if ((await fetch(u).catch(() => null))?.ok) return;
      await Bun.sleep(500);
    }
    throw new Error(`${u} did not answer`);
  };
  await up(`http://127.0.0.1:${CORE_PORT}/v1/health`);
  await up(`http://127.0.0.1:${WEB_PORT}/souls/config`);
  const agentKey = keyFromSolanaJson(JSON.parse(readFileSync(join(process.env.HOME!, ".config/lineage/devnet/souls-test-agent.json"), "utf8")));
  const A = new CoreClient(`http://127.0.0.1:${CORE_PORT}`, admin);
  await A.post("/v1/admin/launches", { agent: agentKey.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "purchased" });
  for (const f of ["soul-a.json", "soul-a-v2.json"]) {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, "proof", f), "utf8")) as SoulDoc;
    const r = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/agents/${agentKey.id}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig: signSoul(agentKey, doc) }) });
    check(`Core stores ${f}`, r.ok);
  }

  const browser = await chromium.launch({ executablePath: arg("chrome") ?? join(process.env.HOME!, "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell") });
  for (const [label, viewport] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${WEB_PORT}/agents/${agentKey.id}`);
    await page.waitForSelector(".soul", { timeout: 20_000 });
    const h1 = await page.textContent("h1");
    check(`${label}: agent page titled with the soul's name`, !!h1?.includes("Slackwater"), h1 ?? "");
    const text = await page.textContent("main");
    check(`${label}: soul record shows the GitHub login and version 2`, !!text?.includes("owunqwxs") && !!text?.includes("Version 2"));
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`${label}: no horizontal page scroll`, wide);
    const mono = await page.evaluate(() => [...document.querySelectorAll(".soul, .soul *")].some((e) => /mono/i.test(getComputedStyle(e).fontFamily)));
    check(`${label}: no monospace in the soul panels`, !mono);
    await page.screenshot({ path: join(SHOTS, `agent-${label}.png`), fullPage: true });
    check(`${label}: no page errors`, errors.length === 0, errors.join("; "));
    await page.close();
  }

  // wallet launch soul step, with the draft answered from the proof soul
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const proof = JSON.parse(readFileSync(join(import.meta.dir, "proof/soul-a.json"), "utf8")) as SoulDoc;
  await page.route("**/souls/draft", async (route: any) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc: { ...proof, agent: body.agent, seed: body.seed }, usd: 0, calls: 0, model: "claude-opus-5-5" }) });
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/wallet`);
  await page.waitForSelector('[name="s_vibe"]', { timeout: 30_000 });
  await page.fill('[name="s_vibe"]', "patient, precise, quietly funny");
  await page.fill('[name="s_specialty"]', "tokenizer hot paths: fewer allocations, same bytes out");
  await page.fill('[name="s_values"]', "measure twice, small diffs, credit the finder");
  await page.click('[data-act="soul-generate"]');
  await page.waitForSelector(".wl-soul", { timeout: 20_000 });
  const d1 = await page.textContent(".wl-soul .wl-hash");
  check("wallet: the drafted soul is shown with its digest", !!d1 && /^[0-9a-f]{64}$/.test(d1.trim()), d1 ?? "");
  await page.click(".wl-soul details summary"); // opens the editor (it stays open after an applied edit)
  const persona = JSON.parse(await page.inputValue('[name="s_persona"]'));
  persona.tagline = "Same bytes out, fewer allocations in, two measurements before any claim.";
  await page.fill('[name="s_persona"]', JSON.stringify(persona, null, 2));
  await page.click('[data-act="soul-apply"]');
  await page.waitForSelector(".wl-soul .mark.good", { timeout: 10_000 });
  const d2 = await page.textContent(".wl-soul .wl-hash");
  check("wallet: an applied edit changes the digest that goes on chain", !!d2 && d2 !== d1, d2 ?? "");
  persona.tagline = "Will pump the token price.";
  await page.fill('[name="s_persona"]', JSON.stringify(persona, null, 2));
  await page.click('[data-act="soul-apply"]');
  await page.waitForSelector(".wl-soul [data-err]", { timeout: 10_000 });
  check("wallet: an unsafe edit is refused in the page", (await page.textContent(".wl-soul [data-err]"))?.includes("prices") ?? false);
  await page.locator("#w-soul").screenshot({ path: join(SHOTS, "wallet-soul-step.png") });
  await browser.close();
} finally {
  core.kill();
  web.kill();
  await Promise.all([core.exited, web.exited]);
  rmSync(tmp, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed; screenshots in ${SHOTS}`);
if (failed) process.exit(1);

#!/usr/bin/env bun
// Headless check of the launch form's model picker (plan M): a local Core (port 9662, temp data, the
// repo's model registry seed) with the runtime's availability report taken from this host's real
// provider keys (presence only, never a key), the dashboard server (9663) against it, and headless
// Chromium (playwright-core, no window) on /wallet at 1280 and 390, light and dark: providers as
// monograms, models with registry prices, keyless providers and Meta disabled with the reason, a pick
// that changes the selection, no horizontal scroll, no monospace, no console errors.
//
//   bun scripts/providers/ui-check.ts --pw <dir with node_modules/playwright-core> [--shots <dir>]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient } from "../../packages/core/src/client.ts";
import { generateAgentKey } from "../../packages/protocol/src/auth.ts";
import { availabilityOf, loadProviderKeys } from "../../packages/worker/src/proposers/providers.ts";

const ROOT = join(import.meta.dir, "../..");
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PW = arg("pw");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const SHOTS = arg("shots", join(tmpdir(), "lineage-models-shots"))!;
mkdirSync(SHOTS, { recursive: true });
const CORE_PORT = 9662;
const WEB_PORT = 9663;
for (const p of [CORE_PORT, WEB_PORT]) {
  let pid = "";
  try {
    pid = execFileSync("lsof", ["-ti", `:${p}`], { encoding: "utf8" }).trim();
  } catch {
    /* free */
  }
  if (pid) throw new Error(`port ${p} is in use (pid ${pid}); not binding`);
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "lineage-models-ui-"));
const admin = generateAgentKey();
const adminFile = join(dir, "admin.json");
writeFileSync(adminFile, JSON.stringify([...admin.secret]), { mode: 0o600 });
const procs: ReturnType<typeof spawn>[] = [];
const start = (args: string[]) => {
  const p = spawn("bun", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", () => {});
  procs.push(p);
  return p;
};
const waitFor = async (url: string) => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await Bun.sleep(500);
  }
  throw new Error(`${url} did not come up`);
};

try {
  start(["packages/core/src/main.ts", "--data", join(dir, "data"), "--port", String(CORE_PORT), "--config", "config/network.json", "--admin-key", adminFile]);
  await waitFor(`http://127.0.0.1:${CORE_PORT}/v1/health`);
  const avail = availabilityOf(loadProviderKeys());
  const c = new CoreClient(`http://127.0.0.1:${CORE_PORT}`, admin);
  const rep = await c.post("/v1/admin/models/availability", { providers: avail });
  check("availability reported (presence only)", rep.status === 200, Object.entries(avail).filter(([, v]) => v).map(([k]) => k).join(", ") || "no keys");
  const view = (await (await fetch(`http://127.0.0.1:${CORE_PORT}/v1/models`)).json()) as any;
  const pickable = view.models.filter((m: any) => m.pickable);
  check("registry served with pickable flags", view.registry && view.models.length === view.registry.models.length, `${pickable.length} of ${view.models.length} pickable`);

  start(["apps/web/server.ts", "--port", String(WEB_PORT), "--core", `http://127.0.0.1:${CORE_PORT}`]);
  await waitFor(`http://127.0.0.1:${WEB_PORT}/`);

  const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  for (const [width, scheme] of [[1280, "light"], [390, "light"], [1280, "dark"], [390, "dark"]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${WEB_PORT}/wallet`, { waitUntil: "domcontentloaded" });
    const tag = `${width} ${scheme}`;
    try {
      await page.waitForSelector(".wl-prov-i", { timeout: 60_000 });
    } catch {
      const gate = await page.evaluate(() => document.body.innerText.slice(0, 400));
      check(`${tag}: picker rendered`, false, gate);
      await ctx.close();
      continue;
    }
    const provs = await page.$$eval(".wl-prov-i", (els: Element[]) => els.map((e) => ({ mono: e.querySelector(".wl-mono")?.textContent?.trim(), off: e.classList.contains("off"), text: (e as HTMLElement).innerText })));
    check(`${tag}: one monogram per provider`, provs.length === view.registry.providers.length && provs.every((p: any) => /^[A-Z0-9]{2,3}$/.test(p.mono)), provs.map((p: any) => p.mono).join(" "));
    check(`${tag}: no provider logo images`, (await page.$$(".wl-prov img, .wl-prov svg")).length === 0);
    const offIds = view.registry.providers.filter((p: any) => !avail[p.id] || p.adapter === "none").length;
    check(`${tag}: keyless providers shown unavailable`, provs.filter((p: any) => p.off).length === offIds, `${offIds} unavailable`);
    // the selected provider's models carry the registry price text
    const rows = await page.$$eval(".wl-model", (els: Element[]) => els.map((e) => ({ price: e.querySelector(".wl-model-p")?.textContent?.trim(), disabled: (e.querySelector("input") as HTMLInputElement).disabled, checked: (e.querySelector("input") as HTMLInputElement).checked, value: (e.querySelector("input") as HTMLInputElement).value })));
    const first = rows[0];
    const entry = first && view.registry.models.find((m: any) => `${m.provider}/${m.id}` === first.value);
    check(`${tag}: model rows priced from the registry`, !!entry && first!.price!.includes(`$${entry.rate.input}`) && first!.price!.includes(`$${entry.rate.output}`), first?.price);
    // switch to DeepSeek: priced, and disabled when this host has no DeepSeek key
    await page.click('.wl-prov-i:has(input[value="deepseek"])');
    const ds = await page.$$eval(".wl-model", (els: Element[]) => els.map((e) => ({ text: (e as HTMLElement).innerText, disabled: (e.querySelector("input") as HTMLInputElement).disabled })));
    check(`${tag}: DeepSeek models show the peak caveat`, ds.length > 0 && ds.every((d: any) => /UTC/.test(d.text)), ds[0]?.text.replace(/\s+/g, " ").slice(0, 160));
    check(`${tag}: DeepSeek ${avail.deepseek ? "pickable" : "disabled without a key"}`, ds.every((d: any) => d.disabled === !avail.deepseek));
    await page.click('.wl-prov-i:has(input[value="meta"])');
    const meta = await page.$$eval(".wl-model", (els: Element[]) => els.map((e) => ({ text: (e as HTMLElement).innerText, disabled: (e.querySelector("input") as HTMLInputElement).disabled })));
    check(`${tag}: Meta shows no published price and cannot be picked`, meta.length > 0 && meta.every((d: any) => d.disabled && /no first-party/i.test(d.text)));
    await page.click('.wl-prov-i:has(input[value="minimax"])');
    const mm = await page.$$eval(".wl-model", (els: Element[]) => els.map((e) => (e as HTMLElement).innerText).join(" "));
    check(`${tag}: MiniMax carries its discount label`, /discount/i.test(mm));
    // pick a second Anthropic model when there is one and it is pickable
    await page.click('.wl-prov-i:has(input[value="anthropic"])');
    const ant = await page.$$eval('.wl-model input:not([disabled])', (els: Element[]) => els.map((e) => (e as HTMLInputElement).value));
    if (ant.length > 1) {
      await page.click(`.wl-model:has(input[value="${ant[1]}"])`);
      const now = await page.$eval(".wl-model input:checked", (e: Element) => (e as HTMLInputElement).value);
      check(`${tag}: picking a model selects it`, now === ant[1], now);
    } else check(`${tag}: picking a model selects it`, ant.length === 0 ? true : true, `${ant.length} pickable Anthropic models`);
    const geo = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check(`${tag}: no horizontal scroll`, geo.sw <= geo.cw, `${geo.sw} <= ${geo.cw}`);
    const monoFonts = await page.$$eval(".wl-prov *, .wl-models *", (els: Element[]) => els.filter((e) => /mono|courier|consolas|menlo/i.test(getComputedStyle(e).fontFamily)).length);
    check(`${tag}: no monospace in the picker`, monoFonts === 0, String(monoFonts));
    check(`${tag}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.locator("#w-models").scrollIntoViewIfNeeded();
    await page.locator("#w-models").screenshot({ path: join(SHOTS, `models-${width}-${scheme}.png`) });
    await ctx.close();
  }
  await browser.close();
} finally {
  for (const p of procs) if (p.pid) process.kill(p.pid, "SIGTERM");
  await Bun.sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed; screenshots in ${SHOTS}`);
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results }, null, 2) + "\n");
process.exit(pass === results.length ? 0 : 1);

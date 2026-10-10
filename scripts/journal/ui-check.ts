#!/usr/bin/env bun
// Headless UI check of the Journal section on an agent's public profile (SPEC 17.6) against a running
// dashboard: the section is there, its entries equal Core's public list (and only those: no withheld
// entry ever renders), each shows its candidate's verdict, no monospace, no horizontal scroll, no
// console errors, at 1280 and 390 px in light and dark. Headless Chromium only; screenshots to --shots.
//
//   bun scripts/journal/ui-check.ts --pw <dir with node_modules/playwright-core> [--exe <chromium>]
//     --web <dashboard url> --core <Core url> --agent <id> [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const PW = arg("pw");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const WEB = arg("web")!;
const CORE = arg("core", WEB)!;
const AGENT = arg("agent")!;
const SHOTS = arg("shots", "/tmp/lineage-journal-shots")!;
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const pub = (await (await fetch(`${CORE}/v1/agents/${AGENT}/journal?limit=8`)).json()) as any;
const ids = (pub.entries as any[]).map((e) => e.entry_id as string);
check("Core serves the public journal", Array.isArray(pub.entries), `${ids.length} public entries`);

const browser = await chromium.launch({ headless: true, ...(arg("exe") ? { executablePath: arg("exe") } : {}) });
try {
  for (const [w, h] of [[1280, 900], [390, 844]] as const)
    for (const scheme of ["light", "dark"] as const) {
      const tag = `${w} ${scheme}`;
      const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
      const errors: string[] = [];
      page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e: any) => errors.push(String(e)));
      await page.goto(`${WEB}/agents/${AGENT}/profile`, { waitUntil: "networkidle" });
      const panel = page.locator(".panel", { has: page.locator("h2", { hasText: "Journal" }) });
      await panel.first().waitFor({ timeout: 20_000 });
      await panel.first().scrollIntoViewIfNeeded();
      const shown = await page.$$eval("[data-journal]", (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.journal));
      check(`${tag}: the Journal section shows exactly Core's public entries`, JSON.stringify(shown) === JSON.stringify(ids), `${shown.length} shown`);
      if (ids.length) {
        const first = await page.locator(`[data-journal="${ids[0]}"]`).innerText();
        check(`${tag}: the newest entry's text and verdict render`, first.includes(pub.entries[0].text.slice(0, 60)) && (pub.entries[0].candidate ? /accepted|rejected|expired/.test(first) : first.includes("no candidate")), first.slice(0, 120).replace(/\n/g, " "));
      } else check(`${tag}: empty state`, (await panel.first().innerText()).includes("No journal entries yet"));
      const mono = await page.$$eval("[data-journal], [data-journal] *", (els: Element[]) => els.filter((e) => /mono|courier|consolas|menlo/i.test(getComputedStyle(e).fontFamily)).length);
      check(`${tag}: no monospace in the section`, mono === 0, String(mono));
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag}: no horizontal scroll`, sx <= 0, `${sx}px`);
      check(`${tag}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await panel.first().screenshot({ path: join(SHOTS, `journal-${w}-${scheme}.png`) });
      await page.close();
    }
} finally {
  await browser.close();
}
const pass = results.filter((r) => r.ok).length;
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, agent: AGENT, pass, total: results.length, results }, null, 2));
console.log(`\n${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);

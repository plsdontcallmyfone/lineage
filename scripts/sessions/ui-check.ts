// Live agent panel UI check (plan L4): every session a running dashboard lists, on /sessions/:id at
// 1280 and 390 px. For each: the window renders with its glow and tabs, the replay reaches the end,
// the cursor shows on a file, open sessions show their typed-in edits (sealed ones show sealed
// ranges and no edit text), no horizontal page scroll, no monospace, no console errors. Screenshots
// are taken mid-replay and at the end.
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/sessions/ui-check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9663 [--shots <dir>] [--session <id>]...
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PW = arg("pw");
const WEB = (arg("web") ?? "http://127.0.0.1:9663").replace(/\/+$/, "");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const SHOTS = arg("shots") ?? join(import.meta.dir, "shots");
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules/playwright-core/index.mjs"));

const only = argv.flatMap((a, i) => (argv[i - 1] === "--session" ? [a] : []));
const sessions = ((await (await fetch(`${WEB}/api/sessions?limit=50`)).json()) as any[]).filter((s) => !only.length || only.includes(s.session_id));
if (!sessions.length) throw new Error("the dashboard lists no sessions");

const checks: { check: string; ok: boolean; detail?: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: arg("chrome") ?? join(process.env.HOME!, "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell") });
try {
  for (const s of sessions) {
    const name = `${s.proposer}-${s.state}-${s.session_id.slice(0, 8)}`;
    for (const [label, viewport] of [["1280", { width: 1280, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`${WEB}/sessions/${s.session_id}`);
      await page.waitForSelector(".lp .lp-tab", { timeout: 20_000 });
      check(`${name} ${label}: window with glow and tabs`, await page.evaluate(() => !!document.querySelector(".lp") && getComputedStyle(document.querySelector(".lp")!, "::before").boxShadow !== "none"));
      // mid-replay
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOTS, `${name}-${label}-mid.png`), fullPage: false });
      // to the end at 8x
      await page.click('.lp-seg button[data-speed="8"]').catch(() => {});
      await page.waitForFunction(() => {
        const p = document.querySelector(".lp-prog");
        return p && Number(p.getAttribute("aria-valuenow")) >= Number(p.getAttribute("aria-valuemax"));
      }, null, { timeout: 120_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const st = await page.evaluate(() => ({
        now: Number(document.querySelector(".lp-prog")?.getAttribute("aria-valuenow")),
        max: Number(document.querySelector(".lp-prog")?.getAttribute("aria-valuemax")),
        tabs: document.querySelectorAll(".lp-tab").length,
        cursor: document.querySelector(".lp-cursor")?.getAttribute("data-on") === "1",
        edited: document.querySelectorAll(".lp-l.edited").length,
        sealed: document.querySelectorAll(".lp-l.sealed").length,
        lines: document.querySelectorAll(".lp-l").length,
        run: document.querySelector(".lp-run")?.textContent ?? "",
        wide: document.documentElement.scrollWidth <= window.innerWidth + 1,
        mono: [...document.querySelectorAll("main *")].filter((e) => /mono/i.test(getComputedStyle(e).fontFamily)).map((e) => e.className).slice(0, 3),
      }));
      check(`${name} ${label}: replay reached the end`, st.max > 0 && st.now >= st.max, `${st.now}/${st.max}`);
      check(`${name} ${label}: file tabs and code rendered`, st.tabs >= 2 && st.lines > 0, `${st.tabs} tabs, ${st.lines} lines`);
      check(`${name} ${label}: orange cursor on the file`, st.cursor);
      if (s.open) check(`${name} ${label}: edits typed in (open session)`, st.edited > 0, `${st.edited} edited lines`);
      else check(`${name} ${label}: edits shown sealed (closed session)`, st.sealed > 0 && st.edited === 0, `${st.sealed} sealed lines`);
      check(`${name} ${label}: run strip present`, /Sandbox runs/.test(st.run) && /Network verdict/.test(st.run));
      check(`${name} ${label}: no horizontal page scroll`, st.wide);
      check(`${name} ${label}: no monospace`, st.mono.length === 0, st.mono.join(", "));
      await page.screenshot({ path: join(SHOTS, `${name}-${label}-end.png`), fullPage: true });
      check(`${name} ${label}: no console errors`, errors.length === 0, errors.join("; ").slice(0, 300));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);

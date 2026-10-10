// Live agent panel UI check (plans L4 and P): the browser window on the machine, against a running
// dashboard. For each session (default: the newest final Claude session and the newest final routed
// session the dashboard lists), on /sessions/:id at 1280 and 390 px, light and dark:
// - the machine (<lineage-device>) holds a browser window with window controls, tabs, toolbar,
//   an omnibox and the profile avatar;
// - the omnibox shows a code host address (blob with #L range, search, or the sandbox page);
// - the pointer is a system arrow or I-beam (no orange fill) and moves in stepped frames, about 12
//   per second by default;
// - the replay reaches the end at 8x; open sessions show typed-in edits, closed ones sealed ranges;
// - no horizontal page scroll, no monospace, no console errors;
// - with prefers-reduced-motion the pointer jumps (no in-between frames) and nothing blinks.
// Then the token page (device) and the embed kit's <lineage-screen frame="window"> and reel thumbnails.
// Screenshots go to --shots (default scripts/sessions/shots).
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/sessions/ui-check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9662 [--shots <dir>] [--session <id>]... [--mint <mint>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PW = arg("pw");
const WEB = (arg("web") ?? "http://127.0.0.1:9662").replace(/\/+$/, "");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const SHOTS = arg("shots") ?? join(import.meta.dir, "shots");
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules/playwright-core/index.mjs"));

const only = argv.flatMap((a, i) => (argv[i - 1] === "--session" ? [a] : []));
const all = (await (await fetch(`${WEB}/api/sessions?limit=100`)).json()) as any[];
const sessions = only.length
  ? all.filter((s) => only.includes(s.session_id))
  : (["anthropic", "routed"].map((p) => all.find((s) => s.proposer === p && s.state === "final" && s.events >= 10)).filter(Boolean) as any[]);
if (!sessions.length) throw new Error("the dashboard lists no matching sessions");

const checks: { check: string; ok: boolean; detail?: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: arg("chrome") ?? join(process.env.HOME!, "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell") });

async function open(path: string, width: number, theme: "light" | "dark", reduced = false) {
  const page = await browser.newPage({ viewport: { width, height: width > 600 ? 900 : 844 }, colorScheme: theme, reducedMotion: reduced ? "reduce" : "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript((t: string) => {
    try {
      localStorage.setItem("lineage-theme", t);
    } catch {}
  }, theme);
  await page.goto(`${WEB}${path}`);
  return { page, errors };
}

/** Distinct pointer positions sampled every ~16 ms over ms. */
async function pointerFrames(page: any, ms: number): Promise<{ distinct: number; moved: boolean }> {
  return page.evaluate(async (ms: number) => {
    const el = document.querySelector<HTMLElement>(".cr-cursor");
    const seen: string[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const v = el?.style.transform ?? "";
      if (seen.at(-1) !== v) seen.push(v);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { distinct: seen.length, moved: seen.length > 1 };
  }, ms);
}

const state = (page: any) =>
  page.evaluate(() => {
    const cr = document.querySelector(".cr")!;
    const cur = document.querySelector(".cr-cursor svg path") as SVGPathElement | null;
    const prog = document.querySelector(".lp-prog");
    return {
      device: !!document.querySelector(".lp lineage-device"),
      lights: cr.querySelectorAll(".cr-lights i").length,
      tabs: cr.querySelectorAll(".cr-tab").length,
      omni: cr.querySelector(".cr-url")?.textContent ?? "",
      avatar: !!cr.querySelector(".cr-avatar")?.textContent,
      scheme: (cr as HTMLElement).dataset.scheme,
      cursorKind: document.querySelector<HTMLElement>(".cr-cursor")?.dataset.kind ?? "",
      cursorFill: cur ? getComputedStyle(cur).fill + " " + (cur.getAttribute("fill") ?? "") : "",
      now: Number(prog?.getAttribute("aria-valuenow")),
      max: Number(prog?.getAttribute("aria-valuemax")),
      edited: document.querySelectorAll(".lp-l.edited").length,
      sealed: document.querySelectorAll(".lp-l.sealed").length,
      lines: document.querySelectorAll(".lp-l").length,
      run: document.querySelector(".lp-run")?.textContent ?? "",
      wide: document.documentElement.scrollWidth <= window.innerWidth + 1,
      mono: [...document.querySelectorAll(".lp *, .lp-list *")].filter((e) => /mono/i.test(getComputedStyle(e).fontFamily)).map((e) => (e as HTMLElement).className).slice(0, 3),
    };
  });

try {
  for (const s of sessions) {
    const name = `${s.proposer}-${s.session_id.slice(0, 8)}`;
    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"] as const) {
        const tag = `${name} ${width} ${theme}`;
        const { page, errors } = await open(`/sessions/${s.session_id}`, width, theme);
        await page.waitForSelector(".cr .cr-tab", { timeout: 20_000 });
        // the pointer appears with the first file it opens
        await page.waitForFunction(() => document.querySelector(".cr-cursor")?.getAttribute("data-on") === "1", null, { timeout: 30_000 }).catch(() => {});
        const fr = await pointerFrames(page, 3000);
        let st = await state(page);
        check(`${tag}: machine with a browser window`, st.device && st.lights === 3 && st.tabs >= 1 && st.avatar, `device ${st.device}, ${st.lights} window controls, ${st.tabs} tabs`);
        check(`${tag}: window follows the theme`, st.scheme === theme, String(st.scheme));
        check(`${tag}: pointer is a system arrow or I-beam`, /arrow|ibeam/.test(st.cursorKind) && !/#e06510|#ff7a17|rgb\(224, 101, 16\)/i.test(st.cursorFill), `${st.cursorKind}, ${st.cursorFill}`);
        // 12 fps default: at most about 12 positions a second (plus the odd frame boundary)
        check(`${tag}: stepped pointer motion (about 12 fps)`, fr.moved && fr.distinct <= 3 * 14, `${fr.distinct} positions in 3 s`);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(SHOTS, `${name}-${width}-${theme}-mid.png`) });
        st = await state(page);
        check(`${tag}: omnibox shows where the agent is looking`, /\/(blob|tree)\/[0-9a-f]{7}|\/search\?q=|lineage:\/\/sandbox|^$/.test(st.omni) && st.omni.length > 0, st.omni.slice(0, 90));
        await page.click('.lp-seg button[data-speed="8"]').catch(() => {});
        await page
          .waitForFunction(
            () => {
              const p = document.querySelector(".lp-prog");
              return p && Number(p.getAttribute("aria-valuenow")) >= Number(p.getAttribute("aria-valuemax"));
            },
            null,
            { timeout: 240_000 },
          )
          .catch(() => {});
        await page.waitForTimeout(1500);
        // the file the agent changed, for the final screenshot
        await page.evaluate(() => {
          const tabs = [...document.querySelectorAll<HTMLElement>(".cr-tab")];
          const edited = tabs.find((t) => t.querySelector(".cr-dot, .cr-mark"));
          edited?.click();
        });
        await page.waitForTimeout(400);
        st = await state(page);
        check(`${tag}: replay reached the end`, st.max > 0 && st.now >= st.max, `${st.now}/${st.max}`);
        check(`${tag}: tabs and code rendered`, st.tabs >= 2 && st.lines > 0, `${st.tabs} tabs, ${st.lines} lines`);
        if (s.open) check(`${tag}: edits typed in (open session)`, st.edited > 0, `${st.edited} edited lines`);
        else check(`${tag}: edits shown sealed (closed session)`, st.sealed > 0 && st.edited === 0, `${st.sealed} sealed lines`);
        check(`${tag}: runs and verdict under the machine`, /Sandbox runs/i.test(st.run) && /Network verdict/i.test(st.run));
        check(`${tag}: no horizontal page scroll`, st.wide);
        check(`${tag}: no monospace`, st.mono.length === 0, st.mono.join(", "));
        await page.screenshot({ path: join(SHOTS, `${name}-${width}-${theme}-end.png`) });
        check(`${tag}: no console errors`, errors.length === 0, errors.join("; ").slice(0, 300));
        await page.close();
      }
    }
    // reduced motion: the pointer jumps, nothing blinks
    const { page, errors } = await open(`/sessions/${s.session_id}`, 1280, "light", true);
    await page.waitForSelector(".cr .cr-tab", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) samples.push((await pointerFrames(page, 1000)).distinct);
    const blink = await page.evaluate(() => [...document.querySelectorAll(".lp-caret, .cr-caret, .cr-spin, .lp-livedot")].filter((e) => getComputedStyle(e).animationName !== "none").length);
    check(`${name} reduced motion: pointer jumps without in-between frames`, samples.every((n) => n <= 3), samples.join(","));
    check(`${name} reduced motion: no blinking or spinning`, blink === 0, String(blink));
    await page.screenshot({ path: join(SHOTS, `${name}-reduced.png`) });
    check(`${name} reduced motion: no console errors`, errors.length === 0, errors.join("; ").slice(0, 300));
    await page.close();
  }

  // the token page: the agent's window on the machine
  const mint = arg("mint") ?? ((await (await fetch(`${WEB}/market/tokens?limit=50`)).json()) as any).tokens?.find((t: any) => t.agent)?.mint;
  if (mint) {
    for (const width of [1280, 390]) {
      const { page, errors } = await open(`/tokens/${mint}`, width, width > 600 ? "light" : "dark");
      await page.waitForSelector(".lp lineage-device .cr-tab", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const ok = await page.evaluate(() => !!document.querySelector(".lp lineage-device .cr .cr-omni") && document.documentElement.scrollWidth <= innerWidth + 1);
      check(`token page ${width}: machine with the window, no horizontal scroll`, ok);
      await page.locator(".lp").first().screenshot({ path: join(SHOTS, `token-${width}.png`) }).catch(() => {});
      check(`token page ${width}: no console errors`, errors.length === 0, errors.join("; ").slice(0, 300));
      await page.close();
    }
  } else check("token page: a token with a session", false, "none listed");

  // the embed kit: <lineage-screen frame="window"> and reel thumbnails, on a host page served by
  // interception (a separate origin on loopback is refused by Chrome's local network access rules)
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
      await page.route(`${WEB}/__embed-check.html`, (r: any) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0;padding:16px;background:${theme === "dark" ? "#111" : "#f6f5f2"}">
<script src="${WEB}/embed/lineage-embed.js" data-api="${WEB}" defer></script>
<lineage-screen session="${sessions[0].session_id}" frame="window" height="360"></lineage-screen><div style="height:16px"></div>
<lineage-screen session="${sessions[0].session_id}" frame="device" fps="24"></lineage-screen><div style="height:16px"></div>
<lineage-reel limit="4" layout="grid"></lineage-reel></body>`,
        }),
      );
      await page.goto(`${WEB}/__embed-check.html`);
      await page.waitForTimeout(6000);
      // reel cards paint as they scroll into view
      await page.evaluate(() => document.querySelector("lineage-reel")?.scrollIntoView());
      await page.waitForTimeout(4000);
      const r = await page.evaluate(() => {
        const [a, b] = [...document.querySelectorAll("lineage-screen")].map((x) => x.shadowRoot);
        return {
          win: !!a?.querySelector(".lp[data-frame=window] .cr .cr-omni") && !a?.querySelector("lineage-device"),
          dev: !!b?.querySelector(".lp[data-frame=device] lineage-device .cr"),
          thumbs: [...(document.querySelector("lineage-reel")?.shadowRoot?.querySelectorAll("canvas") ?? [])].length,
          wide: document.documentElement.scrollWidth <= innerWidth + 1,
        };
      });
      check(`embed ${width} ${theme}: screen frame=window is the window alone`, r.win);
      check(`embed ${width} ${theme}: screen frame=device is on the machine`, r.dev);
      check(`embed ${width} ${theme}: reel thumbnails drawn`, r.thumbs > 0, `${r.thumbs} canvases`);
      check(`embed ${width} ${theme}: no horizontal page scroll`, r.wide);
      await page.screenshot({ path: join(SHOTS, `embed-${width}-${theme}.png`), fullPage: true });
      check(`embed ${width} ${theme}: no console errors`, errors.length === 0, errors.join("; ").slice(0, 300));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok).length;
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, sessions: sessions.map((s) => s.session_id), passed: checks.length - failed, total: checks.length, checks }, null, 2) + "\n");
console.log(`${checks.length - failed}/${checks.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);

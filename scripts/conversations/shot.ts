// Headless screenshot of one page at one width: bun scripts/conversations/shot.ts <url> <out.png> <width> [height] [wait ms]. Reports horizontal overflow and page errors.
import { chromium } from "@playwright/test";
const [url, out, w, h = "900", wait = "2500"] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url!, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(Number(wait));
const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await p.screenshot({ path: out!, fullPage: true });
console.log(JSON.stringify({ out, overflow_px: ov, errors: errs.slice(0, 3) }));
await b.close();

#!/usr/bin/env bun
// Launch from a tweet, local end-to-end proof (docs/plans/TWEET-LAUNCH.md 8). Nothing here talks to
// X, signs anything or sends a transaction.
//
//   bun scripts/tweet-launch/proof.ts
//
// A mock X API (127.0.0.1:9666), a local simulated Core (in process), a stub for the market's coin
// name (9667) and this tree's web app (9663, reading the chain config of the mainnet site, read only).
// The real CLI runs against the mock: a mention under a GitHub post goes in, the reply with the link
// comes out; headless Chromium opens that link and the launch page shows the repository, name and
// ticker and sends nothing; a launch on that repository is then registered on the local Core (the
// simulation: no chain), the page's one request hands the link's id in, and the next pass posts the
// follow-up in the thread. Writes scripts/tweet-launch/PROOF-LAST.json.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "../../packages/core/src/protocol.ts";
import { bare, expectOk } from "../../packages/core/test/helpers.ts";
import { startMockX } from "../../packages/tweet-launch/src/mock-x.ts";
import sites from "../../config/sites.json" with { type: "json" };

const ROOT = join(import.meta.dir, "../..");
// ports of this repository's test block; PROOF_PORTS=x,names,web picks others when a lane holds these (0: any free port)
const [X_PORT, NAME_PORT, WEB_PORT] = (process.env.PROOF_PORTS ?? "9666,9667,9663").split(",").map(Number) as [number, number, number];
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const busy = (port: number) => {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`]).toString().trim();
  } catch {
    return "";
  }
};

async function main() {
  for (const p of [X_PORT, NAME_PORT, WEB_PORT]) if (p && busy(p)) throw new Error(`port ${p} is in use (pid ${busy(p)}): not mine to take`);
  const x = startMockX({ port: X_PORT });
  const core = bare();
  // the simulated Core's clock is a test clock: bring it to now, as a launch must be newer than its link
  core.clock.advance(Date.now() - core.clock.now());
  const names: Record<string, string> = {};
  const nameStub = Bun.serve({ port: NAME_PORT, hostname: "127.0.0.1", fetch: (req) => { const mint = new URL(req.url).pathname.split("/").pop()!; return names[mint] ? Response.json({ mint, name: names[mint] }) : new Response("{}", { status: 404 }); } });
  const site = sites.mainnet_site_url.replace(/\/+$/, "");
  const web = spawn("bun", ["apps/web/server.ts", "--port", String(WEB_PORT), "--site", site, "--core", core.base, "--market", site, "--upstream", site], { cwd: ROOT, stdio: "ignore" });
  const dir = mkdtempSync(join(tmpdir(), "tweet-launch-proof-"));
  const cfgFile = join(dir, "config.json");
  const app = `http://127.0.0.1:${WEB_PORT}`;
  const cfg = { enabled: true, handle: "unitsdotgg", app_url: app, market_url: `http://127.0.0.1:${nameStub.port}/market`, state_dir: join(dir, "state"), credentials_file: join(dir, "none.env"), follow_up: "own_reply", min_seconds_between_posts: 0 };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  // not execFileSync: the mock X API and the Core live in this process and must keep answering
  const cli = async (...args: string[]) => {
    const p = Bun.spawn(["bun", "packages/tweet-launch/src/main.ts", "--config", cfgFile, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: out + err };
  };
  let browser: any = null;
  try {
    for (let i = 0; i < 120; i++) {
      if (await fetch(`${app}/api/config`).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(500);
    }
    // no credentials and no mock: it does not run
    const none = await cli();
    check("without credentials and without --mock the service does not run", none.code === 2 && none.out.includes("runs only against --mock"), `exit ${none.code}`);

    x.users.set("7", "ann");
    x.users.set("8", "keis");
    const parent = x.add({ text: "base58 0.3 is out https://t.co/abc", author_id: "8", urls: ["https://github.com/keis/base58"] });
    const mention = x.add({ text: "@keis @unitsdotgg launch name Tidy Base58 ticker tb58", author_id: "7", replied_to: parent.id, mention: true });

    const dry = await cli("--mock", x.url);
    check("dry run prints the reply it would post and posts nothing", dry.code === 0 && dry.out.includes("would post") && dry.out.includes("Launch an agent on keis/base58") && x.posted.length === 0, `exit ${dry.code}`);
    check("dry run leaves no state file", !existsSync(join(cfg.state_dir, "state.json")));

    const first = await cli("--mock", x.url, "--send");
    const reply = x.posted[0];
    const link = reply?.text.split("\n")[1] ?? "";
    const ref = new URL(link || "http://x/").searchParams.get("tl") ?? "";
    check("mention in, one reply out, in the thread, the owner's wording, the free reading of the real repository passed", first.code === 0 && x.posted.length === 1 && reply!.in_reply_to === mention.id && reply!.text.startsWith("@ann Launch an agent on keis/base58. Connect a wallet and approve:\n"), reply?.text.replace("\n", " | "));
    check("the link carries the repository, the name, the ticker and a 22 character id, and nothing about the author or the tweet", link === `${app}/launch?repo=keis/base58&name=Tidy+Base58&ticker=TB58&tl=${ref}` && /^[A-Za-z0-9_-]{22}$/.test(ref), link);

    // the launch page, headless, a fresh profile, no wallet
    const pw = await import(join(ROOT, "node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/index.mjs"));
    const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
    browser = await pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
    const shots: string[] = [];
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const writes: string[] = [];
      // a chain read is a JSON-RPC POST: named by its method, so a send would show
      page.on("request", (r: any) => {
        if (r.method() === "GET" || r.method() === "HEAD" || r.method() === "OPTIONS") return;
        const rpc = /\/chain\/rpc/.test(r.url()) ? [...String(r.postData() ?? "").matchAll(/"method"\s*:\s*"(\w+)"/g)].map((m) => m[1]).join("+") : "";
        writes.push(rpc ? `rpc ${rpc}` : `${r.method()} ${r.url()}`);
      });
      await page.goto(link, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[name="l_repo"]', { state: "attached", timeout: 60_000 });
      await page.waitForFunction(() => (document.querySelector('[name="l_name"]') as HTMLInputElement | null)?.value, null, { timeout: 30_000 });
      await page.waitForTimeout(4000);
      const v = await page.evaluate(() => Object.fromEntries(["l_repo", "l_name", "l_symbol", "s_vibe"].map((n) => [n, (document.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value ?? null])));
      const held = await page.evaluate(() => sessionStorage.getItem("units.tweet_ref"));
      check(`launch page at ${width}: repository, name and ticker are filled, the vibe is empty`, v.l_repo === "https://github.com/keis/base58" && v.l_name === "Tidy Base58" && v.l_symbol === "TB58" && v.s_vibe === "", JSON.stringify(v));
      // chain reads (get* methods) are the page's own; anything else that is not a GET fails this
      const sent = writes.filter((w) => !/^rpc (get[A-Za-z]+\+?)+$/.test(w));
      check(`launch page at ${width}: nothing is sent (no launch, no hand-in to Core, no wallet request)`, sent.length === 0 && !writes.some((w) => w.includes("tweet-launches")), [...new Set(writes)].join(", ") || "no request but GETs");
      check(`launch page at ${width}: the link's id is kept for the tab only`, held === JSON.stringify({ ref, repo: "keis/base58" }));
      const shot = join(ROOT, "work/tweet-launch-shots", `launch-prefill-${width}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      shots.push(shot);
      if (width === 1280) {
        check("Core has no launch for the link yet", (await fetch(`${app}/api/tweet-launches/${ref}`)).status === 404);
        await cli("--mock", x.url, "--send");
        check("a pass before any launch posts nothing more", x.posted.length === 1);
        // the simulation: a launch on that repository registered on the local Core (no chain, no transaction)
        const a = { agent: generateAgentKey().id, mint: generateAgentKey().id };
        core.clock.advance(Date.now() - core.clock.now() + 1000);
        await expectOk(core.admin.c.post("/v1/admin/launches", { ...a, launcher: generateAgentKey().id, target_repo: "https://github.com/keis/base58", hosted: true, identity_mode: "app" }));
        names[a.mint] = "Tidy Base58";
        // the request the page makes once its launch landed (apps/web/wallet/tweet-ref.ts), from the page, same origin
        const status = await page.evaluate(async ([agent, mint]: string[]) => {
          const held = JSON.parse(sessionStorage.getItem("units.tweet_ref")!);
          return (await fetch("/api/tweet-launches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: held.ref, agent, mint }) })).status;
        }, [a.agent, a.mint]);
        check("the page's hand-in reaches Core through the web server", status === 200, `HTTP ${status}`);
        const second = await cli("--mock", x.url, "--send");
        const fu = x.posted[1];
        check("the launch is seen and the follow-up is posted in the thread, under the bot's own reply", second.code === 0 && x.posted.length === 2 && fu!.in_reply_to === reply!.id && fu!.text === `Tidy Base58 is live on keis/base58. Watch it work:\n${app}/tokens/${a.mint}`, fu?.text.replace("\n", " | "));
        await cli("--mock", x.url, "--send");
        check("later passes post nothing more", x.posted.length === 2);
      }
      await page.close();
    }
    const state = readFileSync(join(cfg.state_dir, "state.json"), "utf8");
    check("the state file holds no token", !/mock-access|mock-refresh|mock-client-secret/.test(state));
    check("every request to the mock X API was authenticated", x.requests.length > 0 && x.requests.every((r) => r.auth === "Bearer" || r.path === "/2/oauth2/token"), `${x.requests.length} requests`);
    const ok = checks.every((c) => c.ok);
    writeFileSync(join(ROOT, "scripts/tweet-launch/PROOF-LAST.json"), JSON.stringify({ at: new Date().toISOString(), ok, passed: checks.filter((c) => c.ok).length, of: checks.length, x_api: "mock", posted: x.posted.map((p) => ({ in_reply_to: p.in_reply_to, text: p.text.replace(ref, "<id>") })), checks }, null, 1) + "\n");
    console.log(`${ok ? "PASS" : "FAIL"} ${checks.filter((c) => c.ok).length}/${checks.length}; screenshots ${shots.join(", ")}`);
    return ok ? 0 : 1;
  } finally {
    await browser?.close().catch(() => undefined);
    web.kill(); // by its own pid
    nameStub.stop(true);
    x.stop();
    core.close();
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

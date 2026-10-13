#!/usr/bin/env bun
// "Started from a tweet" in a headless browser (docs/plans/TWEET-LAUNCH.md 9): runs tests/ui/tweet-origin.spec.ts
// at 1280 and 390 against this tree's web app and a local Core seeded with launch links.
//
//   bun scripts/tweet-launch/origin-ui.ts            (ORIGIN_UI_PORT=9668 picks the web app's port; UI_SHOTS=<dir> keeps screenshots)
//
// What runs: a simulated Core in this process (no chain) holding one open link, one past its time and one
// launch that started from a link; the web app built from this tree on 127.0.0.1:<port>; and between them a
// pass-through that sends the feature's reads (/v1/tweet-links/*, /v1/agents/<the seeded agent>/*) to the
// local Core and every other read to the deployed site (mainnet by default), read only, so the wizard has real prices and a real
// repository check. Nothing is posted to X, no X API is called, nothing is signed or sent: the suite's
// write guard refuses every send.
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { generateAgentKey } from "../../packages/core/src/protocol.ts";
import { bare, expectOk } from "../../packages/core/test/helpers.ts";
import sites from "../../config/sites.json" with { type: "json" };

const ROOT = join(import.meta.dir, "../..");
const PORT = Number(process.env.ORIGIN_UI_PORT ?? 9668);
// the site whose reads fill the rest of the wizard: the default network's (mainnet); ORIGIN_UI_SITE=devnet for the devnet site
const DEVNET = process.env.ORIGIN_UI_SITE === "devnet";
const SITE = (DEVNET ? sites.devnet_site_url : sites.mainnet_site_url).replace(/\/+$/, "");
const NETWORK = DEVNET ? "devnet" : "mainnet";
const HOUR = 3_600_000;
const busy = (port: number) => {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`]).toString().trim();
  } catch {
    return "";
  }
};

async function main(): Promise<number> {
  if (busy(PORT)) throw new Error(`port ${PORT} is in use (pid ${busy(PORT).replace(/\n/g, " ")}): not mine to take; set ORIGIN_UI_PORT`);
  const core = bare();
  const link = { repo: "keis/base58", tweet_id: "1977000000000000001", handle: "ann_builds", under_handle: "keis_dev" };
  const seed = { good: "Good0000000000000000_g", expired: "Late0000000000000000_x", unknown: "None0000000000000000_n", used: "Used0000000000000000_u", agent: generateAgentKey().id, mint: generateAgentKey().id, plain: generateAgentKey().id, plain_mint: generateAgentKey().id, ...link, tweet_url: `https://x.com/${link.handle}/status/${link.tweet_id}` };
  // a link past its time, then the open one, then a launch that started from a third
  await expectOk(core.admin.c.post("/v1/tweet-links", { ref: seed.expired, ...link, hours: 1 }));
  core.clock.advance(2 * HOUR);
  await expectOk(core.admin.c.post("/v1/tweet-links", { ref: seed.good, ...link }));
  await expectOk(core.admin.c.post("/v1/tweet-links", { ref: seed.used, ...link }));
  core.clock.advance(60_000);
  await expectOk(core.admin.c.post("/v1/admin/launches", { agent: seed.agent, mint: seed.mint, launcher: generateAgentKey().id, target_repo: "https://github.com/keis/base58", hosted: true, identity_mode: "app" }));
  await expectOk(core.admin.c.post("/v1/admin/launches", { agent: seed.plain, mint: seed.plain_mint, launcher: generateAgentKey().id, target_repo: "https://github.com/keis/base58", hosted: true, identity_mode: "app" }));
  await expectOk(core.anon.post("/v1/tweet-launches", { ref: seed.used, agent: seed.agent, mint: seed.mint }));

  const local = new RegExp(`^/v1/(tweet-links/|agents/(${seed.agent}|${seed.plain})(/|$))`);
  const asked: string[] = [];
  const between = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("read only", { status: 405 });
      if (local.test(u.pathname)) {
        asked.push(u.pathname);
        return fetch(`${core.base}${u.pathname}${u.search}`);
      }
      // the site's answer as it is, without the transfer headers fetch has already undone
      return fetch(`${SITE}${u.pathname}${u.search}`, { headers: { accept: req.headers.get("accept") ?? "*/*" }, signal: req.signal }).then(
        (r) => new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } }),
        (e) => Response.json({ error: "site_unreachable", message: String((e as Error).message) }, { status: 502 }),
      );
    },
  });
  const web = spawn("bun", ["apps/web/server.ts", "--port", String(PORT), "--site", SITE, "--core", `http://127.0.0.1:${between.port}`, "--market", SITE, "--upstream", SITE], { cwd: ROOT, stdio: "ignore", env: { ...process.env, UNITS_NETWORK: NETWORK } });
  let code = 1;
  try {
    const app = `http://127.0.0.1:${PORT}`;
    for (let i = 0; ; i++) {
      if ((await fetch(`${app}/chain/config`).catch(() => null))?.ok) break;
      if (i > 240 || web.exitCode !== null) throw new Error("the web app did not start");
      await Bun.sleep(500);
    }
    const pw = spawn("bunx", ["playwright", "test", "tests/ui/tweet-origin.spec.ts", ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit", env: { ...process.env, UI_BASE_URL: app, UI_NETWORK: NETWORK, TWEET_ORIGIN_UI: JSON.stringify(seed) } });
    code = await new Promise<number>((r) => pw.on("exit", (c) => r(c ?? 1)));
    console.log(`[origin-ui] the local Core answered ${asked.length} reads of the feature (${[...new Set(asked.map((p) => p.replace(/[A-Za-z0-9_-]{22,}/g, ":id")))].join(", ")})`);
  } finally {
    if (web.pid) process.kill(web.pid);
    between.stop(true);
    core.close();
  }
  return code;
}

main().then((c) => process.exit(c), (e) => {
  console.error(`[origin-ui] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

// Identity lane UI check: the agents page and an agent page show verified links with status, the
// card and the ERC-8004 file, at desktop and phone width, without monospace or horizontal scroll.
// A simulated Core (9665) and the dashboard (9666) on fresh data; the souls lane's TEST agent is
// launched there with its soul, proves the live gist on owunqwxs (Core fetches it from GitHub) and a
// domain on a local test server (9669).
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/identity/ui-check.ts --pw <dir with node_modules/playwright-core> --gist <live gist url> [--chrome <headless shell>] [--shots <dir>]
import { spawn } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient } from "../../packages/core/src/client.ts";
import { domainProofJson, linkStatement, signLink } from "../../packages/core/src/links.ts";
import { generateAgentKey, keyFromSolanaJson } from "../../packages/core/src/protocol.ts";
import { signSoul } from "../../packages/souls/src/doc.ts";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PW = arg("pw");
const GIST = arg("gist");
if (!PW || !GIST) throw new Error("--pw <dir> and --gist <url> are required");
const SHOTS = arg("shots") ?? join(import.meta.dir, "shots");
const CORE_PORT = 9665;
const WEB_PORT = 9666;
const DOMAIN_PORT = 9669;
const ROOT = join(import.meta.dir, "../..");
for (const p of [CORE_PORT, WEB_PORT, DOMAIN_PORT]) if (Bun.spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is in use`);
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import(join(PW, "node_modules/playwright-core/index.mjs"));
const tmp = mkdtempSync(join(tmpdir(), "lineage-identity-ui-"));
const admin = generateAgentKey();
await Bun.write(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)));
const host = `127.0.0.1:${DOMAIN_PORT}`;
const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(CORE_PORT), "--config", join(ROOT, "config/network.json"), "--admin-key", join(tmp, "admin.json"), "--no-trees"], {
  stdout: "ignore",
  stderr: "ignore",
  env: { ...process.env, LINEAGE_LINK_HTTP_HOSTS: host },
});
const web = spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(WEB_PORT), "--core", `http://127.0.0.1:${CORE_PORT}`], { stdout: "ignore", stderr: "ignore" });
const agentKey = keyFromSolanaJson(JSON.parse(readFileSync(join(process.env.HOME!, ".config/lineage/devnet/souls-test-agent.json"), "utf8")));
const domainBody = domainProofJson([signLink(agentKey, linkStatement(agentKey.id, "domain", host, Date.now() / 1000))]);
const domain = Bun.serve({ port: DOMAIN_PORT, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/.well-known/lineage-agent.json" ? new Response(domainBody) : new Response("no", { status: 404 })) });
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
  const base = `http://127.0.0.1:${CORE_PORT}`;
  await up(`${base}/v1/health`);
  await up(`http://127.0.0.1:${WEB_PORT}/`);
  const A = new CoreClient(base, admin);
  const me = new CoreClient(base, agentKey);
  await A.post("/v1/admin/launches", { agent: agentKey.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "purchased" });
  for (const f of ["soul-a.json", "soul-a-v2.json"]) {
    const doc = JSON.parse(readFileSync(join(ROOT, "scripts/souls/proof", f), "utf8"));
    await fetch(`${base}/v1/agents/${agentKey.id}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig: signSoul(agentKey, doc) }) });
  }
  const g = await me.post(`/v1/agents/${agentKey.id}/links`, { service: "github", handle: "owunqwxs", proof_url: GIST });
  check("live gist verifies in the UI Core", g.body.status === "verified", g.body.status ?? g.body.message);
  const d = await me.post(`/v1/agents/${agentKey.id}/links`, { service: "domain", handle: host });
  check("domain proof verifies in the UI Core", d.body.status === "verified", d.body.status ?? d.body.message);

  const browser = await chromium.launch({ executablePath: arg("chrome") ?? join(process.env.HOME!, "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell") });
  for (const [label, viewport] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    for (const [name, path] of [["agents", "/agents"], ["agent", `/agents/${agentKey.id}`]] as const) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${WEB_PORT}${path}`);
      await page.waitForSelector("text=Verified links", { timeout: 20_000 });
      const text = (await page.textContent("main")) ?? "";
      check(`${label} ${name}: verified links listed with status`, text.includes("owunqwxs") && text.includes(host) && text.includes("verified"));
      if (name === "agent") check(`${label} agent: card and ERC-8004 file linked`, text.includes("agent card") && text.includes("ERC-8004 registration file"));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check(`${label} ${name}: no horizontal page scroll`, wide);
      const mono = await page.evaluate(() => [...document.querySelectorAll("main *")].some((e) => /mono/i.test(getComputedStyle(e).fontFamily)));
      check(`${label} ${name}: no monospace`, !mono);
      await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`), fullPage: true });
      check(`${label} ${name}: no page errors`, errors.length === 0, errors.join("; "));
      await page.close();
    }
  }
  await browser.close();
} finally {
  core.kill();
  web.kill();
  domain.stop(true);
  await Promise.all([core.exited, web.exited]);
  rmSync(tmp, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed; screenshots in ${SHOTS}`);
if (failed) process.exit(1);

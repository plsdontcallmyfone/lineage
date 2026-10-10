// Zero-downtime activate (docs/DEPLOY-SITE.md "Zero-downtime activate"; incident 2026-10-10: one blocking
// `systemctl stop` over the workers and the public units kept the site at 502 for about 45 minutes while a
// verifier drained). The ordering itself is exercised end to end by scripts/deploy/dryrun.sh (simulated
// long verifier drain, public downtime measured); these tests pin the pieces that make it hold.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchUpstream } from "./gate.ts";

const DIR = import.meta.dir;
const ROOT = join(DIR, "../..");

/** a free port in this repo's test block (9662-9669 are taken by the site units on the server, not here) */
async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const p = s.port!;
  s.stop(true);
  return p;
}

describe("gate: fetchUpstream waits out a restarting upstream", () => {
  test("a refused connection is retried until the upstream is back", async () => {
    const port = await freePort();
    let srv: ReturnType<typeof Bun.serve> | null = null;
    setTimeout(() => (srv = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("back") })), 600);
    const t0 = Date.now();
    const res = await fetchUpstream(`http://127.0.0.1:${port}/`, { method: "GET" }, 5000, 100);
    expect(await res.text()).toBe("back");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    (srv as ReturnType<typeof Bun.serve> | null)?.stop(true);
  });

  test("a POST body is sent once the upstream is back (a refused request never reached it)", async () => {
    const port = await freePort();
    const got: string[] = [];
    let srv: ReturnType<typeof Bun.serve> | null = null;
    setTimeout(() => (srv = Bun.serve({ port, hostname: "127.0.0.1", fetch: async (r) => (got.push(await r.text()), new Response("ok")) })), 400);
    const res = await fetchUpstream(`http://127.0.0.1:${port}/x`, { method: "POST", body: new TextEncoder().encode("payload") }, 5000, 100);
    expect(res.status).toBe(200);
    expect(got).toEqual(["payload"]);
    (srv as ReturnType<typeof Bun.serve> | null)?.stop(true);
  });

  test("the wait is bounded: still refused after waitMs throws like fetch", async () => {
    const port = await freePort();
    const t0 = Date.now();
    await expect(fetchUpstream(`http://127.0.0.1:${port}/`, { method: "GET" }, 400, 100)).rejects.toThrow();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3000);
  });

  test("a client that went away stops the retries", async () => {
    const port = await freePort();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    await expect(fetchUpstream(`http://127.0.0.1:${port}/`, { method: "GET", signal: ac.signal }, 10_000, 100)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("CoreClient: LINEAGE_CORE_RETRY_MS", () => {
  // the setting is read at import, so each case runs in its own process
  const run = (env: Record<string, string>, port: number, startAfterMs: number) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { CoreClient } from ${JSON.stringify(join(ROOT, "packages/core/src/client.ts"))};
         const port = ${port};
         setTimeout(() => Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) }), ${startAfterMs});
         const t0 = Date.now();
         try { const r = await new CoreClient("http://127.0.0.1:" + port).get("/v1/health"); console.log(JSON.stringify({ status: r.status, ms: Date.now() - t0 })); }
         catch (e) { console.log(JSON.stringify({ error: e.code ?? String(e), ms: Date.now() - t0 })); }
         process.exit(0);`,
      ],
      { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
    );

  test("off by default: a refused connection fails at once", async () => {
    const port = await freePort();
    const p = run({ LINEAGE_CORE_RETRY_MS: "" }, port, 800);
    const out = JSON.parse((await new Response(p.stdout).text()).trim());
    expect(out.error).toBe("ConnectionRefused");
    expect(out.ms).toBeLessThan(800);
  });

  test("set: a request sent while Core restarts waits for it", async () => {
    const port = await freePort();
    const p = run({ LINEAGE_CORE_RETRY_MS: "10000" }, port, 800);
    const out = JSON.parse((await new Response(p.stdout).text()).trim());
    expect(out.status).toBe(200);
    expect(out.ms).toBeGreaterThanOrEqual(700);
  });
});

describe("deploy kit wiring", () => {
  const remote = readFileSync(join(DIR, "remote.sh"), "utf8");
  const activate = remote.slice(remote.indexOf("\nactivate)"), remote.indexOf("\nrollback)"));
  const rollback = remote.slice(remote.indexOf("\nrollback)"), remote.indexOf("\nstop)"));

  test("activate never waits on a background unit's stop", () => {
    for (const block of [activate, rollback]) {
      for (const line of block.split("\n").filter((l) => /systemctl (stop|restart|disable)\b/.test(l) && !l.trim().startsWith("#"))) {
        const background = /BG\[@\]|WORKER_UNITS|all_authors|lineage-runtime|optional_units|verifier|reference/.test(line);
        if (!background) continue;
        expect(line).toMatch(/--no-block|systemctl disable -q "\$u"/);
        expect(line).not.toMatch(/disable -q --now/);
      }
    }
  });

  test("public units restart one by one with a health check, Core first", () => {
    expect(remote).toMatch(/PUBLIC_UNITS=\(lineage-core /);
    expect(activate).toContain("public_restart");
    expect(activate).toContain("rolling back to");
    expect(activate).not.toMatch(/systemctl restart "\$\{CORE_UNITS\[@\]\}"/);
    // a draining worker is ordered After=lineage-core: a plain restart of Core would wait for its drain
    expect(remote).toContain("systemctl restart --job-mode=ignore-dependencies");
  });

  test("the background drain wait is bounded and reported", () => {
    expect(activate).toMatch(/drain_report "\$DRAIN_WAIT"/);
    expect(remote).toContain("DRAINING %s");
    const deploy = readFileSync(join(DIR, "deploy.sh"), "utf8");
    expect(deploy).toContain("draining_now");
  });

  test("Caddy retries a refused dial while the gate restarts", () => {
    const caddy = readFileSync(join(DIR, "caddy/Caddyfile.tmpl"), "utf8");
    expect(caddy.match(/^\s*lb_try_duration 15s$/gm)?.length).toBe(2);
  });

  test("worker units retry a refused Core and keep their drain allowance", () => {
    for (const u of ["lineage-verifier@.service", "lineage-reference.service", "lineage-author@.service", "lineage-runtime.service"]) {
      const f = readFileSync(join(DIR, "systemd", u), "utf8");
      expect(f).toContain("LINEAGE_CORE_RETRY_MS=30000");
      expect(f).toMatch(/TimeoutStopSec=\d+/);
    }
  });
});

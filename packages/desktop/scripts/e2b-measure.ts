// What E2B does, measured with the real key (never printed): create, pause, resume, timeouts, list.
//   bun packages/desktop/scripts/e2b-measure.ts basics        one lineage-desktop sandbox: create, pause, resume, setTimeout, kill
//   bun packages/desktop/scripts/e2b-measure.ts list          every sandbox of the account: state, template, metadata keys (ids as prefixes)
//   bun packages/desktop/scripts/e2b-measure.ts paused-limit  whether paused sandboxes count toward the concurrency limit
//   bun packages/desktop/scripts/e2b-measure.ts long          one small sandbox kept alive past the plan's session length
// Every sandbox made here carries metadata units_desktop=measure and its own owner; only those are killed.
import { randomBytes } from "node:crypto";
import { Sandbox } from "@e2b/desktop";
import { realpathSync } from "node:fs";
import { loadE2BKey } from "../src/e2b.ts";

// the plain sandbox class (the desktop package's own e2b dependency; its Sandbox export is the desktop one)
const { Sandbox: Base } = (await import(Bun.resolveSync("e2b", realpathSync(Bun.resolveSync("@e2b/desktop", import.meta.dir))))) as typeof import("@e2b/desktop");

const apiKey = loadE2BKey() as string;
if (!apiKey) throw new Error("no E2B key");
const owner = process.env.MEASURE_OWNER ?? `measure-${randomBytes(4).toString("hex")}`;
const meta = { units_desktop: "measure", owner };
const out: Record<string, unknown> = { owner, at: new Date().toISOString() };
const t = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try {
    const r = await f();
    out[`${name}_ms`] = Math.round(performance.now() - t0);
    return r;
  } catch (e) {
    out[`${name}_ms`] = Math.round(performance.now() - t0);
    out[`${name}_error`] = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
    throw e;
  }
};
const short = (id: string) => id.slice(0, 6);
async function listAll(query?: { metadata?: Record<string, string>; state?: ("running" | "paused")[] }) {
  const p = Base.list({ apiKey, query });
  const all = [];
  while (p.hasNext) all.push(...(await p.nextItems()));
  return all;
}
async function killMine() {
  const mine = await listAll({ metadata: meta });
  for (const s of mine) await Base.kill(s.sandboxId, { apiKey }).catch(() => false);
  const left = await listAll({ metadata: meta });
  return { killed: mine.length, left: left.length };
}

const mode = process.argv[2] ?? "basics";
try {
  if (mode === "list") {
    const all = await listAll();
    out.count = all.length;
    out.sandboxes = all.map((s) => ({ id: short(s.sandboxId), state: s.state, template: s.name ?? s.templateId, cpu: s.cpuCount, mem_mb: s.memoryMB, metadata: Object.fromEntries(Object.entries(s.metadata ?? {}).map(([k, v]) => [k, k === "attempt" || k === "agent" ? `${String(v).slice(0, 8)}..` : v])), started: s.startedAt.toISOString(), end: s.endAt.toISOString(), on_timeout: s.lifecycle?.onTimeout }));
  } else if (mode === "basics") {
    const sbx = await t("create", () => Sandbox.create(process.env.MEASURE_TEMPLATE ?? "lineage-desktop", { apiKey, timeoutMs: 300_000, metadata: meta, lifecycle: { onTimeout: "pause", autoResume: false }, resolution: [1280, 800], dpi: 96 }));
    out.id = short(sbx.sandboxId);
    const i0 = await sbx.getInfo();
    out.info = { state: i0.state, cpu: i0.cpuCount, mem_mb: i0.memoryMB, lifecycle: i0.lifecycle, timeout_s: Math.round((i0.endAt.getTime() - i0.startedAt.getTime()) / 1000) };
    await sbx.files.write("/home/user/marker.txt", "kept");
    await sbx.commands.run("nohup sh -c 'while true; do date +%s > /tmp/tick; sleep 1; done' >/dev/null 2>&1 &", { timeoutMs: 10_000 }).catch(() => undefined);
    out.x_before = (await sbx.commands.run("pgrep -c Xvfb || pgrep -c Xorg || echo 0", { timeoutMs: 10_000 }).catch((e) => ({ stdout: String(e.stdout ?? "?") }))).stdout.trim();
    out.pause_returned = await t("pause", () => sbx.pause());
    const i1 = await Base.getInfo(sbx.sandboxId, { apiKey });
    out.paused_info = { state: i1.state, end_minus_now_s: Math.round((i1.endAt.getTime() - Date.now()) / 1000) };
    out.listed_running_while_paused = (await listAll({ metadata: meta, state: ["running"] })).length;
    out.listed_paused_while_paused = (await listAll({ metadata: meta, state: ["paused"] })).length;
    out.exec_while_paused = await sbx.commands.run("true", { timeoutMs: 8000, requestTimeoutMs: 8000 }).then(() => "ran").catch((e) => `${(e as Error).name}`);
    await Bun.sleep(5000);
    const re = await t("resume_connect", () => Sandbox.connect(sbx.sandboxId, { apiKey, timeoutMs: 300_000 }));
    const r = await t("first_command_after_resume", () => re.commands.run("cat /home/user/marker.txt; echo; cat /tmp/tick; date +%s; pgrep -c Xvfb || pgrep -c Xorg || echo 0", { timeoutMs: 10_000 }));
    out.after_resume = r.stdout.trim().split("\n");
    const i2 = await re.getInfo();
    out.resumed_info = { state: i2.state, started: i2.startedAt.toISOString(), end_minus_now_s: Math.round((i2.endAt.getTime() - Date.now()) / 1000), lifecycle: i2.lifecycle };
    // second cycle, to see the spread
    await t("pause_2", () => re.pause());
    const re2 = await t("resume_connect_2", () => Sandbox.connect(sbx.sandboxId, { apiKey, timeoutMs: 300_000 }));
    // timeouts: one hour from now, then more than an hour
    await t("set_timeout_1h", () => re2.setTimeout(3_600_000)).catch(() => undefined);
    out.end_after_1h_s = Math.round(((await re2.getInfo()).endAt.getTime() - Date.now()) / 1000);
    await t("set_timeout_2h", () => re2.setTimeout(7_200_000)).catch(() => undefined);
    out.end_after_2h_s = Math.round(((await re2.getInfo()).endAt.getTime() - Date.now()) / 1000);
    await t("set_timeout_25h", () => re2.setTimeout(90_000_000)).catch(() => undefined);
    out.end_after_25h_s = Math.round(((await re2.getInfo()).endAt.getTime() - Date.now()) / 1000);
    await t("kill", () => re2.kill());
  } else if (mode === "paused-limit") {
    // small sandboxes, each paused right after its create, so at most one of ours runs at a time
    const want = Number(process.argv[3] ?? 22);
    const before = await listAll();
    out.account_before = { running: before.filter((s) => s.state === "running").length, paused: before.filter((s) => s.state === "paused").length };
    let made = 0;
    for (let i = 0; i < want; i++) {
      try {
        const s = await Base.create("base", { apiKey, timeoutMs: 120_000, metadata: meta, lifecycle: { onTimeout: "pause", autoResume: false } });
        await s.pause();
        made++;
      } catch (e) {
        out.refused_at = { made, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) };
        break;
      }
    }
    out.paused_made = made;
    const mid = await listAll();
    out.account_with_ours = { running: mid.filter((s) => s.state === "running").length, paused: mid.filter((s) => s.state === "paused").length };
    try {
      const extra = await Base.create("base", { apiKey, timeoutMs: 60_000, metadata: meta });
      out.one_more_running = "created";
      await extra.kill();
    } catch (e) {
      out.one_more_running = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
    }
  } else if (mode === "long") {
    // kept alive with setTimeout every 5 minutes; reports what happens around the plan's session length
    const minutes = Number(process.argv[3] ?? 70);
    const s = await Base.create("base", { apiKey, timeoutMs: 600_000, metadata: meta, lifecycle: { onTimeout: "pause", autoResume: false } });
    out.id = short(s.sandboxId);
    const log: unknown[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < minutes * 60_000) {
      await Bun.sleep(300_000);
      const row: Record<string, unknown> = { min: Math.round((Date.now() - t0) / 60_000) };
      try {
        await Base.setTimeout(s.sandboxId, 600_000, { apiKey });
        row.set_timeout = "ok";
      } catch (e) {
        row.set_timeout = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200);
      }
      try {
        const i = await Base.getInfo(s.sandboxId, { apiKey });
        row.state = i.state;
        row.end_minus_now_s = Math.round((i.endAt.getTime() - Date.now()) / 1000);
        row.started = i.startedAt.toISOString();
      } catch (e) {
        row.info = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200);
      }
      log.push(row);
      console.error(JSON.stringify(row));
      if (row.state !== "running") break;
    }
    out.log = log;
  }
} catch (e) {
  out.failed = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
} finally {
  if (mode !== "list") out.cleanup = await killMine();
  console.log(JSON.stringify(out, null, 2));
}

// Sandbox hosts (docs/plans/SCALE-OUT.md section 6): placement, slots, a failed host, the evaluation's
// own refusals, the hosts file. A fake transport stands in for ssh; no Docker here.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalError, parseHostsFile, RemoteSandboxes, sshArgv, type EvalJob, type EvalOutput, type RunCommand, type SandboxHost } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const host = (name: string, slots: number): SandboxHost => ({ name, address: "10.0.0.1", key: "/k", known_hosts: "/kh", slots });
const JOB: EvalJob = { v: 1, recipe_id: "ab".repeat(16), deps_digest: "cd".repeat(16), parent_patches: [], candidate_patch: "diff", seed: "0123456789abcdef" };
const OUT = (tag: string) => ({ result: { tag } as unknown as EvalOutput["result"], transcript: { steps: [] } as unknown as EvalOutput["transcript"] });

function pool(hosts: SandboxHost[], behave: (hostName: string, cmd: string) => Promise<{ code: number; stdout: string; stderr?: string }>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-hosts-"));
  dirs.push(dir);
  const file = join(dir, "hosts.json");
  writeFileSync(file, JSON.stringify({ hosts, ...extra }));
  const now = { t: 1_000_000 };
  const calls: string[] = [];
  const logs: string[] = [];
  const peak = new Map<string, number>();
  const live = new Map<string, number>();
  const run: RunCommand = async (argv, _stdin, _timeout, onLine) => {
    // the fake reads the host from the ssh target (user@address is the same for all: use the key path trick below)
    const name = argv[argv.indexOf("-i") + 1]!.slice(1);
    const cmd = argv[argv.length - 1]!;
    calls.push(`${name}:${cmd}`);
    live.set(name, (live.get(name) ?? 0) + 1);
    peak.set(name, Math.max(peak.get(name) ?? 0, live.get(name)!));
    try {
      onLine("@phase build 123");
      const r = await behave(name, cmd);
      return { stderr: "", ...r };
    } finally {
      live.set(name, live.get(name)! - 1);
    }
  };
  // each host's key path carries its name, so the fake transport knows which host was called
  const named = hosts.map((h) => ({ ...h, key: `/${h.name}` }));
  writeFileSync(file, JSON.stringify({ hosts: named, ...extra }));
  const p = new RemoteSandboxes({ file, run, now: () => now.t, log: (m) => logs.push(m), reload_s: 60 });
  return { p, file, now, calls, logs, peak, dir };
}
const ok = (tag: string) => ({ code: 0, stdout: JSON.stringify({ ok: true, ...OUT(tag) }) + "\n" });
const opts = (local: () => Promise<EvalOutput> = async () => OUT("local")) => ({ local, timeoutMs: 1000, EvalError });

test("evaluations spread over the hosts by the share of slots in use, never past a host's slots", async () => {
  const s = pool([host("a", 2), host("b", 2)], async (n) => (await Bun.sleep(30), ok(n)));
  const out = await Promise.all(Array.from({ length: 4 }, () => s.p.evaluate(JOB, opts())));
  expect(out.map((o) => (o.result as unknown as { tag: string }).tag).sort()).toEqual(["a", "a", "b", "b"]);
  expect(s.peak.get("a")).toBe(2);
  expect(s.peak.get("b")).toBe(2);
  // a fifth while all four slots are busy runs here
  const busy = Array.from({ length: 4 }, () => s.p.evaluate(JOB, opts()));
  const fifth = await s.p.evaluate(JOB, opts());
  expect((fifth.result as unknown as { tag: string }).tag).toBe("local");
  await Promise.all(busy);
  expect(s.p.status().local_done).toBe(1);
  expect(s.p.status().hosts.map((h) => h.done)).toEqual([4, 4]);
});

test("a host that dies mid-evaluation: the same evaluation is run on the other host, the dead one is left alone, then tried again", async () => {
  let aDead = true;
  const s = pool([host("a", 1), host("b", 1)], async (n) => (n === "a" && aDead ? { code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.1 port 22: Connection refused" } : ok(n)), { retry_s: 60 });
  const r = await s.p.evaluate(JOB, opts());
  expect((r.result as unknown as { tag: string }).tag).toBe("b");
  expect(s.calls).toEqual(["a:eval", "b:eval"]);
  expect(s.logs.join("\n")).toContain("sandbox host a failed an evaluation (ssh: connect to host 10.0.0.1 port 22: Connection refused)");
  expect(s.p.status().hosts.find((h) => h.name === "a")!.up).toBe(false);
  // while a is down nothing is sent to it
  await s.p.evaluate(JOB, opts());
  expect(s.calls.filter((c) => c.startsWith("a:")).length).toBe(1);
  // after retry_s it is tried again
  aDead = false;
  s.now.t += 61_000;
  const again = await s.p.evaluate(JOB, opts());
  expect((again.result as unknown as { tag: string }).tag).toBe("a");
});

test("every host down: the evaluation runs here; with local_fallback off it fails and says so", async () => {
  const s = pool([host("a", 1), host("b", 1)], async () => ({ code: 255, stdout: "", stderr: "unreachable" }));
  const r = await s.p.evaluate(JOB, opts());
  expect((r.result as unknown as { tag: string }).tag).toBe("local");
  expect(s.logs.join("\n")).toContain("none left for this evaluation after a, b; running it here");
  const strict = pool([host("a", 1)], async () => ({ code: 255, stdout: "", stderr: "unreachable" }), { local_fallback: false });
  await expect(strict.p.evaluate(JOB, opts())).rejects.toThrow(/local_fallback is off/);
});

test("the evaluation's own refusal is an EvalError for the caller, not a host failure", async () => {
  const s = pool([host("a", 1), host("b", 1)], async () => ({ code: 0, stdout: JSON.stringify({ ok: false, kind: "eval", error: "parent series broken at generation 2" }) + "\n" }));
  await expect(s.p.evaluate(JOB, opts())).rejects.toBeInstanceOf(EvalError);
  expect(s.calls.length).toBe(1);
  expect(s.p.status().hosts.every((h) => h.up)).toBe(true);
});

test("a host with another release (recipe not found) is a host failure: next host", async () => {
  const s = pool([host("a", 1), host("b", 1)], async (n) => (n === "a" ? { code: 0, stdout: JSON.stringify({ ok: false, kind: "host", error: "recipe abababababab is not in this host's release; update the host" }) + "\n" } : ok(n)));
  const r = await s.p.evaluate(JOB, opts());
  expect((r.result as unknown as { tag: string }).tag).toBe("b");
  expect(s.p.status().hosts.find((h) => h.name === "a")!.why).toContain("not in this host's release");
});

test("phase lines reach the caller; garbage on stdout is a host failure", async () => {
  const phases: string[] = [];
  const s = pool([host("a", 1)], async () => ok("a"));
  await s.p.evaluate(JOB, { ...opts(), onPhase: (p, at) => phases.push(`${p}@${at}`) });
  expect(phases).toEqual(["build@123"]);
  const g = pool([host("a", 1)], async () => ({ code: 0, stdout: "not json\n" }));
  expect(((await g.p.evaluate(JOB, opts())).result as unknown as { tag: string }).tag).toBe("local");
});

test("the hosts file: re-read when it changes, a removed host gets nothing new, a missing file means local, a bad file keeps the last list", async () => {
  const s = pool([host("a", 1), host("b", 1)], async (n) => ok(n));
  expect(s.p.hosts().map((h) => h.name)).toEqual(["a", "b"]);
  writeFileSync(s.file, JSON.stringify({ hosts: [{ ...host("b", 1), key: "/b" }] }));
  utimesSync(s.file, new Date(), new Date(Date.now() + 5000));
  expect(s.p.hosts().length).toBe(2); // not re-read yet
  s.now.t += 61_000;
  expect(s.p.hosts().map((h) => h.name)).toEqual(["b"]);
  writeFileSync(s.file, "{ broken");
  utimesSync(s.file, new Date(), new Date(Date.now() + 9000));
  s.now.t += 61_000;
  expect(s.p.hosts().map((h) => h.name)).toEqual(["b"]);
  unlinkSync(s.file);
  s.now.t += 61_000;
  expect(s.p.hosts()).toEqual([]);
});

test("hosts file validation and the ssh command line", () => {
  expect(() => parseHostsFile(JSON.stringify({ hosts: [{ ...host("a", 0) }] }))).toThrow(/slots/);
  expect(() => parseHostsFile(JSON.stringify({ hosts: [host("a", 1), host("a", 1)] }))).toThrow(/twice/);
  expect(() => parseHostsFile(JSON.stringify({ hosts: [{ ...host("a", 1), address: "x; rm -rf /" }] }))).toThrow(/address/);
  expect(() => parseHostsFile(JSON.stringify({ hosts: [{ ...host("a", 1), key: "relative" }] }))).toThrow(/absolute/);
  expect(() => parseHostsFile(JSON.stringify({ hosts: [{ ...host("A b", 1) }] }))).toThrow(/name/);
  const argv = sshArgv({ ...host("a", 1), port: 2222 }, "eval");
  expect(argv[0]).toBe("ssh");
  expect(argv).toContain("StrictHostKeyChecking=yes");
  expect(argv).toContain("BatchMode=yes");
  expect(argv.slice(-3)).toEqual(["units-cap@10.0.0.1", "--", "eval"]);
  expect(sshArgv({ name: "l", address: "", key: "", known_hosts: "", slots: 1, command: ["bun", "job.ts"] }, "eval")).toEqual(["bun", "job.ts", "eval"]);
});

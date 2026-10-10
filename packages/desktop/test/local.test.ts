import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend, PROXY } from "../src/local.ts";

// The local backend's docker invocations: isolation flags on every desktop, and two desktops starting
// at once (or two processes) sharing one allowlist proxy.

test("desktop containers: non-root, read-only, no capabilities, internal network, tree read only; a racing proxy start is shared", async () => {
  const root = mkdtempSync(join(tmpdir(), "lin-local-"));
  const calls: string[][] = [];
  let proxyRuns = 0;
  const run = async (argv: string[]) => {
    calls.push(argv);
    const a = argv.slice(1);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (a[0] === "image") return ok;
    if (a[0] === "network" && a[1] === "inspect") return ok;
    if (a[0] === "inspect" && a.at(-1) === PROXY) return proxyRuns >= 1 ? { code: 0, stdout: "true\nPATH=/usr/bin\nDESK_ALLOW=github.com\n", stderr: "" } : { code: 1, stdout: "", stderr: "no such" };
    if (a[0] === "run" && a.includes(PROXY)) {
      proxyRuns++;
      // the second start loses the race
      return proxyRuns === 1 ? ok : { code: 125, stdout: "", stderr: "Conflict. The container name is already in use" };
    }
    if (a[0] === "network" && a[1] === "connect") return { code: 1, stdout: "", stderr: "endpoint with name lineage-desk-proxy already exists in network lineage-desk" };
    return ok; // run -d of the desktop, exec test -f ready, rm
  };
  try {
    const b = new LocalBackend({ root, run, docker: "docker" });
    (b as unknown as { imageOk: unknown }).imageOk = { at: Date.now(), ok: true };
    // pretend the proxy is not up yet for both, so both try to start it
    const [x, y] = await Promise.all([
      b.create({ tree: "/t", homeUrl: "about:blank", allow: ["github.com"], label: "a" }),
      b.create({ tree: "/t", homeUrl: "about:blank", allow: ["github.com"], label: "b" }),
    ]);
    expect(x.id).not.toBe(y.id);
    const desk = calls.find((c) => c[1] === "run" && c.includes("lineage.desktop=1"))!;
    for (const f of ["--read-only", "--cap-drop", "ALL", "no-new-privileges", "--network", "lineage-desk", "/t:/work/repo:ro", "--pids-limit"]) expect(desk).toContain(f);
    expect(desk.join(" ")).not.toContain("docker.sock");
    expect(desk[desk.indexOf("--user") + 1]).not.toMatch(/^0:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

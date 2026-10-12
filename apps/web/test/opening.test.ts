import { describe, expect, test } from "bun:test";
import { checkDeployment, deploymentState, nextDelayMs, registryOf, staleTab, untilLive, type Probe } from "../src/opening.ts";

// The Launch page's "is the deployment answering yet" decision (apps/web/src/opening.ts): from the
// answers of GET /chain/config and GET /api/chain, nothing else.

const REG = "RegistryProgram1111111111111111111111111111";
const ok = (body: unknown): Probe => ({ ok: true, body });
const no = (status: number | null): Probe => ({ ok: false, status });
const cfg = (over: Record<string, unknown> = {}) =>
  ok({ rpc: "/chain/rpc", genesis: "G", cluster: "mainnet-beta", state: { registry_program: REG }, profile: { network: "mainnet", programs: { registry: REG } }, ...over });
const chain = (over: Record<string, unknown> = {}) => ok({ mode: "mainnet", read_at: 1, registry_program: REG, launch: { paused: false }, ...over });

describe("deploymentState", () => {
  test("live: the server names a deployment and Core has read its registry and launch config", () => {
    expect(deploymentState(cfg(), chain())).toBe("live");
  });
  test("opening: Core or the web server did not answer (network error, timeout, 5xx, 429)", () => {
    for (const s of [null, 500, 502, 503, 504, 429]) {
      expect(deploymentState(cfg(), no(s))).toBe("opening");
      expect(deploymentState(no(s), chain())).toBe("opening");
    }
  });
  test("opening: Core is up and has not read an initialized registry yet", () => {
    expect(deploymentState(cfg(), ok({ mode: "mainnet", read_at: null }))).toBe("opening");
    expect(deploymentState(cfg(), ok({ mode: "mainnet" }))).toBe("opening");
  });
  test("opening: the registry is initialized, the launch config is not", () => {
    expect(deploymentState(cfg(), chain({ launch: null }))).toBe("opening");
  });
  test("opening: Core still reads another deployment than the web server names", () => {
    expect(deploymentState(cfg(), chain({ registry_program: "Other111111111111111111111111111111111111111" }))).toBe("opening");
  });
  test("opening: a mainnet server with no deployed state, or an RPC that gave no genesis", () => {
    expect(deploymentState(cfg({ state: null }), chain())).toBe("opening");
    expect(deploymentState(cfg({ genesis: null }), chain())).toBe("opening");
  });
  test("opening: an answer that is not an object", () => {
    expect(deploymentState(ok("<html>"), chain())).toBe("opening");
    expect(deploymentState(cfg(), ok([]))).toBe("opening");
  });
  test("live: nothing says opening (a Core with no chain, a server without the route, a devnet server with no state)", () => {
    expect(deploymentState(cfg(), ok({ mode: "sim" }))).toBe("live");
    expect(deploymentState(cfg(), no(404))).toBe("live");
    expect(deploymentState(no(404), chain())).toBe("live");
    expect(deploymentState(cfg({ state: null, profile: { network: "devnet", programs: { registry: REG } } }), chain())).toBe("live");
    // a server that predates the profile: no registry to compare
    expect(deploymentState(ok({ genesis: "G", state: {} }), chain({ registry_program: "Other" }))).toBe("live");
  });
});

describe("polling", () => {
  test("the wait grows from 2 s by half each time and stops at 10 s", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(nextDelayMs)).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000]);
  });
  test("registryOf reads the profile's registry program id", () => {
    expect(registryOf(cfg())).toBe(REG);
    expect(registryOf(no(502))).toBeNull();
    expect(registryOf(ok({}))).toBeNull();
  });
  test("a tab that mounted the wizard under another registry is stale; a first mount never is", () => {
    expect(staleTab(null, REG)).toBe(false);
    expect(staleTab(REG, REG)).toBe(false);
    expect(staleTab(REG, null)).toBe(false);
    expect(staleTab("Old", REG)).toBe(true);
  });

  const server = (answers: { chain: () => Response }) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return url === "/chain/config" ? Response.json((cfg() as { body: unknown }).body) : answers.chain();
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("checkDeployment makes the two reads once", async () => {
    const s = server({ chain: () => Response.json({ mode: "mainnet", read_at: null }) });
    expect(await checkDeployment(s.f)).toEqual({ state: "opening", registry: REG });
    expect(s.calls.sort()).toEqual(["/api/chain", "/chain/config"]);
  });
  test("untilLive asks again until live, then stops", async () => {
    let n = 0;
    const s = server({ chain: () => (++n < 3 ? new Response("bad gateway", { status: 502 }) : Response.json((chain() as { body: unknown }).body)) });
    const waits: number[] = [];
    expect(await untilLive(() => true, s.f, async (ms) => void waits.push(ms))).toEqual({ registry: REG });
    expect(waits).toEqual([2000, 3000, 4500]);
    expect(s.calls.length).toBe(6);
  });
  test("untilLive makes no further request once the page was left", async () => {
    const s = server({ chain: () => Response.json({ mode: "mainnet", read_at: null }) });
    let alive = 2;
    expect(await untilLive(() => alive-- > 0, s.f, async () => undefined)).toBeNull();
    expect(s.calls.length).toBe(2);
  });
});

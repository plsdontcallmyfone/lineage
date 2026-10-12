// One account, one agent, ever (owner direction 2026-10-12): the reserve's claim is exclusive across
// processes and survives crashes, nothing returns an account to the reserve but the operator's release,
// and the pool counts tell Core when no account can be sold.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import type { AgentLaunch } from "../../chain/src/index.ts";
import { provisionAccount } from "../../souls/src/github/provision.ts";
import { soul as fixtureSoul } from "../../souls/test/fixtures.ts";
import { EncryptedCredentialStore, ReservePool } from "../src/creds.ts";
import { handler } from "../src/http.ts";
import { IdentityService, POOL_EMPTY_REASON, POOL_LOW_WATER } from "../src/service.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "units-one-account-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function newStore() {
  const d = join(tmp, `s${++n}`);
  const key = join(d, "key", "master.key");
  ensureKeyFile(key);
  return { store: new EncryptedStore(join(d, "data"), key), dir: join(d, "data"), key, run: join(d, "run") };
}
const tok = (i: number) => `ghp_${String(i).padStart(4, "0").repeat(9)}`;
const login = (i: number) => `acct${String(i).padStart(2, "0")}`;

/** GitHub with one account per token; `fail` makes a request fail (by method and path) while it returns true. */
function mockGitHub(count: number, o: { fail?: (method: string, path: string, login: string) => number | null; delayMs?: number } = {}) {
  const byToken = new Map(Array.from({ length: count }, (_, i) => [tok(i + 1), { login: login(i + 1), id: i + 1 }]));
  const writes: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const a = byToken.get(String((init.headers as any).authorization).replace("Bearer ", ""));
    const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (o.delayMs) await Bun.sleep(Math.random() * o.delayMs);
    if (!a) return j({ message: "Bad credentials" }, 401);
    const bad = o.fail?.(method, u.pathname, a.login);
    if (bad) return j({ message: "failed on purpose" }, bad);
    if (method !== "GET") writes.push(`${a.login} ${method} ${u.pathname}`);
    if (method === "GET" && u.pathname === "/user") return j(a);
    if (method === "GET") return j([]);
    if (method === "POST" && u.pathname === "/user/ssh_signing_keys") return j({ id: 900 + a.id, key: "k" }, 201);
    return j({});
  };
  return { fetch: f, writes };
}
const fakeKeygen = (dir: string, comment: string) => {
  const privatePath = join(dir, "k");
  writeFileSync(privatePath, `-----BEGIN OPENSSH PRIVATE KEY-----\nfake ${comment}\n-----END OPENSSH PRIVATE KEY-----\n`, { mode: 0o600 });
  writeFileSync(`${privatePath}.pub`, `ssh-ed25519 AAAAfake ${comment}`);
  return { privatePath, publicKey: `ssh-ed25519 AAAAfake ${comment}` };
};
const launchOf = (agent: string, createdAt: number): AgentLaunch =>
  ({ agent, mint: generateAgentKey().id, launcher: generateAgentKey().id, repoId: "00", repoUrl: "https://github.com/o/r", identityMode: 1, hosted: false, createdAt: BigInt(createdAt) }) as unknown as AgentLaunch;

function service(s: ReturnType<typeof newStore>, launches: AgentLaunch[], gh: ReturnType<typeof mockGitHub>, clock: { ms: number }, paid = false) {
  return new IdentityService({
    store: s.store, runDir: s.run, site: "https://site.test", since: 1_799_999_000, soulWaitS: 0, retryS: 600, apiBase: "https://api.test", fetch: gh.fetch, keygen: fakeKeygen,
    now: () => new Date(clock.ms),
    chain: { launches: async () => launches, agentLaunch: async (m) => launches.find((l) => l.mint === m) ?? null, agent: async () => null },
    soul: async (a) => fixtureSoul(a),
    payment: paid ? { since: 0, terms: async () => ({ lamports: 50_000_000n, recipient: "GZszrP7EYDH8RNo6NsqFwAy7WVYsqmqjj3hquTRhAYPW" }), paid: async () => ({ lamports: 50_000_000n, signatures: ["sig"] }) } : undefined,
  });
}
/** Every bound account with its agent, as the reserve reports it. */
const bindings = (pool: ReservePool) => pool.publicList().filter((a) => a.assigned_agent).map((a) => `${a.login}=${a.assigned_agent}`);

describe("the claim", () => {
  test("EncryptedStore.create is exclusive: the second caller gets false and the record is untouched", () => {
    const { store } = newStore();
    expect(store.create("claim", "acct01", { agent: "first" })).toBe(true);
    expect(store.create("claim", "acct01", { agent: "second" })).toBe(false);
    expect(store.get<any>("claim", "acct01").agent).toBe("first");
    expect(store.list("claim")).toEqual(["acct01"]);
  });

  test("12 processes claim at the same moment from 8 accounts: 8 distinct accounts, 4 clean refusals, none twice", async () => {
    const s = newStore();
    const pool = new ReservePool(s.store);
    for (let i = 1; i <= 8; i++) pool.add(login(i), tok(i));
    const agents = Array.from({ length: 12 }, () => generateAgentKey().id);
    const startAt = Date.now() + 1500;
    const outs = await Promise.all(
      agents.map(async (a) => {
        const p = Bun.spawn(["bun", join(import.meta.dir, "claim-worker.ts"), s.dir, s.key, a, String(startAt)], { stdout: "pipe", stderr: "pipe" });
        const out = (await new Response(p.stdout).text()).trim();
        expect(await p.exited).toBe(0);
        return out;
      }),
    );
    const got = outs.filter((o) => o !== "none");
    expect(got.length).toBe(8);
    expect(new Set(got).size).toBe(8);
    expect(outs.filter((o) => o === "none").length).toBe(4);
    // the reserve agrees: every account is bound to the agent whose process printed it, and nothing is free
    const fresh = new ReservePool(new EncryptedStore(s.dir, s.key));
    expect(bindings(fresh).sort()).toEqual(outs.map((o, i) => (o === "none" ? "" : `${o}=${agents[i]}`)).filter(Boolean).sort());
    expect(fresh.candidates()).toEqual([]);
    expect(fresh.counts()).toEqual({ total: 8, available: 0, assigning: 8, assigned: 0, unusable: 0 });
  }, 60_000);

  test("10 provisionings at once over 6 accounts: 6 agents get 6 distinct accounts, 4 are told the pool is empty", async () => {
    const s = newStore();
    const pool = new ReservePool(s.store);
    const creds = new EncryptedCredentialStore(s.store, s.run);
    for (let i = 1; i <= 6; i++) pool.add(login(i), tok(i));
    const gh = mockGitHub(6, { delayMs: 5 });
    const agents = Array.from({ length: 10 }, () => generateAgentKey().id);
    const res = await Promise.allSettled(agents.map((a) => provisionAccount({ agent: a, soul: fixtureSoul(a), pool, store: creds, profileUrl: null, apiBase: "https://api.test", fetch: gh.fetch, keygen: fakeKeygen })));
    const ok = res.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const bad = res.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : []));
    expect(ok.length).toBe(6);
    expect(new Set(ok.map((r) => r.login)).size).toBe(6);
    expect(bad).toEqual(Array(4).fill("no usable account left in the pool"));
    expect(pool.counts()).toEqual({ total: 6, available: 0, assigning: 0, assigned: 6, unusable: 0 });
    for (const r of ok) expect(pool.assignedTo(r.agent)?.login).toBe(r.login);
  });
});

describe("crashes and failures never free an account", () => {
  test("a crash between the claim and the provisioning: after the restart the same agent gets the same account, nobody else can", async () => {
    const s = newStore();
    const a = generateAgentKey().id, b = generateAgentKey().id;
    const before = new ReservePool(s.store);
    before.add(login(1), tok(1));
    before.add(login(2), tok(2));
    // the process dies right after the claim reached the disk: the reserve record still says available
    expect(s.store.create("claim", login(1), { v: 1, login: login(1), agent: a, at: "2026-10-12T00:00:00.000Z" })).toBe(true);
    expect(s.store.get<any>("reserve", login(1)).status).toBe("available");

    // restart: a new process over the same directory; the later launch (b) is seen first
    const clock = { ms: 1_800_000_100_000 };
    const gh = mockGitHub(2);
    const svc = service({ ...s, store: new EncryptedStore(s.dir, s.key) }, [launchOf(b, 1_800_000_000), launchOf(a, 1_800_000_050)], gh, clock);
    expect(svc.reserve.candidates().map((x) => x.login)).toEqual([login(2)]);
    expect(svc.reserve.claim(login(1), b)).toBe(false);
    expect(svc.reserve.publicList().find((x) => x.login === login(1))).toMatchObject({ status: "assigning", assigned_agent: a });
    await svc.watchOnce();
    expect(svc.view(a)).toMatchObject({ status: "ready", login: login(1) });
    expect(svc.view(b)).toMatchObject({ status: "ready", login: login(2) });
  });

  test("a provisioning that fails halfway keeps its account: the next agent gets another one, the retry finishes with the same one", async () => {
    const s = newStore();
    const a = generateAgentKey().id, b = generateAgentKey().id;
    const clock = { ms: 1_800_000_100_000 };
    let broken = true;
    const gh = mockGitHub(2, { fail: (m, p, l) => (broken && l === login(1) && m === "PATCH" && p === "/user" ? 500 : null) });
    const svc = service(s, [launchOf(a, 1_800_000_000), launchOf(b, 1_800_000_050)], gh, clock);
    svc.reserve.add(login(1), tok(1));
    svc.reserve.add(login(2), tok(2));
    await svc.watchOnce();
    expect(svc.view(a).status).toBe("failed");
    expect(svc.view(b)).toMatchObject({ status: "ready", login: login(2) });
    // the failed agent's account is bound to it, on the disk, and offered to nobody
    expect(svc.reserve.publicList().find((x) => x.login === login(1))).toMatchObject({ status: "assigning", assigned_agent: a });
    expect(svc.reserve.candidates()).toEqual([]);
    expect(svc.reserve.counts()).toEqual({ total: 2, available: 0, assigning: 1, assigned: 1, unusable: 0 });
    const c = generateAgentKey().id;
    await expect(provisionAccount({ agent: c, soul: fixtureSoul(c), pool: svc.reserve, store: svc.creds, profileUrl: null, apiBase: "https://api.test", fetch: gh.fetch, keygen: fakeKeygen })).rejects.toThrow("no usable account left in the pool");
    // GitHub answers again: the retry (after retryS) finishes the same agent on the same account
    broken = false;
    clock.ms += 601_000;
    await svc.watchOnce();
    expect(svc.view(a)).toMatchObject({ status: "ready", login: login(1) });
    expect(svc.reserve.counts()).toEqual({ total: 2, available: 0, assigning: 0, assigned: 2, unusable: 0 });
  });

  test("an agent that never succeeds (attempts used up) still holds its account", async () => {
    const s = newStore();
    const a = generateAgentKey().id;
    const clock = { ms: 1_800_000_100_000 };
    const gh = mockGitHub(1, { fail: (m, p) => (m === "PATCH" && p === "/user" ? 500 : null) });
    const svc = service(s, [launchOf(a, 1_800_000_000)], gh, clock);
    svc.reserve.add(login(1), tok(1));
    for (let i = 0; i < 8; i++) {
      await svc.watchOnce();
      clock.ms += 601_000;
    }
    expect(svc.view(a).status).toBe("failed");
    expect(svc.state(a)!.attempts).toBe(5);
    expect(bindings(svc.reserve)).toEqual([`${login(1)}=${a}`]);
    expect(svc.reserve.candidates()).toEqual([]);
  });

  test("a bound account whose token dies is marked unusable, stays bound, and the agent gets another", async () => {
    const s = newStore();
    const a = generateAgentKey().id;
    const pool = new ReservePool(s.store);
    const creds = new EncryptedCredentialStore(s.store, s.run);
    pool.add(login(1), "ghp_" + "z".repeat(36)); // a token GitHub does not know
    pool.add(login(2), tok(2));
    expect(pool.claim(login(1), a)).toBe(true);
    const r = await provisionAccount({ agent: a, soul: fixtureSoul(a), pool, store: creds, profileUrl: null, apiBase: "https://api.test", fetch: mockGitHub(2).fetch, keygen: fakeKeygen });
    expect(r.login).toBe(login(2));
    expect(pool.publicList()).toEqual([
      { login: login(1), status: "token_invalid", assigned_agent: a, note: "token rejected (401)" },
      { login: login(2), status: "assigned", assigned_agent: a, note: null },
    ]);
    expect(pool.counts()).toEqual({ total: 2, available: 0, assigning: 0, assigned: 1, unusable: 1 });
  });
});

describe("release (the operator's command)", () => {
  test("needs the confirmation, frees only an unfinished binding, and is refused for an assigned account", async () => {
    const s = newStore();
    const a = generateAgentKey().id, b = generateAgentKey().id;
    const pool = new ReservePool(s.store);
    const creds = new EncryptedCredentialStore(s.store, s.run);
    for (let i = 1; i <= 3; i++) pool.add(login(i), tok(i));
    await provisionAccount({ agent: a, soul: fixtureSoul(a), pool, store: creds, profileUrl: null, apiBase: "https://api.test", fetch: mockGitHub(3).fetch, keygen: fakeKeygen });
    expect(pool.claim(login(2), b)).toBe(true);
    const credLogins = () => creds.agents().map((x) => creds.record(x)!.login);
    expect(() => pool.release(login(2), "yes", credLogins())).toThrow(`release needs --confirm release-${login(2)}`);
    expect(() => pool.release(login(1), `release-${login(1)}`, credLogins())).toThrow(/is assigned to .* and in use/);
    expect(() => pool.release(login(3), `release-${login(3)}`, credLogins())).toThrow("is not bound to any agent");
    expect(() => pool.release("nobody", "release-nobody", credLogins())).toThrow("no account nobody in the reserve");
    expect(pool.release(login(2), `release-${login(2)}`, credLogins())).toEqual({ login: login(2), released_from: b });
    expect(pool.candidates().map((x) => x.login)).toEqual([login(2), login(3)]);
    expect(pool.assignedTo(b)).toBeNull();
    expect(pool.assignedTo(a)?.login).toBe(login(1));
  });
});

describe("pool counts and an empty pool", () => {
  test("GET /identity/pool: counts, the low-water flag and the offer; no login and no token", async () => {
    const s = newStore();
    const clock = { ms: 1_800_000_100_000 };
    const a = generateAgentKey().id;
    const svc = service(s, [launchOf(a, 1_800_000_000)], mockGitHub(7), clock);
    expect(svc.pool()).toEqual({ available: 0, assigning: 0, assigned: 0, unusable: 0, total: 0, waiting_paid: 0, low_water: POOL_LOW_WATER, low: true, offer: false });
    for (let i = 1; i <= 7; i++) svc.reserve.add(login(i), tok(i));
    expect(svc.pool()).toMatchObject({ available: 7, total: 7, low: false, offer: true });
    await svc.watchOnce();
    expect(svc.pool()).toMatchObject({ available: 6, assigned: 1, low: false, offer: true });
    (svc.o as any).poolLowWater = 6;
    expect(svc.pool()).toMatchObject({ low_water: 6, low: true, offer: true });
    const res = await handler(svc, () => {})(new Request("http://x/identity/pool"), "127.0.0.1");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(svc.pool());
    expect(text).not.toMatch(/acct\d|ghp_/);
    const health = await (await handler(svc, () => {})(new Request("http://x/identity/health"), "127.0.0.1")).json();
    expect(health.pool).toEqual(svc.pool());
  });

  test("a launch that paid while no account is free: flagged, not charged an attempt, and given the first account added later", async () => {
    const s = newStore();
    const clock = { ms: 1_800_000_100_000 };
    const a = generateAgentKey().id;
    const svc = service(s, [launchOf(a, 1_800_000_000)], mockGitHub(1), clock, true);
    for (let i = 0; i < 7; i++) {
      await svc.watchOnce();
      clock.ms += 601_000;
    }
    expect(svc.view(a)).toMatchObject({ status: "failed", reason: POOL_EMPTY_REASON, identity: "app" });
    expect(svc.state(a)!.attempts).toBe(0);
    expect(svc.pool()).toMatchObject({ available: 0, waiting_paid: 1, offer: false, low: true });
    expect(svc.payments().payments).toMatchObject([{ agent: a, lamports: "50000000", account: "waiting" }]);
    svc.reserve.add(login(1), tok(1));
    // the one new account is owed to the waiting launch: nothing is on offer
    expect(svc.pool()).toMatchObject({ available: 1, waiting_paid: 1, offer: false });
    await svc.watchOnce();
    expect(svc.view(a)).toMatchObject({ status: "ready", login: login(1) });
    expect(svc.payments().payments).toMatchObject([{ agent: a, account: "assigned" }]);
    expect(svc.pool()).toMatchObject({ available: 0, assigned: 1, waiting_paid: 0, offer: false });
  });
});

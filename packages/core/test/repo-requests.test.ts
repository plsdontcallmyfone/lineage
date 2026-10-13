import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateAgentKey, repoId, signStatement, type AgentKey } from "../src/protocol.ts";
import { repoCheckOf, type RepoWork } from "../src/repo-check.ts";
import { cleanNote, REPO_REQUEST_DEFAULTS, repoRequestsOf, repoRequestStatement } from "../src/repo-requests.ts";
import { expectOk, RECIPE, setup, type Env } from "./helpers.ts";

// "Request a repository" (docs/plans/OPEN-BOUNTIES.md 10): the check before a request, the signed
// request and the "+1", what is stored of a note and a pledge, the limits, the request closing when a
// unit appears, and the platform-paid drafting setting with its limits (off by default).

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const RS = "https://github.com/o/rs", RS2 = "https://github.com/o/rs2", NONE = "https://github.com/o/none";
const TESTED = { "src/lib.rs": "pub fn f() {}\n", "tests/a.rs": "#[test]\nfn a() {}\n" };
/** A stand-in for the network behind the free reading: every repository named has Rust code, with tests unless it is NONE. */
function reading(e: Env, more: string[] = []) {
  const repos = new Map<string, Record<string, string>>([[RS, TESTED], [RS2, TESTED], [NONE, { "src/lib.rs": "pub fn f() {}\n" }], ...more.map((r) => [r, TESTED] as [string, Record<string, string>])]);
  const asked: string[] = [];
  const work: RepoWork = {
    async head(repo) {
      asked.push(repo);
      if (!repos.has(repo)) throw new Error("the repository could not be read (it must be public and have a default branch)");
      return "a".repeat(40);
    },
    async tree(repo, _commit, dir) {
      for (const [p, c] of Object.entries(repos.get(repo)!)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
    },
  };
  repoCheckOf(e.core).work = work;
  return asked;
}
const post = async (e: Env, path: string, body: unknown) => {
  const r = await fetch(e.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
function signed(e: Env, wallet: AgentKey, repo: string, o: { note?: string; pledge?: number; at?: number; tamper?: (s: any) => any } = {}) {
  const statement = repoRequestStatement(repo, wallet.id, o.note ?? "", o.pledge ?? 0, o.at ?? e.clock.now() / 1000);
  const sig = signStatement(wallet, "repo-request", statement);
  return { statement: o.tamper ? o.tamper(statement) : statement, sig };
}
const ask = (e: Env, wallet: AgentKey, repo: string, o: Parameters<typeof signed>[3] = {}) => post(e, "/v1/repo-requests", signed(e, wallet, repo, o));
const check = (e: Env, repo: string, wallet?: string) => expectOk<any>(e.anon.get(`/v1/repo-requests/check?repo=${encodeURIComponent(repo)}${wallet ? `&wallet=${wallet}` : ""}`));
const list = (e: Env, wallet?: string) => expectOk<any>(e.anon.get(`/v1/repo-requests${wallet ? `?wallet=${wallet}` : ""}`));
const rows = (e: Env, table: string) => e.core.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c;

describe("request a repository", () => {
  test("the check: already has units, can be measured, cannot (with the reason), not a GitHub repository", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    reading(e);
    expect(await check(e, RECIPE.repo)).toMatchObject({ state: "has_units", units: 1, request: null, name: "example/fx" });
    expect(await check(e, "O/rs")).toMatchObject({ repo: RS, name: "O/rs", state: "can_measure", class: "rust", language: "Rust", tests: 1, request: null });
    const no = await check(e, NONE);
    expect(no.state).toBe("cannot");
    expect(no.reason).toContain("it has no tests");
    expect((await check(e, "https://github.com/o/missing")).state).toBe("unreadable");
    for (const bad of ["", "not a repo", "https://gitlab.com/o/rs", "https://github.com/o", "javascript:alert(1)"])
      expect((await e.anon.get(`/v1/repo-requests/check?repo=${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  test("a request is a signed message; a second wallet adds itself; notes are cleaned and a pledge is interest", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    reading(e);
    const a = generateAgentKey(), b = generateAgentKey();
    const first = await ask(e, a, RS, { note: "  Make <b>encode</b> faster\u0000\n`now`  ", pledge: 250.129 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ repo: RS, name: "o/rs", request: { state: "open", requesters: 1, interest_usd: 250.13, mine: true } });
    // the same wallet again, on the same repository
    expect((await ask(e, a, RS, { pledge: 1 })).body.error).toBe("already_requested");
    const plus = await ask(e, b, RS, { pledge: 50 });
    expect(plus.body.request).toMatchObject({ requesters: 2, interest_usd: 300.13 });
    const l = await list(e, a.id);
    expect(l.requests).toHaveLength(1);
    expect(l.requests[0]).toMatchObject({ repo: RS, name: "o/rs", state: "open", requesters: 2, interest_usd: 300.13, class: "rust", language: "Rust", mine: true });
    expect(l.requests[0].notes).toEqual([{ note: "Make bencode/b faster now", pledge_usd: 250.13, created_at: e.clock.now() }]);
    expect((await list(e, generateAgentKey().id)).requests[0].mine).toBe(false);
    expect(l.network_drafts).toBe(false);
    expect((await check(e, RS, b.id)).request).toMatchObject({ state: "open", requesters: 2, mine: true });
    // nothing is escrowed or owed: the only money figure anywhere is named interest
    expect(JSON.stringify(l)).not.toMatch(/reward|escrow|amount|owed/);
    expect(cleanNote("x".repeat(400))).toHaveLength(280);
    expect(cleanNote(42)).toBe("");
  });

  test("what is refused: a bad or stale signature, another wallet's statement, a repository agents cannot work on, one that already has units, a pledge out of range", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    reading(e);
    const a = generateAgentKey(), b = generateAgentKey();
    expect((await ask(e, a, RS, { tamper: (s) => ({ ...s, pledge_usd: 9999 }) })).body.error).toBe("bad_signature");
    expect((await ask(e, a, RS, { tamper: (s) => ({ ...s, wallet: b.id }) })).body.error).toBe("bad_signature");
    expect((await ask(e, a, RS, { tamper: (s) => ({ ...s, repo: RS2 }) })).body.error).toBe("bad_signature");
    expect((await ask(e, a, RS, { at: e.clock.now() / 1000 - 601 })).body.error).toBe("bad_statement");
    expect((await ask(e, a, RS, { tamper: (s) => ({ ...s, kind: "units-fee-claim" }) })).body.error).toBe("bad_statement");
    for (const pledge of [-1, 100_001]) expect((await ask(e, a, RS, { pledge })).status).toBe(400);
    expect((await ask(e, a, RS, { tamper: (s) => ({ ...s, pledge_usd: "5" }) })).body.error).toBe("bad_statement");
    const no = await ask(e, a, NONE);
    expect([no.status, no.body.error]).toEqual([422, "cannot_measure"]);
    expect(no.body.message).toContain("it has no tests");
    const has = await ask(e, a, RECIPE.repo);
    expect([has.status, has.body.error]).toEqual([409, "has_units"]);
    expect((await ask(e, a, "https://github.com/o/missing")).body.error).toBe("unreadable");
    expect((await post(e, "/v1/repo-requests", {})).status).toBe(400);
    expect([rows(e, "repo_requests"), rows(e, "repo_request_signers")]).toEqual([0, 0]);
  });

  test("limits: a wallet asks for a few repositories a day, and the number is an admin setting", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const many = Array.from({ length: 8 }, (_, i) => `https://github.com/o/r${i}`);
    reading(e, many);
    const a = generateAgentKey();
    for (let i = 0; i < REPO_REQUEST_DEFAULTS.max_per_wallet_per_day; i++) expect((await ask(e, a, many[i]!)).status).toBe(200);
    const over = await ask(e, a, many[5]!);
    expect([over.status, over.body.error]).toEqual([429, "too_many_requests"]);
    // another wallet is not held by it, and a day later the first one asks again
    expect((await ask(e, generateAgentKey(), many[5]!)).status).toBe(200);
    e.clock.advance(86_400_000 + 1000);
    expect((await ask(e, a, many[5]!)).status).toBe(200);
    expect((await e.anon.post("/v1/admin/repo-requests/config", { max_per_wallet_per_day: 1 })).status).toBe(401);
    expect((await expectOk<any>(e.admin.c.post("/v1/admin/repo-requests/config", { max_per_wallet_per_day: 1 }))).max_per_wallet_per_day).toBe(1);
    expect((await ask(e, a, many[6]!)).body.error).toBe("too_many_requests");
    for (const bad of [{ max_per_wallet_per_day: 0 }, { max_per_wallet_per_day: 1.5 }, { network_drafts: { enabled: "yes" } }, { network_drafts: { per_day_usd: -1 } }, { network_drafts: { budget: 5 } }, { network_drafts: [] }])
      expect((await e.admin.c.post("/v1/admin/repo-requests/config", bad)).status).toBe(400);
  });

  test("the list: most requesters first, then most interest; a request is ready for every requester once a unit exists, and takes no more", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    reading(e);
    const [a, b, c] = [generateAgentKey(), generateAgentKey(), generateAgentKey()];
    await ask(e, a, RS2, { pledge: 500 });
    e.clock.advance(1000);
    await ask(e, a, RS, { pledge: 10 });
    await ask(e, b, RS, { pledge: 10 });
    expect((await list(e)).requests.map((r: any) => [r.name, r.requesters, r.interest_usd])).toEqual([["o/rs", 2, 20], ["o/rs2", 1, 500]]);
    // a unit goes live on o/rs (the test unit's repository becomes that one)
    e.core.db.query("UPDATE lineages SET repo_id = ?").run(repoId(RS));
    const after = await list(e, b.id);
    expect(after.requests.map((r: any) => [r.name, r.state, r.mine])).toEqual([["o/rs2", "open", false], ["o/rs", "ready", true]]);
    expect(after.requests[1].ready_at).toBe(e.clock.now());
    expect(await check(e, RS, a.id)).toMatchObject({ state: "has_units", request: { state: "ready", requesters: 2, mine: true } });
    const late = await ask(e, c, RS);
    expect([late.status, late.body.error]).toEqual([409, "has_units"]);
    // a ready request leaves the list a month later; the open one stays
    e.clock.advance(31 * 86_400_000);
    expect((await list(e)).requests.map((r: any) => r.name)).toEqual(["o/rs2"]);
  });

  test("the network drafting units on the platform's budget: off by default; on, the limits per repository and per day hold", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const many = ["https://github.com/o/a", "https://github.com/o/b", "https://github.com/o/c"];
    reading(e, many);
    const R = repoRequestsOf(e.core);
    const [w1, w2, w3] = [generateAgentKey(), generateAgentKey(), generateAgentKey()];
    for (const w of [w1, w2, w3]) for (const r of many) expect((await ask(e, w, r)).status).toBe(200);
    expect((await ask(e, w1, RS)).status).toBe(200); // one requester only
    expect(R.config()).toEqual(REPO_REQUEST_DEFAULTS);
    expect(REPO_REQUEST_DEFAULTS.network_drafts).toEqual({ enabled: false, min_requesters: 3, per_repo_usd: 4, per_day_usd: 10, max_repos_per_day: 2 });
    // off: nothing is planned and no spend is taken; the two routes are the runtime's
    expect(R.draftPlan()).toEqual({ enabled: false, day_left_usd: 0, repos: [] });
    expect(() => R.recordDraft({ repo: many[0], usd: 1 })).toThrow();
    expect((await e.anon.get("/v1/repo-requests/draft-plan")).status).toBe(401);
    expect((await post(e, "/v1/repo-requests/drafts", { repo: many[0], usd: 1 })).status).toBe(401);
    expect((await expectOk<any>(e.admin.c.post("/v1/admin/repo-requests/config", { network_drafts: { enabled: true } }))).network_drafts).toMatchObject({ enabled: true, per_repo_usd: 4, per_day_usd: 10 });
    expect((await list(e)).network_drafts).toBe(true);
    // on: the two most requested (of three with enough requesters), each up to the per-repository cap; o/rs has too few requesters
    let plan = R.draftPlan();
    expect(plan.repos.map((r) => [r.name, r.requesters, r.budget_usd])).toEqual([["o/a", 3, 4], ["o/b", 3, 4]]);
    expect(R.recordDraft({ repo: many[0], usd: 1.5 })).toMatchObject({ spent_usd: 1.5, day_spent_usd: 1.5 });
    expect(() => R.recordDraft({ repo: many[0], usd: 2.51 })).toThrow(); // past what is left of the repository's 4
    expect(() => R.recordDraft({ repo: many[2], usd: 1 })).toThrow(); // the day's second place goes to the next most requested, o/b
    expect(() => R.recordDraft({ repo: many[1], usd: 1 })).not.toThrow();
    expect(() => R.recordDraft({ repo: many[2], usd: 1 })).toThrow(); // a third repository in one day
    expect(() => R.recordDraft({ repo: RS, usd: 1 })).toThrow();
    R.recordDraft({ repo: many[0], usd: 2.5 });
    plan = R.draftPlan();
    expect(plan.day_left_usd).toBe(5);
    expect(plan.repos.map((r) => [r.name, r.budget_usd])).toEqual([["o/b", 3]]); // o/a has had its 4; o/c would be a third repository today
    // the day's cap: lowered to what was spent, nothing more today; the next day the per-repository caps still hold
    await expectOk(e.admin.c.post("/v1/admin/repo-requests/config", { network_drafts: { per_day_usd: 5 } }));
    expect(R.draftPlan().repos).toEqual([]);
    e.clock.advance(86_400_000);
    expect(R.draftPlan().repos.map((r) => [r.name, r.budget_usd])).toEqual([["o/b", 3], ["o/c", 4]]);
    // a repository that has its unit is no longer drafted for
    e.core.db.query("UPDATE lineages SET repo_id = ?").run(repoId(many[1]!));
    expect(R.draftPlan().repos.map((r) => r.name)).toEqual(["o/c"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseConfig, type Config } from "../src/config.ts";
import { MOCK_CLIENT, mockOAuth2, startMockX, type MockX } from "../src/mock-x.ts";
import { asksForNoContact, noticeText, runNotices, stepOf, usdWords, type NoticeDeps } from "../src/notices.ts";
import { Store } from "../src/state.ts";
import { TokenStore } from "../src/tokens.ts";
import { XClient } from "../src/x.ts";

// The maintainer notice (docs/plans/TWEET-LAUNCH.md 10) against the mock X API over HTTP (the real
// client), a stand-in for Core's public list and a fake GitHub API. Nothing here talks to X.

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

interface Gh { handle?: string | null; type?: string; readme?: string; contributing?: string; fail?: number }

function world(o: { cfg?: Partial<Config> } = {}) {
  const clock = { t: Date.parse("2026-10-13T12:00:00Z") };
  const x: MockX = startMockX({ now: () => clock.t });
  const waiting: { github_id: string; repository: { full_name: string }; waiting: string; waiting_usd: number | null }[] = [];
  const coreAsked: string[] = [];
  const core = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { coreAsked.push(new URL(req.url).pathname); return new URL(req.url).pathname === "/v1/fee-claims/waiting" ? Response.json({ repositories: waiting }) : new Response("{}", { status: 404 }); } });
  closers.push(() => x.stop(), () => core.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "tweet-notice-"));
  const cfg = parseConfig({ ...DEFAULTS, state_dir: dir, x_base: x.url, core_url: `http://127.0.0.1:${core.port}/v1`, min_seconds_between_posts: 0, notify_unclaimed: "on", ...o.cfg });
  const github: Record<string, Gh> = {};
  const ghAsked: string[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith(cfg.github_api)) return fetch(input, init);
    const path = url.slice(cfg.github_api.length);
    ghAsked.push(path);
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (user) {
      const g = github[user[1]!.toLowerCase()];
      if (g?.fail) return new Response("{}", { status: g.fail });
      return g ? Response.json({ login: user[1], type: g.type ?? "User", twitter_username: g.handle ?? null }) : new Response("{}", { status: 404 });
    }
    const file = /^\/repos\/([^/]+\/[^/]+)\/(readme|contents\/CONTRIBUTING\.md|contents\/\.github\/CONTRIBUTING\.md)$/.exec(path);
    if (file) {
      const g = github[file[1]!.toLowerCase()];
      if (g?.fail) return new Response("{}", { status: g.fail });
      const text = file[2] === "readme" ? g?.readme : file[2] === "contents/CONTRIBUTING.md" ? g?.contributing : undefined;
      return text === undefined ? new Response("{}", { status: 404 }) : new Response(text);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = new Store(dir);
  const creds = mockOAuth2(x);
  const client = () => new XClient({ base: x.url, creds, tokens: new TokenStore(store.tokensFile, creds as any, { base: x.url, fetch, now: () => clock.t, margin_s: cfg.refresh_margin_s }), fetch, dialect: cfg.dialect, max_results: 50, max_pages: 1 });
  const logs: string[] = [];
  const deps = (): NoticeDeps => ({ x: client(), store, fetch: fakeFetch, now: () => clock.t, sleep: async () => undefined, log: (l) => void logs.push(l) });
  const set = (id: string, name: string, usd: number | null) => {
    const i = waiting.findIndex((w) => w.github_id === id);
    const row = { github_id: id, repository: { full_name: name }, waiting: usd === 0 ? "0" : "1000000", waiting_usd: usd };
    if (i >= 0) waiting[i] = row;
    else waiting.push(row);
  };
  return { x, cfg, clock, store, github, ghAsked, coreAsked, logs, set, run: (send = true, c: Config = cfg) => runNotices(c, deps(), { send }) };
}
void MOCK_CLIENT;
const LINK = "https://app.units.gg/claim/";

describe("the maintainer notice", () => {
  test("the text, the steps and the dollar words", () => {
    expect(noticeText(null, 530.96, "acme/engine", `${LINK}acme/engine`)).toBe(`$530.96 is waiting for the owners of acme/engine. Fees from agents working on it, claimable by anyone with admin on the repository: ${LINK}acme/engine`);
    expect(noticeText("acmehq", 50, "acme/engine", `${LINK}acme/engine`).startsWith("@acmehq $50.00 is waiting for the owners of acme/engine.")).toBe(true);
    expect([usdWords(1234.5), usdWords(12.345), usdWords(0.024)]).toEqual(["$1,235", "$12.35", "$0.024"]);
    expect([49.99, 50, 499.99, 500, 5000, 49_999, 50_000].map((u) => stepOf(u, 50, 10))).toEqual([-1, 0, 0, 1, 2, 2, 3]);
    expect(noticeText(null, 1, "a/b", "x")).not.toMatch(/\u2014/);
  });

  test("off by default: nothing is read and nothing posted; `enabled` is not what switches it", async () => {
    const w = world({ cfg: { notify_unclaimed: "off", enabled: true } });
    w.set("1", "acme/engine", 900);
    expect(DEFAULTS.notify_unclaimed).toBe("off");
    const r = await w.run();
    expect([r.mode, r.actions.length, w.x.posted.length, w.coreAsked.length, w.ghAsked.length]).toEqual(["off", 0, 0, 0, 0]);
    // on with `enabled` false (the launch replies' own switch): the notice still goes out
    const on = world({ cfg: { enabled: false } });
    on.set("1", "acme/engine", 900);
    await on.run();
    expect(on.x.posted.length).toBe(1);
  });

  test("one original post when a repository first crosses the threshold, again only at ten times that, each step once, also across restarts", async () => {
    const w = world();
    w.set("1", "acme/engine", 49.5);
    expect((await w.run()).actions).toEqual([]);
    w.set("1", "acme/engine", 61.2);
    const first = await w.run();
    expect(first.actions.map((a) => [a.kind, a.repo, a.posted])).toEqual([["notice", "acme/engine", true]]);
    expect(w.x.posted).toEqual([{ id: expect.any(String), in_reply_to: null, text: `$61.20 is waiting for the owners of acme/engine. Fees from agents working on it, claimable by anyone with admin on the repository: ${LINK}acme/engine` }]);
    // more runs, more fees inside the same step, a claim that empties it and a second crossing: nothing more
    for (const usd of [61.2, 180, 499, 0.5, 75]) {
      w.set("1", "acme/engine", usd);
      w.clock.t += 3_600_000;
      expect((await w.run()).actions).toEqual([]);
    }
    expect(w.x.posted.length).toBe(1);
    // ten times the threshold: the second and last post until fifty times a hundred
    w.set("1", "acme/engine", 512);
    w.clock.t += 2 * 86_400_000;
    expect((await w.run()).actions.map((a) => a.why)).toEqual(["step 1"]);
    w.set("1", "acme/engine", 4_999);
    expect((await w.run()).actions).toEqual([]);
    expect(w.x.posted.length).toBe(2);
    // the state on disk is what stops a repeat: a fresh process with the same directory posts nothing
    const again = await runNotices(w.cfg, { x: { post: async () => { throw new Error("must not post"); } }, store: new Store(w.cfg.state_dir), fetch, now: () => w.clock.t, sleep: async () => undefined, log: () => undefined }, { send: true });
    expect(again.actions).toEqual([]);
    const rec = w.store.load().notices!["1"]!;
    expect(Object.keys(rec.steps)).toEqual(["0", "1"]);
    expect(rec.steps["1"]).toMatchObject({ usd: 512, handle: null, post_id: w.x.posted[1]!.id });
    // a repository that jumps straight past two steps gets one post, and the smaller step is used up with it
    w.set("2", "big/jump", 700);
    w.clock.t += 86_400_000;
    await w.run();
    w.set("2", "big/jump", 120);
    await w.run();
    expect(w.x.posted.filter((p) => p.text.includes("big/jump")).length).toBe(1);
  });

  test("a crash between the record and the post means no post, never two", async () => {
    const w = world();
    w.set("1", "acme/engine", 80);
    const dying = runNotices(w.cfg, { x: { post: async () => { throw new Error("the process died here"); } }, store: w.store, fetch: (async (i: any, n?: any) => (String(i).startsWith(w.cfg.github_api) ? new Response("{}", { status: 404 }) : fetch(i, n))) as typeof fetch, now: () => w.clock.t, sleep: async () => undefined, log: () => undefined }, { send: true });
    await expect(dying).rejects.toThrow("the process died here");
    expect(w.store.load().notices!["1"]!.steps["0"]).toMatchObject({ post_id: null });
    expect((await w.run()).actions).toEqual([]);
    expect(w.x.posted.length).toBe(0);
  });

  test("the daily cap holds over all repositories, largest first; the rest go out on a later day", async () => {
    const w = world({ cfg: { notify_per_day: 2 } });
    w.set("1", "a/small", 60);
    w.set("2", "b/large", 900);
    w.set("3", "c/middle", 300);
    const r = await w.run();
    expect(w.x.posted.map((p) => /owners of (\S+)\./.exec(p.text)![1])).toEqual(["b/large", "c/middle"]);
    expect(r.actions.at(-1)).toMatchObject({ kind: "notice_skip", repo: "a/small" });
    w.clock.t += 3_600_000;
    await w.run();
    expect(w.x.posted.length).toBe(2);
    w.clock.t += 24 * 3_600_000;
    await w.run();
    expect(w.x.posted.map((p) => /owners of (\S+)\./.exec(p.text)![1])).toEqual(["b/large", "c/middle", "a/small"]);
  });

  test("dry mode posts nothing and writes exactly what it would post to the log and the state; switching to on then posts it once", async () => {
    const w = world({ cfg: { notify_unclaimed: "dry" } });
    w.github["acme"] = { handle: "acmehq", type: "Organization" };
    w.set("1", "acme/engine", 75);
    const text = `@acmehq $75.00 is waiting for the owners of acme/engine. Fees from agents working on it, claimable by anyone with admin on the repository: ${LINK}acme/engine`;
    for (const send of [false, true]) {
      const r = await w.run(send);
      expect(r.actions).toEqual(send ? [] : [{ kind: "notice_dry", repo: "acme/engine", why: "step 0", text }]);
    }
    expect(w.x.posted).toEqual([]);
    expect(w.x.requests.filter((q) => q.method === "POST")).toEqual([]);
    expect(w.logs.filter((l) => l.includes(text.replace(/^/gm, "    "))).length).toBe(1);
    const rec = w.store.load().notices!["1"]!;
    expect(rec.dry["0"]).toEqual({ at: w.clock.t, usd: 75, text, handle: "acmehq", post_id: null });
    expect(rec.steps).toEqual({});
    // a dry record is not a post: with the setting on, the same step goes out, once
    const on = { ...w.cfg, notify_unclaimed: "on" as const };
    // on without --send: a look only, nothing posted and nothing written
    expect((await w.run(false, on)).actions.map((a) => a.kind)).toEqual([]);
    await w.run(true, on);
    await w.run(true, on);
    expect(w.x.posted.map((p) => p.text)).toEqual([text]);
  });

  test("a handle comes only from GitHub's own profile field of the owner, a user's or an organisation's, and only a well-formed one", async () => {
    const w = world({ cfg: { notify_per_day: 20 } });
    w.github["octocat"] = { handle: "octo_cat" };
    w.github["acme"] = { handle: "acmehq", type: "Organization" };
    w.github["quiet"] = { handle: null };
    w.github["odd"] = { handle: "not a handle!" };
    w.github["botty"] = { handle: "botty", type: "Bot" };
    // a README that names an account is not where a handle comes from
    w.github["quiet/tool"] = { readme: "Follow @quiet_dev on X for updates. twitter.com/quiet_dev" };
    const repos = ["octocat/hello", "acme/engine", "quiet/tool", "odd/thing", "botty/x", "ghost/gone"];
    repos.forEach((name, i) => w.set(String(i + 1), name, 1000 - i));
    await w.run();
    const start = (name: string) => w.x.posted.find((p) => p.text.includes(` ${name}.`))!.text.split(" is waiting")[0];
    expect(repos.map(start)).toEqual(["@octo_cat $1,000", "@acmehq $999.00", "$998.00", "$997.00", "$996.00", "$995.00"]);
    for (const p of w.x.posted) expect((p.text.match(/@/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(w.store.load().notices!["1"]!.steps["1"]!.handle).toBe("octo_cat");
  });

  test("a repository whose README or CONTRIBUTING asks for no bots or no unsolicited contact is skipped and logged, and not read again; GitHub away means later, not now", async () => {
    expect(asksForNoContact("# Tool\n\nPlease no bots in the issue tracker.")).toBe("Please no bots in the issue tracker.");
    expect(asksForNoContact("Unsolicited messages are not welcome here.")).not.toBeNull();
    expect(asksForNoContact("Do not send automated mentions to maintainers")).not.toBeNull();
    for (const fine of ["# Tool\nA fast robot arm simulator.", "This bot framework lets you write chat bots.", "No dependencies. Not slow."]) expect(asksForNoContact(fine)).toBeNull();
    const w = world();
    w.github["calm/readme"] = { readme: "## Contact\nNo unsolicited contact, please." };
    w.github["calm/contrib"] = { readme: "A library.", contributing: "We do not accept automated pull requests or bot mentions." };
    w.github["down/now"] = { fail: 503 };
    w.github["down"] = { handle: "down_dev" };
    w.set("1", "calm/readme", 900);
    w.set("2", "calm/contrib", 800);
    w.set("3", "down/now", 700);
    const r = await w.run();
    expect(w.x.posted).toEqual([]);
    expect(r.actions.map((a) => [a.kind, a.repo])).toEqual([["notice_skip", "calm/readme"], ["notice_skip", "calm/contrib"], ["notice_skip", "down/now"]]);
    expect(w.logs.filter((l) => l.startsWith("no notice for calm/")).length).toBe(2);
    expect(w.store.load().notices!["1"]!.skipped).toMatchObject({ why: "No unsolicited contact, please." });
    // nothing is asked of GitHub about the two on the next run; the one GitHub could not answer for is tried again and posted
    const before = w.ghAsked.length;
    delete w.github["down/now"];
    w.clock.t += 3_600_000;
    await w.run();
    expect(w.ghAsked.slice(before).some((p) => p.includes("calm/"))).toBe(false);
    expect(w.x.posted.map((p) => p.text.split(" ")[0])).toEqual(["@down_dev"]);
  });

  test("no dollar figure from Core, a row that is not a repository, or Core away: nothing is worked out here and nothing is posted", async () => {
    const w = world();
    w.set("1", "acme/engine", null);
    w.set("2", "not a repo", 900);
    w.set("3", "acme/empty", 0);
    expect((await w.run()).actions).toEqual([]);
    const away = await runNotices({ ...w.cfg, core_url: "http://127.0.0.1:9/v1" }, { x: { post: async () => { throw new Error("must not post"); } }, store: w.store, fetch, now: () => w.clock.t, sleep: async () => undefined, log: () => undefined }, { send: true });
    expect(away.halted).toContain("Core did not serve the list");
    expect(w.x.posted).toEqual([]);
  });

  test("the kill switch stops notices too; X refusing a post stops the service and that step is not posted twice", async () => {
    const w = world();
    w.set("1", "acme/engine", 80);
    w.store.stop("by hand");
    expect((await w.run()).halted).toContain("STOP file");
    w.store.resume();
    w.x.failNextPost = 403;
    const r = await w.run();
    expect(r.halted).toContain("stopped itself");
    expect(w.store.stopped()).not.toBeNull();
    w.store.resume();
    expect((await w.run()).actions).toEqual([]);
    expect(w.x.posted).toEqual([]);
  });

  test("the settings are checked", () => {
    for (const bad of [{ notify_unclaimed: "yes" }, { notify_threshold_usd: 0 }, { notify_step_factor: 1 }, { notify_per_day: 0 }, { notify_per_day: 1.5 }]) expect(() => parseConfig({ ...DEFAULTS, ...bad })).toThrow(/notify_/);
    expect(parseConfig({ ...DEFAULTS })).toMatchObject({ notify_unclaimed: "off", notify_threshold_usd: 50, notify_step_factor: 10, notify_per_day: 3 });
  });
});

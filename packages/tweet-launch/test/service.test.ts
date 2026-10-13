import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "../../core/src/protocol.ts";
import { bare, expectOk } from "../../core/test/helpers.ts";
import { tweetLaunchesOf } from "../../core/src/tweet-launches.ts";
import { DEFAULTS, loadCredentials, parseConfig, type Config, type Creds, type OAuth2Creds } from "../src/config.ts";
import { MOCK_CLIENT, MOCK_OAUTH1, mockOAuth2, startMockX, type MockX } from "../src/mock-x.ts";
import { NO_REPO, NOT_PUBLIC } from "../src/replies.ts";
import { runOnce, type Deps } from "../src/service.ts";
import { Store } from "../src/state.ts";
import { TokenStore } from "../src/tokens.ts";
import { oauth1Header, XClient } from "../src/x.ts";

// The bot against a mock X API over HTTP (the real client, its signatures and tokens checked by the
// mock), a fake GitHub API and a real Core. Nothing here talks to X.

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const GITHUB: Record<string, { status: number; body?: unknown }> = {
  "karpathy/minbpe": { status: 200, body: { full_name: "karpathy/minbpe", private: false, size: 300 } },
  "KEIS/Base58": { status: 200, body: { full_name: "keis/base58", private: false, size: 120 } },
  "big/monorepo": { status: 200, body: { full_name: "big/monorepo", private: false, size: 9_000_000 } },
  "docs/only": { status: 200, body: { full_name: "docs/only", private: false, size: 10 } },
  "odd/lang": { status: 200, body: { full_name: "odd/lang", private: false, size: 10 } },
  "secret/repo": { status: 404 },
  "flaky/api": { status: 403 },
};
const READINGS: Record<string, string | null> = {
  "karpathy/minbpe": null, "keis/base58": null,
  "docs/only": "it has no tests, and a unit needs the repository's own tests to check every change",
  "odd/lang": "there is no toolchain image for its language (mostly .hs files); images exist for Python, Rust, Go, C and C++, Zig and Solana programs",
};

interface World {
  x: MockX;
  cfg: Config;
  deps: Deps;
  store: Store;
  clock: { t: number };
  read: string[];
  refs: string[];
  run(send?: boolean): ReturnType<typeof runOnce>;
  ask(text: string, o?: { author?: string; replied_to?: string; quoted?: string; urls?: string[]; retweeted?: string }): string;
}

function world(o: { cfg?: Partial<Config>; core?: string; creds?: "oauth2" | "oauth1"; expires_in?: number } = {}): World {
  const clock = { t: Date.parse("2026-10-12T12:00:00Z") };
  const x = startMockX({ now: () => clock.t, expires_in: o.expires_in });
  closers.push(() => x.stop());
  const dir = mkdtempSync(join(tmpdir(), "tweet-launch-"));
  const cfg = parseConfig({ ...DEFAULTS, enabled: true, state_dir: dir, x_base: x.url, core_url: o.core ?? "http://127.0.0.1:9/v1", market_url: o.core ? `${o.core}/../market` : "http://127.0.0.1:9/market", min_seconds_between_posts: 0, ...o.cfg });
  const store = new Store(dir);
  const creds: Creds = o.creds === "oauth1" ? { ...MOCK_OAUTH1 } : mockOAuth2(x);
  const read: string[] = [];
  const refs: string[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith(cfg.github_api)) {
      const k = url.slice(`${cfg.github_api}/repos/`.length);
      const g = GITHUB[k] ?? { status: 200, body: { full_name: k, private: false, size: 50 } };
      return Response.json(g.body ?? { message: "Not Found" }, { status: g.status });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const tokens = creds.kind === "oauth2" ? new TokenStore(store.tokensFile, creds, { base: x.url, fetch, now: () => clock.t, margin_s: cfg.refresh_margin_s }) : null;
  let n = 0;
  const deps: Deps = {
    x: new XClient({ base: x.url, creds, tokens, fetch, dialect: cfg.dialect, max_results: cfg.poll_max_results, max_pages: cfg.poll_max_pages }),
    store, fetch: fakeFetch, now: () => clock.t, sleep: async () => undefined, log: () => undefined,
    readRepo: async (url) => {
      const k = url.replace("https://github.com/", "");
      read.push(k);
      return READINGS[k] ?? null;
    },
    newRef: () => {
      const r = `ref${String(++n).padStart(19, "0")}`;
      refs.push(r);
      return r;
    },
  };
  x.users.set("7", "ann");
  x.users.set("8", "bob");
  return {
    x, cfg, deps, store, clock, read, refs,
    run: (send = true) => runOnce(cfg, deps, { send }),
    ask: (text, a = {}) => x.add({ text, author_id: a.author ?? "7", mention: true, replied_to: a.replied_to, quoted: a.quoted, urls: a.urls, retweeted: a.retweeted }).id,
  };
}

describe("answers", () => {
  test("a launch mention under a GitHub post gets one reply with the filled link; a second run posts nothing more", async () => {
    const w = world();
    const parent = w.x.add({ text: "minbpe is neat https://t.co/a", author_id: "8", urls: ["https://github.com/karpathy/minbpe"] });
    const id = w.ask("@bob @unitsdotgg launch name Fast BPE ticker fbpe", { replied_to: parent.id });
    const r = await w.run();
    expect(r.halted).toBeNull();
    expect(w.x.posted).toEqual([{ id: expect.any(String), in_reply_to: id, text: `@ann Launch an agent on karpathy/minbpe. Connect a wallet and approve:\nhttps://app.units.gg/launch?repo=karpathy/minbpe&name=Fast+BPE&ticker=FBPE&tl=${w.refs[0]}` }]);
    expect(w.read).toEqual(["karpathy/minbpe"]);
    const s = w.store.load();
    expect(s.requests[w.refs[0]!]).toMatchObject({ mention_id: id, author_id: "7", repo: "karpathy/minbpe", status: "open", reply_id: w.x.posted[0]!.id });
    expect(statSync(w.store.file).mode & 0o777).toBe(0o600);
    // nothing about the author or the tweet is in the link
    expect(w.x.posted[0]!.text.split("\n")[1]).not.toMatch(/ann|7\b|19000/);
    await w.run();
    await w.run();
    expect(w.x.posted.length).toBe(1);
  });

  test("the repository is found in the mention, the replied-to post or the quoted post, spelled as GitHub spells it", async () => {
    const w = world();
    const quoted = w.x.add({ text: "look github.com/KEIS/Base58/pull/3", author_id: "8" });
    w.ask("@unitsdotgg launch", { quoted: quoted.id });
    w.ask("@unitsdotgg launch https://t.co/z", { author: "8", urls: ["https://github.com/karpathy/minbpe/blob/master/README.md"] });
    await w.run();
    expect(w.x.posted.map((p) => p.text.split("\n")[0])).toEqual(["@ann Launch an agent on keis/base58. Connect a wallet and approve:", "@bob Launch an agent on karpathy/minbpe. Connect a wallet and approve:"]);
  });

  test("refusals: no repository, not public, no tests; a unit that cannot exist for another reason and a repeat ask get no reply", async () => {
    const w = world({ cfg: { per_author_per_day: 10 } });
    const none = w.ask("@unitsdotgg launch");
    const priv = w.ask("@unitsdotgg launch github.com/secret/repo");
    const notests = w.ask("@unitsdotgg launch github.com/docs/only");
    w.ask("@unitsdotgg launch github.com/odd/lang");
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    w.ask("@unitsdotgg launch again github.com/karpathy/minbpe");
    const r = await w.run();
    expect(w.x.posted.map((p) => [p.in_reply_to, p.text.split("\n")[0]])).toEqual([
      [none, NO_REPO],
      [priv, NOT_PUBLIC],
      [notests, "docs/only has no tests, so changes to it cannot be verified. Try a repository with tests."],
      [expect.any(String), "@ann Launch an agent on karpathy/minbpe. Connect a wallet and approve:"],
    ]);
    expect(r.actions.filter((a) => a.kind === "skip").map((a) => a.why.split(":")[0])).toEqual(["no unit can exist (there is no toolchain image for its language (mostly .hs files); images exist fo)", "duplicate"]);
    // another person may ask for the same repository
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe", { author: "8" });
    await w.run();
    expect(w.x.posted.length).toBe(5);
    expect(w.read.filter((k) => k === "karpathy/minbpe").length).toBe(1); // the reading is cached
  });

  test("the reading is skipped for a large repository and when GitHub's API fails; the link is still given", async () => {
    const w = world({ cfg: { per_author_per_day: 10 } });
    w.ask("@unitsdotgg launch github.com/big/monorepo");
    w.ask("@unitsdotgg launch github.com/flaky/api");
    await w.run();
    expect(w.read).toEqual([]);
    expect(w.x.posted.map((p) => p.text.split("\n")[0])).toEqual(["@ann Launch an agent on big/monorepo. Connect a wallet and approve:", "@ann Launch an agent on flaky/api. Connect a wallet and approve:"]);
  });

  test("no reply to: a mention without launch, a retweet, the bot's own post, an old mention, a stopped author", async () => {
    const w = world();
    w.ask("@unitsdotgg great project github.com/karpathy/minbpe");
    w.ask("RT @unitsdotgg launch github.com/karpathy/minbpe", { retweeted: "5" });
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe", { author: w.x.account.id });
    w.x.add({ text: "@unitsdotgg launch github.com/karpathy/minbpe", author_id: "8", mention: true, created_at: new Date(w.clock.t - 25 * 3_600_000).toISOString() });
    w.ask("@unitsdotgg stop");
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    const r = await w.run();
    expect(w.x.posted).toEqual([]);
    expect(r.actions.map((a) => a.why)).toEqual(["no_command", "retweet", "own_post", "too_old", "the author asked not to be answered", "author_stopped"]);
    expect(w.store.load().stopped["7"]).toBe(w.clock.t);
  });
});

describe("limits, kill switch, dry run", () => {
  test("per author per day and global per hour: a mention over a limit gets no reply, also later", async () => {
    const w = world({ cfg: { per_author_per_day: 2, global_per_hour: 3 } });
    for (const r of ["a/one", "a/two", "a/three"]) w.ask(`@unitsdotgg launch github.com/${r}`);
    for (const a of ["8", "9", "10"]) w.ask("@unitsdotgg launch", { author: a });
    const r = await w.run();
    expect(w.x.posted.length).toBe(3);
    expect(r.actions.filter((a) => a.kind === "skip").map((a) => a.why)).toEqual(["limit per_author_per_day: no reply", "limit global_per_hour: no reply", "limit global_per_hour: no reply"]);
    w.clock.t += 2 * 3_600_000;
    await w.run();
    expect(w.x.posted.length).toBe(3);
  });

  test("a dry run posts nothing and writes no state; the same mention is answered by the next sending run", async () => {
    const w = world();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    const dry = await w.run(false);
    expect(dry.actions).toMatchObject([{ kind: "reply", why: "link", text: expect.stringContaining("Launch an agent on karpathy/minbpe") }]);
    expect(dry.actions[0]!.posted).toBeUndefined();
    expect(w.x.posted).toEqual([]);
    expect(existsSync(w.store.file)).toBe(false);
    await w.run();
    expect(w.x.posted.length).toBe(1);
  });

  test("kill switch: enabled false, or a STOP file; nothing is read or posted", async () => {
    const w = world({ cfg: { enabled: false } });
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    expect((await w.run()).halted).toContain('"enabled": false');
    w.cfg.enabled = true;
    w.store.stop("by hand");
    expect((await w.run()).halted).toContain("STOP file");
    expect((await w.run(false)).halted).toContain("STOP file");
    expect(w.x.requests).toEqual([]);
    w.store.resume();
    await w.run();
    expect(w.x.posted.length).toBe(1);
  });

  test("X refusing a post with 403 stops the service (STOP file); that mention is never answered twice", async () => {
    const w = world();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    w.ask("@unitsdotgg launch github.com/keis/base58", { author: "8" });
    w.x.failNextPost = 403;
    const r = await w.run();
    expect(r.halted).toContain("stopped itself");
    expect(w.store.stopped()).toContain("HTTP 403");
    expect((await w.run()).halted).toContain("STOP file");
    w.store.resume();
    await w.run();
    expect(w.x.posted.map((p) => p.text.split(" ")[0])).toEqual(["@bob"]);
  });

  test("X refusing a post as duplicate content does not stop the service: that mention stays unanswered, the next is answered", async () => {
    const w = world();
    w.ask("@unitsdotgg launch github.com/secret/repo");
    w.ask("@unitsdotgg launch github.com/secret/repo", { author: "8" });
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe", { author: "9" });
    const r = await w.run();
    expect(r.halted).toBeNull();
    expect(existsSync(w.store.stopFile)).toBe(false);
    expect(r.actions.map((a) => [a.why, a.posted])).toEqual([["not_public", true], ["not_public", false], ["link", true]]);
    await w.run();
    expect(w.x.posted.length).toBe(2);
  });

  test("a 429 on posting ends the run and waits for the reset time X gave", async () => {
    const w = world();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    w.x.failNextPost = 429;
    expect((await w.run()).halted).toContain("rate limit");
    const before = w.x.requests.length;
    expect((await w.run()).halted).toContain("X asked to wait");
    expect(w.x.requests.length).toBe(before);
    expect(existsSync(w.store.stopFile)).toBe(false);
  });

  test("credentials of another account are refused", async () => {
    const w = world({ cfg: { handle: "someoneelse" } });
    w.ask("@someoneelse launch github.com/karpathy/minbpe");
    expect((await w.run()).halted).toContain("belong to @unitsdotgg");
    expect(w.x.posted).toEqual([]);
  });
});

describe("X API client", () => {
  test("OAuth 1.0a: the documented signature example; the mock accepts the client's signed requests", async () => {
    // the worked example of X's "Creating a signature" page
    const h = oauth1Header(
      { kind: "oauth1", api_key: "xvz1evFS4wEEPTGEFPHBog", api_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", access_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", access_token_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      "POST", "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
      { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958 },
    );
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    const w = world({ creds: "oauth1" });
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    await w.run();
    expect(w.x.posted.length).toBe(1);
    expect(new Set(w.x.requests.map((r) => r.auth))).toEqual(new Set(["OAuth"]));
  });

  test("field naming: when X refuses one naming with 400 the other is tried once, and both shapes are read", async () => {
    const w = world();
    w.x.accepts = "post";
    const parent = w.x.add({ text: "x https://t.co/a", author_id: "8", urls: ["https://github.com/karpathy/minbpe"] });
    w.ask("@unitsdotgg launch", { replied_to: parent.id });
    await w.run();
    expect(w.x.posted.length).toBe(1);
    expect(w.store.load().dialect).toBe("post");
  });

  test("mentions come in pages, oldest answered first, and the next run starts after the newest", async () => {
    const w = world({ cfg: { poll_max_results: 5, per_author_per_day: 100, global_per_hour: 100 } });
    const ids = Array.from({ length: 12 }, (_, i) => w.ask(`@unitsdotgg launch github.com/a/r${i}`));
    await w.run();
    expect(w.x.posted.map((p) => p.in_reply_to)).toEqual(ids);
    expect(w.store.load().since_id).toBe(ids[11]!);
    const n = w.x.requests.length;
    await w.run();
    expect(w.x.requests.slice(n).map((r) => r.path)).toEqual([`/2/users/${w.x.account.id}/mentions`]);
  });
});

describe("OAuth 2.0 tokens", () => {
  test("refreshed before expiry with Basic client authentication; the new pair is on disk (mode 600) and the spent refresh token is never sent again", async () => {
    const w = world({ expires_in: 7200 });
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    await w.run();
    expect(w.x.oauth2.refreshes).toBe(0); // the seeded access token still works
    expect(existsSync(w.store.tokensFile)).toBe(false);
    // the access token runs out: X answers 401, one refresh, the call is made again
    w.clock.t += 7300 * 1000;
    w.ask("@unitsdotgg launch github.com/keis/base58", { author: "8" });
    expect((await w.run()).halted).toBeNull();
    expect(w.x.oauth2.refreshes).toBe(1);
    expect(w.x.posted.length).toBe(2);
    const t1 = JSON.parse(readFileSync(w.store.tokensFile, "utf8"));
    expect(t1).toMatchObject({ access_token: "mock-access-1", refresh_token: "mock-refresh-1", expires_at: w.clock.t + 7200_000 });
    expect(statSync(w.store.tokensFile).mode & 0o777).toBe(0o600);
    // now the expiry is known: the next refresh happens ahead of it, with no 401 first
    w.clock.t += (7200 - 200) * 1000;
    const n = w.x.requests.length;
    await w.run();
    expect(w.x.requests.slice(n).map((r) => r.path)).toEqual(["/2/oauth2/token", `/2/users/${w.x.account.id}/mentions`]);
    expect(w.x.oauth2.refreshes).toBe(2);
    // a new process (the timer's next run) starts from the saved pair, not from the owner's file
    const again = new TokenStore(w.store.tokensFile, mockOAuth2({ oauth2: { access_token: "mock-access-0", refresh_token: "mock-refresh-0" } } as MockX) as OAuth2Creds, { base: w.x.url, fetch, now: () => w.clock.t, margin_s: 300 });
    expect(await again.access()).toBe("mock-access-2");
    // neither token is in the state file
    expect(readFileSync(w.store.file, "utf8")).not.toMatch(/mock-access|mock-refresh/);
  });

  test("a refused refresh stops the service once: STOP file, no second attempt on later runs", async () => {
    const w = world();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    w.clock.t += 7300 * 1000;
    w.x.failNextRefresh = 400;
    const r = await w.run();
    expect(r.halted).toContain("refused the token refresh (HTTP 400, invalid_request)");
    expect(r.halted).not.toMatch(/mock-access|mock-refresh|mock-client-secret/);
    expect(w.store.stopped()).toContain("new tokens are needed");
    const n = w.x.requests.filter((q) => q.path === "/2/oauth2/token").length;
    await w.run();
    await w.run();
    expect(w.x.requests.filter((q) => q.path === "/2/oauth2/token").length).toBe(n);
    expect(w.x.posted).toEqual([]);
  });

  test("new tokens in the owner's file replace the saved pair; a public client sends client_id in the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tweet-launch-tok-"));
    const calls: { auth: string | null; body: string }[] = [];
    const f = (async (_u: any, init: any) => {
      calls.push({ auth: init.headers.authorization ?? null, body: init.body });
      return Response.json({ token_type: "bearer", expires_in: 7200, access_token: `a${calls.length}`, refresh_token: `r${calls.length}` });
    }) as unknown as typeof fetch;
    const o = { base: "http://x", fetch: f, now: () => 1000, margin_s: 300 };
    const pub = new TokenStore(join(dir, "t.json"), { kind: "oauth2", access_token: "", refresh_token: "seed-r", client_id: "cid", client_secret: null }, o);
    expect(await pub.access()).toBe("a1"); // no access token in the file: refreshed at once
    expect(calls[0]).toEqual({ auth: null, body: "grant_type=refresh_token&refresh_token=seed-r&client_id=cid" });
    const conf = new TokenStore(join(dir, "t.json"), { kind: "oauth2", access_token: "new-a", refresh_token: "new-r", ...MOCK_CLIENT }, o);
    expect(await conf.access()).toBe("new-a");
    await conf.refresh();
    expect(calls[1]).toEqual({ auth: `Basic ${Buffer.from("mock-client:mock-client-secret").toString("base64")}`, body: "grant_type=refresh_token&refresh_token=new-r" });
  });
});

describe("credentials file", () => {
  test("OAuth 2.0 first, OAuth 1.0a when only its four values are there, null when empty; refused when others can read it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tweet-launch-cred-"));
    const file = join(dir, "x.env");
    expect(loadCredentials(file)).toBeNull();
    writeFileSync(file, "X_API_KEY=\nX_ACCESS_TOKEN=\n# empty\n", { mode: 0o600 });
    expect(loadCredentials(file)).toBeNull();
    writeFileSync(file, 'X_ACCESS_TOKEN=at\nX_REFRESH_TOKEN="rt"\nX_CLIENT_ID=cid\nX_CLIENT_SECRET=cs\nX_BEARER_TOKEN=bt\n', { mode: 0o600 });
    expect(loadCredentials(file)).toEqual({ kind: "oauth2", access_token: "at", refresh_token: "rt", client_id: "cid", client_secret: "cs" });
    writeFileSync(file, "export X_API_KEY=k\nX_API_SECRET=s\nX_ACCESS_TOKEN=at\nX_ACCESS_TOKEN_SECRET=ats\n", { mode: 0o600 });
    expect(loadCredentials(file)).toEqual({ kind: "oauth1", api_key: "k", api_secret: "s", access_token: "at", access_token_secret: "ats" });
    const open = join(dir, "open.env");
    writeFileSync(open, "X_ACCESS_TOKEN=at\n", { mode: 0o644 });
    expect(() => loadCredentials(open)).toThrow("chmod 600");
  });
});

describe("the link round trip", () => {
  test("mention in, reply with link out, the launch handed to Core, follow-up out; a launch on another repository or an older one is not followed up", async () => {
    const e = bare();
    closers.push(() => e.close());
    const market = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { const mint = new URL(req.url).pathname.split("/").pop()!; return names[mint] ? Response.json({ mint, name: names[mint] }) : new Response("no", { status: 404 }); } });
    closers.push(() => market.stop(true));
    const names: Record<string, string> = {};
    const w = world({ core: `${e.base}/v1`, cfg: { follow_up: "own_reply", market_url: `http://127.0.0.1:${market.port}/market`, per_author_per_day: 10 } });
    const launch = async (repo: string, name: string) => {
      const a = { agent: generateAgentKey().id, mint: generateAgentKey().id };
      await expectOk(e.admin.c.post("/v1/admin/launches", { ...a, launcher: generateAgentKey().id, target_repo: repo, hosted: true, identity_mode: "app" }));
      names[a.mint] = name;
      return a;
    };
    // a launch that exists before the link is made cannot answer it
    const early = await launch("https://github.com/karpathy/minbpe", "Early");
    e.clock.advance(60_000);
    w.clock.t = e.clock.now();
    const m1 = w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    const m2 = w.ask("@unitsdotgg launch github.com/keis/base58", { author: "8" });
    const m3 = w.ask("@unitsdotgg launch github.com/a/third", { author: "9" });
    await w.run();
    expect(w.x.posted.length).toBe(3);
    const [r1, r2, r3] = w.refs as [string, string, string];
    // nothing launched yet: no follow-up
    await w.run();
    expect(w.x.posted.length).toBe(3);

    e.clock.advance(120_000);
    w.clock.t = e.clock.now();
    const good = await launch("https://github.com/karpathy/minbpe", "Fast BPE");
    const other = await launch("https://github.com/someone/else", "Other");
    // what the launch page does once its launch landed (apps/web/wallet/tweet-ref.ts)
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: r1, ...good }));
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: r2, ...other }));
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: r3, ...early }));
    const r = await w.run();
    expect(w.x.posted.slice(3)).toEqual([{ id: expect.any(String), in_reply_to: w.x.posted[0]!.id, text: `Fast BPE is live on karpathy/minbpe. Watch it work:\nhttps://app.units.gg/tokens/${good.mint}` }]);
    expect(r.actions.filter((a) => a.kind === "mismatch").map((a) => a.mention_id).sort()).toEqual([m2, m3].sort());
    const s = w.store.load();
    expect(s.requests[r1]).toMatchObject({ mention_id: m1, status: "done", outcome: "followed", agent: good.agent, mint: good.mint, follow_up_id: w.x.posted[3]!.id });
    expect([s.requests[r2]!.outcome, s.requests[r3]!.outcome]).toEqual(["mismatch", "mismatch"]);
    await w.run();
    expect(w.x.posted.length).toBe(4);
  });

  test("follow-up off (the default): the launch is noted and nothing more is posted; a link nobody used expires", async () => {
    const e = bare();
    closers.push(() => e.close());
    const w = world({ core: `${e.base}/v1`, cfg: { link_hours: 2 } });
    w.clock.t = e.clock.now();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    w.ask("@unitsdotgg launch github.com/keis/base58", { author: "8" });
    await w.run();
    e.clock.advance(60_000);
    w.clock.t = e.clock.now();
    const a = { agent: generateAgentKey().id, mint: generateAgentKey().id };
    await expectOk(e.admin.c.post("/v1/admin/launches", { ...a, launcher: generateAgentKey().id, target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "app" }));
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: w.refs[0], ...a }));
    await w.run();
    expect(w.x.posted.length).toBe(2);
    expect(w.store.load().requests[w.refs[0]!]).toMatchObject({ status: "done", outcome: "launched", agent: a.agent });
    w.clock.t += 3 * 3_600_000;
    const r = await w.run();
    expect(r.actions.map((x) => x.kind)).toEqual(["expired"]);
    expect(w.store.load().requests[w.refs[1]!]!.outcome).toBe("expired");
  });
});

// Where a launch started (owner 2026-10-13): the bot tells Core, signed with its own key, which tweet
// each link answers, before the reply goes out.
describe("the tweet a link answers", () => {
  test("with a key Core knows: the asking tweet, its author and the author above it are registered; the launch page can resolve the id", async () => {
    const e = bare();
    closers.push(() => e.close());
    const key = generateAgentKey();
    tweetLaunchesOf(e.core).writers.add(key.id);
    const w = world({ core: `${e.base}/v1`, cfg: { link_hours: 2 } });
    w.deps.coreKey = key;
    w.clock.t = e.clock.now();
    const parent = w.x.add({ text: "minbpe is neat https://t.co/a", author_id: "8", urls: ["https://github.com/karpathy/minbpe"] });
    const m1 = w.ask("@bob @unitsdotgg launch", { replied_to: parent.id });
    // a reply to one's own post names nobody above it
    const own = w.x.add({ text: "my repo github.com/keis/base58", author_id: "7" });
    const m2 = w.ask("@unitsdotgg launch", { replied_to: own.id });
    // a dry run registers nothing
    await w.run(false);
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM tweet_links").get()).toEqual({ n: 0 });
    w.refs.splice(0);
    await w.run();
    const [r1, r2] = w.refs as [string, string];
    expect(w.store.load().requests[r1]).toMatchObject({ handle: "ann", under_handle: "bob", registered: true });
    expect(w.store.load().requests[r2]).toMatchObject({ handle: "ann", under_handle: null, registered: true });
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-links/${r1}`))).toEqual({ origin: { repo: "karpathy/minbpe", handle: "ann", tweet_url: `https://x.com/ann/status/${m1}`, under_handle: "bob" } });
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-links/${r2}`))).toEqual({ origin: { repo: "keis/base58", handle: "ann", tweet_url: `https://x.com/ann/status/${m2}`, under_handle: null } });
    // the link in the reply still says nothing about the author or the tweet
    expect(w.x.posted[0]!.text).toContain(`/launch?repo=karpathy/minbpe&tl=${r1}`);
  });

  test("without a key, with a key Core does not know, or with Core away: the link is still given, nothing is registered", async () => {
    const e = bare();
    closers.push(() => e.close());
    const w = world({ core: `${e.base}/v1` });
    w.clock.t = e.clock.now();
    w.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    await w.run();
    w.deps.coreKey = generateAgentKey();
    w.ask("@unitsdotgg launch github.com/keis/base58");
    await w.run();
    const away = world({ cfg: {} });
    away.deps.coreKey = generateAgentKey();
    away.ask("@unitsdotgg launch github.com/karpathy/minbpe");
    await away.run();
    expect(w.x.posted.length).toBe(2);
    expect(away.x.posted.length).toBe(1);
    expect(Object.values(w.store.load().requests).map((r) => r.registered ?? false)).toEqual([false, false]);
    expect(away.store.load().requests[away.refs[0]!]!.registered).toBe(false);
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM tweet_links").get()).toEqual({ n: 0 });
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-links/${w.refs[0]}`))).toEqual({ origin: null });
  });
});

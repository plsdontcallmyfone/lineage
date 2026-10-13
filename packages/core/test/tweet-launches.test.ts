import { afterEach, describe, expect, test } from "bun:test";
import { CoreClient } from "../src/client.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { tweetLaunchesOf } from "../src/tweet-launches.ts";
import { bare, expectOk } from "./helpers.ts";

// Launch from a tweet (docs/plans/TWEET-LAUNCH.md 4): the launch page hands in the launch a link led
// to. Only an existing launch can be named; an id is used once; a launch answers one id.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const REF_A = "AAAAAAAAAAAAAAAAAAAAAA";
const REF_B = "BBBBBBBBBBBBBBBB_-BBBB";

async function launch(e: ReturnType<typeof bare>, repo: string) {
  const agent = generateAgentKey().id;
  const mint = generateAgentKey().id;
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent, mint, launcher: generateAgentKey().id, target_repo: repo, hosted: true, identity_mode: "app" }));
  return { agent, mint };
}

describe("tweet launches", () => {
  test("a launch Core knows is handed in once per link; the link's launch is read back with its repository", async () => {
    const e = bare();
    env = e;
    const a = await launch(e, "https://github.com/keis/base58");
    expect((await e.anon.get(`/v1/tweet-launches/${REF_A}`)).status).toBe(404);
    const r = await expectOk<any>(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...a }));
    expect(r).toMatchObject({ ref: REF_A, agent: a.agent, mint: a.mint, repo: "https://github.com/keis/base58" });
    expect(typeof r.launched_at).toBe("number");
    // the page may ask again: same answer, no second row
    expect(await expectOk<any>(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...a }))).toEqual(r);
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-launches/${REF_A}`))).toEqual(r);
    // the id is single-use, and a launch answers one id
    const b = await launch(e, "https://github.com/keis/base58");
    const used = await e.anon.post("/v1/tweet-launches", { ref: REF_A, ...b });
    expect([used.status, used.body.error]).toEqual([409, "ref_used"]);
    const twice = await e.anon.post("/v1/tweet-launches", { ref: REF_B, ...a });
    expect([twice.status, twice.body.error]).toEqual([409, "launch_used"]);
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_B, ...b }));
  });

  test("a launch Core has not read, a wrong coin and malformed bodies are refused and store nothing", async () => {
    const e = bare();
    env = e;
    const a = await launch(e, "https://github.com/keis/base58");
    const unknown = await e.anon.post("/v1/tweet-launches", { ref: REF_A, agent: generateAgentKey().id, mint: generateAgentKey().id });
    expect([unknown.status, unknown.body.error]).toEqual([404, "launch_unknown"]);
    const wrongMint = await e.anon.post("/v1/tweet-launches", { ref: REF_A, agent: a.agent, mint: generateAgentKey().id });
    expect([wrongMint.status, wrongMint.body.error]).toEqual([404, "launch_unknown"]);
    for (const body of [{ ref: "short", ...a }, { ref: REF_A + "A", ...a }, { ref: REF_A, agent: "x", mint: a.mint }, { ref: REF_A }, [], "x"]) {
      expect((await e.anon.post("/v1/tweet-launches", body)).status).toBe(400);
    }
    expect((await e.anon.get("/v1/tweet-launches/nope")).status).toBe(400);
    expect((await e.anon.get(`/v1/tweet-launches/${REF_A}`)).status).toBe(404);
  });
});

// Where a launch started (owner 2026-10-13): the reply bot tells Core, signed with its own key, which
// tweet a link answers. The launch page resolves an open link's id; an agent's pages read the tweet its
// launch started from. Both answer only what Core was told by that key, and only while it is true.
describe("the tweet a launch started from", () => {
  const LINK = { ref: REF_A, repo: "Keis/Base58", tweet_id: "1977000000000000001", handle: "asker_1", under_handle: "repo_author" };
  const ORIGIN = { repo: "keis/base58", handle: "asker_1", tweet_url: "https://x.com/asker_1/status/1977000000000000001", under_handle: "repo_author" };
  const HOUR = 3_600_000;

  test("only the bot's key or the admin key registers a link; the same statement twice is one row, another for the same id is refused", async () => {
    const e = bare();
    env = e;
    const bot = generateAgentKey();
    const stranger = generateAgentKey();
    const as = (k: typeof bot) => new CoreClient(e.base, k, () => e.clock.now());
    expect((await e.anon.post("/v1/tweet-links", LINK)).status).toBe(401);
    const no = await as(stranger).post("/v1/tweet-links", LINK);
    expect([no.status, no.body.error]).toEqual([403, "not_tweet_bot"]);
    // the bot's key is not known to this Core yet
    expect((await as(bot).post("/v1/tweet-links", LINK)).status).toBe(403);
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-links/${REF_A}`))).toEqual({ origin: null });
    tweetLaunchesOf(e.core).writers.add(bot.id);
    expect(await expectOk<any>(as(bot).post("/v1/tweet-links", LINK))).toEqual(ORIGIN);
    expect(await expectOk<any>(as(bot).post("/v1/tweet-links", LINK))).toEqual(ORIGIN);
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM tweet_links").get()).toEqual({ n: 1 });
    const other = await as(bot).post("/v1/tweet-links", { ...LINK, handle: "someone_else" });
    expect([other.status, other.body.error]).toEqual([409, "ref_registered"]);
    // the admin key may write too; a reply to one's own tweet names nobody above it
    expect(await expectOk<any>(e.admin.c.post("/v1/tweet-links", { ...LINK, ref: REF_B, under_handle: "ASKER_1", hours: 1 }))).toEqual({ ...ORIGIN, under_handle: null });
    for (const body of [
      { ...LINK, ref: "short" }, { ...LINK, repo: "no-slash" }, { ...LINK, repo: "a/b/c" }, { ...LINK, tweet_id: "12x" }, { ...LINK, tweet_id: 12 }, { ...LINK, handle: "@asker" },
      { ...LINK, handle: "a".repeat(16) }, { ...LINK, under_handle: "x y" }, { ...LINK, under_handle: 3 }, { ...LINK, hours: 0 }, { ...LINK, hours: 1.5 }, { ...LINK, hours: 24 * 90 + 1 }, [], "x",
    ]) {
      expect((await e.admin.c.post("/v1/tweet-links", body)).status).toBe(400);
    }
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM tweet_links").get()).toEqual({ n: 2 });
  });

  test("resolve: an open id answers the tweet, its author and the repository and nothing else; unknown, expired and used ids answer null", async () => {
    const e = bare();
    env = e;
    const open = async (ref: string) => (await expectOk<any>(e.anon.get(`/v1/tweet-links/${ref}`))).origin;
    await expectOk(e.admin.c.post("/v1/tweet-links", LINK));
    const whole = await expectOk<any>(e.anon.get(`/v1/tweet-links/${REF_A}`));
    expect(whole).toEqual({ origin: ORIGIN });
    expect(Object.keys(whole.origin).sort()).toEqual(["handle", "repo", "tweet_url", "under_handle"]);
    // unknown and malformed
    expect(await open(REF_B)).toBeNull();
    expect((await e.anon.get("/v1/tweet-links/nope")).status).toBe(400);
    // open until its time, then gone
    e.clock.advance(72 * HOUR - 1000);
    expect(await open(REF_A)).toEqual(ORIGIN);
    e.clock.advance(1000);
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-links/${REF_A}`))).toEqual({ origin: null });
    // single use: a launch handed in with the id closes it
    await expectOk(e.admin.c.post("/v1/tweet-links", { ...LINK, ref: REF_B }));
    expect(await open(REF_B)).toEqual(ORIGIN);
    const a = await launch(e, "https://github.com/keis/base58");
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_B, ...a }));
    expect(await open(REF_B)).toBeNull();
  });

  test("an agent's origin: only a launch handed in with a registered id, on the link's repository, while the link was open", async () => {
    const e = bare();
    env = e;
    const origin = async (agent: string) => (await expectOk<any>(e.anon.get(`/v1/agents/${agent}/tweet-origin`))).origin;
    // launched before the link existed: not from this link
    const early = await launch(e, "https://github.com/keis/base58");
    e.clock.advance(1000);
    await expectOk(e.admin.c.post("/v1/tweet-links", LINK));
    await expectOk(e.admin.c.post("/v1/tweet-links", { ...LINK, ref: REF_B, tweet_id: "1977000000000000002", handle: "second", under_handle: null }));
    e.clock.advance(1000);
    const good = await launch(e, "https://github.com/Keis/base58.git");
    const elsewhere = await launch(e, "https://github.com/other/repo");
    const plain = await launch(e, "https://github.com/keis/base58");
    expect(await origin(good.agent)).toBeNull();
    // the id handed in for a launch on another repository: the row is kept (the bot reads it), the origin is not served
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_B, ...elsewhere }));
    expect(await origin(elsewhere.agent)).toBeNull();
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...good }));
    const got = await origin(good.agent);
    expect(got).toEqual(ORIGIN);
    expect(Object.keys(got).sort()).toEqual(["handle", "repo", "tweet_url", "under_handle"]);
    // the whole answer names nothing but the origin: no id of the link, no wallet, no time
    const whole = await expectOk<any>(e.anon.get(`/v1/agents/${good.agent}/tweet-origin`));
    expect(Object.keys(whole)).toEqual(["origin"]);
    expect(JSON.stringify(whole)).not.toContain(REF_A);
    // a launch that handed in nothing, one older than the link, an id nobody registered, and an unknown agent
    expect(await origin(plain.agent)).toBeNull();
    const made = "DDDDDDDDDDDDDDDDDDDDDD";
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: made, ...plain }));
    expect(await origin(plain.agent)).toBeNull();
    // registering an id after a launch used it is refused: nobody can attach a tweet to a launch afterwards
    const after = await e.admin.c.post("/v1/tweet-links", { ...LINK, ref: made });
    expect([after.status, after.body.error]).toEqual([409, "ref_used"]);
    expect(await origin(early.agent)).toBeNull();
    expect(await origin(generateAgentKey().id)).toBeNull();
    expect((await e.anon.get("/v1/agents/nope/tweet-origin")).status).toBe(400);
    // the answer stays after the link's time: the launch did start there
    e.clock.advance(100 * HOUR);
    expect(await origin(good.agent)).toEqual(ORIGIN);
  });

  test("a launch Core registered after the link's time, or before the link, has no origin", async () => {
    const e = bare();
    env = e;
    const old = await launch(e, "https://github.com/keis/base58");
    e.clock.advance(1000);
    await expectOk(e.admin.c.post("/v1/tweet-links", { ...LINK, hours: 1 }));
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...old }));
    expect((await expectOk<any>(e.anon.get(`/v1/agents/${old.agent}/tweet-origin`))).origin).toBeNull();
    await expectOk(e.admin.c.post("/v1/tweet-links", { ...LINK, ref: REF_B, hours: 1 }));
    e.clock.advance(HOUR + 1000);
    const late = await launch(e, "https://github.com/keis/base58");
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_B, ...late }));
    expect((await expectOk<any>(e.anon.get(`/v1/agents/${late.agent}/tweet-origin`))).origin).toBeNull();
  });
});

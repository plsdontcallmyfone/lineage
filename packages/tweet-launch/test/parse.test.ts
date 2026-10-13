import { describe, expect, test } from "bun:test";
import { parseCommand, repoInText, resolveRepo, type Mention, type XPost } from "../src/parse.ts";
import { limited, prune, record, type PostLog } from "../src/limits.ts";
import { followUpReply, linkReply, NO_REPO, NOT_PUBLIC, noTestsReply, X_MAX, xLength } from "../src/replies.ts";
import { launchLink } from "../src/service.ts";

const post = (o: Partial<XPost>): XPost => ({ id: "1", text: "", author_id: "7", username: "ann", created_at: null, urls: [], refs: [], ...o });
const mention = (o: Partial<Mention>): Mention => ({ ...post(o), replied_to: null, quoted: null, ...o });

describe("the command", () => {
  test("launch must follow the tag, in any case; without it nothing is asked", () => {
    expect(parseCommand("@unitsdotgg launch", "unitsdotgg").kind).toBe("launch");
    expect(parseCommand("@bob @UnitsDotGG  LAUNCH", "unitsdotgg").kind).toBe("launch");
    expect(parseCommand("@unitsdotgg please launch this one", "unitsdotgg").kind).toBe("launch");
    expect(parseCommand("launch @unitsdotgg", "unitsdotgg").kind).toBe("none");
    expect(parseCommand("@unitsdotgg relaunch", "unitsdotgg").kind).toBe("none");
    expect(parseCommand("@unitsdotgg launched yet?", "unitsdotgg").kind).toBe("none");
    expect(parseCommand("@unitsdotgg nice work", "unitsdotgg").kind).toBe("none");
    expect(parseCommand("@unitsdotggx launch", "unitsdotgg").kind).toBe("none");
    expect(parseCommand("@unitsdotgg stop", "unitsdotgg").kind).toBe("stop");
  });

  test("name and ticker are read as typed and checked with the wizard's rules; the ticker is never made from the name", () => {
    expect(parseCommand("@unitsdotgg launch name Fast Parser ticker fpar", "unitsdotgg")).toEqual({ kind: "launch", name: "Fast Parser", ticker: "FPAR", vibe: null, dropped: [] });
    expect(parseCommand('@unitsdotgg launch name: "Tidy" ticker: $TIDY vibe: patient, precise https://t.co/abc', "unitsdotgg")).toEqual({ kind: "launch", name: "Tidy", ticker: "TIDY", vibe: "patient, precise", dropped: [] });
    expect(parseCommand("@unitsdotgg launch name Tidy Parser", "unitsdotgg")).toMatchObject({ name: "Tidy Parser", ticker: null });
    expect(parseCommand("@unitsdotgg launch", "unitsdotgg")).toMatchObject({ name: null, ticker: null, vibe: null });
    // refused fields are dropped, the rest stays
    expect(parseCommand("@unitsdotgg launch name " + "x".repeat(33) + " ticker OK1", "unitsdotgg")).toMatchObject({ name: null, ticker: "OK1", dropped: ["name"] });
    expect(parseCommand("@unitsdotgg launch name Good ticker TOO-LONG-TICKER", "unitsdotgg")).toMatchObject({ name: "Good", ticker: null, dropped: ["ticker"] });
    expect(parseCommand("@unitsdotgg launch name Elon Musk ticker EM", "unitsdotgg")).toMatchObject({ name: null, ticker: "EM", dropped: ["name"] });
    expect(parseCommand("@unitsdotgg launch name to the moon coin", "unitsdotgg")).toMatchObject({ name: null, dropped: ["name"] });
    expect(parseCommand("@unitsdotgg launch name Calm vibe: kill yourself", "unitsdotgg")).toMatchObject({ name: "Calm", vibe: null, dropped: ["vibe"] });
  });
});

describe("the repository", () => {
  test("a GitHub repository link in a text, also behind a file or pull request path; GitHub's own pages are not repositories", () => {
    expect(repoInText("see https://github.com/karpathy/minbpe")).toEqual({ owner: "karpathy", name: "minbpe" });
    expect(repoInText("github.com/keis/base58/pull/12.")).toEqual({ owner: "keis", name: "base58" });
    expect(repoInText("https://www.github.com/a/b.git and more")).toEqual({ owner: "a", name: "b" });
    expect(repoInText("https://github.com/a/b.")).toEqual({ owner: "a", name: "b" });
    expect(repoInText("https://github.com/orgs/units-agents/repositories")).toBeNull();
    expect(repoInText("https://github.com/topics/rust then https://github.com/x/y")).toEqual({ owner: "x", name: "y" });
    expect(repoInText("https://github.com/karpathy")).toBeNull();
    expect(repoInText("https://gitlab.com/a/b notgithub.com/a/b")).toBeNull();
  });

  test("looked for in the mention, then the post replied to, then the quoted post; expanded links before text", () => {
    const parent = post({ id: "2", text: "new release https://t.co/x", urls: ["https://github.com/p/parent"] });
    const quoted = post({ id: "3", text: "github.com/q/quoted" });
    expect(resolveRepo(mention({ text: "@unitsdotgg launch https://t.co/y", urls: ["https://github.com/m/own"], replied_to: parent, quoted }))).toEqual({ owner: "m", name: "own", from: "mention" });
    expect(resolveRepo(mention({ text: "@unitsdotgg launch", replied_to: parent, quoted }))).toEqual({ owner: "p", name: "parent", from: "replied_to" });
    expect(resolveRepo(mention({ text: "@unitsdotgg launch", quoted }))).toEqual({ owner: "q", name: "quoted", from: "quoted" });
    expect(resolveRepo(mention({ text: "@unitsdotgg launch", replied_to: post({ text: "no link here" }) }))).toBeNull();
  });
});

describe("limits", () => {
  const cfg = { per_author_per_day: 2, global_per_hour: 3, global_per_day: 5 };
  const H = 3_600_000;
  test("per author per day, global per hour, global per day; old posts stop counting", () => {
    const log: PostLog = { posts: [], by_author: {} };
    let now = 1_000_000_000_000;
    expect(limited(log, cfg, "a", now)).toBeNull();
    record(log, "a", now);
    record(log, "a", now);
    expect(limited(log, cfg, "a", now)).toBe("per_author_per_day");
    expect(limited(log, cfg, "b", now)).toBeNull();
    record(log, "b", now);
    expect(limited(log, cfg, "c", now)).toBe("global_per_hour");
    expect(limited(log, cfg, null, now)).toBe("global_per_hour");
    now += H + 1;
    expect(limited(log, cfg, "c", now)).toBeNull();
    record(log, "c", now);
    record(log, null, now);
    expect(limited(log, cfg, "d", now + H + 1)).toBe("global_per_day");
    now += 24 * H;
    prune(log, now);
    expect(limited(log, cfg, "a", now)).toBeNull();
    expect(log.by_author.a).toBeUndefined();
  });
});

describe("texts", () => {
  test("the owner's wording, word for word, within X's length, with no em dash", () => {
    const link = launchLink("https://app.units.gg", "karpathy/minbpe", "AAAAAAAAAAAAAAAAAAAAAA", { name: "Fast Parser", ticker: "FPAR", vibe: null });
    expect(link).toBe("https://app.units.gg/launch?repo=karpathy/minbpe&name=Fast+Parser&ticker=FPAR&tl=AAAAAAAAAAAAAAAAAAAAAA");
    expect(linkReply("ann", "karpathy/minbpe", link)).toBe(`@ann Launch an agent on karpathy/minbpe. Connect a wallet and approve:\n${link}`);
    expect(followUpReply("Fast Parser", "karpathy/minbpe", "https://app.units.gg/tokens/MINT")).toBe("Fast Parser is live on karpathy/minbpe. Watch it work:\nhttps://app.units.gg/tokens/MINT");
    expect(NO_REPO).toBe("I could not find a GitHub repository in this conversation. Reply to a tweet with a GitHub link.");
    expect(NOT_PUBLIC).toBe("That repository is not public, so an agent cannot work on it.");
    expect(noTestsReply("a/b")).toBe("a/b has no tests, so changes to it cannot be verified. Try a repository with tests.");
    const longest = "o".repeat(39) + "/" + "r".repeat(100);
    for (const t of [linkReply("a".repeat(15), longest, link), followUpReply("n".repeat(32), longest, link), noTestsReply(longest), NO_REPO, NOT_PUBLIC]) {
      expect(xLength(t)).toBeLessThanOrEqual(X_MAX);
      expect(t).not.toContain(String.fromCharCode(0x2014));
    }
  });

  test("a post that talks about the bot is not a request: launch counts only right after the handle", () => {
    expect(parseCommand("Lou (@launchonunits) turns a reply into an agent launch: tag it under a tweet with a GitHub repo", "launchonunits").kind).toBe("none");
    expect(parseCommand("Tag me under any tweet that links a repo: @launchonunits launch", "launchonunits").kind).toBe("launch");
    expect(parseCommand("@launchonunits, launch name Fast", "launchonunits")).toMatchObject({ kind: "launch", name: "Fast" });
    expect(parseCommand("@ann @launchonunits @bob launch", "launchonunits").kind).toBe("launch");
    expect(parseCommand("@launchonunits please launch this", "launchonunits").kind).toBe("launch");
    expect(parseCommand("@launchonunits is how you get an agent to launch on a repo", "launchonunits").kind).toBe("none");
    expect(parseCommand("@launchonunits LAUNCH https://github.com/karpathy/minbpe", "launchonunits").kind).toBe("launch");
  });
});

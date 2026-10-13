import { describe, expect, test } from "bun:test";
import { fixedShareBps, planFeeRoute, repoNameOf, tickText } from "../wallet/fee-route-plan.ts";

// The wizard's fee route (docs/plans/GITHUB-FEE-CLAIMS.md 11): one tick, the repository the agent
// works on is the only recipient, the share is the chain config's number.

const CFG = { minBps: 2000, maxBps: 2000 };
const HELLO = { asked: "octocat/hello-world", id: "1296269", full_name: "octocat/Hello-World" };

describe("launch wizard fee route", () => {
  test("not ticked: the launch adds nothing", () => {
    expect(planFeeRoute({ ticked: false, cfg: CFG, repoUrl: "https://github.com/octocat/Hello-World", looked: HELLO })).toBeNull();
    expect(planFeeRoute({ ticked: false, cfg: null, repoUrl: "", looked: null })).toBeNull();
  });

  test("ticked: the route is for the id of the repository in the field, at the share read from chain", () => {
    expect(planFeeRoute({ ticked: true, cfg: CFG, repoUrl: "https://github.com/octocat/Hello-World", looked: HELLO }))
      .toEqual({ githubId: 1296269n, bps: 2000, line: "20% of fees go to the owners of octocat/Hello-World" });
    // the figure follows the chain, whatever it is
    expect(planFeeRoute({ ticked: true, cfg: { minBps: 1250, maxBps: 1250 }, repoUrl: "https://github.com/octocat/hello-world.git", looked: HELLO }))
      .toMatchObject({ githubId: 1296269n, bps: 1250, line: "12.5% of fees go to the owners of octocat/Hello-World" });
  });

  test("a lookup made for another repository is refused: the recipient is never anything but the checked repository", () => {
    expect(() => planFeeRoute({ ticked: true, cfg: CFG, repoUrl: "https://github.com/acme/engine", looked: HELLO })).toThrow(/has not confirmed the repository/);
    expect(() => planFeeRoute({ ticked: true, cfg: CFG, repoUrl: "https://github.com/acme/engine", looked: null })).toThrow(/has not confirmed/);
    expect(() => planFeeRoute({ ticked: true, cfg: CFG, repoUrl: "https://gitlab.com/acme/engine", looked: HELLO })).toThrow();
    expect(() => planFeeRoute({ ticked: true, cfg: CFG, repoUrl: "https://github.com/octocat/Hello-World", looked: { ...HELLO, id: "octocat" } })).toThrow();
  });

  test("no config on chain: no share to offer, and a ticked box does not launch", () => {
    expect(fixedShareBps(null)).toBeNull();
    expect(fixedShareBps({ minBps: 0, maxBps: 0 })).toBeNull();
    expect(fixedShareBps(CFG)).toBe(2000);
    expect(() => planFeeRoute({ ticked: true, cfg: null, repoUrl: "https://github.com/octocat/Hello-World", looked: HELLO })).toThrow(/not set on chain/);
  });

  test("the tick's sentence names the repository and the chain's figure", () => {
    expect(tickText(2000, "octocat/Hello-World")).toBe("Route 20% of this agent's fees to the owners of octocat/Hello-World");
    expect(tickText(1500, null)).toBe("Route 15% of this agent's fees to the owners of the repository it works on");
    expect(repoNameOf("https://github.com/OctoCat/Hello-World/")).toBe("octocat/hello-world");
    expect(repoNameOf("https://example.com/a/b")).toBeNull();
  });
});

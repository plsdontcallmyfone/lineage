// The coin's links on the agent profile and the coin page (apps/web/src/coin-links.ts): read from the
// coin's own metadata document, shown only when they pass the same rules the launch applies.
import { describe, expect, test } from "bun:test";
import { coinLinkProblem } from "../../../packages/chain/src/coin-metadata.ts";
import { coinLinksRow, linksOfDoc, showableLink } from "../src/coin-links.ts";

const MINT = "C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br";

describe("coin links on the pages", () => {
  test("the page's rule and the launch's rule agree on every case", () => {
    const cases: [("twitter" | "telegram" | "website"), string][] = [
      ["twitter", "https://x.com/a"], ["twitter", "https://twitter.com/a"], ["twitter", "https://t.me/a"], ["twitter", "https://x.com/"], ["twitter", "https://x.com.evil.example/a"],
      ["telegram", "https://t.me/a"], ["telegram", "https://x.com/a"], ["telegram", "http://t.me/a"],
      ["website", "https://example.org/coin"], ["website", "http://example.org"], ["website", "javascript:alert(1)"], ["website", "https://u:p@example.org"], ["website", 'https://example.org/"onmouseover="x'], ["website", "https://localhost"], ["website", `https://example.org/${"a".repeat(120)}`],
    ];
    for (const [k, v] of cases) expect(showableLink(k, v), `${k} ${v}`).toBe(coinLinkProblem(k, v) === null);
  });
  test("the launcher's links are shown; the app's own fallback website and anything unusable are not", () => {
    const doc = { name: "x", twitter: "https://x.com/unitscoin", telegram: "https://t.me/unitscoin", website: "https://example.org/coin" };
    expect(linksOfDoc(doc, MINT)).toEqual({ twitter: doc.twitter, telegram: doc.telegram, website: doc.website });
    expect(linksOfDoc({ website: `https://app.units.gg/tokens/${MINT}` }, MINT)).toEqual({});
    expect(linksOfDoc({ twitter: "javascript:alert(1)", telegram: 5, website: "http://example.org" }, MINT)).toEqual({});
    expect(linksOfDoc(null, MINT)).toEqual({});
    const row = coinLinksRow({ twitter: doc.twitter, website: doc.website }).s;
    expect(row).toContain('href="https://x.com/unitscoin"');
    expect(row).toContain(">Twitter (X)</a>");
    expect(row).toContain(">Website</a>");
    expect(row).not.toContain("Telegram");
    expect(row).toContain('rel="noopener nofollow ugc"');
    expect(coinLinksRow({}).s).toBe("");
  });
});

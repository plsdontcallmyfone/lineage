import { describe, expect, test } from "bun:test";
import { CLAIM_SHARE_PATH, claimPreview, loadClaimPreview, usdWords, withPreview } from "../claim-preview.ts";
import { coins, readWaiting, waitingList, waitingRepoBody, waitingSection, type Waiting } from "../src/fees-waiting.ts";

// Fees waiting for the owners of a repository (docs/plans/GITHUB-FEE-CLAIMS.md 12): the list on the
// Claim page, the section on the project page, the page of one repository, and the words a posted
// link previews with. Every figure shown is one Core served.

const AGENT = "So11111111111111111111111111111111111111112";
const row = (name: string, waiting: string, usd: number | null, o: Partial<Waiting["repositories"][number]> = {}) => ({
  github_id: "5000001", repository: { id: "5000001", full_name: name, html_url: `https://github.com/${name}`, owner: { login: name.split("/")[0]!, type: "Organization", avatar_url: null } },
  waiting, waiting_usd: usd, claimed: "0", claimed_usd: usd === null ? null : 0, routed_total: waiting, agents: [{ agent: AGENT, bps: 2000, routed_total: waiting, set_at: 1_760_000_000 }],
  routed_since: 1_760_000_000, waiting_since: waiting === "0" ? null : 1_760_000_500, ...o,
});
const USD = { quote_usd: 0.0004, read_at: 1_760_002_000, decimals: 6 };
const list = (rows: Waiting["repositories"], usd = true): Waiting => ({ repositories: rows, total_waiting: "0", total_waiting_usd: usd ? 0 : null, usd: usd ? USD : null, usd_reason: usd ? null : "the market indexer gave no USD price" });
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("fees waiting: what the pages show", () => {
  test("the project page section: dollars first, the coin amount after, the Claim button on that repository", () => {
    const w = list([row("acme/engine", "250000000000", 100, { claimed: "40000000000", claimed_usd: 16 })]);
    const s = waitingSection(w, "Acme/Engine").s;
    expect(text(s)).toContain("$100.00 250,000 $UNITS is waiting for the owners of acme/engine. Anyone with admin on the repository can claim it.");
    expect(text(s)).toContain("From 1 agent:");
    expect(text(s)).toContain("$16.00 40,000 $UNITS claimed so far");
    expect(text(s)).toContain("waiting since");
    expect(s).toContain('href="/claim?repo=acme%2Fengine"');
    expect(s).toContain('href="/claim/acme/engine"');
    expect(s).toContain('id="fees-waiting"');
    // a route with nothing in the escrow, and a repository nothing is routed to
    const empty = text(waitingSection(list([row("acme/engine", "0", 0)]), "acme/engine").s);
    expect(empty).toContain("Nothing is waiting for the owners of acme/engine right now. 1 agent routes a share of fees to it");
    expect(empty).toContain("nothing claimed so far");
    expect(empty).not.toContain("waiting since");
    expect(waitingSection(list([row("acme/engine", "5", 1)]), "other/repo").s).toBe("");
    expect(waitingSection(null, "acme/engine").s).toBe("");
  });

  test("the list on the Claim page: Core's order, only repositories with something waiting, and an honest empty state", () => {
    const w = list([row("acme/engine", "250000000000", 100), row("octocat/Hello-World", "60000000", 0.024), row("acme/quiet", "0", 0)]);
    const s = waitingList(w).s;
    expect([...s.matchAll(/data-fees-repo="([^"]+)"/g)].map((m) => m[1])).toEqual(["acme/engine", "octocat/Hello-World"]);
    expect(text(s)).toContain("Repositories with fees waiting 2");
    expect(text(s)).toContain("$0.024 60 $UNITS");
    expect(s).toContain('href="/projects/octocat/hello-world#fees-waiting"');
    expect(text(s)).toContain("1 more with a route and nothing waiting.");
    const none = text(waitingList(list([])).s);
    expect(none).toContain("No repository has fees waiting.");
    expect(none).toContain("No agent routes fees to a repository yet.");
    expect(text(waitingList(list([row("acme/quiet", "0", 0)])).s)).toContain("1 agent route a share of fees to a repository; nothing has arrived, or everything was claimed.");
    // where Core serves no list the page adds nothing
    expect(waitingList(null).s).toBe("");
  });

  test("the page of one repository: waiting, nothing waiting, nothing routed, and not served", () => {
    const has = waitingRepoBody(list([row("acme/engine", "250000000000", 100)]), "acme/engine").s;
    expect(has).toContain('data-fees-page="waiting"');
    expect(text(has)).toContain("$100.00 is waiting for the owners of acme/engine");
    expect(text(has)).toContain("Fees from agents working on acme/engine . Anyone with admin on the repository can claim them: sign in with GitHub, bind a wallet, claim.");
    expect(text(has)).toContain("20% of its fees");
    expect(has).toContain('href="/claim?repo=acme%2Fengine"');
    const empty = waitingRepoBody(list([row("acme/engine", "0", 0)]), "acme/engine").s;
    expect(empty).toContain('data-fees-page="empty"');
    expect(text(empty)).toContain("Nothing is waiting for the owners of acme/engine");
    const none = waitingRepoBody(list([]), "nobody/nothing").s;
    expect(none).toContain('data-fees-page="none"');
    expect(text(none)).toContain("No fees are routed to nobody/nothing");
    expect(none).not.toContain("$");
    expect(waitingRepoBody(null, "acme/engine").s).toContain('data-fees-page="off"');
  });

  test("without a dollar reading the dollars say so and no coin number stands in for them; a broken answer shows nothing", () => {
    const w = list([row("acme/engine", "250000000000", null)], false);
    const s = text(waitingSection(w, "acme/engine").s);
    expect(s).toContain("$ unavailable is waiting for the owners of acme/engine");
    expect(s).toContain("No US dollar price: the market indexer gave no USD price");
    expect(s).not.toContain("250,000");
    expect(coins("250000000000", null)).toBe("");
    expect(readWaiting(null)).toBeNull();
    expect(readWaiting({ repositories: "x" })).toBeNull();
    // rows that are not what Core serves are dropped: a name that is not owner/name, an amount that is not a number
    const kept = readWaiting({ repositories: [row("acme/engine", "5", 1), row("<script>/x", "5", 1), row("a/b", "five", 1), row("a/c", "5", -1 as any)], total_waiting: "5", usd: USD })!;
    expect(kept.repositories.map((r) => r.repository.full_name)).toEqual(["acme/engine"]);
    for (const out of [waitingSection(list([row("acme/engine", "1", 1)]), "acme/engine").s, waitingList(list([])).s]) expect(out).not.toMatch(/\u2014|devnet|TBA|mono/i);
  });
});

describe("the words a posted link previews with", () => {
  test("the amount when something waits, plain words otherwise; GitHub's spelling of the name", () => {
    expect(claimPreview("acme/engine", row("Acme/Engine", "250000000000", 1234.5))).toEqual({ title: "$1,235 is waiting for the owners of Acme/Engine", description: "Fees from agents working on Acme/Engine, claimable by anyone with admin on the repository." });
    expect(claimPreview("acme/engine", row("acme/engine", "60000000", 0.024)).title).toBe("$0.024 is waiting for the owners of acme/engine");
    expect(usdWords(12.345)).toBe("$12.35");
    for (const none of [null, row("acme/engine", "0", 0), row("acme/engine", "5", null)]) expect(claimPreview("acme/engine", none).title).toBe("Fees for the owners of acme/engine");
    // a renamed repository: Core's row names it as GitHub does now
    expect(claimPreview("acme/old-engine", row("acme/engine", "5000000", 3)).title).toBe("$3.00 is waiting for the owners of acme/engine");
    expect(claimPreview("acme/engine", { repository: { full_name: "<b>" }, waiting: "5", waiting_usd: 3 }).title).toBe("$3.00 is waiting for the owners of acme/engine");
  });

  test("the tags go into the served document, escaped; only /claim/<owner>/<name> gets them", () => {
    const doc = "<!doctype html>\n<html><head>\n<meta charset=\"utf-8\">\n</head>\n<body><div id=\"app\"></div></body></html>";
    const out = withPreview(doc, { title: 'a "b" <c>', description: "d & e" }, "https://app.units.gg/claim/acme/engine");
    expect(out).toContain("<title>a &quot;b&quot; &lt;c&gt; | units</title>");
    expect(out).toContain('<meta property="og:description" content="d &amp; e">');
    expect(out).toContain('<meta property="og:url" content="https://app.units.gg/claim/acme/engine">');
    expect(out).toContain('<meta name="twitter:card" content="summary">');
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("</head>"));
    expect(out).toContain('<div id="app"></div>');
    expect(withPreview(doc, { title: "t", description: "d" }, null)).not.toContain("og:url");
    expect(CLAIM_SHARE_PATH.exec("/claim/acme/engine")?.slice(1, 3)).toEqual(["acme", "engine"]);
    for (const p of ["/claim", "/claim/acme", "/claim/acme/engine/x", "/claim/-bad/x", "/claim/a/b c"]) expect(CLAIM_SHARE_PATH.test(p)).toBe(false);
  });

  test("read from Core once a minute; Core away or the feature off gives the plain words", async () => {
    let calls = 0, t = 1_000_000;
    const f = (async (url: any) => {
      calls++;
      expect(String(url)).toBe("http://core/v1/fee-claims/waiting?repo=acme%2Fengine");
      return new Response(JSON.stringify({ repositories: [row("acme/engine", "250000000000", 100)] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await loadClaimPreview("http://core", "acme/engine", f, () => t)).title).toBe("$100.00 is waiting for the owners of acme/engine");
    await loadClaimPreview("http://core", "Acme/Engine", f, () => t + 30_000);
    expect(calls).toBe(1);
    await loadClaimPreview("http://core", "acme/engine", f, () => t + 61_000);
    expect(calls).toBe(2);
    const off = (async () => new Response('{"error":"feature_off"}', { status: 404 })) as unknown as typeof fetch;
    expect((await loadClaimPreview("http://core", "x/off", off, () => t)).title).toBe("Fees for the owners of x/off");
    const away = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect((await loadClaimPreview("http://core", "x/away", away, () => t)).title).toBe("Fees for the owners of x/away");
  });
});

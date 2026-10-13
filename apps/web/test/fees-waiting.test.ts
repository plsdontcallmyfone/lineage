import { describe, expect, test } from "bun:test";
import { CLAIM_SHARE_PATH, claimPreview, loadClaimPreview, usdWords, withPreview } from "../claim-preview.ts";
import { claimHow, coins, oneShare, readWaiting, waitingList, waitingRepoBody, waitingSection, waitingStats, WAITING_CSS, type Waiting } from "../src/fees-waiting.ts";

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
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

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
    // the button says what it claims, and is the primary one only when something waits
    expect(s).toMatch(/class="wl-btn primary" href="\/claim\?repo=acme%2Fengine" data-fees-claim>Claim \$100\.00</);
    // a route with nothing in the escrow, and a repository nothing is routed to
    const empty = text(waitingSection(list([row("acme/engine", "0", 0)]), "acme/engine").s);
    expect(empty).toContain("Nothing is waiting for the owners of acme/engine right now. 1 agent shares fees with it");
    expect(empty).toContain("nothing claimed so far");
    expect(empty).not.toContain("waiting since");
    expect(waitingSection(list([row("acme/engine", "0", 0)]), "acme/engine").s).toMatch(/class="wl-btn" href="[^"]+" data-fees-claim>Claim</);
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
    expect(text(s)).toContain("1 more receives fees and has nothing waiting.");
    // every row: the repository, what waits, how many agents and since when, and a Claim that opens the flow on it
    expect(text(s)).toContain("acme/engine 1 agent, waiting since");
    expect([...s.matchAll(/class="wl-btn fw-claim" href="([^"]+)" data-fees-claim/g)].map((m) => m[1])).toEqual(["/claim?repo=acme%2Fengine", "/claim?repo=octocat%2FHello-World"]);
    expect(s).toContain('href="/claim/octocat/Hello-World">Details</a>');
    const none = text(waitingList(list([])).s);
    expect(none).toContain("No repository has fees waiting right now.");
    expect(none).toContain("This fills when an agent earns fees for a repository. Launch an agent with fees shared to its repository's owners .");
    expect(waitingList(list([])).s).toContain('<a class="link" href="/launch">Launch an agent with fees shared to its repository\'s owners</a>');
    expect(text(waitingList(list([row("acme/quiet", "0", 0)])).s)).toContain("1 agent shares fees with a repository; nothing has arrived yet, or all of it was claimed.");
    // where Core serves no list the page adds nothing
    expect(waitingList(null).s).toBe("");
  });

  test("the page of one repository: waiting, nothing waiting, nothing routed, and not served", () => {
    const has = waitingRepoBody(list([row("acme/engine", "250000000000", 100)]), "acme/engine").s;
    expect(has).toContain('data-fees-page="waiting"');
    expect(text(has)).toContain("$100.00 is waiting for the owners of acme/engine");
    expect(text(has)).toContain("Fees from agents working on acme/engine . Anyone with admin on the repository can claim them.");
    // the primary button names the amount and lands in the flow with the repository preselected
    expect(has).toMatch(/class="wl-btn primary" href="\/claim\?repo=acme%2Fengine" data-fees-claim>Claim \$100\.00</);
    expect(text(has)).toContain("20% of its fees");
    expect(has).toContain('href="/claim?repo=acme%2Fengine"');
    const empty = waitingRepoBody(list([row("acme/engine", "0", 0)]), "acme/engine").s;
    expect(empty).toContain('data-fees-page="empty"');
    expect(text(empty)).toContain("Nothing is waiting for the owners of acme/engine");
    const none = waitingRepoBody(list([]), "nobody/nothing").s;
    expect(none).toContain('data-fees-page="none"');
    expect(text(none)).toContain("No fees are shared with nobody/nothing");
    expect(none).not.toMatch(/\$\d/);
    expect(none).toContain('href="/launch?repo=nobody%2Fnothing"');
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

describe("the Claim page: tiles, the explanation, the words", () => {
  test("four tiles from the list Core served, and nothing where it served none", () => {
    const w: Waiting = { ...list([row("acme/engine", "250000000000", 100, { claimed: "40000000000", claimed_usd: 16 }), row("octocat/Hello-World", "60000000", 0.024), row("acme/quiet", "0", 0)]), total_waiting: "250060000000", total_waiting_usd: 100.024 };
    const t = text(waitingStats(w).s);
    expect(t).toContain("Waiting now $100.02 250,060 $UNITS");
    expect(t).toContain("Claimed so far $16.00 40,000 $UNITS, at today's price");
    expect(t).toContain("Repositories receiving fees 3 2 with fees waiting");
    expect(t).toContain("Agents sharing fees 3 20% of their fees each");
    expect(oneShare(w)).toBe(2000);
    // shares that differ are not averaged into one figure
    const mixed = list([row("a/b", "5", 1), row("c/d", "5", 1, { agents: [{ agent: AGENT, bps: 1000, routed_total: "5", set_at: 1 }] })]);
    expect(oneShare(mixed)).toBeNull();
    expect(text(waitingStats(mixed).s)).toContain("Agents sharing fees 2 with a repository's owners");
    const none = text(waitingStats(list([])).s);
    expect(none).toContain("Waiting now $0");
    expect(none).toContain("Repositories receiving fees 0 none yet");
    expect(none).toContain("Agents sharing fees 0 none yet");
    // no dollar reading: the tile says so and no coin count stands in for dollars
    const dry = text(waitingStats(list([row("acme/engine", "250000000000", null)], false)).s);
    expect(dry).toContain("Waiting now $ unavailable No US dollar price: the market indexer gave no USD price");
    expect(waitingStats(null).s).toBe("");
  });

  test("How this works says only what holds: the share Core served, no access to code only for the empty scope", () => {
    const full = text(claimHow({ scope: "", share: 2000 }).s);
    expect(full).toContain("The GitHub sign-in asks for no access to your code.");
    expect(full).toContain("No GitHub token is kept.");
    expect(full).toContain("Only someone with admin on the repository can claim.");
    expect(full).toContain("share 20% of the agent's fees with the owners of the repository it works on");
    expect(full).toContain("Any one admin can claim all of it, first come.");
    expect(full).toContain("a team should agree on one wallet before anyone claims");
    expect(full).toContain("You pay the network fee and, the first time, the small deposit Solana asks for to open the wallet's $UNITS account.");
    // a wider scope, or one Core did not name: the page does not promise "no access"; with no single share it names no figure
    for (const scope of ["public_repo", null, undefined]) {
      const t = text(claimHow({ scope, share: null }).s);
      expect(t).not.toContain("no access to your code");
      expect(t).toContain("share part of the agent's fees");
      expect(t).not.toMatch(/\d+% of the agent/);
    }
    // closed until asked for, opened by the bounty explanation's own toggle
    const h = claimHow({ scope: "" }).s;
    expect(h).toMatch(/<button type="button" class="rq-btn" aria-expanded="false" aria-controls="(cl-how-\d+)" data-rq-toggle>How this works<\/button>/);
    expect(h).toMatch(/class="rq-panel" id="cl-how-\d+" role="region" aria-label="How claiming works" hidden>/);
  });

  test("a maintainer's words, and the page's rules in the style sheet", () => {
    const w: Waiting = list([row("acme/engine", "250000000000", 100), row("acme/quiet", "0", 0)]);
    const all = [waitingStats(w).s, waitingList(w).s, waitingList(list([])).s, claimHow({ scope: "", share: 2000 }).s, waitingSection(w, "acme/engine").s, waitingRepoBody(w, "acme/engine").s, waitingRepoBody(w, "acme/quiet").s, waitingRepoBody(list([]), "x/y").s].map(text).join(" ");
    expect(all).not.toMatch(/escrow|\bCore\b|attest|read from chain|on chain|\bbind|\broute[sd]?\b|\u2014/i);
    expect(WAITING_CSS).not.toMatch(/mono|courier|menlo|consolas/i);
    // the content width of the other pages, and one column on a narrow screen
    expect(WAITING_CSS).toContain(".cl-page{display:grid;gap:20px;max-width:calc(1440px - 2 * var(--pad-x));margin-left:auto;margin-right:auto");
    expect(WAITING_CSS).toMatch(/@media \(max-width:1100px\)\{\s*\.cl-cols\{grid-template-columns:minmax\(0,1fr\)/);
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

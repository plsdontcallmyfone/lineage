import { describe, expect, test } from "bun:test";
import { claimCard, claimError, claimPhases, HEADLINE, NOT_ADMIN, signinError, type CardFacts, type CardRec } from "../wallet/claim-state.ts";

// The Claim card (owner 2026-10-13): one headline, one sentence, one action that changes with what is
// known. Every state and every error the page can be in, as words, without a browser.

const WALLET = "7xKpAbCdEfGhJkLmNpQrStUvWxYz123456789AbCd3fQ2", OTHER = "9aBcAbCdEfGhJkLmNpQrStUvWxYz123456789AbCdZz11";
const ENGINE = { id: "5000001", full_name: "acme/engine" }, TOOLS = { id: "5000002", full_name: "mona/tools" }, QUIET = { id: "5000003", full_name: "acme/quiet" };
// 6 decimals at 0.0004 USD a coin
const usd = (base: bigint) => `$${((Number(base) / 1e6) * 0.0004).toFixed(2)}`;
const rec = (claimable: string, o: Partial<NonNullable<NonNullable<CardRec>["escrow"]>> = {}, agents = 1): CardRec => ({ agents, escrow: { claimable, claimed: "0", wallet: null, pending_wallet: null, ...o } });
const facts = (o: Partial<CardFacts> = {}): CardFacts => ({ providers: { oauth: true, gist: true }, off: null, sess: null, connected: null, recs: new Map(), focus: null, done: new Set(), now: 1_760_000_000, ...o });
const mona = (repos = [ENGINE, TOOLS], wallet: string | null = null, method = "oauth") => ({ login: "mona", method, wallet, repositories: repos });
const steps = (f: CardFacts) => claimCard(f, usd).steps.map((s) => `${s.label}:${s.state}`).join(" ");

describe("the claim card", () => {
  test("the headline never changes", () => {
    expect(HEADLINE).toBe("Claim fees for your repository");
  });

  test("before the site has answered, where claims are not offered, and when the site is away", () => {
    const loading = claimCard(facts({ providers: null }), usd);
    expect(loading).toMatchObject({ key: "loading", lead: "Checking what is waiting.", primary: null, steps: [] });
    const off = claimCard(facts({ off: "feature_off", providers: null }), usd);
    expect(off).toMatchObject({ key: "off", primary: null, steps: [] });
    expect(off.lead).toBe("The owners of a repository claim their share of an agent's fees on this page.");
    const away = claimCard(facts({ off: "unreachable", providers: null }), usd);
    expect(away.lead).toBe("The site did not answer, so this page cannot tell what is waiting. Try again.");
    expect(away.primary).toEqual({ action: "retry", label: "Try again" });
  });

  test("signed out: Sign in with GitHub, and the steps start at GitHub", () => {
    const v = claimCard(facts(), usd);
    expect(v.key).toBe("signed-out");
    expect(v.lead).toBe("Sign in with GitHub to see what is waiting for the repositories you have admin on.");
    expect(v.primary).toEqual({ action: "oauth", label: "Sign in with GitHub" });
    expect(steps(facts())).toBe("GitHub:now Wallet:todo Claim:todo");
    expect(v.rows).toEqual([]);
    // a wallet already connected in the header counts at once
    expect(steps(facts({ connected: WALLET }))).toBe("GitHub:now Wallet:done Claim:todo");
  });

  test("signed out with a repository named: the sign-in asks about that repository, only when fees are shared with it", () => {
    const v = claimCard(facts({ focus: { full_name: "acme/engine", id: ENGINE.id, routed: true } }), usd);
    expect(v.lead).toBe("Sign in with GitHub to claim the fees waiting for acme/engine.");
    expect(v.primary).toEqual({ action: "oauth-repo", label: "Sign in with GitHub", repo: "acme/engine" });
    const none = claimCard(facts({ focus: { full_name: "mona/unrelated", id: "583231", routed: false } }), usd);
    expect(none.primary).toEqual({ action: "oauth", label: "Sign in with GitHub" });
  });

  test("no sign-in offered here: the gist is the way, with no primary button of the card's own", () => {
    const v = claimCard(facts({ providers: { oauth: false, gist: true } }), usd);
    expect(v.key).toBe("gist-only");
    expect(v.primary).toBeNull();
    expect(v.lead).toContain("a public gist that your wallet signed");
  });

  test("signed in, no wallet: Connect wallet, with what waits already said", () => {
    const f = facts({ sess: mona(), recs: new Map([[ENGINE.id, rec("1327407400000")], [TOOLS.id, rec("829696100000")]]) });
    const v = claimCard(f, usd);
    expect(v.key).toBe("connect");
    expect(v.lead).toBe("$862.84 is waiting for 2 of your repositories. Connect the wallet it should go to.");
    expect(v.primary).toEqual({ action: "connect", label: "Connect wallet" });
    expect(steps(f)).toBe("GitHub:done Wallet:now Claim:todo");
    // the repositories show with their amounts, and no row has a button before there is a wallet
    expect(v.rows.map((r) => [r.full_name, r.state, r.button])).toEqual([["acme/engine", "ready", null], ["mona/tools", "ready", null]]);
    const nothing = claimCard(facts({ sess: mona([QUIET]), recs: new Map([[QUIET.id, rec("0")]]) }), usd);
    expect(nothing.lead).toBe("Connect the wallet your fees should go to.");
  });

  test("signed in with a wallet and money waiting: a Claim button per repository, the largest first, then the empty ones", () => {
    const f = facts({ sess: mona([QUIET, TOOLS, ENGINE]), connected: WALLET, recs: new Map([[ENGINE.id, rec("1327407400000", {}, 2)], [TOOLS.id, rec("829696100000")], [QUIET.id, rec("0")]]) });
    const v = claimCard(f, usd);
    expect(v.key).toBe("ready");
    expect(v.primary).toBeNull();
    expect(v.lead).toBe("$862.84 is waiting for 2 of your repositories.");
    expect(v.rows.map((r) => [r.full_name, r.state, r.button?.label ?? null])).toEqual([["acme/engine", "ready", "Claim $530.96"], ["mona/tools", "ready", "Claim $331.88"], ["acme/quiet", "empty", null]]);
    expect(v.rows[0]!.button).toEqual({ action: "claim", label: "Claim $530.96", primary: true });
    expect(v.rows[0]!.agents).toBe(2);
    expect(steps(f)).toBe("GitHub:done Wallet:done Claim:now");
    const one = claimCard(facts({ sess: mona([ENGINE]), connected: WALLET, recs: new Map([[ENGINE.id, rec("1030750000000")]]) }), usd);
    expect(one.lead).toBe("$412.30 is waiting for acme/engine.");
    expect(one.rows[0]!.button!.label).toBe("Claim $412.30");
  });

  test("how many times the wallet is asked: twice until this sign-in knows the wallet, then once", () => {
    const recs = new Map([[ENGINE.id, rec("5000000")]]);
    expect(claimCard(facts({ sess: mona([ENGINE], null), connected: WALLET, recs }), usd).prompts).toBe(2);
    expect(claimCard(facts({ sess: mona([ENGINE], WALLET), connected: WALLET, recs }), usd).prompts).toBe(1);
    // the sign-in was tied to another wallet: the connected one is proven again
    expect(claimCard(facts({ sess: mona([ENGINE], OTHER), connected: WALLET, recs }), usd).prompts).toBe(2);
    expect(claimPhases(2).map((p) => p.label)).toEqual(["Proving your wallet", "Claiming"]);
    expect(claimPhases(1).map((p) => p.label)).toEqual(["Claiming"]);
    expect(claimPhases(2)[0]!.hint).toBe("Approve the message in your wallet. It is free and moves nothing.");
  });

  test("signed in, repositories that receive fees with nothing waiting", () => {
    const f = facts({ sess: mona([QUIET]), connected: WALLET, recs: new Map([[QUIET.id, rec("0")]]) });
    const v = claimCard(f, usd);
    expect(v.key).toBe("empty");
    expect(v.lead).toBe("Nothing is waiting right now. Fees arrive here as the agents working on your repositories earn them.");
    expect(v.rows[0]).toMatchObject({ state: "empty", button: null });
    expect(steps(f)).toBe("GitHub:done Wallet:done Claim:todo");
  });

  test("signed in, none of the account's repositories receive fees: one quiet line and what would change it", () => {
    const v = claimCard(facts({ sess: mona([]), connected: WALLET }), usd);
    expect(v.key).toBe("none");
    expect(v.lead).toBe("None of your repositories receive fees yet.");
    expect(v.note).toBe("That changes when someone launches an agent on one of them and shares its fees with the owners. An organisation's repository shows here once one of its owners has approved the units app on GitHub's sign-in screen.");
    expect(v.primary).toBeNull();
    expect(v.rows).toEqual([]);
    // through a gist, which covers personal repositories only
    expect(claimCard(facts({ sess: mona([], WALLET, "gist"), connected: WALLET }), usd).note).toBe("A gist covers repositories under your own account. For an organisation's repository, sign in with GitHub.");
  });

  test("an organisation that has not approved the app: GitHub did not report admin on the repository the visitor came for", () => {
    const focus = { full_name: "acme/engine", id: ENGINE.id, routed: true };
    const none = claimCard(facts({ sess: mona([]), connected: WALLET, focus }), usd);
    expect(none.note).toBe("GitHub did not say this account has admin on acme/engine. For an organisation's repository, an owner of the organisation may first have to approve the units app on GitHub's sign-in screen.");
    expect(none.note).toBe(NOT_ADMIN("acme/engine"));
    // the same with other repositories of theirs listed
    const some = claimCard(facts({ sess: mona([TOOLS]), connected: WALLET, focus, recs: new Map([[TOOLS.id, rec("5000000")]]) }), usd);
    expect(some.key).toBe("ready");
    expect(some.note).toBe(NOT_ADMIN("acme/engine"));
    // one of theirs is marked instead, and a repository no agent shares fees with raises nothing
    const mine = claimCard(facts({ sess: mona([ENGINE]), connected: WALLET, focus, recs: new Map([[ENGINE.id, rec("5000000")]]) }), usd);
    expect(mine.note).toBeNull();
    expect(mine.rows[0]!.focused).toBe(true);
    expect(claimCard(facts({ sess: mona([]), connected: WALLET, focus: { full_name: "mona/unrelated", id: "9", routed: false } }), usd).note).not.toContain("GitHub did not say");
  });

  test("balances still being read, and one that could not be read", () => {
    const f = facts({ sess: mona([ENGINE, TOOLS]), connected: WALLET, recs: new Map<string, CardRec>([[TOOLS.id, null]]) });
    const v = claimCard(f, usd);
    expect(v.rows.map((r) => [r.full_name, r.state])).toEqual([["acme/engine", "loading"], ["mona/tools", "error"]]);
    expect(v.lead).toBe("Reading what is waiting for your repositories.");
    expect(v.rows.every((r) => r.button === null)).toBe(true);
  });

  test("earlier claims went to another wallet: the move is asked for, waited for, then a plain claim", () => {
    const base = { sess: mona([ENGINE], WALLET), connected: WALLET };
    const ask = claimCard(facts({ ...base, recs: new Map([[ENGINE.id, rec("5000000", { wallet: OTHER })]]) }), usd);
    expect(ask.rows[0]).toMatchObject({ state: "move", paidTo: OTHER, button: { action: "claim", label: "Move claims to this wallet", primary: false } });
    expect(ask.key).toBe("empty"); // nothing this wallet can be paid now
    expect(ask.lead).toBe("What is waiting is paid to the wallet that claimed before. You can ask to move it to yours.");
    const wait = claimCard(facts({ ...base, recs: new Map([[ENGINE.id, rec("5000000", { wallet: OTHER, pending_wallet: { wallet: WALLET, effective_at: 1_760_000_600 } })]]) }), usd);
    expect(wait.rows[0]).toMatchObject({ state: "moving", movesAt: 1_760_000_600, button: null });
    expect(wait.lead).toBe("Claims are moving to your wallet. Until the date below they are paid to the wallet that claimed before.");
    const due = claimCard(facts({ ...base, now: 1_760_000_600, recs: new Map([[ENGINE.id, rec("5000000", { wallet: OTHER, pending_wallet: { wallet: WALLET, effective_at: 1_760_000_600 } })]]) }), usd);
    expect(due.rows[0]).toMatchObject({ state: "ready", button: { label: "Claim $0.00" } });
    // a move someone else asked for changes nothing for this wallet
    const theirs = claimCard(facts({ ...base, recs: new Map([[ENGINE.id, rec("5000000", { wallet: OTHER, pending_wallet: { wallet: "3rd", effective_at: 1 } })]]) }), usd);
    expect(theirs.rows[0]!.state).toBe("move");
    // the wallet earlier claims were paid to claims as usual
    expect(claimCard(facts({ ...base, recs: new Map([[ENGINE.id, rec("5000000", { wallet: WALLET })]]) }), usd).rows[0]!.state).toBe("ready");
  });

  test("after a claim: the row is done, and when all are, the card says the next fees arrive here", () => {
    const f = facts({ sess: mona([ENGINE], WALLET), connected: WALLET, recs: new Map([[ENGINE.id, rec("0", { claimed: "1327407400000", wallet: WALLET })]]), done: new Set([ENGINE.id]) });
    const v = claimCard(f, usd);
    expect(v.rows[0]).toMatchObject({ state: "done", button: null, claimed: 1327407400000n });
    expect(v.lead).toBe("Claimed. The next fees arrive here as agents earn them.");
    expect(steps(f)).toBe("GitHub:done Wallet:done Claim:done");
    // with a repository beside it that has earned nothing, the card still closes on the claim
    const withQuiet = facts({ sess: mona([ENGINE, QUIET], WALLET), connected: WALLET, recs: new Map([[ENGINE.id, rec("0")], [QUIET.id, rec("0")]]), done: new Set([ENGINE.id]) });
    expect(claimCard(withQuiet, usd).lead).toBe("Claimed. The next fees arrive here as agents earn them.");
    expect(steps(withQuiet)).toBe("GitHub:done Wallet:done Claim:done");
    // one claimed, one still waiting: the waiting one leads
    const two = claimCard(facts({ sess: mona([ENGINE, TOOLS], WALLET), connected: WALLET, recs: new Map([[ENGINE.id, rec("0")], [TOOLS.id, rec("829696100000")]]), done: new Set([ENGINE.id]) }), usd);
    expect(two.rows.map((r) => r.state)).toEqual(["ready", "done"]);
    expect(two.lead).toBe("$331.88 is waiting for mona/tools.");
  });
});

describe("errors, in words", () => {
  const says = (code: string | null, message = "", repo?: string) => claimError(code, message, repo).text;

  test("each thing that can go wrong has its own sentence", () => {
    expect(says("github_unreachable")).toBe("GitHub did not answer. Try again.");
    expect(says("core_unreachable")).toBe("The site did not answer. Try again.");
    expect(says("network", "Failed to fetch")).toBe("The site did not answer. Try again.");
    expect(says("not_admin", "", "acme/engine")).toBe(NOT_ADMIN("acme/engine"));
    expect(says("not_a_repository_escrow", "", "mona/unrelated")).toBe("No agent shares fees with mona/unrelated, so there is nothing to claim for it.");
    expect(says("nothing_to_claim")).toBe("Nothing is waiting right now. Someone else with admin may have just claimed it.");
    expect(says("claims_paused")).toBe("Claims are paused right now. What is waiting stays where it is. Try again later.");
    expect(says("attest_rate")).toBe("A claim for this repository was started a moment ago. Try again in a few seconds.");
    expect(says("bad_signature")).toBe("The wallet's signature could not be checked. Try again.");
    expect(says("stale_statement")).toBe("The wallet's signature could not be checked. Try again.");
    expect(says("no_sign_message")).toBe("This wallet cannot sign a message. Connect one that can.");
    expect(says("no_attestor")).toBe("Claims cannot be confirmed right now. What is waiting stays where it is. Try again later.");
    expect(says("tx_failed")).toBe("The claim did not go through. Nothing was taken. Try again.");
    expect(says("bad_gist_url")).toBe("That is not a gist address. It looks like https://gist.github.com/you/0123abcd.");
    expect(says("proof_invalid")).toContain("GitHub has no public gist at that address holding the text.");
    expect(says("bad_login")).toBe("Type your GitHub username.");
    expect(says("bad_repository")).toBe("Type a repository as owner/name.");
    expect(says("wrong_wallet")).toBe("The connected wallet changed while this was running. Try again.");
    expect(says("something_new")).toBe("That did not work. Try again.");
    expect(says(null)).toBe("That did not work. Try again.");
  });

  test("a refusal in the wallet is recognised from what the wallet said", () => {
    for (const m of ["User rejected the request.", "Transaction cancelled", "User denied message signature", "declined"]) expect(says(null, m)).toBe("You declined in the wallet. Nothing was sent.");
    expect(says("wallet_declined")).toBe("You declined in the wallet. Nothing was sent.");
  });

  test("a sign-in that ran out sends the visitor back to the sign-in, and nothing else does", () => {
    for (const c of ["no_session", "bad_session", "session_expired"]) expect(claimError(c)).toEqual({ text: "Your sign-in has run out. Sign in with GitHub again.", again: true });
    for (const c of ["github_unreachable", "not_admin", "tx_failed", "nothing_to_claim", "x"]) expect(claimError(c).again).toBe(false);
  });

  test("a sign-in that came back without one says why", () => {
    expect(signinError("access_denied")).toBe("You cancelled the GitHub sign-in. Nothing was shared.");
    expect(signinError("bad_state")).toBe("That sign-in had run out before it finished. Sign in again.");
    expect(signinError("bad_callback")).toBe("That sign-in had run out before it finished. Sign in again.");
    expect(signinError("github_unreachable")).toBe("GitHub did not answer. Try again.");
    expect(signinError("oauth_refused")).toBe("GitHub did not complete the sign-in. Try again.");
    expect(signinError("anything")).toBe("The sign-in did not finish. Try again.");
  });

  test("no sentence uses the builders' words, an em dash, or a figure", () => {
    const codes = ["github_unreachable", "core_unreachable", "no_session", "not_admin", "not_a_repository_escrow", "nothing_to_claim", "claims_paused", "attest_rate", "bad_signature", "no_sign_message", "no_attestor", "tx_failed", "bad_gist_url", "proof_invalid", "bad_login", "bad_repository", "no_wallet_connected", "wrong_wallet", "?"];
    const all = [...codes.map((c) => says(c, "", "a/b")), ...["access_denied", "bad_state", "github_unreachable", "oauth_refused", "?"].map(signinError),
      ...[facts(), facts({ sess: mona([]) }), facts({ sess: mona([ENGINE]), connected: WALLET, recs: new Map([[ENGINE.id, rec("5")]]) }), facts({ off: "unreachable" }), facts({ off: "feature_off" })].flatMap((f) => { const v = claimCard(f, usd); return [v.lead, v.note ?? ""]; }),
      ...claimPhases(2).flatMap((p) => [p.label, p.hint])].join(" ");
    expect(all).not.toMatch(/escrow|\bCore\b|attest|on chain|\bbind|\bbound\b|\broute[sd]?\b|—/i);
  });
});

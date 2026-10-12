// The launch wizard's Identity step (owner direction 2026-10-11): two choices, A units account (the
// default, label in bold) and Your own token; no App identity, no "Price TBA".
import { describe, expect, test } from "bun:test";

// the wallet bundle keeps its session on window; a bare object is enough to render markup here
(globalThis as any).window ??= globalThis;
(globalThis as any).addEventListener ??= () => {};
(globalThis as any).dispatchEvent ??= () => true;
const { custodyHtml, hasIdentityService, launchTrackRows } = await import("../wallet/identity.ts");
const { launchSkeleton } = await import("../wallet/pages.ts");

describe("Identity step", () => {
  const h = launchSkeleton().s;
  const radios = [...h.matchAll(/<input type="radio" name="l_identity" value="([a-z]+)"( checked)?>/g)];
  test("renders the two options, the GitHub account first and checked; it says the agent gets access to an account for a fee, never that we operate it", () => {
    expect(radios.map((r) => r[1])).toEqual(["purchased", "token"]);
    expect(radios[0]![2]).toBe(" checked");
    expect(h).toContain("<b>A GitHub account for the agent.</b> Your agent gets access to a GitHub account, set up after launch with a signing key so its commits show Verified. Fee: ");
    expect(h).not.toMatch(/we operate|not offered here/);
    // the option is one element the page hides where the deployment gives no account
    expect(h).toContain('<label class="radio" id="w-id-paid">');
    expect(h).toContain('id="w-id-price"');
    expect(h).toContain("<b>Your own token.</b>");
  });
  test("no App identity, no lineage-app[bot], no Price TBA, no em dash", () => {
    for (const x of ["App identity", "lineage-app[bot]", "Price TBA", "devnet charges nothing", "Purchased account", String.fromCharCode(0x2014)]) expect(h.includes(x)).toBe(false);
    expect(custodyHtml("purchased").s.includes("TBA")).toBe(false);
  });
  test("Funding: credits in USD, no Pay with selector, no trading allocation, no launch parameters table", () => {
    expect(h).toContain('name="l_deposit"');
    expect(h).toContain("Credits (USD)");
    for (const x of ["Pay with", "l_deposit_pay", "l_alloc", "Launch parameters (on chain)", 'id="w-fees"']) expect(h.includes(x)).toBe(false);
  });
});

describe("an instance without the identity service (the mainnet instance: /identity/* answers 502 there)", () => {
  test("it is the instance whose Core names no units account recipient; an unread config counts as none", () => {
    expect(hasIdentityService({ identity_account_recipient: "GZszrPVqDzXc1Cn7RkZCEXMGWKZ5eCqnh7Tk3sTz9JDf" })).toBe(true);
    expect(hasIdentityService({ identity_account_recipient: null })).toBe(false);
    expect(hasIdentityService({})).toBe(false);
    expect(hasIdentityService(null)).toBe(false);
  });
  test("the After the launch list has no GitHub account row there, so nothing asks /identity/*", () => {
    expect(launchTrackRows({ identityService: false, hosted: true, banner: false })).toEqual(["confirmed", "vault", "runtime", "session", "verdict"]);
    expect(launchTrackRows({ identityService: true, hosted: true, banner: true })).toEqual(["confirmed", "vault", "github", "runtime", "images", "session", "verdict"]);
  });
  test("the page asks the identity service only behind that switch", async () => {
    const src = await Bun.file(new URL("../wallet/main.ts", import.meta.url)).text();
    // every read of /identity/agents and every showIdentity or submitLaunchToken call in the launch and profile code is guarded
    const lines = src.split("\n").filter((l) => /fetch\(`\/identity\/|showIdentity\("|await submitLaunchToken\(/.test(l));
    expect(lines.length).toBe(5);
    for (const l of lines) expect(l).toMatch(/hasIdentityService\(P\.cfg\)|idService|track\.has\("github"\)/);
  });
});

describe("Runtime choice (owner 2026-10-12: each line says what it means for the launcher)", () => {
  const h = launchSkeleton().s;
  test("Hosted is the default and both lines state the consequence in one sentence", () => {
    expect(h).toMatch(/<input type="radio" name="l_hosted" value="hosted" checked>/);
    expect(h).toContain("<b>Hosted.</b> We run the agent for you around the clock on its own live desktop, and its work is paid from its compute vault, which its coin's fees refill.");
    expect(h).toContain("<b>Self-hosted.</b> You run the agent's worker on your own machine with its key and pay your own model costs; nothing runs for it here.");
  });
});

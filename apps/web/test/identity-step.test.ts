// The launch wizard's Identity step (owner direction 2026-10-11): two choices, A units account (the
// default, label in bold) and Your own token; no App identity, no "Price TBA".
import { describe, expect, test } from "bun:test";

// the wallet bundle keeps its session on window; a bare object is enough to render markup here
(globalThis as any).window ??= globalThis;
(globalThis as any).addEventListener ??= () => {};
(globalThis as any).dispatchEvent ??= () => true;
const { custodyHtml } = await import("../wallet/identity.ts");
const { launchSkeleton } = await import("../wallet/pages.ts");

describe("Identity step", () => {
  const h = launchSkeleton().s;
  const radios = [...h.matchAll(/<input type="radio" name="l_identity" value="([a-z]+)"( checked)?>/g)];
  test("renders the two options, A units account first and checked", () => {
    expect(radios.map((r) => r[1])).toEqual(["purchased", "token"]);
    expect(radios[0]![2]).toBe(" checked");
    expect(h).toContain("<b>A units account</b>: a GitHub account we operate, set up automatically after launch: cleaned, named and described from the soul, with a signing key so its commits show Verified, and a member of the units-agents organization.");
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

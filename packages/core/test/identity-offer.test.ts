// "A units account" is hidden from launchers while the identity service has no free account (identity-offer.ts).
import { describe, expect, test } from "bun:test";
import { IdentityOffer, parsePool, STALE_MS } from "../src/identity-offer.ts";

const RECIPIENT = "6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3";
const net = () => ({ mode: "mainnet", prepay: { min_usd: "5", identity_account_price_lamports: "50000000", identity_account_recipient: RECIPIENT } });
const pool = (available: number, offer = available > 0) => ({ available, assigning: 0, assigned: 0, unusable: 0, total: available, waiting_paid: 0, low_water: 5, low: available <= 5, offer });

describe("units account offer", () => {
  test("no identity service watched: the config is served as configured", () => {
    const o = new IdentityOffer();
    const n = net();
    expect(o.unavailable()).toBeNull();
    expect(o.view(n)).toBe(n);
  });

  test("free accounts: offered; none on offer: recipient hidden with the reason; the config object is never changed", () => {
    let t = 1_000_000;
    const o = new IdentityOffer(() => t);
    o.url = "http://127.0.0.1:9765";
    const n = net();
    // never answered yet: not offered
    expect(o.view(n).prepay).toEqual({ ...n.prepay, identity_account_recipient: null, identity_account_unavailable: "the units account service is not answering right now" });
    o.record(parsePool(pool(3))!);
    expect(o.view(n)).toBe(n);
    o.record(parsePool(pool(0))!);
    expect(o.view(n).prepay).toEqual({ ...n.prepay, identity_account_recipient: null, identity_account_unavailable: "no units account is free right now" });
    // accounts are there but all owed to launches that already paid
    o.record(parsePool(pool(2, false))!);
    expect(o.unavailable()).toBe("no units account is free right now");
    expect(n.prepay.identity_account_recipient).toBe(RECIPIENT);
    // a stale reading stops the offer
    o.record(parsePool(pool(9))!);
    expect(o.unavailable()).toBeNull();
    t += STALE_MS + 1;
    expect(o.unavailable()).toBe("the units account service is not answering right now");
  });

  test("a config without a recipient stays as it is (the option was never offered)", () => {
    const o = new IdentityOffer();
    o.url = "http://127.0.0.1:9765";
    const n = { prepay: { identity_account_recipient: null } };
    expect(o.view(n)).toBe(n);
  });

  test("sample reads GET /identity/pool; a failure keeps the last reading until it is stale", async () => {
    let t = 5_000_000;
    const o = new IdentityOffer(() => t);
    o.url = "http://identity.test/";
    const asked: string[] = [];
    let body: unknown = pool(4);
    const f = (async (u: string) => (asked.push(u), body === null ? new Response("down", { status: 502 }) : new Response(JSON.stringify(body)))) as unknown as typeof fetch;
    expect(await o.sample(f)).toEqual({ ok: true });
    expect(asked).toEqual(["http://identity.test/identity/pool"]);
    expect(o.unavailable()).toBeNull();
    body = null;
    expect(await o.sample(f)).toEqual({ ok: false, error: "answered 502" });
    expect(o.unavailable()).toBeNull();
    t += STALE_MS + 1;
    expect(o.unavailable()).not.toBeNull();
    body = { nonsense: true };
    expect((await o.sample(f)).ok).toBe(false);
    expect(parsePool({ available: 1 })).toBeNull();
  });
});

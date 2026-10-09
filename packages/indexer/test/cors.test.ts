import { describe, expect, test } from "bun:test";
import { corsFor, marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";

// LINEAGE_CORS_ORIGINS (embed kit): unset keeps `*`; set, only listed origins get CORS headers.
describe("market API CORS", () => {
  const db = openDb(":memory:");
  const get = (api: (r: Request) => Promise<Response>, origin?: string) =>
    api(new Request("http://x/market/tokens", { headers: origin ? { origin } : {} }));

  test("unset: * for everyone", async () => {
    const r = await get(marketApi(db, () => ({ ok: true }), { corsOrigins: "" }), "https://a.example");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("set: listed origins echoed, wildcards, others get none", async () => {
    const api = marketApi(db, () => ({ ok: true }), { corsOrigins: "https://*.vercel.app, http://localhost:*" });
    expect((await get(api, "https://lineage-garage.vercel.app")).headers.get("access-control-allow-origin")).toBe("https://lineage-garage.vercel.app");
    expect((await get(api, "http://localhost:3000")).headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const no = await get(api, "https://evil.example");
    expect(no.status).toBe(200);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    expect(no.headers.get("vary")).toBe("Origin");
    expect((await get(api)).headers.get("access-control-allow-origin")).toBeNull();
    // a dot in the pattern is literal
    expect(corsFor("https://lineage-garageXvercel.app", "https://lineage-garage.vercel.app")["access-control-allow-origin"]).toBeUndefined();
  });
});

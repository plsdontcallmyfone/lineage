import { describe, expect, test } from "bun:test";
import { applyCors, corsOrigins } from "../src/http.ts";

// LINEAGE_CORS_ORIGINS (embed kit): unset keeps Core's `*`; set, only GET and HEAD answers to a listed
// origin carry CORS headers, so a browser on another origin can read the public API and call nothing else.
const res = () => new Response("{}", { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const req = (method: string, origin: string | null, pre?: string) =>
  new Request("http://core/v1/stats", { method, headers: { ...(origin ? { origin } : {}), ...(pre ? { "access-control-request-method": pre } : {}) } });

describe("Core CORS", () => {
  test("unset keeps *", () => {
    expect(corsOrigins("")).toBeNull();
    expect(applyCors(req("GET", "https://a.example"), res(), null).headers.get("access-control-allow-origin")).toBe("*");
  });
  test("configured origins: reads only, echoed, wildcards", () => {
    const allowed = corsOrigins("https://*.vercel.app,http://localhost:*,https://lineage.example");
    const acao = (r: Request) => applyCors(r, res(), allowed).headers.get("access-control-allow-origin");
    expect(acao(req("GET", "https://lineage-garage.vercel.app"))).toBe("https://lineage-garage.vercel.app");
    expect(acao(req("HEAD", "http://localhost:5173"))).toBe("http://localhost:5173");
    expect(acao(req("GET", "https://lineage.example"))).toBe("https://lineage.example");
    expect(acao(req("GET", "https://evil.example"))).toBeNull();
    expect(acao(req("GET", "https://lineageXexample"))).toBeNull();
    expect(acao(req("GET", null))).toBeNull();
    expect(acao(req("POST", "https://lineage.example"))).toBeNull();
    const pre = applyCors(req("OPTIONS", "https://lineage.example", "GET"), new Response(null, { status: 204 }), allowed);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://lineage.example");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(applyCors(req("OPTIONS", "https://lineage.example", "POST"), new Response(null, { status: 204 }), allowed).headers.get("access-control-allow-origin")).toBeNull();
  });
});

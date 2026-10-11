import { afterEach, describe, expect, test } from "bun:test";
import { unitJson, unitPath } from "../src/unit-alias.ts";
import { expectOk, setup, type Env } from "./helpers.ts";

// The protocol noun rename (docs/plans/REBRAND-UNITS.md 3.14): /v1/units answers like /v1/lineages,
// views gain unit_id next to lineage_id with the same value, and signed or hashed payloads are untouched.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe("unit names in the API", () => {
  test("paths map to the lineage routes", () => {
    expect(unitPath("/v1/units")).toBe("/v1/lineages");
    expect(unitPath("/v1/units/abc/tree")).toBe("/v1/lineages/abc/tree");
    expect(unitPath("/v1/admin/units/abc/status")).toBe("/v1/admin/lineages/abc/status");
    expect(unitPath("/v1/unitsx")).toBe("/v1/unitsx");
  });
  test("output gains unit_id and units; signed objects, hashed subtrees and verification routes do not", () => {
    const body = { lineage_id: "aa", lineages: 3, recipe: { lineage_id: "x" }, st: { v: 1, kind: "lineage-journal", lineage_id: "bb" }, s2: { sig: "s", lineage_id: "cc" } };
    const out = JSON.parse(unitJson("/v1/lineages/aa", body));
    expect(out.unit_id).toBe("aa");
    expect(out.units).toBe(3);
    expect(out.recipe.unit_id).toBeUndefined();
    expect(out.st.unit_id).toBeUndefined();
    expect(out.s2.unit_id).toBeUndefined();
    expect(body).not.toHaveProperty("unit_id"); // the handler's object is never changed
    expect(JSON.parse(unitJson("/v1/epochs/3", { lineage_id: "aa" }))).toEqual({ lineage_id: "aa" });
  });
  test("a real Core answers /v1/units, /v1/units/:id and ?unit= like the lineage names", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const a = await expectOk(e.anon.get("/v1/lineages"));
    const b = await expectOk(e.anon.get("/v1/units"));
    expect(b).toEqual(a);
    expect(b[0].unit_id).toBe(b[0].lineage_id);
    const one = await expectOk(e.anon.get(`/v1/units/${e.lineage}`));
    expect(one.lineage_id).toBe(e.lineage);
    expect(one.unit_id).toBe(e.lineage);
    const c1 = await expectOk(e.anon.get(`/v1/candidates?lineage=${e.lineage}`));
    const c2 = await expectOk(e.anon.get(`/v1/candidates?unit=${e.lineage}`));
    expect(c2).toEqual(c1);
  });
});

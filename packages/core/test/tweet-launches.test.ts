import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "../src/protocol.ts";
import { bare, expectOk } from "./helpers.ts";

// Launch from a tweet (docs/plans/TWEET-LAUNCH.md 4): the launch page hands in the launch a link led
// to. Only an existing launch can be named; an id is used once; a launch answers one id.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const REF_A = "AAAAAAAAAAAAAAAAAAAAAA";
const REF_B = "BBBBBBBBBBBBBBBB_-BBBB";

async function launch(e: ReturnType<typeof bare>, repo: string) {
  const agent = generateAgentKey().id;
  const mint = generateAgentKey().id;
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent, mint, launcher: generateAgentKey().id, target_repo: repo, hosted: true, identity_mode: "app" }));
  return { agent, mint };
}

describe("tweet launches", () => {
  test("a launch Core knows is handed in once per link; the link's launch is read back with its repository", async () => {
    const e = bare();
    env = e;
    const a = await launch(e, "https://github.com/keis/base58");
    expect((await e.anon.get(`/v1/tweet-launches/${REF_A}`)).status).toBe(404);
    const r = await expectOk<any>(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...a }));
    expect(r).toMatchObject({ ref: REF_A, agent: a.agent, mint: a.mint, repo: "https://github.com/keis/base58" });
    expect(typeof r.launched_at).toBe("number");
    // the page may ask again: same answer, no second row
    expect(await expectOk<any>(e.anon.post("/v1/tweet-launches", { ref: REF_A, ...a }))).toEqual(r);
    expect(await expectOk<any>(e.anon.get(`/v1/tweet-launches/${REF_A}`))).toEqual(r);
    // the id is single-use, and a launch answers one id
    const b = await launch(e, "https://github.com/keis/base58");
    const used = await e.anon.post("/v1/tweet-launches", { ref: REF_A, ...b });
    expect([used.status, used.body.error]).toEqual([409, "ref_used"]);
    const twice = await e.anon.post("/v1/tweet-launches", { ref: REF_B, ...a });
    expect([twice.status, twice.body.error]).toEqual([409, "launch_used"]);
    await expectOk(e.anon.post("/v1/tweet-launches", { ref: REF_B, ...b }));
  });

  test("a launch Core has not read, a wrong coin and malformed bodies are refused and store nothing", async () => {
    const e = bare();
    env = e;
    const a = await launch(e, "https://github.com/keis/base58");
    const unknown = await e.anon.post("/v1/tweet-launches", { ref: REF_A, agent: generateAgentKey().id, mint: generateAgentKey().id });
    expect([unknown.status, unknown.body.error]).toEqual([404, "launch_unknown"]);
    const wrongMint = await e.anon.post("/v1/tweet-launches", { ref: REF_A, agent: a.agent, mint: generateAgentKey().id });
    expect([wrongMint.status, wrongMint.body.error]).toEqual([404, "launch_unknown"]);
    for (const body of [{ ref: "short", ...a }, { ref: REF_A + "A", ...a }, { ref: REF_A, agent: "x", mint: a.mint }, { ref: REF_A }, [], "x"]) {
      expect((await e.anon.post("/v1/tweet-launches", body)).status).toBe(400);
    }
    expect((await e.anon.get("/v1/tweet-launches/nope")).status).toBe(400);
    expect((await e.anon.get(`/v1/tweet-launches/${REF_A}`)).status).toBe(404);
  });
});

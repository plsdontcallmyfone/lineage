import { afterEach, describe, expect, test } from "bun:test";
import { budgetOf } from "../src/conversation-limits.ts";
import { conversationsOf } from "../src/conversations.ts";
import { formatTalk } from "@units/protocol";
import { enable, FREE, momentsOf, post, say, withSoul } from "./conv-scene.ts";
import { expectOk, makeAuthor, setup, type Env } from "./helpers.ts";

// The limits of agent conversations (docs/plans/AGENT-CONVERSATIONS.md 4): rates per agent and per
// repository, the minimum gap, relevance, and no ping-pong (thread depth, thread cool-down, per pair).

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});
const MIN = 60_000;

describe("conversation limits", () => {
  test("off: Core stores no conversation message; a plain note still passes", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    const r = await say(e, a, [b], "Ilse, hello.");
    expect([r.status, r.body.error]).toEqual([403, "conversations_off"]);
    enable(e);
    await expectOk(say(e, a, [b], "Ilse, hello."));
    conversationsOf(e.core).setConfig({ enabled: false });
    expect((await say(e, b, [a], "Wren, hello.")).body.error).toBe("conversations_off");
    expect((await momentsOf(e, b)).length).toBe(0);
  });

  test("per agent: the gap, the hour and the day; the budget says why and when", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    enable(e, { pair_per_day: 500 }); // defaults: 2 an hour, 6 a day, 900 s apart
    await expectOk(say(e, a, [b], "Ilse, one."));
    let r = await say(e, a, [b], "Ilse, too soon.");
    expect([r.status, r.body.error]).toEqual([429, "talk_rate"]);
    expect(r.body.message).toContain("900 s between two messages");
    let bud = (await expectOk<any>(e.anon.get(`/v1/agents/${a.id}/conversation`))).budget;
    expect(bud).toMatchObject({ ok: false, agent: { hour: 1, day: 1 } });
    expect(bud.next_at - e.clock.now()).toBe(900_000);
    e.clock.advance(16 * MIN);
    await expectOk(say(e, a, [b], "Ilse, two."));
    e.clock.advance(16 * MIN);
    r = await say(e, a, [b], "Ilse, three in one hour.");
    expect(r.body.message).toContain("2 messages an hour per agent");
    // the day: 6, however they are spread
    for (let i = 0; i < 4; i++) {
      e.clock.advance(61 * MIN);
      await expectOk(say(e, a, [b], `Ilse, message ${["three", "four", "five", "six"][i]}.`));
    }
    e.clock.advance(61 * MIN);
    r = await say(e, a, [b], "Ilse, seven.");
    expect([r.status, r.body.message]).toEqual([429, "conversation limit: 6 messages a day per agent"]);
    expect(budgetOf(conversationsOf(e.core), a.id)).toMatchObject({ ok: false, why: "6 messages a day per agent", agent: { day: 6 } });
    e.clock.advance(20 * 60 * MIN);
    expect(budgetOf(conversationsOf(e.core), a.id).ok).toBe(true);
  });

  test("per repository: all agents of one repository share an hourly and a daily count", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    const c = await withSoul(e, "Odo Brack");
    enable(e, { ...FREE, per_repo_hour: 2 });
    await expectOk(say(e, a, [b], "Ilse, one."));
    await expectOk(say(e, b, [c], "Odo, two."));
    const r = await say(e, c, [a], "Wren, three.");
    expect([r.status, r.body.message]).toEqual([429, "conversation limit: 2 messages an hour per repository"]);
    e.clock.advance(61 * MIN);
    await expectOk(say(e, c, [a], "Wren, three."));
  });

  test("relevance: only an agent on the same repository or unit, or one that addressed the sender; never oneself, never a stranger", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    const far = await makeAuthor(e, { repo: "https://github.com/example/elsewhere" });
    const verifier = e.reference!;
    enable(e, FREE);
    expect((await say(e, a, [far], "Hello over there.")).body.error).toBe("not_relevant");
    expect((await say(e, a, [verifier], "Hello verifier.")).body.error).toBe("bad_address");
    expect((await say(e, a, [a], "Hello me.")).body.error).toBe("bad_address");
    expect((await say(e, a, [b, far], "Hello both.")).body.error).toBe("not_relevant");
    conversationsOf(e.core).setConfig({ max_mentions: 1 });
    expect((await say(e, a, [b, far], "Hello both.")).body.error).toBe("bad_address");
    // the stranger addresses a first (it may not either), so nothing opens the door from outside
    expect((await say(e, far, [a], "Wren, hello.")).body.error).toBe("not_relevant");
    // a swarm speaks seat to seat
    await expectOk(post(e, a, formatTalk({ seat: 1, to: [{ agent: a.id, seat: 2 }], text: "Seat two takes ns." })));
    expect((await post(e, a, formatTalk({ seat: 2, to: [{ agent: a.id, seat: 2 }], text: "Seat two to itself." }))).body.error).toBe("bad_address");
  });

  test("no ping-pong: a thread holds reply_depth messages, cools down per agent, and a pair has a daily count", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    enable(e, { ...FREE, reply_depth: 3, thread_cooldown_s: 600, pair_per_day: 3 });
    const m1 = (await expectOk<any>(say(e, a, [b], "Ilse, one."))).msg_id;
    e.clock.advance(1000);
    expect((await momentsOf(e, b)).map((m) => m.kind)).toContain("reply");
    const m2 = (await expectOk<any>(say(e, b, [a], "Wren, two.", { thread: m1 }))).msg_id;
    // a answers at once in the same thread: cooling down, and Core offers it no reply moment yet
    let r = await say(e, a, [b], "Ilse, three.", { thread: m2 });
    expect([r.status, r.body.error]).toEqual([409, "thread_limit"]);
    expect((await momentsOf(e, a)).some((m) => m.kind === "reply")).toBe(false);
    e.clock.advance(11 * MIN);
    expect((await momentsOf(e, a)).some((m) => m.kind === "reply")).toBe(true);
    const m3 = (await expectOk<any>(say(e, a, [b], "Ilse, three.", { thread: m2 }))).msg_id;
    // the thread is full at three: b is offered no reply, and one is refused
    e.clock.advance(11 * MIN);
    expect((await momentsOf(e, b)).some((m) => m.kind === "reply")).toBe(false);
    r = await say(e, b, [a], "Wren, four.", { thread: m3 });
    expect(r.body.message).toBe("a thread holds at most 3 messages");
    // a has addressed b twice; the pair count stops the fourth
    await expectOk(say(e, a, [b], "Ilse, a new thread."));
    r = await say(e, a, [b], "Ilse, again.");
    expect([r.status, r.body.error]).toEqual([429, "talk_pair"]);
  });
});

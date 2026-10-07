import { expect, test } from "bun:test";
import { setup, makeAuthor, submit, runReplays, honest, candidate, diff, reconcileOk } from "./helpers.ts";

test("smoke: accepted generation", async () => {
  const env = await setup();
  try {
    const author = await makeAuthor(env);
    const c = await submit(env, author, diff("a"));
    expect(c.status).toBe("replaying");
    await runReplays(env, c.candidate_id, honest());
    const v = await candidate(env, c.candidate_id);
    expect(v.status).toBe("accepted");
    await reconcileOk(env);
  } finally {
    env.close();
  }
});

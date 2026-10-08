import { afterEach, describe, expect, test } from "bun:test";
import { CHALLENGE_KIND, registryPdas, type Ix } from "@lineage/chain";
import { challengeId, challengesOf, slashIdOf } from "../src/challenges.ts";
import { slashId } from "../src/chain.ts";
import { replicate } from "../src/replica.ts";
import { generateAgentKey as agentClientKey } from "../src/protocol.ts";
import {
  agent,
  agentClient,
  candidate,
  commitReplay,
  diff,
  expectOk,
  fund,
  makeAuthor,
  makeVerifier,
  reconcileOk,
  result,
  runReplays,
  setup,
  submit,
  type Agent,
  type Env,
} from "./helpers.ts";

// Bonded challenges (SPEC 10.8) in simulated mode, and the read-only replica (src/replica.ts) run
// against the same Core over HTTP: it must find zero divergence on an honest history, and find the
// tampering when a stored verdict or epoch root is altered behind the API.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const BOND = 1_000_000_000n; // challenge_bond default: one token at 9 decimals
const REWARD = 500_000_000n;
const honest = () => result({}, 1000); // no improvement: the deterministic metric equals the base
const liar = () => result({}, 900); // claims a 10% gain it did not measure

async function challenger(e: Env, tokens = 3n * BOND): Promise<Agent> {
  const c = await makeVerifier(e, { bond: 0n, qualify: false });
  await fund(e, c.id, tokens);
  return c;
}

/** Two colluding verifiers accept a no-op patch; honest verifiers join only afterwards. */
async function capturedCandidate(over: Record<string, unknown> = {}) {
  const e = (env = await setup({ verifiers: 2, over: { max_open_replays: 4, ...over } }));
  const liars = [...e.verifiers];
  const author = await makeAuthor(e);
  const c = await submit(e, author, diff("noop"));
  await runReplays(e, c.candidate_id, () => liar());
  const v = await candidate(e, c.candidate_id);
  expect(v.status).toBe("accepted");
  expect(v.replays.map((r: any) => r.replayer).sort()).toEqual(liars.map((l) => l.id).sort());
  const honestOnes = [await makeVerifier(e), await makeVerifier(e)];
  e.verifiers.push(...honestOnes);
  return { e, liars, honestOnes, author, c, v };
}

describe("verdict challenges", () => {
  test("upheld: fresh replays outvote two colluding replayers; the generation is reverted, the liars slashed, the challenger repaid with a reward", async () => {
    const { e, liars, author, c, v } = await capturedCandidate();
    // the epoch closes with the liars' replay units and the author's units in it
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    expect(closed.payouts.length).toBeGreaterThan(0);
    const ch = await challenger(e);
    const bonds = await Promise.all(liars.map(async (l) => BigInt((await agent(e, l.id)).bond)));
    const reserve0 = BigInt((await expectOk(e.anon.get("/v1/stats"))).balances.reserve);
    const opened = await expectOk(ch.c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id, claim: { says: "no gain on a fresh run" } }));
    expect(opened.status).toBe("replaying");
    expect(opened.epoch).toBe(closed.n);
    expect(BigInt((await agent(e, ch.id)).wallet)).toBe(2n * BOND);
    // the challenged epoch's payouts are held while it is open
    const proof = (await expectOk(e.anon.get(`/v1/epochs/${closed.n}/proofs/${liars[0]!.id}`)))[0];
    const held = await liars[0]!.c.post(`/v1/epochs/${closed.n}/claim`, { dest: proof.dest, amount: proof.amount, proof: proof.proof });
    expect([held.status, held.body.error]).toEqual([409, "claim_held"]);
    // a second challenge of the same verdict is refused
    const again = await (await challenger(e)).c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id });
    expect([again.status, again.body.error]).toEqual([409, "already_challenged"]);

    // fresh replayers exclude every party: author, original replayers, challenger
    const fresh = (await candidate(e, c.candidate_id)).replays.filter((r: any) => r.audit_id === opened.challenge_id);
    expect(fresh.map((r: any) => r.kind).sort()).toEqual(["challenge", "challenge_reference"]);
    for (const r of fresh) expect([author.id, ch.id, ...liars.map((l) => l.id)]).not.toContain(r.replayer);
    // the replayers keep lying; the fresh ones measure honestly
    await runReplays(e, c.candidate_id, (a) => (liars.some((l) => l.id === a.id) ? liar() : honest()));
    const res = await expectOk(e.anon.get(`/v1/challenges/${opened.challenge_id}`));
    expect(res.status).toBe("upheld");
    expect(res.resolution.effect).toBe("reverted");
    expect(res.resolution.combined.minority.sort()).toEqual(v.replays.map((r: any) => r.replay_id).sort());
    expect(res.reward).toBe(REWARD.toString());
    // bond back plus the reward
    expect(BigInt((await agent(e, ch.id)).wallet)).toBe(3n * BOND + REWARD);
    for (let i = 0; i < liars.length; i++) {
      const o = await agent(e, liars[i]!.id);
      expect(BigInt(o.bond)).toBe(bonds[i]! - (bonds[i]! * BigInt(e.cfg.minority_slash_bps)) / 10_000n);
    }
    const gen = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    expect(gen.reverted_by).toBeTruthy();
    // the held epoch was corrected before any claim: the liars and the author are no longer paid in it
    const ep = await expectOk(e.anon.get(`/v1/epochs/${closed.n}`));
    expect(ep.root).not.toBe(closed.root);
    expect(ep.payouts.some((p: any) => p.agent === author.id || liars.some((l) => l.id === p.agent))).toBe(false);
    expect(res.resolution.corrected.root).toBe(ep.root);
    const reserve1 = BigInt((await expectOk(e.anon.get("/v1/stats"))).balances.reserve);
    expect(reserve1).toBeGreaterThan(reserve0 - REWARD); // slashes and returned rebates offset part of the reward
    await reconcileOk(e);
    // a read-only replica recomputes every verdict, the challenge judgement, the unit awards and the corrected epoch
    const rep = await replicate(e.base);
    expect(rep.divergences).toEqual([]);
    expect(rep.challenges.checked).toBe(1);
    expect(rep.epochs.checked).toBe(1);
  });

  test("failed: the fresh replays confirm an honest verdict; the bond goes to the reserve", async () => {
    const e = (env = await setup({ verifiers: 4, over: { max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("real"));
    await runReplays(e, c.candidate_id, () => result());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    const ch = await challenger(e);
    const reserve0 = BigInt((await expectOk(e.anon.get("/v1/stats"))).balances.reserve);
    const opened = await expectOk(ch.c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id }));
    await runReplays(e, c.candidate_id, () => result());
    const res = await expectOk(e.anon.get(`/v1/challenges/${opened.challenge_id}`));
    expect(res.status).toBe("failed");
    expect(BigInt((await agent(e, ch.id)).wallet)).toBe(2n * BOND);
    expect(BigInt((await expectOk(e.anon.get("/v1/stats"))).balances.reserve)).toBe(reserve0 + BOND);
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    // the fresh replayers were paid for their work
    for (const r of (await candidate(e, c.candidate_id)).replays.filter((x: any) => x.audit_id === opened.challenge_id && x.kind === "challenge"))
      expect((await agent(e, r.replayer)).units_epoch).toBeGreaterThan(0);
    await reconcileOk(e);
    await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    expect((await replicate(e.base)).divergences).toEqual([]);
  });

  test("void when no independent verifier is eligible before the deadline; window, registration and finality rules", async () => {
    const e = (env = await setup({ verifiers: 2, over: { max_open_replays: 4, challenge_resolve_timeout_s: 600 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("lonely"));
    await runReplays(e, c.candidate_id, () => result());
    const ch = await challenger(e);
    // only registered agents
    const stranger = agentClient(e);
    const s = await stranger.c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id });
    expect(s.status).toBe(403);
    const bad = await ch.c.post("/v1/challenges", { kind: "verdict", subject: "ab".repeat(32) });
    expect([bad.status, bad.body.error]).toEqual([409, "not_final"]);
    const opened = await expectOk(ch.c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id }));
    // every eligible verifier replayed it: nobody independent can be drawn
    expect(opened.status).toBe("open");
    e.clock.advance(601_000);
    e.core.tick();
    const res = await expectOk(e.anon.get(`/v1/challenges/${opened.challenge_id}`));
    expect(res.status).toBe("void");
    expect(BigInt((await agent(e, ch.id)).wallet)).toBe(3n * BOND);
    // too late now (challenge_window_s 3600 after the verdict)
    const c2 = await submit(e, author, diff("late", "src/z.rs"));
    await runReplays(e, c2.candidate_id, () => result());
    e.clock.advance(3_601_000);
    const late = await ch.c.post("/v1/challenges", { kind: "verdict", subject: c2.candidate_id });
    expect([late.status, late.body.error]).toEqual([409, "challenge_window"]);
    // no bond, no challenge
    const poor = await makeVerifier(e, { bond: 0n, qualify: false });
    const closedNow = await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    const p = await poor.c.post("/v1/challenges", { kind: "epoch", subject: String(closedNow.n) });
    expect(p.status).toBe(402);
    await reconcileOk(e);
  });
});

describe("slash challenges", () => {
  test("a justified minority slash stands (failed); a slash Core got wrong is reversed with its strike (upheld)", async () => {
    const { e, liars, c } = await capturedCandidate();
    const ch = await challenger(e);
    const first = await expectOk(ch.c.post("/v1/challenges", { kind: "verdict", subject: c.candidate_id }));
    await runReplays(e, c.candidate_id, (a) => (liars.some((l) => l.id === a.id) ? liar() : honest()));
    expect((await expectOk(e.anon.get(`/v1/challenges/${first.challenge_id}`))).status).toBe("upheld");
    // a third honest verifier, so the slash challenge can draw someone independent
    e.verifiers.push(await makeVerifier(e));
    const slash = e.core.db.query<any, [string]>("SELECT * FROM slashes WHERE agent_id = ? AND reason = 'challenge_minority'").get(liars[0]!.id)!;
    expect(slashIdOf(slash)).toBe(slashId(slash));
    const bond0 = BigInt((await agent(e, liars[0]!.id)).bond);
    const ch2 = await challenger(e);
    const s1 = await expectOk(ch2.c.post("/v1/challenges", { kind: "slash", subject: slashIdOf(slash) }));
    expect(s1.status).toBe("replaying");
    await runReplays(e, c.candidate_id, (a) => (liars.some((l) => l.id === a.id) ? liar() : honest()));
    const r1 = await expectOk(e.anon.get(`/v1/challenges/${s1.challenge_id}`));
    expect(r1.status).toBe("failed");
    expect(BigInt((await agent(e, liars[0]!.id)).bond)).toBe(bond0);

    // Core bug stand-in: an honest counted replay of another candidate slashed as "minority"
    const author2 = await makeAuthor(e);
    const good = await submit(e, author2, diff("good2", "src/q.rs"));
    await runReplays(e, good.candidate_id, () => honest());
    const gv = await candidate(e, good.candidate_id);
    const victimReplay = gv.replays.find((r: any) => r.role === "counted" && r.kind === "replay");
    const victim = victimReplay.replayer;
    const vb0 = BigInt((await agent(e, victim)).bond);
    const amount = (vb0 * 500n) / 10_000n;
    e.core.tx(() => {
      e.core.ledger.transfer(`agent:${victim}:bond`, "reserve", amount, "slash:minority", victimReplay.replay_id);
      e.core.db.query("INSERT INTO slashes (agent_id, bps, amount, reason, ref, epoch, at) VALUES (?, 500, ?, 'minority', ?, ?, ?)")
        .run(victim, amount.toString(), victimReplay.replay_id, e.core.currentEpoch().n, e.core.now());
      e.core.db.query("INSERT INTO strikes (agent_id, epoch, reason, ref, at) VALUES (?, ?, 'minority', ?, ?)").run(victim, e.core.currentEpoch().n, victimReplay.replay_id, e.core.now());
    });
    const wrong = e.core.db.query<any, [string]>("SELECT * FROM slashes WHERE ref = ?").get(victimReplay.replay_id)!;
    e.verifiers.push(await makeVerifier(e));
    const ch3 = await challenger(e);
    const s2 = await expectOk(ch3.c.post("/v1/challenges", { kind: "slash", subject: `#${wrong.id}` }));
    await runReplays(e, good.candidate_id, () => honest());
    const r2 = await expectOk(e.anon.get(`/v1/challenges/${s2.challenge_id}`));
    expect(r2.status).toBe("upheld");
    expect(r2.resolution.reversed).toBe(amount.toString());
    expect(BigInt((await agent(e, victim)).bond)).toBe(vb0);
    expect((await agent(e, victim)).strikes_epoch).toBe(0);
    // reversed once: the same slash cannot be challenged again
    const again = await (await challenger(e)).c.post("/v1/challenges", { kind: "slash", subject: slashIdOf(wrong) });
    expect([again.status, again.body.error]).toEqual([409, "already_challenged"]);
    await reconcileOk(e);
  });

  test("a reveal-mismatch slash is re-checked without replays", async () => {
    const e = (env = await setup({ verifiers: 3, over: { max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("mm"));
    // one replayer reveals something it did not commit to
    const pending: Awaited<ReturnType<typeof commitReplay>>[] = [];
    for (const a of e.verifiers) {
      const asg = (await expectOk<any[]>(a.c.get("/v1/assignments", true))).find((x) => x.candidate?.candidate_id === c.candidate_id && x.status === "assigned");
      if (asg) pending.push(await commitReplay(a, asg, result()));
    }
    expect(pending.length).toBe(2);
    const cheat = pending[0]!;
    await cheat.a.c.post(`/v1/replays/${cheat.asg.replay_id}/reveal`, { result: { ...cheat.result, metrics: { ir: { base: [1000], cand: [800], deterministic: true } } },
      salt: cheat.salt });
    const mm = e.core.db.query<any, []>("SELECT * FROM slashes WHERE reason = 'reveal_mismatch'").get();
    expect(mm.agent_id).toBe(cheat.a.id);
    const ch = await challenger(e);
    const r = await expectOk(ch.c.post("/v1/challenges", { kind: "slash", subject: slashIdOf(mm) }));
    expect(r.status).toBe("failed");
    expect(r.resolution.recomputed).toBe("mismatch");
    await reconcileOk(e);
  });
});

describe("epoch challenges and the replica", () => {
  test("an honest epoch root stands; a root altered behind the API is corrected by an upheld challenge; the replica sees both", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("ep"));
    await runReplays(e, c.candidate_id, () => result());
    const e0 = await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    const ch = await challenger(e);
    const r0 = await expectOk(ch.c.post("/v1/challenges", { kind: "epoch", subject: String(e0.n) }));
    expect(r0.status).toBe("failed");
    expect(r0.resolution.mismatch).toEqual([]);
    expect((await replicate(e.base)).divergences).toEqual([]);

    // the next epoch's root is altered in Core's database (a Core bug or a compromised operator)
    const c2 = await submit(e, author, diff("ep2", "src/w.rs"));
    await runReplays(e, c2.candidate_id, () => result());
    const e1 = await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    e.core.db.query("UPDATE epochs SET root = ? WHERE n = ?").run("ee".repeat(32), e1.n);
    const tampered = await replicate(e.base);
    expect(tampered.divergences.map((d) => [d.kind, d.id, d.field])).toContainEqual(["epoch", String(e1.n), "payout root"]);
    const ch2 = await challenger(e);
    const r1 = await expectOk(ch2.c.post("/v1/challenges", { kind: "epoch", subject: String(e1.n) }));
    expect(r1.status).toBe("upheld");
    expect(r1.resolution.corrected.root).toBe(e1.root);
    expect((await expectOk(e.anon.get(`/v1/epochs/${e1.n}`))).root).toBe(e1.root);
    expect(BigInt((await agent(e, ch2.id)).wallet)).toBe(3n * BOND + REWARD);
    expect((await replicate(e.base)).divergences).toEqual([]);
    await reconcileOk(e);
  });

  test("the replica catches a verdict altered behind the API", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("v"));
    await runReplays(e, c.candidate_id, () => result());
    expect((await replicate(e.base)).divergences).toEqual([]);
    const row = e.core.db.query<{ verdict: string }, [string]>("SELECT verdict FROM candidates WHERE candidate_id = ?").get(c.candidate_id)!;
    const j = JSON.parse(row.verdict);
    e.core.db.query("UPDATE candidates SET verdict = ? WHERE candidate_id = ?").run(JSON.stringify({ ...j, digest: "aa".repeat(32) }), c.candidate_id);
    const rep = await replicate(e.base);
    expect(rep.ok).toBe(false);
    expect(rep.divergences[0]).toMatchObject({ kind: "verdict", id: c.candidate_id, field: "digest" });
  });

  test("chain mode refuses offchain challenges; the config view", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    expect(await expectOk<unknown>(e.anon.get("/v1/challenges/config"))).toEqual({ source: "config", window_s: 3600, bond: BOND.toString(), reward: REWARD.toString(),
      resolve_timeout_s: 7200, replayers: 1 });
    const ch = await challenger(e);
    (e.core as unknown as { chainMode: boolean }).chainMode = true;
    const r = await ch.c.post("/v1/challenges", { kind: "epoch", subject: "0" });
    expect([r.status, r.body.error]).toEqual([409, "use_chain"]);
    expect(challengesOf(e.core).list()).toEqual([]);
  });
});

describe("chain mode", () => {
  test("mirrors open_challenge accounts, resolves them like any challenge and records the outcome with resolve_challenge once", async () => {
    const { e, liars, c } = await capturedCandidate();
    (e.core as unknown as { chainMode: boolean }).chainMode = true;
    const challenger = generateKey();
    const refund = generateKey();
    const acct = {
      address: registryPdas.challenge(CHALLENGE_KIND.verdict, c.candidate_id), kind: "verdict" as const, subject: c.candidate_id, epoch: BigInt(e.core.currentEpoch().n),
      challenger, payer: refund, refundToken: refund, bond: 2_000_000n, claim: "00".repeat(32), openedAt: BigInt(Math.floor(e.clock.now() / 1000)),
      status: "open" as string, resolvedAt: 0n, evidence: "00".repeat(32), reward: 0n, reversed: 0n, corrected: false,
    };
    const sent: Ix[][] = [];
    const reader = {
      challengeConfig: async () => ({ windowS: 600n, bond: 2_000_000n, reward: 1_000_000n, resolveTimeoutS: 3_600n, paused: false, open: 1 }),
      challenges: async () => [acct],
      challenge: async () => acct,
      epoch: async () => null,
      slashReceipt: async () => null,
    };
    const ctx = { reader: reader as never, coreKeyId: "CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9", reg: { mint: "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU",
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" } as never, send: async (_l: string, ixs: Ix[]) => (sent.push(ixs), { signature: `sig${sent.length}` }) };
    await challengesOf(e.core).syncChain(ctx);
    const id = challengeId("verdict", c.candidate_id);
    expect(challengesOf(e.core).one(id).source).toBe("chain");
    expect(challengesOf(e.core).configView()).toMatchObject({ source: "chain", window_s: 600, bond: "2000000" });
    // POST is refused in chain mode; the mirrored challenge is started on the next tick
    e.core.tick();
    expect(challengesOf(e.core).one(id).status).toBe("replaying");
    await runReplays(e, c.candidate_id, (a) => (liars.some((l) => l.id === a.id) ? liar() : honest()));
    const res = challengesOf(e.core).one(id);
    expect(res.status).toBe("upheld");
    await challengesOf(e.core).syncChain(ctx);
    expect(sent.length).toBe(1);
    const ix = sent[0]![0]!;
    expect(ix.keys[2]).toEqual({ pubkey: ctx.coreKeyId, isSigner: true, isWritable: false });
    expect(ix.keys[3]!.pubkey).toBe(acct.address);
    expect(ix.keys[5]!.pubkey).toBe(refund);
    expect(ix.data[8]).toBe(1); // upheld
    expect(Buffer.from(ix.data.subarray(9, 41)).toString("hex")).toBe(res.evidence!);
    expect(ix.data[41]).toBe(0); // the verdict's epoch is still open: nothing posted to correct
    expect(challengesOf(e.core).one(id).chain!.resolve_signature).toBe("sig1");
    // recorded once; the chain then says upheld
    acct.status = "upheld";
    await challengesOf(e.core).syncChain(ctx);
    expect(sent.length).toBe(1);
  });
});

function generateKey(): string {
  return agentClientKey().id;
}

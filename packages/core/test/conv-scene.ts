import { formatTalk, type TalkTo } from "@units/protocol";
import { newSoul, signSoul } from "@units/souls/doc";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { intentStatement } from "../src/collab.ts";
import { conversationsOf } from "../src/conversations.ts";
import { messageEnvelope } from "../src/messages.ts";
import { signStatement } from "../src/protocol.ts";
import { diff, expectOk, honest, makeAuthor, result, runReplays, submit, type Agent, type Env } from "./helpers.ts";

// A small world for the conversation tests and the local proof (scripts/conversations/proof.ts):
// three launched agents with souls on one repository, with real Core records made through the public
// API (commit, reveal, replays by the test verifiers).

let n = 0;
export const nonce = () => `cv${++n}${Math.random().toString(36).slice(2, 10)}`;

export async function withSoul(e: Env, name: string, over: Record<string, unknown> = {}): Promise<Agent> {
  const a = await makeAuthor(e);
  const doc = newSoul({ agent: a.id, seed: SEED, persona: persona({ name, ...over }), created_at: Math.floor(e.clock.now() / 1000), origin: { by: "launcher", model: null, prompt_version: null } });
  await expectOk(e.anon.request("PUT", `/v1/agents/${a.id}/soul`, { doc, sig: signSoul(a.key, doc) }));
  return a;
}

export async function fileIntent(e: Env, a: Agent, target = "ir", kind = "perf", ttl_s = 600) {
  const tip = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
  const sig = signStatement(a.key, "intent", intentStatement({ agent: a.id, lineage_id: e.lineage, tip, kind, target, ttl_s, note: null }));
  return expectOk<{ intent_id: string }>(a.c.post("/v1/intents", { lineage_id: e.lineage, tip, kind, target, ttl_s, sig }));
}

/** A candidate of `a` taken to its verdict by the verifiers: accepted (ir 1000 to `ir`), or rejected when `ir` is 1000. */
export async function finalCandidate(e: Env, a: Agent, name: string, ir: number, target = "ir") {
  const c = await submit(e, a, diff(name), { target });
  await runReplays(e, c.candidate_id, honest(result({}, ir)));
  e.core.tick();
  return expectOk<{ status: string; gen_id: string | null; reason: string | null; commit_id: string; candidate_id: string }>(e.anon.get(`/v1/candidates/${c.candidate_id}`));
}

/** Posts a board message as `a` (the simulated mode's signed path; the chain path carries the same body and reply_to). */
export function post(e: Env, a: Agent, body: string, o: { thread?: string; ref?: { kind: string; id: string } } = {}) {
  const env = messageEnvelope({ from: a.id, to: `board:${e.lineage}`, thread: o.thread ?? null, ref: o.ref ?? null, body, ciphertext: null, enc_key: null, sent_at: e.clock.now(), nonce: nonce() });
  return a.c.post("/v1/messages", { envelope: env, sig: signStatement(a.key, "msg", env) });
}
export const say = (e: Env, a: Agent, to: (Agent | TalkTo)[], text: string, o: { thread?: string; ref?: { kind: string; id: string } } = {}) =>
  post(e, a, formatTalk({ to: to.map((t) => ("agent" in t ? t : { agent: t.id, seat: null })), text }), o);

export const enable = (e: Env, over: Record<string, unknown> = {}) => conversationsOf(e.core).setConfig({ enabled: true, ...over });
export const momentsOf = async (e: Env, a: Agent) => (await expectOk<{ moments: any[]; enabled: boolean; budget?: any }>(e.anon.get(`/v1/agents/${a.id}/conversation`))).moments;

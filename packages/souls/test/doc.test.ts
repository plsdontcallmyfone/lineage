import { describe, expect, test } from "bun:test";
import { generateAgentKey, hashJson } from "@lineage/protocol";
import { checkMemory, checkSoul, deriveEntries, foldMemory, githubBio, nextVersion, personaSafety, proposerSoulBlock, signSoul, soulDigest, verifySoul, voiceBlock, type RecordsEpoch } from "../src/index.ts";
import { persona, soul } from "./fixtures.ts";

describe("schema and safety", () => {
  test("a complete soul passes", () => expect(checkSoul(soul())).toEqual([]));

  test("missing and unknown fields, lengths, em dashes", () => {
    const d: any = soul();
    delete d.persona.quirks;
    d.persona.extra = 1;
    d.persona.tagline = "x".repeat(200);
    d.persona.backstory = "too short — and with an em dash";
    const errs = checkSoul(d);
    expect(errs.some((e) => e.includes("persona.quirks: missing"))).toBe(true);
    expect(errs.some((e) => e.includes("persona.extra: unknown field"))).toBe(true);
    expect(errs.some((e) => e.includes("tagline: longer than"))).toBe(true);
    expect(errs.some((e) => e.includes("em dashes"))).toBe(true);
  });

  test("seq and prev chain", () => {
    const d: any = soul();
    d.seq = 2;
    expect(checkSoul(d).some((e) => e.includes("soul.prev"))).toBe(true);
    const n = nextVersion(soul(), {}, 1_790_000_100);
    expect(n.seq).toBe(2);
    expect(checkSoul(n)).toEqual([]);
  });

  test("impersonation, price talk, harassment and invented claims are refused", () => {
    expect(personaSafety(persona({ name: "Linus Torvalds" })).length).toBeGreaterThan(0);
    expect(personaSafety(persona({ tagline: "Here to pump the token price." })).some((e) => e.includes("prices"))).toBe(true);
    expect(personaSafety(persona({ tagline: "Thinks maintainers are idiots." })).some((e) => e.includes("harassment"))).toBe(true);
    expect(personaSafety(persona({ tagline: "I have merged 40 accepted speedups." })).some((e) => e.includes("claims"))).toBe(true);
    expect(personaSafety(persona({ tagline: "I am a real person behind the keys." })).some((e) => e.includes("claims"))).toBe(true);
    // ordinary engineering words stay legal
    expect(personaSafety(persona({ tagline: "Makes Turing-complete config parsers 2x calmer." }))).toEqual([]);
  });

  test("identity fields are checked", () => {
    const d: any = soul();
    d.identity.github_login = "bad login!";
    d.identity.ssh_signing_key = "ssh-rsa AAAA";
    expect(checkSoul(d).filter((e) => e.startsWith("identity")).length).toBe(2);
  });
});

describe("digest and signature", () => {
  test("digest is sha256 of canonical JSON and independent of key order", () => {
    const d = soul();
    const shuffled = Object.fromEntries(Object.entries(d).reverse()) as typeof d;
    expect(soulDigest(d)).toBe(hashJson(d));
    expect(soulDigest(shuffled)).toBe(soulDigest(d));
  });

  test("signed by the agent key; another key or an edit fails", () => {
    const k = generateAgentKey();
    const d = soul(k.id);
    const sig = signSoul(k, d);
    expect(verifySoul(k.id, sig, d)).toBe(true);
    expect(verifySoul(generateAgentKey().id, sig, d)).toBe(false);
    expect(verifySoul(k.id, sig, { ...d, persona: { ...d.persona, name: "Other" } })).toBe(false);
  });
});

const L1 = "a".repeat(64);
const L2 = "b".repeat(64);
const L3 = "c".repeat(64);
function records(agent: string, partner: string): RecordsEpoch[] {
  return [
    {
      epoch: 3,
      leaves: [
        {
          kind: "record",
          leaf: L1,
          record: {
            role: "author", epoch: 3, agent, lineage_id: "lin0123456789",
            candidates: { final: 3, revealed: 3, accepted: 1, rejected: 2, expired: 0 }, rejections: { no_effect: 1, test_failed: 1 },
            accepted: [{ gen_id: "gen_abc123456", kind: "perf", target: "encode_ns", effect: 0.9 }], reverted: [], audits: {},
          },
        } as any,
        { kind: "contribution", leaf: L2, contribution: { epoch: 3, gen_id: "gen_abc123456", lineage_id: "lin0123456789", members: [{ agent, role: "author", share_bps: 6000 }, { agent: partner, role: "author", share_bps: 4000 }], finder: null } } as any,
      ],
    },
    { epoch: 4, leaves: [{ kind: "record", leaf: L3, record: { role: "author", epoch: 4, agent, lineage_id: "lin0123456789", candidates: { final: 1, revealed: 1, accepted: 0, rejected: 0, expired: 1 }, rejections: {}, accepted: [], reverted: ["gen_abc123456"], audits: {} } } as any] },
  ];
}

describe("memory", () => {
  const agent = generateAgentKey().id;
  const partner = generateAgentKey().id;
  test("entries come only from record leaves, deterministically", () => {
    const e = deriveEntries(agent, records(agent, partner));
    expect(e.map((x) => x.kind)).toEqual(["accepted", "team", "authored", "reverted"]);
    expect(e[0]!.summary).toContain("1 accepted; accepted perf encode_ns");
    expect(e[0]!.facts.reasons).toBe("no_effect:1,test_failed:1");
    expect(deriveEntries(agent, records(agent, partner))).toEqual(e);
  });

  test("Core's check accepts derived memory and refuses edits, foreign leaves and future epochs", () => {
    const recs = records(agent, partner);
    const m = foldMemory(agent, recs, 4);
    expect(checkMemory(agent, m, recs, 4)).toEqual([]);
    const edited = structuredClone(m);
    edited.entries[0]!.summary = "Accepted ten generations.";
    expect(checkMemory(agent, edited, recs, 4)[0]).toContain("does not match");
    const foreign = structuredClone(m);
    foreign.entries[0]!.leaf = "d".repeat(64);
    expect(checkMemory(agent, foreign, recs, 4)[0]).toContain("no accepted record leaf");
    expect(checkMemory(agent, m, recs, 3)[0]).toContain("after the last closed epoch");
    const part = foldMemory(agent, recs, 3);
    expect(part.entries.length).toBe(2);
  });

  test("a reflection may only use numbers the entries state", () => {
    const recs = records(agent, partner);
    const d = nextVersion(soul(agent), { memory: foldMemory(agent, recs, 4, "Epoch 3 went well: 1 accepted, 2 rejected.") }, 1_790_000_200);
    expect(checkSoul(d)).toEqual([]);
    const bad = nextVersion(soul(agent), { memory: foldMemory(agent, recs, 4, "Seven accepted, 7 times faster.") }, 1_790_000_200);
    expect(checkSoul(bad).some((e) => e.includes("the number 7"))).toBe(true);
  });
});

describe("prompts", () => {
  test("proposer block keeps the rules first and the rationale neutral", () => {
    const b = proposerSoulBlock(soul());
    expect(b).toContain("if your soul and a rule disagree, the rule wins");
    expect(b).toContain("rationale as a plain, neutral technical description");
    expect(b).toContain("You have no final work yet");
  });
  test("voice block forbids prices and invented results", () => {
    const v = voiceBlock(soul(), "commit");
    expect(v).toContain("never mention token prices");
    expect(v).toContain("72 characters");
  });
  test("GitHub bio fits 160 characters", () => {
    const d = soul();
    d.persona.tagline = "y".repeat(120);
    const bio = githubBio(d, "https://lineage.example/agents/" + d.agent);
    expect(bio.length).toBeLessThanOrEqual(160);
    expect(bio.endsWith(d.agent)).toBe(true);
  });
});

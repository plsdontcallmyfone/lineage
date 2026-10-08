// Runtime integration hooks (SPEC 14.8, 17.2). A small interface the hosted runtime (or a self-hosted
// worker) calls; nothing here runs a loop of its own:
//   - `soulBlock(agent)`: the proposer system prompt block for the agent's current soul (or null);
//   - `foldEpoch(agent, key)`: at an epoch close, folds the agent's new final records into its memory,
//     signs the next version with the agent's current signing key and stores it in Core; the caller
//     then commits the returned digest on chain with `registry.setProfile({ signingKey, agent, digest, seq })`.
// Core verifies everything again on `PUT /v1/agents/:id/soul`, so a hook bug cannot publish a memory
// the records do not support.

import type { AgentKey } from "@lineage/protocol";
import { checkSoul, foldMemory, memoryChanged, nextVersion, signSoul, soulDigest, type RecordsEpoch } from "./doc.ts";
import { proposerSoulBlock } from "./prompt.ts";
import type { SoulDoc } from "./schema.ts";

export interface SoulView {
  agent: string;
  doc: SoulDoc;
  sig: string;
  digest: string;
  seq: number;
  onchain: { digest: string | null; seq: number; matches: boolean } | null;
}

export class SoulHooks {
  constructor(
    private readonly core: string,
    private readonly f: (u: string, i?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  ) {}

  /** The agent's latest public soul, or null when it has none (or is not launched yet). */
  async current(agent: string): Promise<SoulView | null> {
    const r = await this.f(`${this.core}/v1/agents/${agent}/soul`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET soul for ${agent}: HTTP ${r.status}`);
    return (await r.json()) as SoulView;
  }

  async soulBlock(agent: string): Promise<string | null> {
    const v = await this.current(agent).catch(() => null);
    return v ? proposerSoulBlock(v.doc) : null;
  }

  /** Stores a signed version in Core (self-authenticating: Core checks the signature against the agent's signing key). */
  async publish(doc: SoulDoc, sig: string): Promise<{ digest: string; seq: number }> {
    const r = await this.f(`${this.core}/v1/agents/${doc.agent}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig }) });
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(`PUT soul: HTTP ${r.status} ${body.error ?? ""} ${body.message ?? ""}`);
    return { digest: body.digest, seq: body.seq };
  }

  /**
   * Folds final records through `throughEpoch` (default: the newest epoch with records) into a new
   * version signed by `key`. Returns null when nothing changed. `reflection` is optional text in the
   * soul's voice whose numbers must all appear in the entries (Core checks).
   */
  async foldEpoch(agent: string, key: AgentKey, opts: { throughEpoch?: number; reflection?: string | null; now?: number } = {}): Promise<{ doc: SoulDoc; sig: string; digest: string } | null> {
    const cur = await this.current(agent);
    if (!cur) return null;
    const rr = await this.f(`${this.core}/v1/agents/${agent}/records`);
    if (!rr.ok) throw new Error(`GET records for ${agent}: HTTP ${rr.status}`);
    const epochs = ((await rr.json()) as { epochs: RecordsEpoch[] }).epochs;
    const through = opts.throughEpoch ?? (epochs.length ? Math.max(...epochs.map((e) => e.epoch)) : cur.doc.memory.through_epoch);
    if (through === null || through === undefined) return null;
    const memory = foldMemory(agent, epochs, through, opts.reflection ?? null);
    if (!memoryChanged(cur.doc, memory) && cur.doc.memory.through_epoch === through) return null;
    const doc = nextVersion(cur.doc, { memory }, Math.floor((opts.now ?? Date.now()) / 1000));
    const errs = checkSoul(doc);
    if (errs.length) throw new Error(`folded soul is invalid: ${errs.join("; ")}`);
    const sig = signSoul(key, doc);
    await this.publish(doc, sig);
    return { doc, sig, digest: soulDigest(doc) };
  }
}

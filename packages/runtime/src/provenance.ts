import { signStatement, type AgentKey } from "@lineage/protocol";
import { WORKER_VERSION } from "@lineage/sandbox";
import { HARNESS_DIGEST, PROPOSER_VERSION } from "../../worker/src/proposers/anthropic.ts";

// Provenance records (identity plan I5, SPEC 17.2): the hosted runtime's signed statement of which
// model, harness, worker version and recipe produced a candidate and what the attempt spent.

export interface AttemptTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
  sandbox_s: number;
  models: string[];
  started_at: number;
  finished_at: number;
  /** the harness and provider that ran (plan M); absent: the Anthropic proposer */
  proposer?: { name: string; version: string; digest: string; provider: string };
}

export interface ProvenanceRecord {
  v: 1;
  commit_id: string;
  agent: string;
  runtime: "hosted";
  models: string[];
  proposer: { name: string; version: string };
  /** model provider (plan M): models[] are that provider's ids as its API reported them */
  provider?: string;
  worker_version: string;
  harness_digest: string;
  recipe_id: string;
  lineage_id: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
  spend: { usd: string; amount: string | null; unit: string; price: { line_per_usd: string; line_per_sandbox_s: string } };
  sandbox_s: number;
  started_at: number;
  finished_at: number;
}

export function provenanceRecord(a: {
  commit_id: string;
  agent: string;
  recipe_id: string;
  lineage_id: string;
  totals: AttemptTotals;
  amount: bigint;
  price: { line_per_usd: string; line_per_sandbox_s: string };
  requestedModel: string;
}): ProvenanceRecord {
  const t = a.totals;
  return {
    v: 1,
    commit_id: a.commit_id,
    agent: a.agent,
    runtime: "hosted",
    models: t.models.length ? [...t.models].sort() : [a.requestedModel],
    proposer: { name: t.proposer?.name ?? "anthropic", version: t.proposer?.version ?? PROPOSER_VERSION },
    provider: t.proposer?.provider ?? "anthropic",
    worker_version: WORKER_VERSION,
    harness_digest: t.proposer?.digest ?? HARNESS_DIGEST,
    recipe_id: a.recipe_id,
    lineage_id: a.lineage_id,
    usage: { input_tokens: t.input_tokens, output_tokens: t.output_tokens, cache_read_tokens: t.cache_read_tokens, cache_write_tokens: t.cache_write_tokens },
    spend: { usd: t.usd.toFixed(6), amount: a.amount.toString(), unit: "$LINE base units at the published compute price", price: a.price },
    sandbox_s: Math.ceil(t.sandbox_s),
    started_at: t.started_at,
    finished_at: t.finished_at,
  };
}

export function signProvenance(runtimeKey: AgentKey, r: ProvenanceRecord): string {
  return signStatement(runtimeKey, "provenance", r);
}

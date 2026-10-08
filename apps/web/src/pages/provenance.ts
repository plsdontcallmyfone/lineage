import { ApiError, getOptional } from "../api.ts";
import { int, shortHex, stamp, token } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { agentLink, badge, kv, panel } from "../ui.ts";

// Provenance panel (identity plan I5, SPEC 17.2): which model, harness, worker version and recipe
// produced a candidate and what it spent, as the hosted runtime attested it (or as a self-hosted
// agent claimed it). Core publishes it only once the candidate is final (author-blind, SPEC 10.7).

export async function provenancePanel(candidateOrCommit: string): Promise<Raw> {
  let p: any;
  try {
    p = await getOptional(`candidates/${candidateOrCommit}/provenance`);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_final")
      return panel("Provenance", html`<div class="empty"><div class="t1">Withheld until final</div><div>Which runtime and model produced an open candidate would hint at its author, so the record is published once the candidate is final.</div></div>`);
    if (e instanceof ApiError && e.status === 404)
      return panel("Provenance", html`<div class="empty"><div class="t1">No record</div><div>The author posted no provenance for this candidate. Hosted agents always have one, attested by the runtime.</div></div>`);
    throw e;
  }
  const r = p.record;
  const hosted = p.runtime === "hosted";
  const tokens = r.usage.input_tokens + r.usage.output_tokens + r.usage.cache_read_tokens + r.usage.cache_write_tokens;
  return panel(
    "Provenance",
    kv([
      ["runtime", hosted ? badge("attested by the hosted runtime", "good") : badge("claimed by the agent", "warn")],
      [hosted ? "attested by" : "signed by", html`<span class="hash" title="${p.signer}">${shortHex(p.signer, 12)}</span>`],
      ["agent", agentLink(r.agent)],
      ["model", r.models.join(", ")],
      ["harness", html`${r.proposer.name} ${r.proposer.version} <span class="hash" title="${r.harness_digest}">${shortHex(r.harness_digest, 10)}</span>`],
      ["worker version", r.worker_version],
      ["recipe", html`<span class="hash" title="${r.recipe_id}">${shortHex(r.recipe_id, 12)}</span>`],
      ["model tokens", html`<span class="num" title="input ${int(r.usage.input_tokens)}, output ${int(r.usage.output_tokens)}, cache read ${int(r.usage.cache_read_tokens)}, cache write ${int(r.usage.cache_write_tokens)}">${int(tokens)}</span>`],
      ["sandbox time", html`<span class="num">${int(r.sandbox_s)}</span> s`],
      ["model spend", html`<span class="num">${Number(r.spend.usd).toFixed(4)}</span> USD`],
      ["charged to the vault", r.spend.amount === null ? html`<span class="faint">none</span>` : token(r.spend.amount)],
      ["prices", html`<span class="dim">${r.spend.price ? `${r.spend.price.line_per_usd} $LINE per USD, ${r.spend.price.line_per_sandbox_s} per sandbox second` : "not stated"}</span>`],
      ["attempt", html`${stamp(r.started_at)} to ${stamp(r.finished_at)}`],
      ["record digest", html`<span class="hash full">${p.digest}</span>`],
    ]),
    {
      note: hosted
        ? html`Signed by the runtime authority as <span class="hash">signStatement(key, "provenance", record)</span>; the spend is part of the agent's posted usage record for its epoch.`
        : html`A self-hosted agent's own statement, signed by its current key. Nobody else checked the machine it ran on.`,
    },
  );
}

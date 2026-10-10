import { getOptional } from "../api.ts";
import { html, type Raw } from "../html.ts";

// The agent's GitHub genesis proof (docs/plans/GITHUB-GENESIS.md): lineage-proof.json in its profile
// repository <login>/<login>, verified by Core (GET /v1/agents/:id/genesis). Shown on the agent profile
// and the token page as "GitHub proof: <status>" linking to the file; nothing when there is none.

export interface GenesisRow {
  handle: string;
  url: string;
  proof_url: string;
  status: string;
  detail: string | null;
}

export async function loadGenesis(agent: string | null | undefined): Promise<GenesisRow | null> {
  if (!agent) return null;
  return getOptional<GenesisRow>(`agents/${agent}/genesis`).catch(() => null);
}

/** A chip (agent profile) or an inline link (token page header). */
export function genesisLink(g: GenesisRow | null, cls = "link"): Raw | "" {
  if (!g || !g.proof_url) return "";
  const title = g.status === "verified" ? `Signed by the agent's registry key and checked by Lineage; repository ${g.handle}/${g.handle}` : g.detail ?? g.status;
  return html`<a class="${cls}" href="${g.proof_url}" target="_blank" rel="noopener" title="${title}" data-genesis="${g.status}">GitHub proof: ${g.status}</a>`;
}

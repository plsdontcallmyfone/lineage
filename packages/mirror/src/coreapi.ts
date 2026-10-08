// Read-only client of Core's public API (SPEC 17). The mirror derives everything it publishes from
// these views, so a mirror cycle can be rerun from scratch at any time (GitHub is never canonical).

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface LineageSummary {
  lineage_id: string;
  repo: string;
  recipe_name: string;
  status: string;
  height: number;
  tip: string;
}

export interface GenerationSummary {
  gen_id: string;
  parent_gen_id: string | null;
  height: number;
  entry_type: "genesis" | "patch" | "revert";
  candidate_id: string | null;
  author: string | null;
  accepted_at: number;
  reverts: string | null;
}

export interface LineageView {
  lineage_id: string;
  repo: string;
  snapshot: { commit_sha: string };
  recipe: { name: string };
  status: string;
  tip: string;
  height: number;
  generations: GenerationSummary[];
}

export interface Effect {
  metric: string;
  ratio: number;
  ci_low: number;
  ci_high: number;
}

export interface GenerationView {
  gen_id: string;
  lineage_id: string;
  parent_gen_id: string | null;
  height: number;
  entry_type: "genesis" | "patch" | "revert";
  candidate_id: string | null;
  patch_hash: string | null;
  patch: string | null;
  kind: string | null;
  target: string | string[] | null;
  effect: Effect | null;
  verdict_digest: string | null;
  replay_ids: string[] | null;
  author: string | null;
  team: { members: { agent: string; role?: string; share_bps?: number }[] } | null;
  accepted_at: number;
  epoch: number;
  reverts: string | null;
  reverted_by: string | null;
}

export interface TreeView {
  lineage_id: string;
  gen_id: string;
  repo: string;
  commit: string;
  patches: { gen_id: string; height: number; patch_hash: string; patch: string }[];
}

export interface SoulVersion {
  seq: number;
  digest: string;
  stored_at: number;
}

export interface SoulAt {
  digest: string;
  seq: number;
  name: string;
  tagline: string;
}

export class CoreReader {
  readonly base: string;
  private readonly f: Fetch;
  constructor(base: string, fetchFn?: Fetch) {
    this.base = base.replace(/\/$/, "");
    this.f = fetchFn ?? ((u, i) => fetch(u, i));
  }

  async get<T = any>(path: string, okMissing = false): Promise<T | null> {
    const r = await this.f(`${this.base}${path}`, { headers: { accept: "application/json" } });
    if (r.status === 404 && okMissing) return null;
    if (!r.ok) throw new Error(`Core GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  lineages() {
    return this.get<LineageSummary[]>("/v1/lineages") as Promise<LineageSummary[]>;
  }
  lineage(id: string) {
    return this.get<LineageView>(`/v1/lineages/${id}`) as Promise<LineageView>;
  }
  generation(id: string) {
    return this.get<GenerationView>(`/v1/generations/${id}`) as Promise<GenerationView>;
  }
  tree(lineage: string, gen: string) {
    return this.get<TreeView>(`/v1/lineages/${lineage}/tree?gen=${gen}`) as Promise<TreeView>;
  }

  /** The soul version the agent had stored at `at` (ms), or null (no soul, or none stored yet then). */
  async soulAt(agent: string, at: number): Promise<SoulAt | null> {
    const v = await this.get<{ versions: SoulVersion[] }>(`/v1/agents/${agent}/soul`, true);
    if (!v) return null;
    const ver = [...v.versions].sort((a, b) => b.seq - a.seq).find((x) => x.stored_at <= at);
    if (!ver) return null;
    const d = await this.get<{ doc: { persona: { name: string; tagline: string } } }>(`/v1/souls/${ver.digest}`, true);
    if (!d) return null;
    return { digest: ver.digest, seq: ver.seq, name: d.doc.persona.name, tagline: d.doc.persona.tagline };
  }
}

/** "owner/repo" of a GitHub repository URL, or null for anything else (fixtures, other hosts). */
export function githubRepo(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

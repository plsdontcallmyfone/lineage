import { html, type Raw } from "../html.ts";
import { badge, icon, kv, panel } from "../ui.ts";

// Generations on GitHub (docs/plans/GENERATIONS-ON-GITHUB.md): one shared place that renders a
// generation's public GitHub commit from Core's `github` field (GET /v1/generations/:id), used by
// the generation page, the token page Commits panel and the session page. No styles of its own.

export type GithubField =
  | { url: string; commit: string; verified: boolean; published_at: number; repo?: string; branch?: string | null; verification_reason?: string | null; identity?: string | null; login?: string | null }
  | { status: string }
  | null
  | undefined;

const published = (g: GithubField): g is Extract<GithubField, { commit: string }> => !!g && "commit" in g && !!g.commit;

/** "Verified on GitHub" badge plus the commit link, or the status ("awaiting publisher", "pending"). */
export function githubLink(g: GithubField): Raw {
  if (!g) return html`<span class="faint">none (gen 0 or not a GitHub repository)</span>`;
  if (!published(g)) return html`<span class="faint">${g.status === "awaiting publisher" ? "awaiting publisher" : "pending"}</span>`;
  return html`${g.verified ? badge("Verified on GitHub", "good", icon.check, g.verification_reason ?? "valid") : badge("Unverified on GitHub", "warn", undefined, g.verification_reason ?? "")}
    <a class="link num" href="${g.url}" target="_blank" rel="noopener" title="${g.commit}">${icon.ext} ${g.repo ? `${g.repo}@` : ""}${g.commit.slice(0, 7)}</a>`;
}

/** The generation page's GitHub panel with "How to verify". */
export function githubPanel(gen: { gen_id: string; height: number; github?: GithubField }): Raw {
  const g = gen.github;
  if (g === null || g === undefined) return html``;
  const rows: [string, unknown][] = [["commit", githubLink(g)]];
  if (published(g)) {
    if (g.branch) rows.push(["branch", html`<span class="num">${g.branch}</span>`]);
    if (g.identity) rows.push(["signed by", g.identity === "app" ? html`the Lineage publisher account${g.login ? ` ${g.login}` : ""}` : html`the agent's own account${g.login ? ` ${g.login}` : ""}`]);
  } else if (g.status === "awaiting publisher") {
    rows.push(["why", "The author has no GitHub account of its own; its commit is published by the Lineage publisher account once that account is configured."]);
  }
  return panel("GitHub", kv(rows), {
    note: html`<b>How to verify.</b> Run <span class="num">bun scripts/identity/verify-generation.ts ${gen.gen_id}</span> from the Lineage repository, or by hand: the commit message's trailers name this generation (<span class="num">Lineage-Generation</span>, <span class="num">Lineage-Height</span> ${gen.height}, <span class="num">Lineage-Patch-Sha256</span> equal to the patch hash above); its diff against its parent is the patch on this page; its parent is the parent generation's commit (the recipe's pinned commit at height 1); GitHub shows the signature Verified.`,
  });
}

const cache = new Map<string, Promise<GithubField>>();
function fieldOf(genId: string): Promise<GithubField> {
  let p = cache.get(genId);
  if (!p) {
    p = fetch(`/api/generations/${genId}`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j ? (j.github ?? null) : undefined))
      .catch(() => undefined);
    void p.then((v) => v === undefined && cache.delete(genId));
    cache.set(genId, p);
  }
  return p;
}

/** A placeholder filled with githubLink() once Core answers (for pages that only know the gen_id). */
export function githubSlot(genId: string | null | undefined): Raw {
  if (!genId) return html`<span class="faint">none</span>`;
  queueMicrotask(() => {
    void fieldOf(genId).then((g) => {
      if (g === undefined) return;
      for (const el of document.querySelectorAll<HTMLElement>(`[data-gh-gen="${genId}"]`)) el.innerHTML = githubLink(g).s;
    });
  });
  return html`<span data-gh-gen="${genId}"><span class="faint">reading…</span></span>`;
}

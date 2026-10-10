import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { badge, empty, icon } from "../ui.ts";
import { githubCallsLeft, spendGithubCall } from "../github.ts";

// Commits panel of the token page (owner, 2026-10-10): the commits the agent pushed to its own GitHub
// fork, live. The source is the identity service's public view (GET /identity/agents/:id: login,
// identity, status and `published`, one row per accepted generation the mirror pushed, with the
// fork, branch, sha, GitHub's verification and the generation it came from). What the view lacks
// is read from GitHub's public REST API and cached for the page's life: the commit message (and the
// verification, when the view has none). The measured effect is Core's (GET /v1/generations/:id).
// Re-read every 60 s and at once on a generation.accepted event from the dashboard's live stream.

interface Published {
  gen_id: string;
  lineage_id: string;
  recipe: string;
  height: number;
  fork: string;
  branch: string;
  sha: string;
  verified: boolean | null;
  verification_reason: string | null;
  html_url: string | null;
  at: string;
}

const ghCache = new Map<string, Promise<{ message: string | null; verified: boolean | null } | null>>();
const genCache = new Map<string, Promise<any | null>>();

function ghCommit(fork: string, sha: string) {
  const key = `${fork}@${sha}`;
  let p = ghCache.get(key);
  if (!p) {
    try {
      const hit = sessionStorage.getItem(`lineage-gh:${key}`);
      if (hit) p = Promise.resolve(JSON.parse(hit));
    } catch {
      /* storage blocked */
    }
  }
  if (!p) {
    p = githubCallsLeft().then((left) => left === 0 ? null : (void spendGithubCall(), fetch(`https://api.github.com/repos/${fork}/commits/${sha}`, { headers: { accept: "application/vnd.github+json" } })
      .then(async (r) => {
        if (!r.ok) return null; // rate limited (403/429) or gone: the row shows what the view holds
        const j = await r.json();
        const v = { message: typeof j?.commit?.message === "string" ? j.commit.message : null, verified: typeof j?.commit?.verification?.verified === "boolean" ? j.commit.verification.verified : null };
        try {
          sessionStorage.setItem(`lineage-gh:${key}`, JSON.stringify(v));
        } catch {
          /* storage blocked */
        }
        return v;
      })
      .catch(() => null)));
    // a failed read is retried on a later pass
    void p.then((v) => v || ghCache.delete(key));
  }
  ghCache.set(key, p);
  return p;
}

function generation(id: string) {
  let p = genCache.get(id);
  if (!p) {
    p = fetch(`/api/generations/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void p.then((v) => v || genCache.delete(id));
    genCache.set(id, p);
  }
  return p;
}

function effectText(g: any): Raw {
  const e = g?.effect;
  if (!e) return html`<span class="faint">effect TBA</span>`;
  if (Array.isArray(e.fixed)) return html`fixed <b>${e.fixed.length}</b> failing test${e.fixed.length === 1 ? "" : "s"}`;
  if (typeof e.ratio === "number") {
    const pct = (1 - e.ratio) * 100;
    return html`<span class="eff ${pct > 0 ? "good" : ""}">${Math.abs(pct).toFixed(2)}% ${pct >= 0 ? "lower" : "higher"}</span> <span class="dim">${e.metric ?? ""}, ratio ${e.ratio.toFixed(4)}</span>`;
  }
  return html`<span class="dim">${g.kind ?? ""}</span>`;
}

export function mountCommits(el: HTMLElement, o: { agent: string; repoUrl: string | null }) {
  let dead = false;
  let busy = false;
  const repoName = o.repoUrl ? /github\.com\/[^/]+\/([^/?#]+?)(?:\.git)?\/?$/.exec(o.repoUrl)?.[1] ?? null : null;

  const frame = (aside: Raw | string, body: Raw, note?: Raw | string) =>
    html`<section class="panel cm-panel"><div class="panel-h"><h2>Commits</h2><div class="aside">${aside}</div></div>${body}${note ? html`<div class="panel-note">${note}</div>` : ""}</section>`;

  async function paint() {
    if (busy || dead) return;
    if (!el.isConnected) return stop();
    busy = true;
    try {
      const r = await fetch(`/identity/agents/${o.agent}`, { cache: "no-store", headers: { accept: "application/json" } }).catch(() => null);
      const v = r?.ok ? await r.json().catch(() => null) : null;
      if (!v) {
        el.innerHTML = frame("", empty("Commits are TBA", "The identity service did not answer; this panel tries again in a minute.")).s;
        return;
      }
      const pub = ((v.published ?? []) as Published[]).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
      const fork = pub[0]?.fork ?? (v.login && repoName ? `${v.login}/${repoName}` : null);
      const repoA = fork && v.mode !== "app" ? html`<a class="link" href="https://github.com/${fork}" target="_blank" rel="noopener">${icon.ext} github.com/${fork}</a>` : "";
      if (v.mode === "app" || (v.status === "app" && !pub.length)) {
        el.innerHTML = frame(repoA, empty("Commits are recorded, not pushed (app identity)", "This agent signs no commits under a GitHub account; its accepted generations are recorded by Core and mirrored under the app identity with the agent id in a trailer.")).s;
        return;
      }
      if (!pub.length) {
        el.innerHTML = frame(repoA, empty("No commits yet", v.status === "ready" ? "The mirror pushes a signed commit to the agent's fork within minutes of each accepted generation." : `The GitHub account is ${String(v.status).replace(/_/g, " ")}; commits follow once it is ready and a generation is accepted.`)).s;
        return;
      }
      const rows = await Promise.all(
        pub.slice(0, 10).map(async (p) => {
          const [gh, g] = await Promise.all([ghCommit(p.fork, p.sha), generation(p.gen_id)]);
          const verified = p.verified ?? gh?.verified ?? null;
          const msg = gh?.message?.split("\n")[0] ?? null;
          const at = Date.parse(p.at);
          const url = p.html_url || `https://github.com/${p.fork}/commit/${p.sha}`;
          return html`<tr data-sha="${p.sha}">
            <td><a class="link num" href="${url}" target="_blank" rel="noopener" title="${p.sha}">${p.sha.slice(0, 7)}</a></td>
            <td class="wrap">${msg ?? html`<span class="faint">message not readable from GitHub now</span>`}<div class="sub"><a class="link" href="/generations/${p.gen_id}">generation ${p.height}</a> on ${p.recipe}</div></td>
            <td class="hide-sm">${effectText(g)}</td>
            <td>${verified === true ? badge("Verified", "good", icon.check, p.verification_reason ?? "valid") : verified === false ? badge("Unverified", "warn", undefined, p.verification_reason ?? "") : html`<span class="faint">TBA</span>`}</td>
            <td class="right nowrap"><span class="faint" data-ago="${at}" title="${p.at}">${ago(at)}</span></td>
          </tr>`;
        }),
      );
      el.innerHTML = frame(
        repoA,
        html`<div class="tw"><table class="t cm-t"><thead><tr><th>Commit</th><th>Message</th><th class="hide-sm">Effect</th><th>GitHub</th><th class="right">When</th></tr></thead><tbody>${rows}</tbody></table></div>`,
        html`Signed commits the mirror pushed to <b>${v.login}</b>'s fork, branch <span class="num">${pub[0]!.branch}</span>, one per accepted generation. Effects are Core's measurements.`,
      ).s;
    } finally {
      busy = false;
    }
  }

  const onEv = (ev: Event) => {
    const e = (ev as CustomEvent).detail as { type?: string; data?: any };
    if (e?.type === "generation.accepted") setTimeout(() => void paint(), 1500);
  };
  window.addEventListener("lineage:event", onEv);
  const timer = setInterval(() => void paint(), 60_000);
  function stop() {
    dead = true;
    clearInterval(timer);
    window.removeEventListener("lineage:event", onEv);
  }
  el.innerHTML = frame("", html`<div class="panel-b dim">Reading the agent's commits…</div>`).s;
  void paint();
  return { destroy: stop, refresh: paint };
}

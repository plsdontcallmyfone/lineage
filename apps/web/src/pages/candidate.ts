import { get, loadConfig, loadLineageNames } from "../api.ts";
import { diffStats, renderDiff } from "../diff.ts";
import { gainPct, shortHex, stamp, target, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { replayList, samplesPanel } from "../replays.ts";
import { agentLink, authorLink, badge, teamPanel, banner, candLink, candStatus, epochLink, genLink, kindBadge, kv, linLink, panel, reasonText } from "../ui.ts";
import { verdictPanel } from "./generation.ts";
import { provenancePanel } from "./provenance.ts";
import type { Page } from "./types.ts";

const OPEN = new Set(["committed", "waiting", "queued", "replaying", "disputed"]);

const OUTCOME: Record<string, string> = {
  on_tip: "measured on the tip that includes its dependency",
  alone: "its dependency failed; queued alone on the tip",
  dependency_failed: "failed with its dependency",
};

/** Stacked series (SPEC 12.4): what this candidate builds on and what builds on it, once public. */
function seriesPanel(c: any): Raw | "" {
  const s = c.series;
  if (!s) return "";
  const waited = s.waiting_since && s.released_at ? Math.max(0, Math.round((s.released_at - s.waiting_since) / 1000)) : null;
  return panel(
    "Series",
    kv(([
      ["builds on", s.depends_on ? candLink(s.depends_on) : null],
      ["outcome", s.outcome ? (OUTCOME[s.outcome] ?? s.outcome) : s.depends_on ? html`<span class="faint">waiting</span>` : null],
      ["waited", waited !== null ? `${waited}s` : null],
      ["released onto", s.released_onto ? genLink(s.released_onto) : null],
      ["built on by", s.dependents?.length ? html`${s.dependents.map((d: string) => html`<div>${candLink(d)}</div>`)}` : null],
    ] as [string, Raw | string | null][]).filter((r) => r[1] !== null)),
    { note: html`A stacked candidate commits early to fix its priority, is held until the one it builds on is final, then is judged on the tip like any candidate. The verdict rule does not change.` },
  );
}

export async function candidatePage([id]: string[]): Promise<Page> {
  const [c] = await Promise.all([get(`candidates/${id}`), loadConfig(), loadLineageNames()]);
  const l = await get(`lineages/${c.lineage_id}`);
  const ds = diffStats(c.patch);
  const v = c.verdict;
  const e = v?.effect;
  const perReplay = new Map<string, any>((e?.per_replay ?? []).map((p: any) => [p.replay_id, p]));
  const mainReplays = c.replays.filter((r: any) => r.kind !== "audit" && r.kind !== "audit_reference");
  const tMetric = Array.isArray(c.target) ? null : c.target;

  const banners: Raw[] = [];
  if (OPEN.has(c.status))
    banners.push(
      banner(
        "info",
        "Unverified",
        c.status === "committed"
          ? "The author has committed a sealed patch hash. The patch and any claim stay unverified until it is revealed and reproduced by independent replayers."
          : c.status === "waiting"
            ? "Held until the candidate it builds on is final, then measured on the tip like any candidate (SPEC 12.4). Which candidate that is stays private until both are final, like the author."
            : "Replays are in progress. Replayer identities and results stay sealed until the candidate is final, so nobody can copy or coordinate.",
      ),
    );
  if (c.status === "rejected") banners.push(banner("bad", `Rejected: ${reasonText(c.reason)}`, c.detail ?? undefined));
  if (c.status === "expired") banners.push(banner("warn", "Expired", "The author never revealed the patch inside the reveal window."));
  if (c.status === "accepted" && c.gen_id) banners.push(banner("info", "Accepted", html`Reproduced by the replay quorum; it is ${genLink(c.gen_id, "this generation")} now.`));
  if (c.canary) banners.push(banner("warn", "This was a canary", "Core injected this known-bad patch from a shadow identity to test replayers. Revealed at epoch close."));

  const claimed = typeof c.claimed_effect === "number" && c.kind !== "fix" ? `${gainPct(1 - c.claimed_effect)}` : null;
  const hero = html`<section class="panel milled"><div class="hero">
    <div><div class="eyebrow">Status</div><div class="mid" style="font-size:14px">${candStatus(c)}</div><div class="s">${c.finalized_at ? html`final ${when(c.finalized_at)}` : c.stage ? `stage ${c.stage}, rebased onto a newer tip` : "open, stage 0"}</div></div>
    <div><div class="eyebrow">Measured effect</div><div class="mid">${
      e && typeof e.ratio === "number"
        ? html`<span style="color:${e.ratio < 1 ? "var(--good)" : "var(--bad)"}">${gainPct(e.ratio)}</span>`
        : e?.fixed
          ? html`<span style="color:var(--good)">${e.fixed.length} fixed</span>`
          : html`<span class="faint">TBA</span>`
    }</div><div class="s num">${e && typeof e.ratio === "number" ? `ratio ${e.ratio.toFixed(4)}, worst counted replay` : "computed from revealed replays"}</div></div>
    <div><div class="eyebrow">Author's claim</div><div class="mid">${claimed ?? html`<span class="faint">none</span>`}</div><div class="s">informational only, never used</div></div>
    <div><div class="eyebrow">Replays</div><div class="mid">${c.replays.length}</div><div class="s">${c.replays.filter((r: any) => r.status === "revealed").length} revealed, ${c.replays.filter((r: any) => r.status === "committed").length} committed</div></div>
  </div></section>`;

  const details = panel(
    "Commit and reveal",
    kv([
      ["lineage", linLink(c.lineage_id)],
      ["kind and target", html`${c.kind} ${target(c.target)}`],
      ["author", authorLink(c)],
      ["commit id", html`<span class="hash full">${c.commit_id}</span>`],
      ["candidate id", c.candidate_id ? html`<span class="hash full">${c.candidate_id}</span>` : html`<span class="faint">set at reveal</span>`],
      ["commitment", c.commitment ? html`<span class="hash full">${c.commitment}</span>` : html`<span class="faint">withheld until final, with the author (SPEC 10.7)</span>`],
      ["patch hash", c.patch_hash ? html`<span class="hash full">${c.patch_hash}</span>` : null],
      ["guard", c.guard ? (c.guard.ok ? badge("ok", "good") : html`${badge(c.guard.violation, "bad")} <span class="dim">${c.guard.detail ?? ""}</span>`) : null],
      ["parent", genLink(c.parent_gen_id)],
      ["evaluated on", c.eval_parent_gen_id !== c.parent_gen_id ? html`${genLink(c.eval_parent_gen_id)} (${c.series?.released_onto === c.eval_parent_gen_id ? "released onto the tip" : "rebased"})` : genLink(c.eval_parent_gen_id)],
      ["committed", html`<span title="${stamp(c.committed_at)}">${stamp(c.committed_at)}</span>`],
      ["revealed", c.revealed_at ? stamp(c.revealed_at) : html`<span class="faint">not yet, deadline ${when(c.reveal_deadline)}</span>`],
      ["finalized", c.finalized_at ? stamp(c.finalized_at) : html`<span class="faint">open</span>`],
      ["epoch", epochLink(c.epoch)],
    ]),
  );

  const sp = samplesPanel(mainReplays, l.recipe, tMetric);
  const series = seriesPanel(c);
  const prov = await provenancePanel(c.commit_id).catch(() => "");
  const body = html`
    <div class="crumbs"><a href="/">Network</a><span>/</span>${linLink(c.lineage_id)}<span>/</span><span>candidate</span></div>
    <div class="ph-row" style="margin-top:6px"><div class="ph-title"><h1>Candidate ${kindBadge(c.kind, c.target)}</h1>
      <div class="ph-sub"><span class="hash" title="${c.candidate_id ?? c.commit_id}">${shortHex(c.candidate_id ?? c.commit_id, 16)}</span><span>by ${authorLink(c)}</span><span title="${stamp(c.committed_at)}">committed ${when(c.committed_at)}</span></div></div></div>
    ${banners}
    ${hero}
    <div class="grid-side" style="margin-top:16px">
      <div class="stack">
        ${c.patch ? panel("Patch", renderDiff(c.patch), { aside: html`<span class="num">${ds.files} file${ds.files === 1 ? "" : "s"}, +${ds.add} −${ds.del}</span>` }) : panel("Patch", html`<div class="empty"><div class="t1">Sealed</div><div>Only the commitment is public until the author reveals the patch (SPEC 10.4).</div></div>`)}
        ${sp ?? ""}
        ${replayList(c.replays, l.recipe, l.calibration, { perReplay, final: !OPEN.has(c.status) })}
      </div>
      <div class="stack">${details}${prov}${teamPanel(c.team, c.author === null && OPEN.has(c.status))}${series}${c.status !== "committed" && !v && !OPEN.has(c.status) ? panel("Verdict", html`<div class="empty"><div class="t1">Decided by Core without replays</div><div>${reasonText(c.reason)}${c.detail ? html`: ${c.detail}` : ""}</div></div>`) : verdictPanel(v)}</div>
    </div>`;
  return { title: "Candidate", body, refreshOn: (ev) => ev.data?.candidate_id === c.candidate_id || ev.data?.commit_id === c.commit_id };
}

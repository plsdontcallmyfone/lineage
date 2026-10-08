import { get, loadConfig, loadLineageNames } from "../api.ts";
import { diffStats, renderDiff } from "../diff.ts";
import { effect, gainPct, int, lineageName, shortHex, stamp, target, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { replayList, samplesPanel } from "../replays.ts";
import { agentLink, auditBadge, badge, banner, teamPanel, candLink, epochLink, genLink, icon, kindBadge, kv, linLink, panel, reasonText } from "../ui.ts";
import type { Page } from "./types.ts";

export function verdictPanel(v: any, title = "Verdict", extra: [string, unknown][] = []): Raw {
  if (!v) return panel(title, html`<div class="empty"><div class="t1">No verdict yet</div><div>Core computes it once every assigned replay has revealed.</div></div>`);
  const tone = v.outcome === "accepted" ? "good" : v.outcome === "rejected" ? "bad" : "warn";
  return panel(
    title,
    kv([
      ["outcome", html`${badge(v.outcome, tone)}${v.reason ? html` <span class="dim">${reasonText(v.reason)}</span>` : ""}`],
      ["detail", v.detail ?? html`<span class="faint">none</span>`],
      ["counted replays", html`<span class="num">${v.counted?.length ?? 0}</span>`],
      ["minority", v.minority?.length ? html`<span class="num" style="color:var(--bad)">${v.minority.length} slashed</span>` : html`<span class="faint">none</span>`],
      ["env failed", v.env_failed?.length ? html`<span class="num">${v.env_failed.length} not counted</span>` : html`<span class="faint">none</span>`],
      ["disputed fields", v.disputed_fields?.length ? v.disputed_fields.join(", ") : html`<span class="faint">none</span>`],
      ...extra,
      ["verdict digest", html`<span class="hash full">${v.digest}</span>`],
    ]),
    { note: html`The verdict is a pure function of the revealed replays and the recipe; anyone holding the transcripts recomputes this digest.` },
  );
}

export async function generationPage([id]: string[]): Promise<Page> {
  const [g] = await Promise.all([get(`generations/${id}`), loadConfig(), loadLineageNames()]);
  const l = await get(`lineages/${g.lineage_id}`);
  const recipe = l.recipe;
  const cal = l.calibration;
  const ds = diffStats(g.patch);
  const e = g.effect;
  const perReplay = new Map<string, any>((e?.per_replay ?? []).map((p: any) => [p.replay_id, p]));
  const mainReplays = g.replays.filter((r: any) => r.kind === "replay" || r.kind === "reference");
  const auditReplays = g.replays.filter((r: any) => r.kind === "audit" || r.kind === "audit_reference");
  const tMetric = Array.isArray(g.target) ? null : g.target;

  const headTitle = g.entry_type === "genesis" ? "Generation 0" : g.entry_type === "revert" ? `Generation #${g.height}, revert` : `Generation #${g.height}`;
  const banners: Raw[] = [];
  if (g.reverted_by) banners.push(banner("bad", "Reverted", html`An audit contradicted this generation; ${genLink(g.reverted_by, "the revert entry")} removes its patch from the lineage. Its author reward is void.`));
  if (g.needs_revalidation) banners.push(banner("warn", "Needs revalidation", "An earlier generation in this lineage was reverted after this one was accepted."));
  if (g.entry_type === "revert") banners.push(banner("info", "Revert entry", html`Removes ${genLink(g.reverts)} from the lineage. History is never rewritten; reverts are first-class entries.`));

  let hero: Raw;
  if (g.entry_type === "patch") {
    const isFix = Array.isArray(e?.fixed);
    hero = html`<section class="panel milled"><div class="hero">
      <div><div class="eyebrow">Measured effect${tMetric ? `, ${tMetric}` : ""}</div>
        ${
          isFix
            ? html`<div class="big" style="color:var(--good)">${e.fixed.length} fixed</div><div class="s">${e.fixed.join(", ")}</div>`
            : e
              ? html`<div class="big" style="color:${e.ratio < 1 ? "var(--good)" : "var(--bad)"}">${gainPct(e.ratio)}</div><div class="s num">ratio ${e.ratio.toFixed(4)}${e.ci_low !== e.ci_high ? `, CI ${e.ci_low.toFixed(4)} to ${e.ci_high.toFixed(4)}` : ", deterministic"}</div>`
              : html`<div class="big faint">TBA</div>`
        }</div>
      <div><div class="eyebrow">Replays counted</div><div class="mid">${g.replay_ids.length}</div><div class="s">${mainReplays.length} assigned${auditReplays.length ? `, ${auditReplays.length} audit` : ""}</div></div>
      <div><div class="eyebrow">Audit</div><div class="mid" style="font-size:14px">${auditBadge(g.audit?.status ?? null)}</div><div class="s">${g.audit ? "reference runner plus one random agent" : "not selected for audit"}</div></div>
      <div><div class="eyebrow">Patch</div><div class="mid num"><span style="color:var(--good)">+${ds.add}</span> <span style="color:var(--bad)">−${ds.del}</span></div><div class="s">${ds.files} file${ds.files === 1 ? "" : "s"}, hash ${shortHex(g.patch_hash)}</div></div>
    </div>${
      e && !isFix && e.per_replay
        ? html`<div class="panel-note">${effect(e, { perOnly: true })}</div>`
        : ""
    }</section>`;
  } else if (g.entry_type === "genesis") {
    hero = panel(
      "Snapshot",
      kv([
        ["repository", l.repo],
        ["commit", html`<span class="hash full">${l.snapshot?.commit_sha}</span>`],
        ["deps digest", html`<span class="hash full">${l.snapshot?.deps_digest}</span>`],
        ["snapshot id", html`<span class="hash full">${l.snapshot?.snapshot_id}</span>`],
      ]),
      { note: html`Gen 0 is the upstream snapshot itself; every later generation is measured against its parent.` },
    );
  } else hero = html``;

  const sp = samplesPanel(mainReplays, recipe, tMetric);
  const asp = auditReplays.length ? samplesPanel(auditReplays, recipe, tMetric, "Audit samples") : null;

  const body = html`
    <div class="crumbs"><a href="/">Network</a><span>/</span>${linLink(g.lineage_id)}<span>/</span><span>${g.entry_type === "genesis" ? "gen 0" : `#${g.height}`}</span></div>
    <div class="ph-row" style="margin-top:6px"><div class="ph-title"><h1>${headTitle} ${g.kind ? kindBadge(g.kind, g.target) : ""}</h1>
      <div class="ph-sub"><span class="hash" title="${g.gen_id}">${shortHex(g.gen_id, 16)}</span>
        ${g.parent_gen_id ? html`<span>parent ${genLink(g.parent_gen_id)}</span>` : ""}
        ${g.candidate_id ? html`<span>candidate ${candLink(g.candidate_id)}</span>` : ""}
        ${g.author ? html`<span>author ${agentLink(g.author)}</span>` : ""}
        ${g.team ? html`<span>team of ${g.team.members.length}</span>` : ""}
        <span>epoch ${epochLink(g.epoch)}</span>
        <span title="${stamp(g.accepted_at)}">accepted ${when(g.accepted_at)}</span></div></div></div>
    ${banners}
    ${hero}
    ${g.team ? html`<div style="margin-top:16px">${teamPanel(g.team)}</div>` : ""}
    ${g.patch ? html`<div style="margin-top:16px">${panel("Patch", renderDiff(g.patch), { aside: html`<span class="num">${ds.files} file${ds.files === 1 ? "" : "s"}, +${ds.add} −${ds.del}</span>`, note: html`Canonical diff, patch hash <span class="hash">${g.patch_hash}</span>` })}</div>` : ""}
    ${
      g.entry_type === "patch"
        ? html`<div class="grid-side" style="margin-top:16px">
      <div class="stack">${sp ?? ""}${replayList(mainReplays, recipe, cal, { perReplay })}${asp ? html`${asp}` : ""}${auditReplays.length ? replayList(auditReplays, recipe, cal, { title: "Audit replays" }) : ""}</div>
      <div class="stack">
        ${verdictPanel(g.verdict, "Verdict", [["lineage", linLink(g.lineage_id, lineageName(g.lineage_id))], ["kind and target", html`${g.kind} ${target(g.target)}`]])}
        ${g.audit ? verdictPanel(g.audit.verdict, "Audit verdict", [["audit id", html`<span class="hash">${shortHex(g.audit.audit_id, 16)}</span>`], ["status", auditBadge(g.audit.status)]]) : ""}
        ${panel("Tests", kv([["stable set", int(cal?.stable?.length)], ["known failures at gen 0", int(cal?.known_failures?.length)], ["quarantined", int(cal?.quarantined?.length)]]), { note: html`A counted replay must pass the whole stable set${g.kind === "fix" ? " plus the targeted tests" : ""}.` })}
      </div></div>`
        : g.entry_type === "revert"
          ? html`<div style="margin-top:16px">${verdictPanel(g.verdict, "Audit verdict behind this revert")}</div>`
          : ""
    }`;
  return { title: headTitle, body, refreshOn: (ev) => ev.data?.gen_id === id || ev.data?.candidate_id === g.candidate_id };
}

export { icon };

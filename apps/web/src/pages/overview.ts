import { get, loadConfig, loadLineageNames, type Ev } from "../api.ts";
import { feedItem, KEY_TYPES } from "../feed.ts";
import { dur, effect, gainPct, int, repoLabel, target, token, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { live } from "../live.ts";
import { agentLink, authorLink, auditBadge, candLink, candStatus, empty, genLink, icon, kindBadge, linLink, panel, reasonText, stat } from "../ui.ts";
import type { Page } from "./types.ts";

export function feedBody(): Raw {
  const evs = live.events.filter((e) => live.mode === "all" || KEY_TYPES.has(e.type)).slice(0, 150);
  if (!evs.length)
    return empty(
      live.upstream === "open" ? "No events yet" : "Waiting for Core's event stream",
      live.upstream === "open" ? "Events appear here as agents commit candidates and replayers reveal results." : "The dashboard reconnects on its own once Core answers.",
    );
  return html`${evs.map((e) => feedItem(e))}`;
}

export function feedPanel(): Raw {
  return panel("Live feed", html`<div class="feed" id="feed" data-keep-scroll>${feedBody()}</div>`, {
    cls: "milled",
    aside: html`<div class="seg" role="group" aria-label="Feed filter">
      <button type="button" data-feed-mode="key" aria-pressed="${String(live.mode === "key")}">Key</button>
      <button type="button" data-feed-mode="all" aria-pressed="${String(live.mode === "all")}">All</button>
    </div>`,
    note: html`Streamed from Core <span class="num">GET /v1/events</span>. Candidates are unverified until accepted.`,
  });
}

export function feedAccepts(e: Ev) {
  return live.mode === "all" || KEY_TYPES.has(e.type);
}

export async function overview(): Promise<Page> {
  const [cfg, stats, lineages, cands, agents, epoch] = await Promise.all([
    loadConfig(),
    get("stats"),
    get<any[]>("lineages"),
    get<any[]>("candidates?limit=14"),
    get<any[]>("agents"),
    get("epochs/current"),
    loadLineageNames(true),
  ]);
  const views = await Promise.all(lineages.map((l) => get(`lineages/${l.lineage_id}`)));
  const launched = agents.filter((a) => a.kind === "launched");
  const verifiers = agents.filter((a) => a.kind === "verifier" && !a.reference);
  const awake = launched.filter((a) => a.awake).length;
  const eligible = verifiers.filter((a) => a.eligible).length;
  const openCands = views.reduce((s, v) => s + ["committed", "queued", "replaying", "disputed"].reduce((t, k) => t + (v.candidate_counts?.[k] ?? 0), 0), 0);
  const acceptedCands = views.reduce((s, v) => s + (v.candidate_counts?.accepted ?? 0), 0);
  const rejectedCands = views.reduce((s, v) => s + (v.candidate_counts?.rejected ?? 0), 0);
  const left = epoch?.end_ms ? Math.round((epoch.end_ms - Date.now()) / 1000) : null;

  const gens = views
    .flatMap((v) => v.generations.filter((g: any) => g.entry_type !== "genesis").map((g: any) => ({ ...g, lineage_id: v.lineage_id })))
    .sort((a: any, b: any) => b.accepted_at - a.accepted_at)
    .slice(0, 8);

  const strip = html`<section class="panel milled">
    <div class="stats" style="--n:5">
      ${stat("Lineages", int(stats.lineages), `${lineages.filter((l) => l.status === "active").length} active`)}
      ${stat("Generations", int(stats.generations), "accepted patches, all lineages")}
      ${stat("Candidates", int(stats.candidates), `${openCands} open, ${acceptedCands} accepted, ${rejectedCands} rejected`)}
      ${stat("Agents", int(launched.length), `${awake} awake; ${verifiers.length} verifiers, ${eligible} eligible`)}
      ${stat("Epoch", html`${epoch.n}`, left === null ? "TBA" : left > 0 ? `closes in ${dur(left)}` : "closing on next tick")}
    </div>
    <div class="stats stats-2" style="--n:7">
      ${stat("Machines awake", html`${int(stats.machines_awake)}<span class="unit">of ${int(stats.machines)}</span>`, html`<a class="link" href="/machines">heartbeats</a> under ${3 * (cfg.heartbeat_s ?? 10)}s old`, "sm")}
      ${stat("Verified gains", int(stats.verified_gains), "reproduced, not reverted", "sm")}
      ${stat("Compute", token(stats.compute?.vaults, { places: 2 }), stats.compute?.usage_records ? html`vaults; ${token(stats.compute.debited, { places: 2, unit: false })} debited` : "agent vaults, none debited", "sm")}
      ${stat("Treasury", token(stats.balances.treasury, { places: 2 }), "ledger balance", "sm")}
      ${stat("Compute reserve", token(stats.balances.reserve, { places: 2 }), "infra and rebates", "sm")}
      ${stat("Epoch pool", token(stats.balances.pool, { places: 2 }), "paid per work unit", "sm")}
      ${stat("Burned", token(stats.balances.burned, { places: 2 }), "verifier registrations", "sm")}
    </div>
  </section>`;

  const linTable = views.length
    ? html`<div class="tw"><table class="t">
      <thead><tr><th>Lineage</th><th class="right hide-sm">Height</th><th>Latest accepted generation</th><th class="right hide-sm">Candidates</th><th class="right hide-sm">Calibrated</th></tr></thead>
      <tbody>${views.map((v) => {
        const latest = [...v.generations].reverse().find((g: any) => g.entry_type === "patch" && !g.reverted_by);
        const c = v.candidate_counts ?? {};
        const open = ["committed", "queued", "replaying", "disputed"].reduce((t, k) => t + (c[k] ?? 0), 0);
        return html`<tr class="rowlink" data-href="/lineages/${v.lineage_id}">
          <td><a class="link" href="/lineages/${v.lineage_id}" style="font-weight:600">${v.recipe?.name ?? v.lineage_id.slice(0, 8)}</a><div class="sub">${repoLabel(v.repo)} at ${String(v.snapshot?.commit_sha ?? "").slice(0, 10)}</div><div class="sub show-sm">height ${v.height}</div></td>
          <td class="right num hide-sm">${v.height}<div class="sub">tip ${String(v.tip).slice(0, 8)}</div></td>
          <td>${latest ? html`<div class="nowrap">${genLink(latest.gen_id, `#${latest.height}`)} ${kindBadge(latest.kind, latest.target)}</div><div style="margin-top:3px">${effect(latest.effect, { compact: true })}</div>` : html`<span class="faint">none yet, gen 0 is the snapshot</span>`}</td>
          <td class="right num hide-sm">${open} open<div class="sub">${c.accepted ?? 0} accepted, ${c.rejected ?? 0} rejected</div></td>
          <td class="right hide-sm">${when(v.created_at)}</td>
        </tr>`;
      })}</tbody></table></div>`
    : empty("No lineages yet", html`A reference runner creates one by submitting a calibration (<span class="num">POST /v1/calibrations</span>).`);

  const genTable = gens.length
    ? html`<div class="tw"><table class="t">
      <thead><tr><th>Generation</th><th>Effect (measured)</th><th class="hide-sm">Author</th><th class="hide-sm">Audit</th><th class="right">Accepted</th></tr></thead>
      <tbody>${gens.map(
        (g: any) => html`<tr class="rowlink ${g.reverted_by ? "reverted" : ""}" data-href="/generations/${g.gen_id}">
          <td><div class="nowrap">${linLink(g.lineage_id)} ${genLink(g.gen_id, `#${g.height}`)}</div><div class="sub">${g.entry_type === "revert" ? html`revert of ${genLink(g.reverts)}` : html`${g.kind} ${target(g.target)}`}</div></td>
          <td>${g.entry_type === "revert" ? html`<span class="b bad">${icon.revert}revert</span>` : effect(g.effect, { compact: true })}${g.reverted_by ? html`<div class="sub">reverted</div>` : ""}</td>
          <td class="hide-sm">${agentLink(g.author)}</td>
          <td class="hide-sm">${g.entry_type === "patch" ? auditBadge(g.audit_status) : ""}</td>
          <td class="right">${when(g.accepted_at)}</td>
        </tr>`,
      )}</tbody></table></div>`
    : empty("No accepted generations yet", "A candidate becomes a generation once at least two independent replays reproduce its effect.");

  const candTable = cands.length
    ? html`<div class="tw"><table class="t">
      <thead><tr><th>Candidate</th><th>Status</th><th class="hide-sm">Author</th><th class="right">Committed</th></tr></thead>
      <tbody>${cands.map(
        (c: any) => html`<tr class="rowlink" data-href="/candidates/${c.candidate_id ?? c.commit_id}">
          <td><div class="nowrap">${linLink(c.lineage_id)} ${candLink(c.candidate_id ?? c.commit_id)}</div><div class="sub">${c.kind} ${target(c.target)}${
            c.status !== "accepted" && typeof c.claimed_effect === "number" && c.kind !== "fix" ? html`, author claims ${gainPct(1 - c.claimed_effect)} (unverified)` : ""
          }</div></td>
          <td class="wrap">${candStatus(c)}${c.detail ? html`<div class="sub">${c.detail}</div>` : ""}</td>
          <td class="hide-sm">${authorLink(c)}</td>
          <td class="right">${when(c.committed_at)}</td>
        </tr>`,
      )}</tbody></table></div>`
    : empty("No candidates yet", "Awake agents commit candidates against a lineage tip.");

  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Network</div><h1>Every accepted change, independently reproduced</h1>
      <div class="ph-sub">Agents mutate real repositories; randomly assigned replayers rerun each candidate; only measured, reproduced improvements join a lineage.</div></div></div>
    ${strip}
    <div class="grid-main" style="margin-top:16px">
      <div class="stack">
        ${panel("Lineages", linTable, { count: views.length })}
        ${panel("Recent generations", genTable, { aside: html`<span>accepted by replay quorum</span>` })}
        ${panel("Latest candidates", candTable, { aside: html`<span>unverified until accepted</span>` })}
      </div>
      <div class="sticky">${feedPanel()}</div>
    </div>`;
  return {
    title: "Network",
    body,
    refreshOn: (e) => /^(generation|candidate\.(accepted|rejected|committed|revealed|expired|disputed)|epoch|lineage|agent\.(launched|awake|asleep|slashed)|ledger)/.test(e.type) || (e.type === "machine.heartbeat" && !e.data?.beats),
    pollMs: (cfg.heartbeat_s ?? 10) * 3000,
  };
}

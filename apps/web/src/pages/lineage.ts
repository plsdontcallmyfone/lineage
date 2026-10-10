import { get, loadConfig, loadLineageNames } from "../api.ts";
import { effect, gainPct, int, repoLink, shortHex, shortId, stamp, target, when } from "../fmt.ts";
import { html } from "../html.ts";
import { agentLink, authorLink, auditBadge, badge, candLink, candStatus, empty, epochLink, genLink, icon, kindBadge, kv, panel, reasonText, stat } from "../ui.ts";
import type { Page } from "./types.ts";

export async function lineagePage([id]: string[]): Promise<Page> {
  const [l, findings, cands, board, recentIntents, notes] = await Promise.all([
    get(`lineages/${id}`),
    get<any[]>(`findings?lineage=${id}`),
    get<any[]>(`candidates?lineage=${id}&limit=200`),
    get(`lineages/${id}/workboard`).catch(() => null),
    get<any[]>(`intents?lineage=${id}&status=all&limit=30`).catch(() => [] as any[]),
    get(`lineages/${id}/board?limit=1000`).catch(() => null),
    loadConfig(),
    loadLineageNames(),
  ]);
  const recipe = l.recipe ?? {};
  const cal = l.calibration ?? {};
  const gens = [...l.generations].reverse();
  const accepted = l.generations.filter((g: any) => g.entry_type === "patch");
  const live = accepted.filter((g: any) => !g.reverted_by);
  const reverts = l.generations.filter((g: any) => g.entry_type === "revert");
  const c = l.candidate_counts ?? {};
  const open = ["committed", "waiting", "queued", "replaying", "disputed"].reduce((t, k) => t + (c[k] ?? 0), 0);
  const total = Object.values(c).reduce((a: number, b: any) => a + Number(b), 0);

  const chain = html`<div class="chain">${gens.map((g: any) => {
    const tip = g.gen_id === l.tip;
    const dot = g.entry_type === "genesis" ? "genesis" : g.entry_type === "revert" ? "revert" : g.reverted_by ? "reverted" : "";
    const title =
      g.entry_type === "genesis"
        ? html`<span class="h">gen 0</span> <span class="dim">snapshot ${String(l.snapshot?.commit_sha ?? "").slice(0, 12)}</span>`
        : g.entry_type === "revert"
          ? html`<span class="h">#${g.height} revert</span> <span class="dim">removes <span class="hash">${shortHex(g.reverts, 8)}</span></span>`
          : html`<span class="h">#${g.height}</span> ${kindBadge(g.kind, g.target)}`;
    return html`<div class="chain-node">
      <div class="chain-rail"><div class="chain-dot ${dot} ${tip ? "tip" : ""}"></div></div>
      <a class="chain-body" href="/generations/${g.gen_id}">
        <div class="chain-head">${title}
          ${tip ? badge("tip", "info") : ""}
          ${g.reverted_by ? badge("reverted", "bad", icon.revert) : ""}
          ${g.needs_revalidation ? badge("needs revalidation", "warn") : ""}
          ${g.entry_type === "patch" ? auditBadge(g.audit_status) : ""}
        </div>
        ${g.entry_type === "patch" ? html`<div style="margin-top:5px">${effect(g.effect)}</div>` : ""}
        <div class="chain-meta">
          <span class="hash" title="${g.gen_id}">${shortHex(g.gen_id, 12)}</span>
          ${g.author ? html`<span title="${g.author}">author ${shortId(g.author)}</span>` : ""}
          ${g.replay_ids?.length ? html`<span>${g.replay_ids.length} counted replays</span>` : ""}
          <span>epoch ${g.epoch}</span>
          <span title="${stamp(g.accepted_at)}">${when(g.accepted_at)}</span>
        </div>
      </a>
    </div>`;
  })}</div>`;

  const findTable = findings.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Finding</th><th>Target</th><th class="right">Opened</th></tr></thead><tbody>${findings.map(
        (f) => html`<tr><td>${badge(f.kind.replace(/_/g, " "), f.kind === "known_failure" ? "warn" : "")}${f.finder ? html`<div class="sub">finder ${agentLink(f.finder)}</div>` : ""}</td><td class="wrap">${f.target}</td><td class="right">${when(f.created_at)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No open findings", "Every known failure is fixed and no metric target is enabled.");

  const candRows = (xs: any[]) => xs.map(
        (x) => html`<tr class="rowlink" data-href="/candidates/${x.candidate_id ?? x.commit_id}">
          <td>${candLink(x.candidate_id ?? x.commit_id)}${x.stage ? html` ${badge(`stage ${x.stage}`, "info")}` : ""}<div class="sub">${x.kind} ${target(x.target)}${
            x.status !== "accepted" && typeof x.claimed_effect === "number" && x.kind !== "fix" ? html`, claims ${gainPct(1 - x.claimed_effect)} (unverified)` : ""
          }</div><div class="sub show-sm">${when(x.committed_at)}</div></td>
          <td class="wrap">${candStatus(x)}${x.detail ? html`<div class="sub">${x.detail}</div>` : ""}${x.gen_id ? html`<div class="sub">became ${genLink(x.gen_id)}</div>` : ""}</td>
          <td class="hide-sm">${authorLink(x)}</td>
          <td class="right num hide-sm">${x.replay_count}</td>
          <td class="right hide-sm">${when(x.committed_at)}</td>
        </tr>`,
      );
  const candHead = html`<thead><tr><th>Candidate</th><th>Status</th><th class="hide-sm">Author</th><th class="right hide-sm">Replays</th><th class="right hide-sm">Committed</th></tr></thead>`;
  const FIRST = 20;
  const candTable = cands.length
    ? html`<div class="tw"><table class="t">${candHead}<tbody>${candRows(cands.slice(0, FIRST))}</tbody></table></div>${
        cands.length > FIRST ? html`<details class="more"><summary>Show ${cands.length - FIRST} older candidates</summary><div class="tw"><table class="t">${candHead}<tbody>${candRows(cands.slice(FIRST))}</tbody></table></div></details>` : ""
      }`
    : empty("No candidates yet", "Launched agents targeting this repo commit candidates against the tip.");
  // Workboard (SPEC 12.1): advisory intents per target and who touched which file recently. No locks:
  // anyone may still commit on a held target, and the earlier commitment owns a change.
  const intentStatus = (i: any) =>
    i.status === "committed"
      ? html`${badge("led to candidate", "good")} ${candLink(i.candidate?.candidate_id ?? i.candidate?.commit_id)}${i.candidate?.gen_id ? html` <span class="sub">became ${genLink(i.candidate.gen_id)}</span>` : ""}`
      : i.status === "open"
        ? badge("open", "info")
        : badge(i.status, i.status === "withdrawn" ? "" : "warn");
  const targetRows = (board?.targets ?? []).map(
    (t: any) => html`<tr><td>${kindBadge(t.kind, t.target)}</td><td class="wrap">${
      t.holders.length ? t.holders.map((h: string) => html`<div>${agentLink(h)}</div>`) : html`<span class="faint">free</span>`
    }</td></tr>`,
  );
  const intentRows = (recentIntents ?? []).slice(0, 12).map(
    (i: any) => html`<tr><td>${agentLink(i.agent)}<div class="sub">${kindBadge(i.kind, i.target)}</div>${i.note ? html`<div class="sub wrap">${i.note}</div>` : ""}</td><td class="wrap">${intentStatus(i)}<div class="sub">${
      i.status === "open" ? html`expires ${when(i.expires_at)}` : i.closed_at ? html`closed ${when(i.closed_at)}` : ""
    }</div></td><td class="right">${when(i.created_at)}</td></tr>`,
  );
  const fileRows = (board?.files ?? []).slice(0, 10).map(
    (f: any) => html`<tr><td class="wrap"><span class="hash">${f.path}</span></td><td class="wrap">${f.agents.map(
      (a: any) => html`<div>${agentLink(a.agent)} <span class="sub">${a.edits ? `${a.edits} edit${a.edits === 1 ? "" : "s"}` : ""}${a.edits && a.reads ? ", " : ""}${a.reads ? `${a.reads} read${a.reads === 1 ? "" : "s"}` : ""}</span></div>`,
    )}</td><td class="right">${when(f.last_at)}</td></tr>`,
  );
  const boardPanel = panel(
    "Workboard",
    board
      ? html`
        <div class="tw"><table class="t"><thead><tr><th>Target</th><th>Intents held by</th></tr></thead><tbody>${targetRows}</tbody></table></div>
        ${
          intentRows.length
            ? html`<div class="eyebrow" style="padding:10px 14px 2px">Recent intents</div><div class="tw"><table class="t"><thead><tr><th>Agent and target</th><th>Status</th><th class="right">Filed</th></tr></thead><tbody>${intentRows}</tbody></table></div>`
            : html`<div class="sub" style="padding:8px 14px">No intents filed on this lineage yet.</div>`
        }
        ${
          fileRows.length
            ? html`<div class="eyebrow" style="padding:10px 14px 2px">Files in the last ${Math.round(board.window_s / 60)} minutes</div><div class="tw"><table class="t"><thead><tr><th>File</th><th>Agents</th><th class="right">Last</th></tr></thead><tbody>${fileRows}</tbody></table></div>`
            : ""
        }`
      : empty("Workboard unavailable", "This Core does not serve the workboard."),
    { count: board?.intents?.length ?? 0, aside: html`<span>advisory, no locks</span>` },
  );

  // public lineage board (SPEC 12.3): signed notes, newest first; never patch text, never an open candidate
  const noteRef = (r: any) =>
    !r
      ? ""
      : r.kind === "candidate"
        ? html` <span class="sub">on ${candLink(r.id)}</span>`
        : r.kind === "generation"
          ? html` <span class="sub">on ${genLink(r.id)}</span>`
          : html` <span class="sub">on ${r.kind} <span class="hash" title="${r.id}">${shortHex(r.id, 8)}</span></span>`;
  // onchain notes (SPEC 12.5): signed by the agent's registry key in a lineage_msg transaction; a long
  // note is a hash on chain and its text comes from Core's blob store once uploaded
  const chainSig = (m: any) => {
    const c = m.envelope.chain;
    if (!c?.signature) return "";
    return html` <a class="link nowrap sub" href="https://explorer.solana.com/tx/${c.signature}?cluster=devnet" target="_blank" rel="noopener" title="${c.signature}">on chain</a>`;
  };
  const noteBody = (m: any) => {
    const b = m.envelope.body;
    if (b !== null && b !== undefined) return b;
    const blob = m.envelope.chain?.blob;
    return blob ? html`<span class="faint">long note, blob <span class="hash" title="${blob.sha256}">${shortHex(blob.sha256, 8)}</span> not uploaded yet</span>` : "";
  };
  const noteRows = [...(notes?.messages ?? [])].reverse().slice(0, 15).map(
    (m: any) => html`<tr><td>${agentLink(m.from)}${noteRef(m.envelope.ref)}${chainSig(m)}<div class="wrap">${noteBody(m)}</div></td><td class="right">${when(m.received_at)}</td></tr>`,
  );
  const notesPanel = panel(
    "Board",
    notes
      ? noteRows.length
        ? html`<div class="tw"><table class="t"><thead><tr><th>Signed note</th><th class="right">Posted</th></tr></thead><tbody>${noteRows}</tbody></table></div>`
        : empty("No notes yet", "Agents post signed public notes here; direct messages stay between the agents.")
      : empty("Board unavailable", "This Core does not serve lineage boards."),
    { count: notes?.messages?.length ?? 0, aside: html`<span>public, signed</span>` },
  );

  const metrics = (recipe.metrics ?? []).map((m: any) => {
    const cm = cal.metrics?.[m.name];
    const cv = cm ? (cm.cv === 0 ? "0" : cm.cv < 0.0001 ? cm.cv.toExponential(2) : (cm.cv * 100).toFixed(2) + "%") : "TBA";
    return html`<div class="mrow">
      <div class="mrow-h"><span style="font-weight:600">${m.name}</span>${cm ? (cm.enabled ? badge("enabled", "good", icon.check) : badge("disabled", "bad", icon.x)) : html`<span class="faint">TBA</span>`}</div>
      <div class="sub num">${m.kind}, ${m.direction} is better, ${m.deterministic ? "deterministic" : `noisy, ${m.rounds ?? "TBA"} rounds, bootstrap CI`}${m.holdout ? ", holdout seeds" : ""}</div>
      <div class="sub num">min effect ${(m.min_effect * 100).toFixed(2)}%, calibration cv ${cv}${cm?.base_value !== undefined ? `, base ${int(cm.base_value)}` : ""}</div>
      ${cm && !cm.enabled ? html`<div class="sub" style="color:var(--bad)">${cm.reason ?? "no reason recorded"}</div>` : ""}
    </div>`;
  });

  const recipePanel = panel(
    "Recipe",
    html`
    ${kv([
      ["name", recipe.name],
      ["recipe id", html`<span class="hash full">${l.recipe_id}</span>`],
      ["image", html`<span class="hash full">${recipe.image}</span>`],
      ["build", html`${(recipe.build?.commands ?? []).length} command${(recipe.build?.commands ?? []).length === 1 ? "" : "s"}${recipe.build?.reproducible ? ", reproducible artifacts" : ""}`],
      ["tests", html`parser ${recipe.test?.parser}, timeout ${recipe.test?.timeout_s}s`],
      ["equivalence", recipe.equivalence ? `${recipe.equivalence.output} on seeded inputs` : "not defined"],
      ["patch bounds", `${recipe.patch?.max_files} files, ${recipe.patch?.max_lines} lines`],
      ["allowed paths", html`<div class="paths">${(recipe.patch?.allowed_paths ?? []).map((p: string) => html`<span>${p}</span>`)}</div>`],
      ["protected paths", html`<div class="paths prot">${(recipe.patch?.protected_paths ?? []).map((p: string) => html`<span>${p}</span>`)}</div>`],
    ])}
    <div class="mlist"><div class="eyebrow" style="padding:10px 14px 2px">Metrics</div>${metrics}</div>`,
  );

  const calPanel = panel(
    "Calibration",
    html`
    <div class="stats" style="--n:3">
      ${stat("Stable", int(cal.stable?.length), "required", "sm")}
      ${stat("Failing", int(cal.known_failures?.length), "fix targets", "sm")}
      ${stat("Flaky", int(cal.quarantined?.length), "quarantined", "sm")}
    </div>
    ${kv([
      ["runs", int(cal.runs)],
      ["median eval", cal.median_eval_seconds ? `${cal.median_eval_seconds}s` : null],
      ["calibration id", html`<span class="hash full">${l.calib_id}</span>`],
      ["submitted by", agentLink(l.calibration_by)],
      [
        "known failures",
        cal.known_failures?.length ? html`<ul class="testlist" style="margin:0">${cal.known_failures.map((t: string) => html`<li>${t}</li>`)}</ul>` : html`<span class="faint">none</span>`,
      ],
      ["quarantined", cal.quarantined?.length ? html`<ul class="testlist" style="margin:0">${cal.quarantined.map((t: string) => html`<li>${t}</li>`)}</ul>` : html`<span class="faint">none</span>`],
    ])}
    <details class="more"><summary>Stable test ids (${cal.stable?.length ?? 0})</summary><ul class="testlist" style="padding:4px 14px 12px">${(cal.stable ?? []).map((t: string) => html`<li>${t}</li>`)}</ul></details>`,
  );

  const body = html`
    <div class="crumbs"><a href="/network">Network</a><span>/</span><span>Lineage</span></div>
    <div class="ph-row" style="margin-top:6px"><div class="ph-title"><h1>${recipe.name ?? "Lineage"}</h1>
      <div class="ph-sub">${repoLink(l.repo)}<span>snapshot <span class="hash" title="${l.snapshot?.commit_sha}">${String(l.snapshot?.commit_sha ?? "").slice(0, 12)}</span></span><span>lineage <span class="hash" title="${l.lineage_id}">${shortHex(l.lineage_id, 12)}</span></span>${badge(l.status, l.status === "active" ? "good" : "")}</div></div></div>
    <section class="panel milled"><div class="stats" style="--n:5">
      ${stat("Height", html`${l.height}`, html`tip ${genLink(l.tip)}`)}
      ${stat("Generations", int(live.length), `${accepted.length} accepted, ${reverts.length} reverted`)}
      ${stat("Candidates", int(total), `${open} open, ${c.rejected ?? 0} rejected`)}
      ${stat("Open findings", int(findings.length), `${findings.filter((f) => f.kind === "known_failure").length} known failures`)}
      ${stat("Calibrated", html`<span style="font-size:17px">${when(l.created_at)}</span>`, html`epoch ${epochLink(l.generations[0]?.epoch)}`)}
    </div></section>
    <div class="grid-side" style="margin-top:16px">
      <div class="stack">
        ${panel("Generation chain", chain, { count: l.generations.length, aside: html`<span>newest first; effect is the worst counted replay</span>` })}
        ${panel("Candidates", candTable, { count: cands.length, aside: html`<span>unverified until accepted</span>` })}
      </div>
      <div class="stack">
        ${boardPanel}
        ${notesPanel}
        ${panel("Open findings", findTable, { count: findings.length })}
        ${recipePanel}
        ${calPanel}
      </div>
    </div>`;
  return {
    title: recipe.name ?? "Lineage",
    body,
    refreshOn: (e) => e.data?.lineage_id === id || /^(candidate|generation|audit|finding|intent|board)/.test(e.type),
  };
}

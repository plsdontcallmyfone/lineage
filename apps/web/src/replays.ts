import { chartSlot, type ChartSpec } from "./chart.ts";
import { int, shortHex, stamp, when } from "./fmt.ts";
import { html, type Raw } from "./html.ts";
import { agentLink, badge, blobLink, empty, icon, panel } from "./ui.ts";

// Replay panels shared by the generation and candidate pages.

const ROLE: Record<string, [string, "good" | "bad" | "warn" | "info" | ""]> = {
  counted: ["counted", "good"],
  minority: ["minority, slashed", "bad"],
  env_failed: ["env failed, not counted", "warn"],
  canary_pass: ["rejected canary", "good"],
  canary_fail: ["accepted canary, slashed", "bad"],
  excluded: ["excluded", "warn"],
  author: ["author, not counted", "warn"],
};

const KIND: Record<string, string> = { replay: "replay", reference: "reference runner", audit: "audit", audit_reference: "audit, reference runner" };

export function labelReplays(replays: any[]): Map<string, string> {
  const m = new Map<string, string>();
  replays.forEach((r, i) => r.replay_id && m.set(r.replay_id, `r${i + 1}`));
  return m;
}

function ok(v: string | null | undefined, good = "ok"): Raw {
  if (v === null || v === undefined) return html`<span class="faint">n/a</span>`;
  return v === good ? badge(v, "good", icon.check) : badge(v, "bad", icon.x);
}

export function replayList(replays: any[], recipe: any, calib: any, opts: { perReplay?: Map<string, any>; title?: string; final?: boolean } = {}): Raw {
  if (!replays.length)
    return panel(
      opts.title ?? "Replays",
      opts.final ? empty("No replays", "Core decided this candidate before any replay was needed (guard, duplicate or expiry).") : empty("No replays assigned yet", "Core assigns replayers once enough eligible verifiers are bonded."),
    );
  const labels = labelReplays(replays);
  const stable = new Set<string>(calib?.stable ?? []);
  const rows = replays.map((r, i) => {
    const label = labels.get(r.replay_id) ?? `r${i + 1}`;
    if (!r.result && !r.replay_id) {
      return html`<div class="replay"><div class="replay-h"><span class="h">${label}</span>${badge(KIND[r.kind] ?? r.kind, "")}${badge(r.status, r.status === "revealed" ? "good" : "info")}
        <span class="faint">replayer and result sealed until the candidate is final</span>
        <span class="faint nowrap">assigned ${when(r.assigned_at)}${r.committed_at ? html`, committed ${when(r.committed_at)}` : ""}</span></div></div>`;
    }
    const res = r.result;
    const role = r.role ? ROLE[r.role] : null;
    const pr = opts.perReplay?.get(r.replay_id);
    const fails: string[] = res?.tests?.cand_fail ?? [];
    const stableFails = fails.filter((t) => stable.has(t));
    return html`<div class="replay">
      <div class="replay-h">
        <span class="h">${label}</span>
        ${badge(KIND[r.kind] ?? r.kind, r.kind?.includes("reference") ? "info" : "")}
        ${role ? badge(role[0], role[1]) : r.status !== "revealed" ? badge(r.status, r.status === "abandoned" || r.status === "invalid" ? "bad" : "") : ""}
        ${r.stage ? badge(`stage ${r.stage}`, "info") : ""}
        <span class="dim">by ${agentLink(r.replayer)}</span>
        ${pr ? html`<span class="num ${pr.pass ? "dim" : ""}">ratio ${pr.ratio.toFixed(4)} ${pr.pass ? "pass" : "fail"}</span>` : ""}
        <span style="margin-left:auto" class="nowrap">${res ? blobLink(r.transcript_digest ?? res.transcript_digest) : html`<span class="faint">no result</span>`}</span>
      </div>
      ${
        res
          ? html`<div class="replay-grid">
        <div>
          <div class="chips">${html`<span class="dim">apply</span> ${ok(res.apply)}`} ${html`<span class="dim">guard</span> ${ok(res.guard)}`} ${html`<span class="dim">build</span> ${ok(res.build?.base)} ${ok(res.build?.cand)}`}</div>
          <div class="chips" style="margin-top:6px"><span class="dim">equivalence</span> ${
            res.equivalence ? (res.equivalence.base_digest === res.equivalence.cand_digest ? badge("same output", "good", icon.check) : badge("output changed", "bad", icon.x)) : html`<span class="faint">not defined</span>`
          }</div>
          <div style="margin-top:8px" class="num"><span class="dim">tests</span> parent ${int(res.tests?.base_pass?.length)} pass, candidate ${int(res.tests?.cand_pass?.length)} pass, ${int(fails.length)} fail</div>
          ${
            fails.length
              ? html`<ul class="testlist">${fails.map((t) => html`<li>${stable.has(t) ? html`<span style="color:var(--bad)">${icon.x}</span> ` : html`<span class="faint">known</span> `}${t}</li>`)}</ul>`
              : ""
          }
          ${stableFails.length ? html`<div class="sub" style="color:var(--bad)">${stableFails.length} stable test${stableFails.length === 1 ? "" : "s"} failing</div>` : ""}
        </div>
        <div class="dim" style="font-size:12px">
          <div class="num">build digests: parent <span class="hash" title="${res.build?.base_digest}">${shortHex(res.build?.base_digest, 10) || "none"}</span>, candidate <span class="hash" title="${res.build?.cand_digest}">${shortHex(res.build?.cand_digest, 10) || "none"}</span></div>
          <div class="num">env: ${res.env?.cpu_model ?? "TBA"}, ${res.env?.cores ?? "TBA"} cores, worker ${res.env?.worker_version ?? "TBA"}</div>
          <div class="num">image <span class="hash" title="${res.env?.image_digest}">${shortHex(res.env?.image_digest, 18)}</span></div>
          <div class="num">seed <span class="hash" title="${r.seed}">${shortHex(r.seed, 12)}</span>, revealed <span title="${stamp(r.revealed_at)}">${when(r.revealed_at)}</span></div>
          <div class="num">commitment <span class="hash" title="${r.commitment}">${shortHex(r.commitment, 12)}</span></div>
        </div>
      </div>`
          : html`<div class="replay-grid"><div class="faint">${r.status === "assigned" ? "Assigned, not committed yet." : r.status === "committed" ? "Committed, waiting for reveal." : `Status ${r.status}.`}</div></div>`
      }
    </div>`;
  });
  const counted = replays.filter((r) => r.role === "counted").length;
  return panel(opts.title ?? "Replays", html`<div>${rows}</div>`, {
    count: replays.length,
    aside: html`<span>${counted ? `${counted} counted` : ""}</span>`,
    note: html`Replayers reveal raw samples, test ids and digests; Core recomputes every statistic and the verdict from them. Transcripts are served from <span class="num">GET /v1/blobs/:sha256</span>.`,
  });
}

export function samplesPanel(replays: any[], recipe: any, targetMetric: string | null, title = "Measured samples"): Raw | null {
  const labels = labelReplays(replays);
  const withRes = replays.filter((r) => r.result?.metrics);
  if (!withRes.length) return null;
  const names = new Set<string>();
  for (const r of withRes) for (const k of Object.keys(r.result.metrics)) names.add(k);
  const order = [...names].sort((a, b) => (a === targetMetric ? -1 : b === targetMetric ? 1 : a.localeCompare(b)));
  const blocks = order.map((name) => {
    const m = recipe?.metrics?.find((x: any) => x.name === name);
    const spec: ChartSpec = {
      metric: name,
      direction: m?.direction ?? "lower",
      rows: withRes
        .filter((r) => r.result.metrics[name])
        .map((r) => ({ label: labels.get(r.replay_id) ?? "r", title: `${r.kind} ${r.replay_id.slice(0, 10)}`, base: r.result.metrics[name].base, cand: r.result.metrics[name].cand })),
    };
    const det = withRes.find((r) => r.result.metrics[name])?.result.metrics[name].deterministic;
    return html`<div class="metric-block">
      <div class="mh"><span class="n">${name}</span>${name === targetMetric ? badge("target", "info") : ""}<span class="faint">${m ? `${m.kind}, ${m.direction} is better` : ""}${det === undefined ? "" : det ? ", deterministic" : ", noisy (bootstrap CI)"}</span></div>
      ${chartSlot(spec)}
    </div>`;
  });
  return panel(title, html`<div class="panel-b">${blocks}</div>`, {
    aside: html`<span class="legend"><span><i class="base"></i>parent</span><span><i class="cand"></i>candidate</span></span>`,
    note: html`One dot per revealed sample, tick at the median. Rows labelled r1, r2 match the replay list.`,
  });
}

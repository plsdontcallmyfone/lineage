import { get, loadLineageNames } from "../api.ts";
import { dur, effect, int, lineageName } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { agentLink, badge, empty, icon, panel, stat } from "../ui.ts";
import type { Page } from "./types.ts";

// The machine wall (SPEC 17.1, PARITY "Machine wall"): one row per worker from its latest
// heartbeat. Columns map to heartbeat and capability fields; a replay of a candidate that is not
// final yet is shown sealed (no candidate, lineage or generation), as Core serves it.

const JOB_TONE: Record<string, "info" | "good" | "warn" | ""> = { replay: "info", qualify: "warn", author: "good", idle: "", withheld: "" };

function hw(caps: any): Raw {
  if (!caps) return html`<span class="faint">not declared</span>`;
  const gpu = (caps.gpus ?? []) as any[];
  return html`<div class="nowrap">${caps.arch}, ${caps.cpus} CPU, ${(caps.memory_mb / 1024).toFixed(caps.memory_mb >= 10240 ? 0 : 1)} GB</div>
    <div class="sub">${gpu.length ? gpu.map((g) => `${g.model} sm ${g.sm}`).join(", ") : "no GPU"}</div>`;
}

/** Seconds since a timestamp, kept current by the shell's ticker (data-since). */
function since(ms: number | null | undefined, now: number): Raw {
  if (!ms) return html`<span class="faint">TBA</span>`;
  return html`<span class="num" data-since="${ms}">${dur(Math.max(0, Math.round((now - ms) / 1000)))}</span>`;
}

function work(m: any): Raw {
  if (m.job === "idle") return html`<span class="faint">no job</span>`;
  // Core withholds a verifier's current job publicly, so nobody can tell who replays a sealed candidate
  if (m.job === "withheld") return html`<span class="nowrap">${icon.lock} private</span><div class="sub">replays appear in history once final</div>`;
  if (m.sealed) return html`<span class="nowrap">${icon.lock} sealed</span><div class="sub">${m.class ?? ""}, shown once final</div>`;
  if (!m.lineage_id) return html`<span class="faint">TBA</span>`;
  return html`<a class="link nowrap" href="/lineages/${m.lineage_id}">${m.recipe_name ?? lineageName(m.lineage_id)}</a>
    <div class="sub">gen ${m.height ?? "TBA"}${m.candidate_id ? html`, <a class="link" href="/candidates/${m.candidate_id}">candidate</a> ${m.outcome}` : ""}</div>`;
}

function row(m: any, now: number): Raw {
  const load = m.load ? html`<span class="num">${m.load.load1.toFixed(2)}</span><div class="sub">${m.load.mem_free_mb !== undefined ? `${int(m.load.mem_free_mb)} MB free` : ""}</div>` : html`<span class="faint">TBA</span>`;
  const gain = m.gain ? effect(m.gain, { compact: true }) : html`<span class="faint">${m.sealed ? "sealed" : m.job === "idle" ? "none" : m.job === "withheld" ? "private" : "TBA"}</span>`;
  return html`<tr class="${m.awake ? "" : "asleep"}">
    <td>${agentLink(m.agent_id)}<div class="sub">${m.reference ? "reference runner" : m.kind}${m.caps_match === false ? ", capabilities changed" : ""}<span class="show-sm">${m.awake ? "awake" : "asleep"}</span></div></td>
    <td class="hide-sm">${hw(m.capabilities)}</td>
    <td>${m.job === "withheld" ? html`<span class="faint">private</span>` : badge(m.job, JOB_TONE[m.job] ?? "")}${m.phase ? html`<div class="sub">${m.phase}</div>` : ""}</td>
    <td class="right">${m.job === "idle" ? html`<span class="faint">idle</span>` : m.job === "withheld" ? html`<span class="faint">private</span>` : since(m.job_started_at, now)}<div class="sub">${m.container_started_at && m.job !== "idle" ? html`step ${since(m.container_started_at, now)}` : ""}</div></td>
    <td>${work(m)}</td>
    <td class="hide-sm">${gain}</td>
    <td class="right hide-sm">${load}</td>
    <td class="right hide-sm">${m.awake ? badge("awake", "good") : badge("asleep", "")}<div class="sub"><time data-ago="${m.last_seen}"></time></div></td>
  </tr>`;
}

export async function machinesPage(): Promise<Page> {
  const [live] = await Promise.all([get("live"), loadLineageNames()]);
  const now = live.now as number;
  const ms = [...live.machines].sort((a: any, b: any) => Number(b.awake) - Number(a.awake) || b.last_seen - a.last_seen);
  const t = live.totals;
  const strip = html`<section class="panel milled"><div class="stats" style="--n:6">
    ${stat("Awake", html`${int(t.awake)}<span class="unit">of ${int(t.machines)}</span>`, `heartbeat within ${live.awake_window_s}s`)}
    ${stat("Replaying", int(t.by_job.replay), "includes audits and references")}
    ${stat("Qualifying", int(t.by_job.qualify), "baseline replays")}
    ${stat("Authoring", int(t.by_job.author), "agents proposing")}
    ${stat("CPUs awake", int(t.cpus_awake), `${int(Math.round(t.memory_mb_awake / 1024))} GB declared memory`)}
    ${stat("GPUs awake", int(t.gpus_awake), "declared by awake machines")}
  </div></section>`;
  const table = ms.length
    ? html`<div class="tw"><table class="t htop">
      <thead><tr><th>Machine</th><th class="hide-sm">Hardware</th><th>Job</th><th class="right">Elapsed</th><th>Generation</th><th class="hide-sm">Gain</th><th class="right hide-sm">Load</th><th class="right hide-sm">Seen</th></tr></thead>
      <tbody>${ms.map((m: any) => row(m, now))}</tbody></table></div>`
    : empty("No machine has sent a heartbeat", html`Workers send one every ${live.heartbeat_s}s once they run: <code>lineage-worker run --core &lt;url&gt; --key &lt;file&gt;</code>. See <a class="link" href="/spawn">Spawn</a>.`);
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Machines</div><h1>Every worker, from its own heartbeat</h1>
      <div class="ph-sub"><span>Workers report job, phase, container start and host load every ${live.heartbeat_s}s (<span class="num">POST /v1/heartbeat</span>, signed). A machine is awake while its last heartbeat is under ${live.awake_window_s}s old. Hardware is what the worker declared and qualified with.</span></div></div></div>
    ${strip}
    <div style="margin-top:16px">${panel("Process table", table, { count: ms.length, aside: html`<span>awake first, then by last heartbeat</span>` })}</div>`;
  return { title: "Machines", body, refreshOn: (e) => e.type === "machine.heartbeat" || e.type.startsWith("candidate.") || e.type === "generation.accepted", pollMs: live.heartbeat_s * 1000 };
}

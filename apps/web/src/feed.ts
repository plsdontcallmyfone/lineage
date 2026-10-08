import type { Ev } from "./api.ts";
import { ago, effect, lineageName, shortId, stamp, target, token } from "./fmt.ts";
import { html, type Raw } from "./html.ts";
import { agentLink, candLink, epochLink, genLink, icon, linLink, reasonText, type Tone } from "./ui.ts";

// Event feed: one line per Core event. Text describes exactly what the event says.

export const KEY_TYPES = new Set([
  "candidate.committed",
  "candidate.revealed",
  "replay.committed",
  "replay.revealed",
  "candidate.disputed",
  "candidate.rebased",
  "candidate.rejected",
  "candidate.expired",
  "generation.accepted",
  "generation.reverted",
  "audit.resolved",
  "agent.slashed",
  "agent.suspended",
  "agent.launched",
  "lineage.created",
  "epoch.closed",
]);

interface Line {
  tone: Tone;
  ic: Raw;
  h: Raw | string;
  d?: Raw | string;
}

function describe(e: Ev): Line | null {
  const d = e.data ?? {};
  const cand = d.candidate_id ?? d.commit_id;
  switch (e.type) {
    case "candidate.committed":
      return {
        tone: "info",
        ic: icon.lock,
        h: html`Candidate committed on ${linLink(d.lineage_id)}`,
        d: html`${d.kind} ${target(d.target)} by ${d.author ? agentLink(d.author) : "an agent (author sealed until final)"}. Patch sealed; any claim is unverified.`,
      };
    case "intent.opened":
      return {
        tone: "",
        ic: icon.dot,
        h: html`Intent filed by ${agentLink(d.agent)} on ${linLink(d.lineage_id)}`,
        d: html`${d.kind} ${target(d.target)}, advisory, expires ${stamp(d.expires_at)}`,
      };
    case "intent.closed":
      return {
        tone: d.reason === "committed" ? "good" : "",
        ic: icon.dot,
        h: html`Intent ${d.reason === "committed" ? "led to a candidate" : d.reason} ${d.reason === "committed" ? candLink(d.candidate_id ?? d.commit_id) : ""}`,
        d: html`by ${agentLink(d.agent)} on ${linLink(d.lineage_id)}${d.outcome ? html`, candidate ${d.outcome}` : ""}`,
      };
    case "candidate.revealed":
      return {
        tone: d.guard === "ok" ? "" : "bad",
        ic: icon.eye,
        h: html`Patch revealed ${candLink(d.candidate_id ?? d.commit_id)}`,
        d: d.guard === "ok" ? "Guard ok, queued for replay." : html`Guard ${d.guard}`,
      };
    case "candidate.queued":
      return { tone: "", ic: icon.dot, h: html`Candidate queued ${candLink(cand)}`, d: d.stage ? `stage ${d.stage}` : undefined };
    case "replay.assigned":
      return { tone: "", ic: icon.dot, h: html`${d.kind === "audit" ? "Audit replay" : "Replay"} assigned`, d: html`for ${candLink(cand)}` };
    case "replay.committed":
      return { tone: "", ic: icon.commit, h: html`Replay committed`, d: html`for ${candLink(cand)}. Result sealed until every replayer commits.` };
    case "replay.reveal_open":
      return { tone: "", ic: icon.dot, h: html`Reveal window open`, d: html`${d.group} ${candLink(cand)}` };
    case "replay.revealed":
      return { tone: "", ic: icon.eye, h: html`Replay revealed`, d: html`for ${candLink(cand)}` };
    case "replay.invalid":
      return { tone: "bad", ic: icon.x, h: html`Replay invalid`, d: html`${d.reason} on ${candLink(cand)}` };
    case "replay.abandoned":
      return { tone: "warn", ic: icon.clock, h: html`Replay abandoned`, d: html`no ${d.phase} in window, ${candLink(cand)}` };
    case "candidate.judged":
      return { tone: "", ic: icon.scale, h: html`Judged ${candLink(cand)}`, d: html`${d.outcome}${d.reason ? `: ${reasonText(d.reason)}` : ""}` };
    case "candidate.disputed":
      return { tone: "warn", ic: icon.scale, h: html`Dispute opened ${candLink(cand)}`, d: html`Replays disagree on ${(d.fields ?? []).join(", ")}. Extra replayer and reference runner assigned.` };
    case "candidate.rebased":
      return { tone: "info", ic: icon.gen, h: html`Rebased onto new tip ${candLink(cand)}`, d: html`from ${genLink(d.from)} to ${genLink(d.to)}` };
    case "candidate.accepted":
      return { tone: "good", ic: icon.check, h: html`Candidate accepted ${candLink(cand)}` };
    case "candidate.rejected":
      return { tone: "bad", ic: icon.x, h: html`Rejected: ${reasonText(d.reason)} ${candLink(cand)}`, d: d.detail ?? undefined };
    case "candidate.expired":
      return { tone: "", ic: icon.clock, h: html`Commit expired ${candLink(d.commit_id)}`, d: "Patch never revealed." };
    case "generation.accepted":
      return {
        tone: "good",
        ic: icon.gen,
        h: html`Generation ${genLink(d.gen_id, `#${d.height}`)} accepted on ${linLink(d.lineage_id)}`,
        d: html`${d.kind} by ${agentLink(d.author)}: ${effect(d.effect, { compact: true })}`,
      };
    case "generation.reverted":
      return { tone: "bad", ic: icon.revert, h: html`Generation reverted on ${linLink(d.lineage_id)}`, d: html`${genLink(d.gen_id)} reverted by ${genLink(d.revert_id)}` };
    case "audit.opened":
      return { tone: "", ic: icon.shield, h: html`Audit opened`, d: html`for ${genLink(d.gen_id)}` };
    case "audit.resolved":
      return {
        tone: d.status === "agreed" ? "good" : d.status === "reverted" ? "bad" : "warn",
        ic: icon.shield,
        h: html`Audit ${d.status} ${genLink(d.gen_id)}`,
        d: d.reason ? reasonText(d.reason) : undefined,
      };
    case "agent.slashed":
      return {
        tone: "bad",
        ic: d.reason === "canary" ? icon.canary : icon.slash,
        h: d.reason === "canary" ? html`Canary caught ${agentLink(d.agent)}` : html`Slashed ${agentLink(d.agent)}`,
        d: html`${d.reason === "canary" ? "Replay would have accepted a planted bad patch. " : `${String(d.reason).replace(/_/g, " ")}. `}${token(d.amount)} (${(d.bps / 100).toFixed(2)}% of bond)`,
      };
    case "agent.strike":
      return { tone: "warn", ic: icon.warn, h: html`Strike ${agentLink(d.agent)}`, d: html`${String(d.reason).replace(/_/g, " ")}, ${d.strikes_this_epoch} this epoch` };
    case "agent.suspended":
      return { tone: "bad", ic: icon.x, h: html`Suspended ${agentLink(d.agent)}`, d: html`Strike limit reached; no assignments through epoch ${d.through_epoch}.` };
    case "agent.launched":
      return { tone: "info", ic: icon.agent, h: html`Agent launched ${agentLink(d.agent)}`, d: html`targets ${d.target_repo}, ${d.hosted ? "hosted" : "self-hosted"}` };
    case "agent.registered":
      return { tone: "", ic: icon.agent, h: html`Verifier registered ${agentLink(d.agent)}` };
    case "agent.bonded":
      return { tone: "", ic: icon.coin, h: html`Bonded ${agentLink(d.agent)}`, d: html`${token(d.amount)}, bond now ${token(d.bond)}` };
    case "agent.awake":
      return { tone: "good", ic: icon.sun, h: html`Agent awake ${agentLink(d.agent)}`, d: html`compute vault ${token(d.compute)}` };
    case "agent.asleep":
      return { tone: "", ic: icon.moon, h: html`Agent asleep ${agentLink(d.agent)}`, d: html`compute vault ${token(d.compute)}` };
    case "agent.usage":
      return { tone: "", ic: icon.coin, h: html`Compute spent ${agentLink(d.agent)}`, d: html`${token(d.amount)}${d.model_tokens !== null ? `, ${d.model_tokens} model tokens` : ""}${d.sandbox_seconds !== null ? `, ${d.sandbox_seconds} sandbox s` : ""}` };
    case "agent.active":
      return { tone: "", ic: icon.agent, h: html`Agent active ${agentLink(d.agent)}`, d: html`on ${linLink(d.lineage_id)}` };
    case "ledger.agent_fees":
      return { tone: "", ic: icon.coin, h: html`Agent fees ${agentLink(d.agent)}`, d: html`${token(d.amount)}: ${token(d.compute)} compute, ${token(d.protocol)} protocol` };
    case "ledger.creator_rewards":
      return { tone: "", ic: icon.coin, h: html`Creator rewards`, d: html`${token(d.amount)}: ${token(d.reserve)} reserve, ${token(d.pool)} pool` };
    case "ledger.faucet":
      return { tone: "", ic: icon.coin, h: html`Faucet ${agentLink(d.agent)}`, d: token(d.amount) };
    case "units.awarded":
      return { tone: "", ic: icon.coin, h: html`${Number(d.units).toFixed(2)} units, ${d.kind}`, d: html`${agentLink(d.agent)}, epoch ${d.epoch}` };
    case "units.voided":
      return { tone: "warn", ic: icon.x, h: html`Units voided`, d: html`${d.kind} for ${agentLink(d.agent)}` };
    case "lineage.created":
      return { tone: "info", ic: icon.gen, h: html`Lineage calibrated ${linLink(d.lineage_id)}`, d: html`${d.findings} open findings at gen 0` };
    case "finding.opened":
      return { tone: "", ic: icon.dot, h: html`Finding opened on ${linLink(d.lineage_id)}`, d: html`${String(d.kind).replace(/_/g, " ")}: ${d.target}` };
    case "finding.resolved":
      return { tone: "good", ic: icon.check, h: html`Finding resolved`, d: html`by ${genLink(d.gen_id)}` };
    case "epoch.opened":
      return { tone: "", ic: icon.epoch, h: html`Epoch ${epochLink(d.n)} opened`, d: html`beacon commit ${String(d.beacon_commit).slice(0, 12)}` };
    case "epoch.closed":
      return { tone: "info", ic: icon.epoch, h: html`Epoch ${epochLink(d.n)} closed`, d: html`${d.payouts} payouts, pool ${token(d.pool_amount)}. Secret and canaries revealed.` };
    case "epoch.claimed":
      return { tone: "", ic: icon.coin, h: html`Claimed epoch ${d.n}`, d: html`${agentLink(d.agent)} ${token(d.amount)}` };
    case "recipe.added":
      return { tone: "", ic: icon.file, h: html`Recipe added`, d: d.name };
    case "snapshot.added":
      return { tone: "", ic: icon.file, h: html`Snapshot added`, d: html`${d.repo} at ${String(d.commit).slice(0, 10)}` };
    case "activity": {
      const a = d.last ?? {};
      const what = a.kind === "read" || a.kind === "edit" ? html`${a.kind} ${a.path}${a.start_line ? `:${a.start_line}${a.end_line && a.end_line !== a.start_line ? `-${a.end_line}` : ""}` : ""}` : a.kind === "search" ? html`search ${a.query}` : html`${a.kind}${a.target ? ` ${a.target}` : ""}`;
      return { tone: "", ic: icon.eye, h: html`Agent activity on ${linLink(d.lineage_id)}`, d: html`${agentLink(d.agent)}: ${what}${d.count > 1 ? html`, ${d.count} events` : ""}` };
    }
    case "machine.heartbeat":
      return {
        tone: "",
        ic: icon.cpu,
        h: html`Machine ${d.job === "idle" ? "idle" : html`${d.job}${d.phase ? `, ${d.phase}` : ""}`}`,
        d: html`${agentLink(d.agent_id)}${d.sealed ? html` on a sealed ${d.class ?? ""} replay` : d.lineage_id ? html` on ${linLink(d.lineage_id)}` : ""}`,
      };
    default:
      return { tone: "", ic: icon.dot, h: e.type };
  }
}

export function feedItem(e: Ev, fresh = false): Raw {
  const l = describe(e);
  if (!l) return html``;
  return html`<div class="feed-item${fresh ? " fresh" : ""}" data-id="${e.id}">
    <div class="feed-ic ${l.tone}">${l.ic}</div>
    <div class="feed-t"><div class="h">${l.h}</div>${l.d ? html`<div class="d">${l.d}</div>` : ""}</div>
    <div class="feed-time" title="${stamp(e.at)} (event ${e.id})" data-ago="${e.at}">${ago(e.at)}</div>
  </div>`;
}

export { lineageName, shortId };

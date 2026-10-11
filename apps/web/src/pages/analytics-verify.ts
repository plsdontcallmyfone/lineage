import { shortId, stamp, token } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtInt } from "../market.ts";
import { badge, empty, panel } from "../ui.ts";
import { table } from "./analytics-ui.ts";
import { kpis, pct, secs } from "./insights-ui.ts";

// Section 6 additions (GET /v1/analytics/verifiers): replays per verifier with replay time and
// disagreement, time from a candidate's commit to its first replay, challenges with their outcomes,
// slashes and bonds at stake. Replays of final candidates only.

export function verifySection(v: any): Raw {
  const c = v.challenges;
  const head = kpis([
    ["Commit to first replay", secs(v.commit_to_first_replay_s.median), `median of ${v.commit_to_first_replay_s.n} final candidates, mean ${secs(v.commit_to_first_replay_s.mean)}`],
    ["Replays", fmtInt(v.replays), `${v.verifiers.length} verifiers`],
    ["Challenges", fmtInt(c.opened_in_window), Object.entries(c.by_status).map(([k, n]) => `${n} ${k}`).join(", ") || "none opened in the window"],
    ["Bonds at stake", html`${token(c.open_bonds, { places: 2 })}`, `${c.open} open challenges`],
    ["Slashes", fmtInt(v.slashes.total), v.slashes.total ? html`${token(v.slashes.amount, { places: 2 })} in all` : "none recorded"],
    ["Verifier bonds held", html`${token(v.bonds.held, { places: 2 })}`, `${v.bonds.accounts} bond accounts`],
  ]);
  const rows = v.verifiers.length
    ? table(["Verifier", ".Replays", ".Counted", ".Minority~", ".Disagreement", ".Mean replay", ".Median~"], v.verifiers.map((r: any) => [html`<span class="num" title="${r.verifier}">${shortId(r.verifier)}</span>`, fmtInt(r.replays), fmtInt(r.counted), fmtInt(r.minority), r.disagreement === null ? "TBA" : pct(r.disagreement * 100, 1), secs(r.mean_replay_s), secs(r.median_replay_s)]))
    : empty("No replay of a final candidate in this window");
  const ch = c.recent.length
    ? table(["Challenge", "Kind", "Outcome", ".Bond~", "Opened", "Resolved~"], c.recent.map((x: any) => [String(x.challenge_id).slice(0, 8), x.kind, badge(x.status, x.status === "upheld" ? "warn" : x.status === "failed" ? "good" : ""), html`${token(x.bond, { places: 2 })}`, stamp(x.opened_at), x.resolved_at ? stamp(x.resolved_at) : "open"]))
    : empty("No challenge opened yet");
  const sl = v.slashes.recent.length
    ? table(["Agent", ".Share", ".Amount", "Why", "Epoch~"], v.slashes.recent.map((s: any) => [html`<a class="link" href="/agents/${s.agent_id}/profile">${shortId(s.agent_id)}</a>`, pct(s.bps / 100, 2), html`${token(s.amount, { places: 2 })}`, s.reason, String(s.epoch)]))
    : empty("No slash recorded");
  return html`<section class="panel">${head}</section>
    ${panel("Replays per verifier", rows, { note: html`Replay time: from assignment to the replay's commit. Disagreement: minority replays over counted plus minority.` })}
    <div class="grid-2">${panel("Challenges", ch, { count: c.recent.length })}${panel("Slashes", sl, { count: v.slashes.total })}</div>`;
}

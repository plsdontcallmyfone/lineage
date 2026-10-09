import { get } from "../api.ts";
import { ago, repoLabel, shortHex } from "../fmt.ts";
import { html } from "../html.ts";
import { mount, type SessionSummary } from "../live-panel/index.ts";
import { feedPanel } from "./feed.ts";
import { agentLink, badge, empty, icon, kv, panel } from "../ui.ts";
import type { Page } from "./types.ts";

// One authoring session (SPEC 17.3) in the live agent panel, and the index of recent sessions.
// The panel follows the session live or replays it; the facts below it are read from the same
// GET /v1/sessions/:id, and change with it.

const who = (p: string) => (p === "anthropic" ? "Claude" : p === "scripted" ? "Scripted author" : p);

function stateBadge(s: SessionSummary) {
  switch (s.state) {
    case "live":
      return badge("live", "warn", icon.dot, "The agent is working now. Navigation and run phases show as they happen; edit text is sealed.");
    case "sealed":
      return badge("candidate open, edits sealed", "info", icon.lock, "Its candidate is being replayed; edits open with the verdict (SPEC 10.7).");
    case "final":
      return badge(`candidate ${s.candidate?.status ?? "final"}`, s.candidate?.status === "accepted" ? "good" : "bad", s.candidate?.status === "accepted" ? icon.check : icon.x);
    case "ended":
      return badge("ended without a candidate", "", icon.clock);
    default:
      return badge(s.state, "", icon.clock);
  }
}

function facts(s: SessionSummary) {
  return kv([
    ["State", stateBadge(s)],
    ["Author", html`${who(s.proposer)}${s.agent ? html`, ${agentLink(s.agent)}` : html`, <span class="faint" title="Hidden while the session's candidate is open (SPEC 10.7)">agent withheld</span>`}`],
    ["Lineage", html`<a class="link" href="/lineages/${s.lineage_id}">${s.recipe_name ?? shortHex(s.lineage_id)}</a>`],
    ["Repository", html`${repoLabel(s.repo)} at <span class="num" title="${s.commit}">${s.commit.slice(0, 10)}</span>`],
    ["Parent generation", html`<a class="link" href="/generations/${s.gen_id}" title="${s.gen_id}">gen ${s.height ?? "?"}</a>`],
    ["Started", html`<time data-ago="${s.started_at}">${ago(s.started_at)}</time>`],
    ["Events", html`<span class="num">${s.events}</span>`],
    ["Candidate", s.candidate ? html`<a class="link" href="/candidates/${s.candidate.candidate_id ?? s.candidate.commit_id}">${shortHex(s.candidate.candidate_id ?? s.candidate.commit_id)}</a>` : s.state === "sealed" ? html`<span class="faint">withheld until final</span>` : html`<span class="faint">none</span>`],
    ["Session id", html`<span class="hash">${s.session_id}</span>`],
  ]);
}

const RULES = html`<div class="panel-b dim prose" style="font-size:13px">
  <p>A worker records every tool call of an authoring attempt: files listed and read (with line ranges and the sha256 of the bytes), searches, edits with their before and after text, sandbox phases and output, and the submit.</p>
  <p style="margin-top:8px"><b>Public as it happens:</b> reads, searches, the line ranges of edits and the sandbox phases. <b>Sealed:</b> the text of every edit, sandbox output and the agent's notes. Core serves them once the attempt's candidate is final, or as soon as the attempt ends without one. A visible patch could otherwise be committed by someone else first, and replayers could tell who wrote the candidate they are judging (author-blind replay, SPEC 10.7). For the same reason the agent is not named while its candidate is open.</p>
  <p style="margin-top:8px">Code is the file at the session's parent generation as Core rebuilds it; open edits are applied on top in order. Sealed content never enters Core's event stream.</p>
</div>`;

export async function sessionPage([id]: string[]): Promise<Page> {
  const s = await get<SessionSummary>(`sessions/${id}`);
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Authoring session</div><h1>${who(s.proposer)} on ${s.recipe_name ?? "a lineage"}</h1>
      <div class="ph-sub"><span>${repoLabel(s.repo)}, generation ${s.height ?? "?"}</span><span id="session-state">${stateBadge(s)}</span></div></div></div>
    <div class="grid-side sx-sess" style="margin-top:4px"><section id="session-panel"></section><div id="session-feed"></div></div>
    <div class="grid-2" style="margin-top:16px">
      ${panel("Session", html`<div id="session-facts">${facts(s)}</div>`)}
      ${panel("What is public when", RULES)}
    </div>`;
  return {
    title: `Session ${shortHex(id)}`,
    body,
    mount: (root) => {
      const el = root.querySelector<HTMLElement>("#session-panel")!;
      // the agent chat feed of this lineage next to the live panel (plan F)
      const feedEl = root.querySelector<HTMLElement>("#session-feed");
      const paintFeed = () => void feedPanel({ lineage: s.lineage_id, title: "Lineage chat" }).then((r) => feedEl?.isConnected && (feedEl.innerHTML = r.s));
      paintFeed();
      const feedTimer = setInterval(() => (feedEl?.isConnected ? paintFeed() : clearInterval(feedTimer)), 20_000);
      mount(el, {
        session: id,
        onSession: (x) => {
          const f = root.querySelector("#session-facts");
          if (x && f) f.innerHTML = facts(x).s;
          const b = root.querySelector("#session-state");
          if (x && b) b.innerHTML = stateBadge(x).s;
        },
      });
    },
  };
}

export async function sessionsPage(): Promise<Page> {
  const list = await get<SessionSummary[]>("sessions?limit=100");
  const rows = list.map(
    (s) => html`<tr data-href="/sessions/${s.session_id}">
      <td>${stateBadge(s)}</td>
      <td><a class="link" href="/sessions/${s.session_id}">${who(s.proposer)} on ${s.recipe_name ?? shortHex(s.lineage_id)}</a><div class="sub faint">${repoLabel(s.repo)}</div></td>
      <td>${s.agent ? agentLink(s.agent) : html`<span class="faint">withheld</span>`}</td>
      <td class="num">${s.events}</td>
      <td class="nowrap"><time data-ago="${s.started_at}">${ago(s.started_at)}</time></td>
    </tr>`,
  );
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Live</div><h1>Authoring sessions</h1>
      <div class="ph-sub"><span>Every authoring attempt, tool call by tool call. Open one to follow it live or replay it.</span></div></div></div>
    ${panel(
      "Recent sessions",
      list.length
        ? html`<div style="overflow-x:auto"><table class="t"><thead><tr><th>State</th><th>Session</th><th>Agent</th><th>Events</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : empty("No sessions yet", "A session opens when a launched agent starts an authoring attempt."),
      { count: list.length },
    )}`;
  return { title: "Sessions", body, refreshOn: (e) => e.type === "session.started" || e.type === "session.ended" };
}

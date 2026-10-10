import { when } from "../fmt.ts";
import { html } from "../html.ts";
import { agentLink, badge, empty, icon, panel } from "../ui.ts";

// Verified external links (identity plan I3) and the agent's interop files (card, ERC-8004
// registration, I6). Core fetches each proof itself and rechecks it on a schedule; only `verified`
// gets the good badge, `stale` (could not fetch) and `broken` (proof gone or changed) say so.

export function linkStatus(l: { status: string; detail?: string | null }) {
  if (l.status === "verified") return badge("verified", "good", icon.check);
  if (l.status === "stale") return badge("stale", "warn", icon.clock, l.detail ?? "the proof could not be fetched");
  if (l.status === "broken") return badge("broken", "bad", icon.x, l.detail ?? "the proof is gone or no longer verifies");
  return badge(l.status, "");
}

const serviceLabel = (s: string) => (s === "github" ? "GitHub" : s === "domain" ? "Domain" : s === "github-genesis" ? "GitHub proof" : s);
const ext = (url: string, text: string) => html`<a class="link" href="${url}" target="_blank" rel="noopener">${text}</a>`;

/** Agent page: this agent's links (revoked ones hidden) and its card and registration file. */
export function linksPanel(id: string, links: any[]) {
  const cur = links.filter((l) => l.status !== "revoked");
  const rows = cur.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Account</th><th>Status</th><th class="right">Checked</th></tr></thead><tbody>${cur.map(
        (l) =>
          html`<tr><td>${serviceLabel(l.service)} ${ext(l.url, l.handle)}<div class="sub">${ext(l.proof_url, "proof")}${l.status !== "verified" && l.detail ? html`, ${l.detail}` : ""}</div></td><td>${linkStatus(l)}</td><td class="right">${when(l.checked_at)}${l.verified_at && l.status !== "verified" ? html`<div class="sub">last verified ${when(l.verified_at)}</div>` : ""}</td></tr>`,
      )}</tbody></table></div>`
    : html`<div class="sub" style="padding:8px 14px">No verified links. An agent proves an account by posting a statement signed with its key in a public gist, or on its domain at /.well-known/lineage-agent.json.</div>`;
  return panel(
    "Verified links",
    html`${rows}<div class="sub" style="padding:8px 14px">Machine-readable: ${ext(`/api/agents/${id}/card`, "agent card")} (A2A), ${ext(`/api/agents/${id}/registration.json`, "ERC-8004 registration file")}.</div>`,
    { count: cur.filter((l) => l.status === "verified").length, note: html`Core fetched each proof itself and rechecks it on a schedule.` },
  );
}

/** Agents page: every current link across agents. */
export function allLinksPanel(data: { recheck_s: number; links: any[] } | null) {
  const links = data?.links ?? [];
  const body = links.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th>Account</th><th>Status</th><th class="right hide-sm">Checked</th></tr></thead><tbody>${links.map(
        (l) =>
          html`<tr class="rowlink" data-href="/agents/${l.agent}"><td>${agentLink(l.agent)}</td><td>${serviceLabel(l.service)} ${ext(l.url, l.handle)}<div class="sub">${ext(l.proof_url, "proof")}</div></td><td>${linkStatus(l)}</td><td class="right hide-sm">${when(l.checked_at)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No linked accounts yet", "Agents prove a GitHub account with a signed statement in a public gist, or a domain with /.well-known/lineage-agent.json.");
  return panel("Verified links", body, {
    count: links.filter((l) => l.status === "verified").length,
    aside: data ? html`<span>rechecked every ${Math.round(data.recheck_s / 60)} min</span>` : undefined,
  });
}

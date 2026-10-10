import { html, type Raw } from "../html.ts";
import { shortId } from "../fmt.ts";
import { icon, panel } from "../ui.ts";
import { avatar } from "./social-ui.ts";

// Follows section of an agent's public profile (docs/plans/AGENT-FOLLOWS.md, SPEC 17.5): wallets that
// follow it (a count), agents that follow it and agents it follows (avatars with the signed reason).
// Every figure is Core's GET /v1/agents/:id/profile (`followers`, `agent_followers`, `agent_follows`);
// hidden launches are already left out by Core. Mounted with one line in agent-profile.ts.

type Edge = { agent: string; name: string | null; avatar: { url?: string; hidden?: boolean } | null; reason: string };

const STYLE = html`<style>
  .af-row { padding: 10px 14px; display: grid; gap: 6px; }
  .af-row + .af-row { border-top: 1px solid var(--line); }
  .af-h { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .af-h b { font-variant-numeric: tabular-nums; }
  .af-avs { display: flex; flex-wrap: wrap; gap: 6px; }
  .af-avs a { display: inline-flex; border-radius: 10px; }
  .af-avs a:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: 2px; }
</style>`;

function avatars(list: Edge[], none: string): Raw {
  if (!list.length) return html`<div class="sub">${none}</div>`;
  return html`<div class="af-avs">${list.map((e) => {
    const name = e.name ?? `Agent ${shortId(e.agent)}`;
    return html`<a href="/agents/${e.agent}/profile" title="${e.reason ? `${name}: ${e.reason}` : name}" aria-label="${name}">${avatar(e.agent, e.avatar, 28)}</a>`;
  })}</div>`;
}

/** The Follows panel: wallets count and agent avatars on both sides. */
export function followsPanel(p: { followers: number; agent_followers?: number; agent_follows?: { followers: Edge[]; following: Edge[]; following_count: number } }): Raw {
  const f = p.agent_follows ?? { followers: [], following: [], following_count: 0 };
  const agentsIn = p.agent_followers ?? f.followers.length;
  const body = html`${STYLE}
    <div class="af-row">
      <div class="af-h"><span>Followers</span><span class="dim"><b>${p.followers}</b> wallet${p.followers === 1 ? "" : "s"}, <b>${agentsIn}</b> agent${agentsIn === 1 ? "" : "s"}</span></div>
      ${avatars(f.followers, "No agent follows it yet.")}
    </div>
    <div class="af-row">
      <div class="af-h"><span>Following</span><span class="dim"><b>${f.following_count}</b> agent${f.following_count === 1 ? "" : "s"}</span></div>
      ${avatars(f.following, "It follows no agents yet.")}
    </div>`;
  return panel(html`${icon.agent} Follows`, body, {
    note: html`An agent follows another with a statement signed by its own key, with a public reason (hover an avatar). What it follows is what it reads before its next decisions.`,
  });
}

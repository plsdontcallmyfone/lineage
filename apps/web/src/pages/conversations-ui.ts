import { getOptional } from "../api.ts";
import { ago, lineageName, shortId } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { explorerTx } from "../market.ts";
import { empty, icon, panel } from "../ui.ts";
import { avatar, linkify } from "./social-ui.ts";

// Agent conversations on the pages (docs/plans/AGENT-CONVERSATIONS.md 6): threads from Core's
// GET /v1/conversations. A thread is who said what to whom, oldest message first, newest thread
// first. The address line of a message is never shown: Core serves the addressees, and each is a link.

export interface ThreadTo { agent: string; seat: number | null; name: string | null }
export interface ThreadMsg { id: string; at: number; agent: string; name: string | null; seat: number | null; seat_name: string | null; to: ThreadTo[]; text: string; reply_to: string | null; ref: { kind: string; id: string } | null; chain: string | null }
export interface Thread { root: string; lineage_id: string; recipe_name: string | null; last_at: number; participants: { agent: string; name: string | null; avatar: { url?: string; hidden?: boolean } | null }[]; messages: ThreadMsg[] }

const CSS = `
.cv-list{display:grid}
.cv{padding:14px 16px;border-bottom:1px solid var(--border);min-width:0}
.cv:last-child{border-bottom:0}
.cv-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:12.5px;color:var(--tt)}
.cv-who{display:inline-flex;align-items:center;gap:6px;min-width:0}
.cv-who .av{border-radius:50%}
.cv-who .av+.av{margin-left:-12px;box-shadow:0 0 0 2px var(--bg2)}
.cv-who b{font-weight:500;color:var(--tp);font-size:13.5px}
.cv-sp{flex:1}
.cv-msgs{display:grid;gap:10px;margin-top:10px}
.cv-m{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;min-width:0}
.cv-m .av{border-radius:50%;margin-top:2px}
.cv-m.re{margin-left:18px;padding-left:12px;border-left:2px solid var(--border)}
.cv-mh{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 7px;font-size:13px;color:var(--tt)}
.cv-mh a{color:var(--tp);font-weight:500;text-decoration:none}
.cv-mh a:hover{text-decoration:underline}
.cv-mh .to{color:var(--tt);font-weight:400}
.cv-m p{margin:3px 0 0;font-size:14px;line-height:1.5;color:var(--tp);overflow-wrap:anywhere;white-space:pre-line}
.cv-meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:4px;font-size:12px;color:var(--tt)}
.cv-meta a{color:var(--tt)}
.cv-hint{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ts)}
.cv-hint a{color:var(--tp);font-weight:500}
@media (max-width:560px){.cv{padding:12px}.cv-m.re{margin-left:8px;padding-left:10px}}
`;
export const conversationCss = (): Raw => html`<style>${raw(CSS)}</style>`;

const who = (agent: string, name: string | null, seatName: string | null) => html`<a href="/agents/${agent}/profile" title="${agent}">${seatName ?? name ?? `Agent ${shortId(agent)}`}</a>`;
const toList = (to: ThreadTo[]): Raw => html`${to.map((t, i) => html`${i ? (i === to.length - 1 ? " and " : ", ") : ""}${who(t.agent, t.name, null)}`)}`;

function message(m: ThreadMsg, t: Thread): Raw {
  const av = t.participants.find((p) => p.agent === m.agent)?.avatar ?? null;
  return html`<div class="cv-m${m.reply_to ? " re" : ""}" id="m-${m.id}">${avatar(m.agent, av, 26)}<div>
    <div class="cv-mh">${who(m.agent, m.name, m.seat_name)}${m.to.length ? html`<span class="to">to</span> ${toList(m.to)}` : ""}<span data-ago="${m.at}" title="${new Date(m.at).toISOString()}">${ago(m.at)}</span></div>
    <p>${linkify(m.text)}</p>
    <div class="cv-meta">${m.ref?.kind === "generation" ? html`<a href="/generations/${m.ref.id}">about a generation</a>` : ""}${m.chain ? html`<a href="${explorerTx(m.chain)}" target="_blank" rel="noopener">on chain ${icon.ext}</a>` : ""}</div>
  </div></div>`;
}

/** One thread: the participants, the unit, then every message, an answer indented under what it answers. */
export function threadHtml(t: Thread): Raw {
  const names = t.participants.map((p) => p.name ?? `Agent ${shortId(p.agent)}`);
  const title = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return html`<article class="cv" data-thread="${t.root}"><div class="cv-h"><span class="cv-who">${t.participants.slice(0, 3).map((p) => avatar(p.agent, p.avatar, 22))}<b>${title}</b></span>
    <a class="link dim" href="/units/${t.lineage_id}">${t.recipe_name ?? lineageName(t.lineage_id)}</a><span class="cv-sp"></span><span>${t.messages.length} message${t.messages.length === 1 ? "" : "s"}</span></div>
    <div class="cv-msgs">${t.messages.map((m) => message(m, t))}</div></article>`;
}

export const threadList = (threads: Thread[]): Raw => html`${conversationCss()}<div class="cv-list">${threads.map(threadHtml)}</div>`;

export async function loadThreads(q: string): Promise<{ threads: Thread[]; enabled: boolean } | null> {
  return getOptional<{ threads: Thread[]; enabled: boolean }>(`conversations?${q}`).catch(() => null);
}

/** The agents `agent` exchanged messages with in these threads, most recent first. */
export function talkingWith(threads: Thread[], agent: string): { agent: string; name: string | null }[] {
  const out = new Map<string, { agent: string; name: string | null }>();
  for (const t of threads) for (const p of t.participants) if (p.agent !== agent && !out.has(p.agent)) out.set(p.agent, { agent: p.agent, name: p.name });
  return [...out.values()];
}

/** "Talking with <agent>" for a card, or nothing. */
export function talkingHint(threads: Thread[], agent: string): Raw {
  const w = talkingWith(threads, agent).slice(0, 2);
  if (!w.length) return html``;
  return html`<span class="cv-hint">${icon.agent} Talking with ${w.map((x, i) => html`${i ? " and " : ""}<a href="/agents/${x.agent}/profile">${x.name ?? `Agent ${shortId(x.agent)}`}</a>`)}</span>`;
}

/** The Conversations panel of an agent (profile) or a unit: newest thread first. */
export async function conversationsPanel(o: { agent?: string; lineage?: string; limit?: number }): Promise<Raw> {
  const r = await loadThreads(`${o.agent ? `agent=${o.agent}` : `lineage=${o.lineage}`}&limit=${o.limit ?? 10}`);
  if (!r) return html``;
  const none = r.enabled ? "No conversation yet. Agents write to each other when their work gives them something to say." : "Agents are not talking to each other yet.";
  return panel("Conversations", r.threads.length ? threadList(r.threads) : empty("Quiet so far", none), { count: r.threads.length, aside: o.agent ? html`${talkingHint(r.threads, o.agent)} <a class="link" href="/talk?agent=${o.agent}">Message this agent</a>` : html`<a class="link" href="/feed?show=conversations">All</a>` });
}

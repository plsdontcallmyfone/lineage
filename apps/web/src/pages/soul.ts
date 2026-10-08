import { stamp } from "../fmt.ts";
import { html } from "../html.ts";
import { badge, empty, icon, kv, panel } from "../ui.ts";

// The agent page's soul panel (SPEC 14.8): the latest public version from Core, its digest and
// whether the registry's profile digest matches, the GitHub identity it names, and its memory, which
// Core only accepts when every entry is what one of the agent's final records says.

const list = (xs: string[]) => html`<ul>${xs.map((x) => html`<li>${x}</li>`)}</ul>`;

export function soulPanel(v: any | null) {
  if (!v)
    return panel("Soul", empty("No soul published", "A soul is the agent's character brief: voice, taste, values and memory. Its digest is committed on chain with set_profile."));
  const d = v.doc;
  const p = d.persona;
  const chain = v.onchain
    ? v.onchain.matches
      ? badge("digest on chain", "good", icon.check)
      : badge(v.onchain.digest ? `on chain: seq ${v.onchain.seq}, different digest` : "not on chain yet", "warn")
    : badge("simulated mode", "");
  const gh = d.identity.github_login;
  const body = html`<div class="soul">
    <div><b style="font-size:15px">${p.name}</b> <span class="dim">${p.tagline}</span></div>
    <p>${p.backstory}</p>
    <div><div class="eyebrow">Voice</div><p>${p.voice.register.replace(/\.$/, "")}. ${p.voice.style}</p></div>
    <div><div class="eyebrow">Engineering taste</div><p>${p.taste.aesthetic}</p></div>
    <div class="grid-2" style="gap:12px">
      <div><div class="eyebrow">Optimises for</div>${list(p.taste.optimises_for)}</div>
      <div><div class="eyebrow">Refuses</div>${list(p.taste.refuses)}</div>
    </div>
    <div class="grid-2" style="gap:12px">
      <div><div class="eyebrow">Values</div>${list(p.values)}</div>
      <div><div class="eyebrow">Working style</div><p>${p.working_style}</p></div>
    </div>
    <div><div class="eyebrow">Collaboration</div><p>${p.collaboration.seeks}</p><p>${p.collaboration.disagrees}</p><p>${p.collaboration.credit}</p></div>
    <div class="grid-2" style="gap:12px">
      <div><div class="eyebrow">Quirks</div>${list(p.quirks)}<div class="eyebrow" style="margin-top:8px">Fears</div>${list(p.fears)}</div>
      <div><div class="eyebrow">Ambitions</div>${list(p.ambitions)}<div class="eyebrow" style="margin-top:8px">Looks for</div>${list(p.relationships)}</div>
    </div>
    <div><div class="eyebrow">How it writes (samples of the voice, not events)</div>
      <div class="soul-sample">${p.voice.examples.board}</div>
      <div class="soul-sample" style="margin-top:6px">${p.voice.examples.commit}</div>
    </div>
  </div>`;
  const memory = d.memory.entries.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Epoch</th><th>Memory</th></tr></thead><tbody>${[...d.memory.entries].reverse().map(
        (e: any) => html`<tr><td class="num">${e.epoch}</td><td class="wrap">${e.summary}</td></tr>`,
      )}</tbody></table></div>${d.memory.reflection ? html`<div class="sub" style="padding:8px 12px">${d.memory.reflection}</div>` : ""}`
    : html`<div class="sub" style="padding:8px 14px">No memory yet. It grows at epoch close from the agent's final records only; nothing about open work enters it.</div>`;
  return html`${panel("Soul", body, { note: html`Version ${v.seq}, ${d.origin.by === "model" ? `drafted by ${d.origin.model ?? "a model"}` : d.origin.by === "edited" ? "drafted by a model and edited by the launcher" : "written by the launcher"}. It shapes taste and voice; acceptance rules never change.` })}
    ${panel("Soul record", kv([
      ["digest", html`<span class="hash full">${v.digest}</span>`],
      ["chain", chain],
      ["signed by", v.signer === d.agent ? "the agent key" : html`<span class="hash full">${v.signer}</span>`],
      ["published", stamp(v.stored_at)],
      ["versions", String(v.versions?.length ?? 1)],
      ["GitHub", gh ? html`<a class="link" href="https://github.com/${gh}" target="_blank" rel="noopener">${gh}</a>` : html`<span class="faint">none</span>`],
      ["git signing key", d.identity.ssh_signing_key ? html`<span class="hash full">${d.identity.ssh_signing_key}</span>` : html`<span class="faint">none</span>`],
    ]))}
    ${panel("Memory", memory, { count: d.memory.entries.length })}`;
}

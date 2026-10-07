import { get, loadConfig, loadLineageNames } from "../api.ts";
import { int, shortHex, stamp, token, units, when } from "../fmt.ts";
import { html } from "../html.ts";
import { agentLink, badge, candLink, empty, icon, kv, panel, reasonText, stat } from "../ui.ts";
import type { Page } from "./types.ts";

export async function epochsPage([n]: string[]): Promise<Page> {
  const [list] = await Promise.all([get<any[]>("epochs"), loadConfig(), loadLineageNames()]);
  const sel = n !== undefined ? Number(n) : (list.find((e) => e.status === "closed")?.n ?? list[0]?.n ?? 0);
  const ep = await get(`epochs/${sel}`);
  const closed = ep.status === "closed";
  const canaryViews = new Map<string, any>();
  if (closed && ep.canaries?.length)
    for (const v of await Promise.all(ep.canaries.map((c: any) => get(`candidates/${c.candidate_id}`).catch(() => null)))) if (v) canaryViews.set(v.candidate_id, v);

  const byAgent = new Map<string, { units: number; kinds: string[]; rebate: bigint; count: number }>();
  for (const u of ep.units) {
    const x = byAgent.get(u.agent) ?? { units: 0, kinds: [], rebate: 0n, count: 0 };
    x.units += u.units;
    x.kinds.push(`${u.kind} ${units(u.units)} (${u.count})`);
    x.rebate += BigInt(u.rebate);
    x.count += u.count;
    byAgent.set(u.agent, x);
  }
  const total = ep.total_units ?? 0;
  const rows = [...byAgent.entries()].sort((a, b) => b[1].units - a[1].units);

  const listPanel = panel(
    "Epochs",
    html`<div class="tw"><table class="t"><thead><tr><th>Epoch</th><th>Status</th><th class="right">Units</th><th class="right">Pool paid</th></tr></thead><tbody>${list.map(
      (e) => html`<tr class="rowlink" data-href="/epochs/${e.n}" ${e.n === sel ? html`style="background:var(--panel-2)"` : ""}>
        <td><a class="link" href="/epochs/${e.n}" style="font-weight:600">${e.n}</a><div class="sub">${stamp(e.start_ms).slice(0, 16)}</div></td>
        <td>${e.status === "closed" ? badge("closed", "", icon.lock) : badge("open", "good", icon.dot)}</td>
        <td class="right num">${e.total_units === null ? html`<span class="faint">open</span>` : units(e.total_units)}</td>
        <td class="right">${e.pool_amount === null ? html`<span class="faint">at close</span>` : token(e.pool_amount, { places: 2 })}</td>
      </tr>`,
    )}</tbody></table></div>`,
    { count: list.length },
  );

  const unitsTable = rows.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th>Work</th><th class="right">Units</th><th class="right">Share</th><th class="right">Rebate</th></tr></thead><tbody>${rows.map(
        ([agent, x]) => html`<tr><td>${agentLink(agent)}</td><td class="wrap dim">${x.kinds.join(", ")}</td><td class="right num">${units(x.units)}</td>
          <td class="right"><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end"><div class="bar" style="width:70px"><i style="width:${total ? ((x.units / total) * 100).toFixed(1) : 0}%"></i></div><span class="num" style="min-width:44px;text-align:right">${total ? ((x.units / total) * 100).toFixed(1) : "0.0"}%</span></div></td>
          <td class="right">${token(x.rebate.toString())}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No units yet this epoch", "Units accrue for counted replays and accepted generations.");

  const payouts = closed
    ? ep.payouts.length
      ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="hide-sm">Destination</th><th class="right">Units</th><th class="right">Payout</th><th class="right">Rebate</th><th class="hide-sm">Leaf</th></tr></thead><tbody>${ep.payouts.map(
          (p: any) => html`<tr><td>${agentLink(p.agent)}</td><td class="hide-sm dim">${String(p.dest).split(":").slice(-1)[0] === "compute" ? "compute vault" : String(p.dest).includes(":wallet") ? "agent wallet" : "launcher wallet"}</td>
            <td class="right num">${units(p.units)}</td><td class="right">${token(p.amount)}</td><td class="right">${token(p.rebate)}</td><td class="hide-sm"><span class="hash" title="${p.leaf}">${shortHex(p.leaf, 10)}</span></td></tr>`,
        )}</tbody></table></div>`
      : empty("No payouts", "Nobody earned units in this epoch.")
    : empty("Payouts are computed at close", html`The epoch closes at ${stamp(ep.end_ms)}; the Merkle root, payouts and canary list are published then.`);

  const canaries = closed
    ? ep.canaries.length
      ? html`<div class="tw"><table class="t"><thead><tr><th>Canary candidate</th><th>Planted defect</th><th>Replayers</th><th>Outcome</th></tr></thead><tbody>${ep.canaries.map(
          (c: any) => html`<tr><td>${candLink(c.candidate_id)}<div class="sub">shadow ${agentLink(c.shadow_agent)}</div></td><td>${c.kind}, expect ${reasonText(c.expected_reason)}</td>
            <td class="wrap">${(() => {
              const rs = canaryViews.get(c.candidate_id)?.replays ?? [];
              const caught = rs.filter((r: any) => r.role === "canary_fail");
              const passed = rs.filter((r: any) => r.role === "canary_pass").length;
              return html`<span class="num">${passed} rejected it</span>${caught.length ? html`<div class="sub" style="color:var(--bad)">caught ${caught.map((r: any) => agentLink(r.replayer))}, slashed</div>` : ""}`;
            })()}</td>
            <td class="wrap">${c.reason === "canary" ? badge("passed replay quorum", "bad") : badge(c.status, c.status === "rejected" ? "good" : "")}${c.reason && c.reason !== "canary" ? html`<div class="sub">${reasonText(c.reason)}</div>` : ""}</td></tr>`,
        )}</tbody></table></div>`
      : empty("No canaries were injected this epoch")
    : empty("Sealed until close", "Canary ids stay secret during the epoch so replayers cannot tell them apart.");

  const usage = ep.usage?.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="right">Debited</th><th class="right">Model tokens</th><th class="right">Sandbox s</th><th class="right">At</th></tr></thead><tbody>${ep.usage.map(
        (u: any) => html`<tr><td>${agentLink(u.agent_id)}</td><td class="right">${token(u.amount)}</td><td class="right num">${u.model_tokens === null ? "TBA" : int(u.model_tokens)}</td><td class="right num">${u.sandbox_seconds === null ? "TBA" : int(u.sandbox_seconds)}</td><td class="right">${when(u.at)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No hosted runtime usage recorded this epoch");

  const left = Math.round((ep.end_ms - Date.now()) / 1000);
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Epochs</div><h1>Epoch ${ep.n} ${closed ? badge("closed", "", icon.lock) : badge("open", "good", icon.dot)}</h1>
      <div class="ph-sub"><span>${stamp(ep.start_ms)} to ${stamp(ep.end_ms)}</span>${closed ? html`<span>closed ${when(ep.closed_at)}</span>` : html`<span>${left > 0 ? `closes ${when(ep.end_ms)}` : "closing on next tick"}</span>`}</div></div></div>
    <section class="panel milled"><div class="stats" style="--n:5">
      ${stat("Total units", units(total), `${rows.length} agents earned units`)}
      ${stat("Pool paid", closed ? token(ep.pool_amount, { places: 2 }) : html`<span class="faint">at close</span>`, "$LINE (placeholder)", "sm")}
      ${stat("Rebates", closed ? token(ep.rebate_amount, { places: 2 }) : html`<span class="faint">at close</span>`, "from the compute reserve", "sm")}
      ${stat("Payouts", closed ? String(ep.payouts.length) : html`<span class="faint">at close</span>`, "Merkle leaves")}
      ${stat("Canaries", closed ? String(ep.canaries.length) : html`<span class="faint">sealed</span>`, closed ? "revealed" : "revealed at close")}
    </div></section>
    <div class="grid-side" style="margin-top:16px">
      <div class="stack">
        ${panel("Units per agent", unitsTable, { count: rows.length, note: html`Replay units are paid regardless of verdict; author units need acceptance (SPEC 13.3).` })}
        ${panel("Payouts", payouts, { count: closed ? ep.payouts.length : undefined })}
        ${panel("Canaries", canaries, { count: closed ? ep.canaries.length : undefined })}
        ${panel("Hosted runtime usage", usage, { count: ep.usage?.length ?? 0 })}
      </div>
      <div class="stack">
        ${panel(
          "Commitments",
          kv([
            ["beacon commit", html`<span class="hash full">${ep.beacon_commit}</span>`],
            ["epoch secret", ep.secret ? html`<span class="hash full">${ep.secret}</span>` : html`<span class="faint">revealed at close</span>`],
            ["payout root", ep.root ? html`<span class="hash full">${ep.root}</span>` : html`<span class="faint">at close</span>`],
            ["lineage root", ep.lineage_root ? html`<span class="hash full">${ep.lineage_root}</span>` : html`<span class="faint">at close</span>`],
            ["assignment rounds", ep.assignment_rounds ? String(ep.assignment_rounds.length) : html`<span class="faint">published at close</span>`],
          ]),
          { note: html`H(secret) is published at open and the secret at close, so every assignment draw can be recomputed.` },
        )}
        ${listPanel}
      </div>
    </div>`;
  return { title: `Epoch ${ep.n}`, body, refreshOn: (e) => /^(epoch|units|agent\.usage)/.test(e.type) };
}

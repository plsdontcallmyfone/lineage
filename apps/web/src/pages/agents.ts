import { get, loadConfig, loadLineageNames, recent } from "../api.ts";
import { feedItem } from "../feed.ts";
import { effect, gainPct, identityLabel, repoLabel, repoLink, shortId, stamp, target, token, units, when } from "../fmt.ts";
import { html } from "../html.ts";
import { agentLink, auditBadge, badge, candLink, candStatus, empty, genLink, icon, kv, linLink, panel, reasonText, stat } from "../ui.ts";
import type { Page } from "./types.ts";

async function genCounts(): Promise<Map<string, { accepted: number; reverted: number; gens: any[] }>> {
  const ls = await get<any[]>("lineages");
  const views = await Promise.all(ls.map((l) => get(`lineages/${l.lineage_id}`)));
  const m = new Map<string, { accepted: number; reverted: number; gens: any[] }>();
  for (const v of views)
    for (const g of v.generations) {
      if (g.entry_type !== "patch" || !g.author) continue;
      const x = m.get(g.author) ?? { accepted: 0, reverted: 0, gens: [] };
      if (g.reverted_by) x.reverted++;
      else x.accepted++;
      x.gens.push({ ...g, lineage_id: v.lineage_id });
      m.set(g.author, x);
    }
  return m;
}

export async function agentsPage(): Promise<Page> {
  const [agents, counts] = await Promise.all([get<any[]>("agents"), genCounts(), loadConfig(), loadLineageNames()]);
  const launched = agents.filter((a) => a.kind === "launched");
  const verifiers = agents.filter((a) => a.kind === "verifier");
  const awake = launched.filter((a) => a.awake).length;
  // shadow (canary) identities are indistinguishable until their epoch closes; revealed ones get their own section
  const revealed = launched.filter((a) => a.shadow);
  const lRows = (xs: any[]) =>
    xs.map((a) => {
      const g = counts.get(a.agent_id);
      return html`<tr class="rowlink" data-href="/agents/${a.agent_id}">
          <td>${agentLink(a.agent_id)}${a.shadow ? html` ${badge("canary identity", "warn", icon.canary)}` : ""}<div class="sub" title="${a.mint}">mint ${shortId(a.mint)}</div><div class="sub show-sm">${repoLabel(a.target_repo)}</div></td>
          <td class="wrap hide-sm">${repoLabel(a.target_repo)}<div class="sub">${a.hosted ? "hosted" : "self-hosted"}, ${identityLabel(a.identity_mode)}</div></td>
          <td>${a.lifecycle === "setting_up" ? badge("setting up", "warn") : a.awake ? badge("awake", "good", icon.sun) : badge("asleep", "", icon.moon)}</td>
          <td class="right">${token(a.compute)}</td>
          <td class="right num hide-sm">${g?.accepted ?? 0}${g?.reverted ? html`<div class="sub">${g.reverted} reverted</div>` : ""}</td>
          <td class="right num hide-sm">${units(a.units_total)}<div class="sub">${units(a.units_epoch)} this epoch</div></td>
          <td class="right hide-sm">${when(a.registered_at)}</td>
        </tr>`;
    });
  const lHead = html`<thead><tr><th>Agent</th><th class="hide-sm">Target repo</th><th>State</th><th class="right">Compute vault</th><th class="right hide-sm">Generations</th><th class="right hide-sm">Units</th><th class="right hide-sm">Launched</th></tr></thead>`;
  const visible = launched.filter((a) => !a.shadow);
  const lTable2 = visible.length
    ? html`<div class="tw"><table class="t">${lHead}<tbody>${lRows(visible)}</tbody></table></div>${
        revealed.length
          ? html`<details class="more"><summary>Show ${revealed.length} revealed canary identities</summary><div class="tw"><table class="t">${lHead}<tbody>${lRows(revealed)}</tbody></table></div></details>`
          : ""
      }`
    : empty("No launched agents", "An agent token launch registers an authoring agent.");

  const vTable = verifiers.length
    ? html`<div class="tw"><table class="t">
      <thead><tr><th>Verifier</th><th class="right">Bond</th><th>Eligible</th><th class="right hide-sm">Strikes</th><th class="right hide-sm">Slashed</th><th class="right hide-sm">Units</th><th class="right hide-sm">Open replays</th></tr></thead>
      <tbody>${verifiers.map(
        (a) => html`<tr class="rowlink" data-href="/agents/${a.agent_id}">
          <td>${agentLink(a.agent_id)}${a.reference ? html` ${badge("reference runner", "info")}` : ""}<div class="sub">${a.operator ? `operator ${a.operator}` : "no operator declared"}</div></td>
          <td class="right">${token(a.bond)}${a.cooling ? html`<div class="sub">unbonding ${token(a.unbond?.amount)}</div>` : ""}</td>
          <td>${a.reference ? html`<span class="faint">reference only</span>` : a.eligible ? badge("eligible", "good", icon.check) : a.suspended ? badge("suspended", "bad", undefined, `no assignments through epoch ${a.suspended_through_epoch}`) : badge("not eligible", "", undefined, "below min bond, cooling, or at max open replays")}</td>
          <td class="right num hide-sm">${a.strikes_epoch}<div class="sub">${a.strikes_total} total</div></td>
          <td class="right hide-sm">${a.slashed_total === "0" ? html`<span class="faint">none</span>` : html`<span style="color:var(--bad)">${token(a.slashed_total)}</span>`}</td>
          <td class="right num hide-sm">${units(a.units_total)}<div class="sub">${units(a.units_epoch)} this epoch</div></td>
          <td class="right num hide-sm">${a.open_replays}</td>
        </tr>`,
      )}</tbody></table></div>`
    : empty("No verifiers", "Verifiers register by burning register_burn and bond to become eligible.");

  const bonded = verifiers.reduce((s, a) => s + BigInt(a.bond), 0n).toString();
  const vaults = launched.reduce((s, a) => s + BigInt(a.compute), 0n).toString();
  const slashed = verifiers.reduce((s, a) => s + BigInt(a.slashed_total), 0n).toString();
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Agents</div><h1>Authors and verifiers</h1>
      <div class="ph-sub">Launched agents author; bonded verifiers replay. Hosted agents never verify.</div></div></div>
    <section class="panel milled"><div class="stats" style="--n:5">
      ${stat("Launched", String(launched.length), `${awake} awake, ${launched.length - awake} asleep or setting up`)}
      ${stat("Compute vaults", token(vaults, { places: 2 }), "$LINE (placeholder), sum", "sm")}
      ${stat("Verifiers", String(verifiers.length), `${verifiers.filter((a) => a.eligible).length} eligible now`)}
      ${stat("Bonded", token(bonded, { places: 2 }), "slashable stake", "sm")}
      ${stat("Slashed", token(slashed, { places: 2 }), "moved to the compute reserve", "sm")}
    </div></section>
    <div style="margin-top:16px">${panel("Launched agents", lTable2, { count: launched.length, aside: html`<span>trading fees fund each compute vault</span>` })}</div>
    <div style="margin-top:16px">${panel("Verifiers", vTable, { count: verifiers.length })}</div>`;
  return { title: "Agents", body, refreshOn: (e) => /^(agent|units|generation|epoch|ledger)/.test(e.type) };
}

export async function agentPage([idp]: string[]): Promise<Page> {
  const id = idp!;
  const [a, counts, cands, evs] = await Promise.all([get(`agents/${id}`), genCounts(), get<any[]>(`candidates?author=${id}&limit=100`), recent({ agent: id, limit: 60 }), loadConfig(), loadLineageNames()]);
  const g = counts.get(id);
  const isL = a.kind === "launched";
  const head = isL ? "Launched agent" : a.reference ? "Reference runner" : "Verifier";
  const body = html`
    <div class="crumbs"><a href="/agents">Agents</a><span>/</span><span>${shortId(id)}</span></div>
    <div class="ph-row" style="margin-top:6px"><div class="ph-title"><h1>${head} <span class="dim" style="font-weight:500">${shortId(id)}</span></h1>
      <div class="ph-sub"><span class="hash full">${id}</span>
      ${isL ? (a.lifecycle === "setting_up" ? badge("setting up", "warn") : a.awake ? badge("awake", "good", icon.sun) : badge("asleep", "", icon.moon)) : a.eligible ? badge("eligible", "good", icon.check) : a.suspended ? badge("suspended", "bad") : ""}
      ${a.shadow ? badge("canary identity", "warn", icon.canary) : ""}</div></div></div>
    <section class="panel milled"><div class="stats" style="--n:5">
      ${isL ? stat("Compute vault", token(a.compute, { places: 2 }), "$LINE (placeholder)", "sm") : stat("Bond", token(a.bond, { places: 2 }), "$LINE (placeholder)", "sm")}
      ${isL ? stat("Generations", String(g?.accepted ?? 0), `${g?.reverted ?? 0} reverted`) : stat("Strikes", String(a.strikes_epoch), `this epoch, ${a.strikes_total} total`)}
      ${stat("Units", units(a.units_total), `${units(a.units_epoch)} this epoch`)}
      ${isL ? stat("Candidates", String(cands.length), `${cands.filter((c) => c.status === "rejected").length} rejected`) : stat("Slashed", a.slashed_total === "0" ? "none" : token(a.slashed_total, { places: 2 }), "total", "sm")}
      ${stat("Wallet", token(a.wallet, { places: 2 }), "agent wallet balance", "sm")}
    </div></section>
    <div class="grid-side" style="margin-top:16px">
      <div class="stack">
        ${
          isL
            ? panel(
                "Accepted generations",
                g?.gens.length
                  ? html`<div class="tw"><table class="t"><thead><tr><th>Generation</th><th>Effect (measured)</th><th>Audit</th><th class="right">Accepted</th></tr></thead><tbody>${[...g.gens]
                      .sort((x, y) => y.accepted_at - x.accepted_at)
                      .map(
                        (x) =>
                          html`<tr class="rowlink ${x.reverted_by ? "reverted" : ""}" data-href="/generations/${x.gen_id}"><td>${linLink(x.lineage_id)} ${genLink(x.gen_id, `#${x.height}`)}<div class="sub">${x.kind} ${target(x.target)}</div></td><td>${effect(x.effect, { compact: true })}</td><td>${auditBadge(x.audit_status)}</td><td class="right">${when(x.accepted_at)}</td></tr>`,
                      )}</tbody></table></div>`
                  : empty("No accepted generations yet", "Only reproduced improvements count."),
                { count: g?.gens.length ?? 0 },
              )
            : ""
        }
        ${
          isL
            ? panel(
                "Candidates",
                cands.length
                  ? html`<div class="tw"><table class="t"><thead><tr><th>Candidate</th><th>Status</th><th class="right">Committed</th></tr></thead><tbody>${cands.map(
                      (c) =>
                        html`<tr class="rowlink" data-href="/candidates/${c.candidate_id ?? c.commit_id}"><td>${linLink(c.lineage_id)} ${candLink(c.candidate_id ?? c.commit_id)}<div class="sub">${c.kind} ${target(c.target)}${
                          c.status !== "accepted" && typeof c.claimed_effect === "number" && c.kind !== "fix" ? html`, claims ${gainPct(1 - c.claimed_effect)} (unverified)` : ""
                        }</div></td><td class="wrap">${candStatus(c)}${c.detail ? html`<div class="sub">${c.detail}</div>` : ""}</td><td class="right">${when(c.committed_at)}</td></tr>`,
                    )}</tbody></table></div>`
                  : empty("No candidates", a.awake ? "This agent is awake and has not committed yet." : "Asleep agents cannot commit; fees refill the compute vault."),
                { count: cands.length },
              )
            : ""
        }
        ${panel("Activity", evs.events.length ? html`<div class="feed" style="max-height:640px">${evs.events.map((e) => feedItem(e))}</div>` : empty("No events held for this agent", "The dashboard keeps Core events it has seen since it started."), { count: evs.events.length, note: html`Replay events name only the candidate while it is open, so replays this agent ran appear after they settle as units and slashes.` })}
      </div>
      <div class="stack">
        ${panel(
          "Identity",
          kv([
            ["kind", a.kind],
            ["registered", stamp(a.registered_at)],
            ...(isL
              ? ([
                  ["mint", html`<span class="hash full">${a.mint}</span>`],
                  ["launcher", html`<span class="hash full">${a.launcher}</span>`],
                  ["target repo", repoLink(a.target_repo)],
                  ["runtime", a.hosted ? "hosted (never verifies)" : "self-hosted"],
                  ["GitHub identity", identityLabel(a.identity_mode)],
                  ["lifecycle", a.lifecycle],
                ] as [string, unknown][])
              : ([
                  ["operator", a.operator ?? html`<span class="faint">none declared</span>`],
                  ["reference runner", a.reference ? "yes" : "no"],
                  ["open replays", String(a.open_replays)],
                  ["cooling", a.cooling ? html`${token(a.unbond?.amount)} ready ${when(a.unbond?.ready_at)}` : "no"],
                  ["suspended", a.suspended ? `through epoch ${a.suspended_through_epoch}` : "no"],
                ] as [string, unknown][])),
          ]),
        )}
        ${panel(
          "Balances",
          kv([
            ["wallet", token(a.wallet)],
            ["bond", token(a.bond)],
            ["compute vault", token(a.compute)],
            ["slashed total", token(a.slashed_total)],
          ]),
          { note: html`Amounts in $LINE (placeholder), from Core's ledger, formatted with token_decimals.` },
        )}
      </div>
    </div>`;
  return { title: shortId(id), body, refreshOn: (e) => e.data?.agent === id || e.data?.author === id || /^(epoch|generation)/.test(e.type) };
}

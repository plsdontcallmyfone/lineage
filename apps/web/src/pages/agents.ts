import { get, loadConfig, loadLineageNames, recent } from "../api.ts";
import { feedItem } from "../feed.ts";
import { effect, gainPct, identityLabel, repoLabel, repoLink, shortId, stamp, target, token, units, when } from "../fmt.ts";
import { html } from "../html.ts";
import { agentLink, auditBadge, badge, candLink, candStatus, empty, genLink, icon, kv, linLink, panel, reasonText, stat } from "../ui.ts";
import { soulPanel } from "./soul.ts";
import { allLinksPanel, linksPanel } from "./links.ts";
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
  const links = await get<{ recheck_s: number; links: any[] }>("links").catch(() => null);
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
          <td class="right num hide-sm">${a.open_replays ?? html`<span class="faint">private</span>`}</td>
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
    <div style="margin-top:16px">${panel("Verifiers", vTable, { count: verifiers.length })}</div>
    <div style="margin-top:16px">${allLinksPanel(links)}</div>`;
  return { title: "Agents", body, refreshOn: (e) => /^(agent|units|generation|epoch|ledger|link)/.test(e.type) };
}

export async function agentPage([idp]: string[]): Promise<Page> {
  const id = idp!;
  const [a, counts, cands, evs, recs, teams, intents] = await Promise.all([get(`agents/${id}`), genCounts(), get<any[]>(`candidates?author=${id}&limit=100`), recent({ agent: id, limit: 60 }),
    get<{ epochs: { epoch: number; record_root: string; leaves: any[] }[] }>(`agents/${id}/records`).catch(() => ({ epochs: [] })),
    get<any[]>(`agents/${id}/teams`).catch(() => [] as any[]),
    get<{ stats: Record<string, number> }>(`agents/${id}/intents`).catch(() => null),
    loadConfig(), loadLineageNames()]);
  const soul = a.kind === "launched" ? await get<any>(`agents/${id}/soul`).catch(() => null) : null;
  const links = await get<any[]>(`agents/${id}/links`).catch(() => [] as any[]);
  // collaboration (SPEC 12): intent record and team candidates (final ones; open ones stay sealed)
  const collabPanel = panel(
    "Collaboration",
    html`${
      intents
        ? kv([
            ["intents filed", String(intents.stats.filed ?? 0)],
            ["open now", String(intents.stats.open ?? 0)],
            ["led to a candidate", String(intents.stats.led_to_candidate ?? 0)],
            ["led to a generation", String(intents.stats.led_to_generation ?? 0)],
            ["withdrawn, expired or stale", String((intents.stats.withdrawn ?? 0) + (intents.stats.expired ?? 0))],
          ])
        : ""
    }${
      teams.length
        ? html`<div class="eyebrow" style="padding:10px 14px 2px">Team candidates</div><div class="tw"><table class="t"><thead><tr><th>Candidate</th><th>Role and share</th></tr></thead><tbody>${teams.map((t) => {
            const me = t.team?.members.find((m: any) => m.agent === id);
            return html`<tr class="rowlink" data-href="/candidates/${t.candidate_id ?? t.commit_id}"><td>${candLink(t.candidate_id ?? t.commit_id)} ${candStatus(t)}<div class="sub">${t.kind} ${target(t.target)}${t.gen_id ? html`, became ${genLink(t.gen_id)}` : ""}</div></td><td>${me ? `${me.role}, ${(me.share_bps / 100).toFixed(2)}%` : ""}<div class="sub">${t.team?.members.length ?? 0} members</div></td></tr>`;
          })}</tbody></table></div>`
        : html`<div class="sub" style="padding:8px 14px">No final team candidates. Open ones stay sealed until final (SPEC 10.7).</div>`
    }`,
    { count: teams.length },
  );
  const g = counts.get(id);
  const isL = a.kind === "launched";
  const head = isL ? "Launched agent" : a.reference ? "Reference runner" : "Verifier";
  const body = html`
    <div class="crumbs"><a href="/agents">Agents</a><span>/</span><span>${shortId(id)}</span></div>
    <div class="ph-row" style="margin-top:6px"><div class="ph-title"><h1>${soul ? soul.doc.persona.name : head} <span class="dim" style="font-weight:500">${soul ? head.toLowerCase() : ""} ${shortId(id)}</span></h1>
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
        ${isL ? soulPanel(soul) : ""}
        ${linksPanel(id, links)}
        ${reputationPanel(id, recs.epochs)}
        ${collabPanel}
        ${panel("Activity", evs.events.length ? html`<div class="feed" style="max-height:640px">${evs.events.map((e) => feedItem(e))}</div>` : empty("No events held for this agent", "The dashboard keeps Core events it has seen since it started."), { count: evs.events.length, note: html`Replay events name only the candidate while it is open, so replays this agent ran appear after they settle as units and slashes.` })}
      </div>
      <div class="stack">
        ${panel(
          "Identity",
          kv([
            ["kind", a.kind],
            ["registered", stamp(a.registered_at)],
            ...(a.identity
              ? ([
                  ["signing key", a.identity.revoked ? badge("revoked by the owner", "bad") : a.identity.signing_key === id ? html`the agent key` : html`<span class="hash full">${a.identity.signing_key}</span>`],
                  ["key changes", String(a.identity.key_seq)],
                  ["owner", a.identity.owner ? html`<span class="hash full">${a.identity.owner}</span>` : html`<span class="faint">none</span>`],
                  ["controller since", stamp(a.identity.controller_since)],
                  ...(a.identity.pending_owner ? ([["pending owner", html`<span class="hash full">${a.identity.pending_owner}</span>`]] as [string, unknown][]) : []),
                ] as [string, unknown][])
              : []),
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
                  ["open replays", a.open_replays === null || a.open_replays === undefined ? html`<span class="faint">private until final</span>` : String(a.open_replays)],
                  ["cooling", a.cooling ? html`${token(a.unbond?.amount)} ready ${a.unbond?.ready_at ? when(a.unbond.ready_at) : "after its open work resolves"}` : "no"],
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
  return { title: soul ? `${soul.doc.persona.name} ${shortId(id)}` : shortId(id), body, refreshOn: (e) => e.data?.agent === id || e.data?.author === id || /^(epoch|generation)/.test(e.type) };
}

/** Per-epoch reputation records (identity plan I2), each a leaf under the epoch's onchain record_root. */
function reputationPanel(id: string, epochs: { epoch: number; record_root: string; leaves: any[] }[]) {
  const rows = epochs.flatMap((e) => e.leaves.filter((l) => l.kind === "record").map((l) => ({ ...l.record, root: e.record_root })));
  const authors = rows.filter((r) => r.role === "author");
  const verifiers = rows.filter((r) => r.role === "verifier");
  const contribs = epochs.flatMap((e) => e.leaves.filter((l) => l.kind === "contribution").map((l) => l.contribution));
  const sum = (m: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
  const author = authors.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Epoch</th><th>Lineage</th><th class="right">Final</th><th class="right">Accepted</th><th class="right">Rejected</th><th class="right">Reverted</th><th>Audits</th></tr></thead><tbody>${authors.map(
        (r) =>
          html`<tr><td class="num">${r.epoch}</td><td>${linLink(r.lineage_id)}</td><td class="right num">${r.candidates.final}</td><td class="right num">${r.candidates.accepted}</td><td class="right num" title="${Object.entries(r.rejections).map(([k, v]) => `${reasonText(k)}: ${v}`).join(", ")}">${r.candidates.rejected}</td><td class="right num">${r.reverted.length}</td><td>${Object.entries(r.audits).map(([k, v]) => `${k} ${v}`).join(", ") || html`<span class="faint">none</span>`}</td></tr>`,
      )}</tbody></table></div>`
    : "";
  const verifier = verifiers.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Epoch</th><th class="right">Replays</th><th class="right">Counted</th><th class="right">Minority</th><th class="right">Abandoned</th><th class="right">Canaries caught</th><th class="right">Canaries passed</th><th class="right">Strikes</th><th class="right">Slashed</th></tr></thead><tbody>${verifiers.map(
        (r) =>
          html`<tr><td class="num">${r.epoch}</td><td class="right num">${r.replays.assigned ?? 0}</td><td class="right num">${r.replays.counted ?? 0}</td><td class="right num">${r.replays.minority ?? 0}</td><td class="right num">${r.replays.abandoned ?? 0}</td><td class="right num">${r.canaries.caught}</td><td class="right num">${r.canaries.accepted}</td><td class="right num">${sum(r.strikes)}</td><td class="right">${r.slashed_total === "0" ? html`<span class="faint">none</span>` : token(r.slashed_total, { places: 2 })}</td></tr>`,
      )}</tbody></table></div>`
    : "";
  return panel(
    "Reputation records",
    rows.length || contribs.length
      ? html`${author}${verifier}${contribs.length ? html`<div class="sub" style="padding:8px 12px">${contribs.length} contribution ${contribs.length === 1 ? "leaf" : "leaves"} naming this agent (accepted generations with their members).</div>` : ""}
        <div class="sub" style="padding:8px 12px">Each row is a leaf under its epoch's <span class="num">record_root</span>, posted on chain with the epoch. <a class="link" href="/api/agents/${id}/credential" download="lineage-credential-${id}.json">Download the credential</a> and check it against the chain alone with <span class="num">bun scripts/verify-credential.ts --file &lt;credential&gt;</span>.</div>`
      : empty("No records yet", "Records cover what became final in closed epochs: candidates, replays, audits, strikes and slashes."),
    { count: rows.length },
  );
}

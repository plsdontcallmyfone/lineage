import { stamp, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtInt } from "../market.ts";
import { badge, empty, panel } from "../ui.ts";
import { axisLabels, legend, slot, vizSlot } from "./analytics-charts.ts";
import { levelBadge, shortSha, table } from "./analytics-ui.ts";
import { kpis, secs, usd } from "./insights-ui.ts";

// Section 1 additions (GET /v1/analytics/ops): the site monitor's last checks (backups included), the
// ops log of deploys, rollbacks and restore tests with measured downtime, desktop minutes, E2B USD and
// sandbox seconds per bucket. Rendered under the existing Network status block (analytics.ts).

export function opsSection(x: any): Raw {
  const lab = axisLabels(x.axis);
  const per = x.axis.unit === "hour" ? "hour" : "day";
  const m = x.monitor;
  const checks = m
    ? html`<div class="ins-pad an-sub">Last run ${when(m.at)}; worst ${levelBadge(m.worst)}. Checks every 5 minutes on the server: units, health, epochs, verifiers, spend caps, balances, disk and backups.</div>
      ${table(["Check", "State", "What it saw~"], m.checks.map((c: any) => [c.id, levelBadge(c.level), html`<span class="wrap">${c.msg}</span>`]))}`
    : empty("No monitor state here", "The site monitor writes its last run on the server (/var/lib/units-monitor/state.json); this Core runs outside it.");
  const backups = m ? m.checks.filter((c: any) => c.id.startsWith("backup")) : [];
  const rt = x.restore_tests[0];
  const backupBody = html`${kpis([
      ["Backups", backups.length ? (backups.every((c: any) => c.level === "ok") ? "fresh" : backups.some((c: any) => c.level === "fail") ? "stale" : "warning") : "TBA", backups.length ? backups.map((c: any) => c.msg).join("; ") : "from the monitor's backup checks"],
      ["Last restore test", rt ? html`${badge(rt.result ?? "TBA", rt.result === "PASS" ? "good" : "bad")}` : "TBA", rt ? html`${stamp(rt.ended_at)}, ${rt.passed ?? 0} checks passed, ${rt.failed ?? 0} failed` : "logged from the next restore test on (deploy.sh restore-test)"],
    ])}`;
  const d = x.deploys;
  const iw = d.in_window;
  const deployRows = d.log.map((e: any) => [
    html`<span class="num">${shortSha(e.sha)}</span>${e.kind === "rollback" ? html` ${badge("rollback")}` : ""}`,
    badge(e.result ?? "TBA", e.result === "ok" ? "good" : e.result === "rolled_back" ? "warn" : "bad"),
    stamp(e.started_at),
    e.public_at && e.started_at ? secs((e.public_at - e.started_at) / 1000) : "TBA",
    e.probe ? html`${fmtInt(e.probe.non_200)} of ${fmtInt(e.probe.probes)}` : "TBA",
    e.probe ? secs(e.probe.longest_gap_ms / 1000) : "TBA",
  ]);
  const rel = d.releases?.releases ?? [];
  const deploys = html`${kpis([
      ["Deploys", String(iw.deploys), `${iw.rollbacks} rollbacks in the window`],
      ["Rolled back", String(iw.rolled_back), `${iw.failed} failed with nothing to go back to`],
      ["Probes not 200", iw.probes ? `${fmtInt(iw.non_200)}` : "TBA", iw.probes ? `of ${fmtInt(iw.probes)} once a second while public units restarted` : "no logged deploy in the window"],
      ["Longest gap", iw.probes ? secs(iw.longest_gap_ms / 1000) : "TBA", "between two 200 answers"],
    ])}
    ${d.log.length ? table(["Release", "Result", "Started~", ".Public units up", ".Not 200", ".Longest gap~"], deployRows) : html`<p class="ins-pad an-sub">The ops log starts with the next deploy (scripts/deploy/remote.sh writes one line per deploy, rollback and restore test). Before it, only the release directories record deploys, without a downtime figure${rel.length ? `: ${rel.length} releases, newest ${stamp(rel[0].at)}` : ""}.</p>`}`;
  const desk = vizSlot({ kind: "stack", label: `desktop minutes per ${per}`, x: lab, fmt: "min", series: [{ name: "desktop minutes", cls: "acc", values: x.desktop_minutes.map((v: any) => v.minutes) }] }, 130);
  const e2b = x.e2b_daily.length
    ? vizSlot({ kind: "stack", label: "E2B USD per UTC day", x: x.e2b_daily.map((v: any) => v.day.slice(5)), fmt: "usd", series: [{ name: "E2B", cls: "c1", values: x.e2b_daily.map((v: any) => v.usd) }] }, 130)
    : html`<p class="ins-pad an-sub">Recorded from the runtime's spend reports from this release on (the highest E2B spend reported each UTC day).${x.live.desktops?.e2b ? html` Today so far: ${usd(x.live.desktops.e2b.spent_today_usd)} of ${usd(x.live.desktops.e2b.cap_usd)}.` : ""}</p>`;
  const classes: string[] = x.sandbox.classes;
  const sandbox = vizSlot({ kind: "stack", label: `sandbox seconds per ${per} by class`, x: lab, fmt: "s", series: classes.map((c, i) => ({ name: c, cls: slot(i), values: x.sandbox.series.map((s: any) => s[c] ?? 0) })) }, 130);
  const dl = x.live.desktops;
  const live = kpis([
    ["Live sessions", String(x.live.sessions), `${x.live.with_desktop} on a desktop`],
    ["This server", dl?.local ? `${dl.local.running} of ${dl.local.max}` : "TBA", "desktops running"],
    ["Desktop hosts", dl?.hosts ? `${dl.hosts.running} of ${dl.hosts.max}` : "none", dl?.hosts ? `${dl.hosts.up} of ${dl.hosts.count} hosts up` : "no host configured"],
    ["E2B", dl?.e2b ? `${dl.e2b.running} of ${dl.e2b.max}` : "TBA", "desktops running"],
    ["Stream viewers", "not published", x.viewers_note],
  ]);
  return html`
    ${panel("Live desktops by place", live)}
    <div class="grid-2">${panel("Service checks (site monitor)", checks, { count: m ? m.checks.length : undefined })}${panel("Backups and restore tests", backupBody)}</div>
    ${panel("Deploys and measured downtime", deploys, { count: d.log.length || undefined })}
    <div class="an-pairs panel">
      <h3>Desktop minutes <span>per ${per}, sessions that ran on a desktop</span></h3>${desk}
      <h3>E2B spend <span>USD per UTC day</span></h3>${e2b}
      <h3>Sandbox time <span>seconds per ${per} by class, published attempts</span></h3>${sandbox}${legend(classes.map((c, i) => ({ name: c, cls: slot(i) })))}
    </div>`;
}

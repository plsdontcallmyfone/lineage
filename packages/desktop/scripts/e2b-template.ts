#!/usr/bin/env bun
// Builds the E2B overflow template `lineage-desktop` (desktop hosts lane, 2026-10-10): E2B's own
// `desktop` template with the session's tools preinstalled (openbox, xterm, micro, ripgrep, xdotool,
// ffmpeg, git, x11-utils), sized to what one desktop was measured to use (SPEC 17.7: 25 % of a core
// steady, 38 % mean, up to 136 % on page loads; 505 to 635 MiB), with headroom: 2 vCPU, 4 GiB.
//
// Why: the stock `desktop` template runs at 8 vCPU and 8 GiB (nproc 8, MemTotal 8146768 kB, read on a
// real sandbox 2026-10-10), which E2B bills at 0.000148 USD/s (0.5328 USD per desktop-hour at the
// 2026-10-10 rates); this one bills 0.000046 USD/s (0.1656 USD per desktop-hour) and starts without
// the 25 s package install.
//
//   bun packages/desktop/scripts/e2b-template.ts [--name lineage-desktop] [--check]
//
// --check starts one sandbox from the built template, prints nproc, MemTotal and which tools are
// missing (none expected), and kills it. The key comes from ~/.config/lineage/e2b.env; never printed.
import { loadE2BKey, e2bUsdPerS } from "../src/e2b.ts";

const argv = process.argv.slice(2);
const name = argv.includes("--name") ? argv[argv.indexOf("--name") + 1]! : "lineage-desktop";
export const TEMPLATE_VCPU = 2;
export const TEMPLATE_MIB = 4096;
const key = loadE2BKey();
if (!key) {
  console.error("no E2B_API_KEY (~/.config/lineage/e2b.env)");
  process.exit(1);
}
process.env.E2B_API_KEY = key;
const { Template, Sandbox } = (await import("@e2b/desktop")) as any;

if (!argv.includes("--check-only")) {
  const t = Template()
    .fromTemplate("desktop")
    .runCmd("DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openbox xterm micro ripgrep xdotool ffmpeg git x11-utils && rm -rf /var/lib/apt/lists/*", { user: "root" });
  const t0 = Date.now();
  const info = await Template.build(t, name, { cpuCount: TEMPLATE_VCPU, memoryMB: TEMPLATE_MIB, onBuildLogs: (l: any) => process.stdout.write(`${String(l?.message ?? l).slice(0, 200)}\n`) });
  console.log(`built ${name} (${info?.templateId ?? "?"}) in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${TEMPLATE_VCPU} vCPU, ${TEMPLATE_MIB} MiB, ${e2bUsdPerS(TEMPLATE_VCPU, TEMPLATE_MIB / 1024).toFixed(6)} USD/s`);
}
if (argv.includes("--check") || argv.includes("--check-only")) {
  const t0 = Date.now();
  const s = await Sandbox.create(name, { timeoutMs: 120_000, metadata: { lineage: "1", attempt: "template-check" } });
  try {
    const r = await s.commands.run("nproc; grep MemTotal /proc/meminfo; for t in xdotool ffmpeg openbox xterm micro rg git xdpyinfo; do command -v $t >/dev/null || echo missing $t; done");
    console.log(r.stdout.trim());
  } finally {
    await s.kill();
    console.log(`check sandbox up ${((Date.now() - t0) / 1000).toFixed(1)} s in all`);
  }
}

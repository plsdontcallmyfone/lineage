import { join } from "node:path";
import { DesktopPool } from "../../desktop/src/pool.ts";
import type { RuntimeConfig } from "./config.ts";

// Agent desktops in the hosted runtime (SPEC 17.7): the slot pool (our server first, then E2B). The
// stream files for the gate and the recording publisher are in packages/desktop/src/publish.ts.

export { startRecordingPublisher, withDesktops } from "../../desktop/src/publish.ts";

export function desktopPool(cfg: RuntimeConfig, log: (m: string) => void): DesktopPool | null {
  const local = cfg.desktops_max ?? 0;
  const e2b = cfg.e2b_max ?? 0;
  if (local <= 0 && e2b <= 0 && !cfg.desktop_hosts_file) return null;
  const pool = new DesktopPool(
    {
      root: join(cfg.state_dir, "desktops"),
      desktops_max: local,
      e2b_max: e2b,
      desktop_usd_per_day: cfg.desktop_usd_per_day ?? 5,
      allow: cfg.desktop_allow ?? ["github.com", "githubusercontent.com", "githubassets.com"],
      e2b: cfg.e2b,
      recordings: cfg.recordings === true,
      // desktop hosts lane: hosts first (least loaded), every attempt waits for a desktop unless turned off
      hosts_file: cfg.desktop_hosts_file,
      required: cfg.desktop_required !== false,
    },
    { log },
  );
  const s = pool.status();
  log(`desktops: ${pool.hosts.size} desktop host(s) with ${[...pool.hosts.values()].reduce((n, b) => n + b.host.desktops_max, 0)} slots, ${local} on this server${pool.local.unavailable() ? ` (${pool.local.unavailable()})` : ""}, ${e2b} on E2B${pool.e2b.unavailable() ? ` (${pool.e2b.unavailable()})` : ""}; E2B spend today ${s.e2b.spent_today_usd.toFixed(4)} of ${s.e2b.cap_usd} USD; recordings ${pool.recording ? "on" : "off (live only)"}; desktop ${pool.required ? "required for every attempt" : "optional"}`);
  return pool;
}


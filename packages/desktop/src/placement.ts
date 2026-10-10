// Where a new desktop goes (desktop hosts lane, docs/plans/AGENT-DESKTOPS.md "Desktop hosts"):
// desktop hosts first, least loaded first; then the site's own slots; then E2B within its count and
// day cap. A slot that is down, full or over its budget is skipped with its reason, so when nothing is
// free the caller can say why.

export interface Slot {
  /** "host:<name>", "local" or "e2b" */
  key: string;
  kind: "host" | "local" | "e2b";
  running: number;
  max: number;
  /** null when this slot can take a desktop now (healthy, under budget), else why not */
  why: string | null;
}

/** Candidates in placement order: free hosts by load (running/max, then running, then config order), the site, E2B. */
export function placementOrder(slots: Slot[]): Slot[] {
  const free = (s: Slot) => s.why === null && s.running < s.max;
  const hosts = slots
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.kind === "host" && free(x.s))
    .sort((a, b) => a.s.running / a.s.max - b.s.running / b.s.max || a.s.running - b.s.running || a.i - b.i)
    .map((x) => x.s);
  return [...hosts, ...slots.filter((s) => s.kind === "local" && free(s)), ...slots.filter((s) => s.kind === "e2b" && free(s))];
}

/** Why no slot is free: each kind's state in one line. */
export function noSlotWhy(slots: Slot[]): string {
  const parts: string[] = [];
  const hosts = slots.filter((s) => s.kind === "host");
  if (hosts.length) {
    const up = hosts.filter((s) => s.why === null);
    if (!up.length) parts.push(`desktop hosts: ${hosts.length === 1 ? "the only one is" : `all ${hosts.length} are`} down`);
    else parts.push(`desktop hosts ${up.reduce((a, s) => a + s.running, 0)} of ${up.reduce((a, s) => a + s.max, 0)} busy${hosts.length > up.length ? ` (${hosts.length - up.length} of ${hosts.length} down)` : ""}`);
  } else parts.push("no desktop hosts");
  for (const k of ["local", "e2b"] as const) {
    const s = slots.find((x) => x.kind === k);
    if (!s || s.max === 0) continue;
    const label = k === "local" ? "this server" : "E2B";
    parts.push(s.why && s.running < s.max ? `${label}: ${s.why}` : `${label} ${s.running} of ${s.max} busy`);
  }
  return parts.join("; ");
}

// --------------------------------------------------------------------------------------- capacity

/**
 * One desktop as measured on the site (SPEC 17.7, 2026-10-10, 4 vCPU amd64): 38 % of a core mean over a
 * session (25 % steady, up to 136 % on page loads, capped at 1.5 CPUs) and 505 to 635 MiB.
 */
export const DESKTOP_MEASURED = { cpu_mean: 0.38, cpu_peak: 1.36, mib_peak: 635, measured_at: "2026-10-10", where: "site, 4 vCPU amd64" } as const;

/**
 * Headroom policy (a choice, not a measurement): keep 1 vCPU and 1 GiB for the host (sshd, Docker,
 * the proxy), plan the rest of the CPU at 70 % of its mean load so page-load peaks of a few desktops at
 * once still fit, and plan memory at 1.25 times the measured peak (trees live in each desktop's tmpfs).
 */
export const HEADROOM = { reserve_vcpu: 1, reserve_mib: 1024, cpu_target: 0.7, mem_factor: 1.25 } as const;

export function hostCapacity(h: { cpus: number; mem_mib: number }): { desktops_max: number; by_cpu: number; by_mem: number; basis: string } {
  const by_cpu = Math.max(0, Math.floor(((h.cpus - HEADROOM.reserve_vcpu) * HEADROOM.cpu_target) / DESKTOP_MEASURED.cpu_mean));
  const by_mem = Math.max(0, Math.floor((h.mem_mib - HEADROOM.reserve_mib) / (DESKTOP_MEASURED.mib_peak * HEADROOM.mem_factor)));
  const desktops_max = Math.min(by_cpu, by_mem, 16);
  return {
    desktops_max,
    by_cpu,
    by_mem,
    basis: `${h.cpus} vCPU, ${h.mem_mib} MiB: CPU (${h.cpus} - ${HEADROOM.reserve_vcpu}) x ${HEADROOM.cpu_target} / ${DESKTOP_MEASURED.cpu_mean} = ${by_cpu}; memory (${h.mem_mib} - ${HEADROOM.reserve_mib}) / (${DESKTOP_MEASURED.mib_peak} x ${HEADROOM.mem_factor}) = ${by_mem}; per desktop measured ${DESKTOP_MEASURED.measured_at} on the ${DESKTOP_MEASURED.where}`,
  };
}

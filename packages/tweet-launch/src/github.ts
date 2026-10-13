// Is it a public GitHub repository (docs/plans/TWEET-LAUNCH.md 2)? One unauthenticated GitHub API
// read. "unknown" (rate limit, outage) never refuses anyone: the link is given and the wizard checks.

export type RepoCheck = { state: "public"; full_name: string; size_kb: number } | { state: "missing" } | { state: "unknown"; why: string };

export async function checkRepo(api: string, owner: string, name: string, f: typeof fetch): Promise<RepoCheck> {
  try {
    const r = await f(`${api}/repos/${owner}/${name}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/vnd.github+json", "user-agent": "units-tweet-launch" } });
    if (r.status === 404) return { state: "missing" };
    if (!r.ok) return { state: "unknown", why: `GitHub API HTTP ${r.status}` };
    const j = (await r.json()) as { private?: boolean; full_name?: string; size?: number };
    if (j.private) return { state: "missing" };
    if (typeof j.full_name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(j.full_name)) return { state: "unknown", why: "GitHub API answer without a name" };
    return { state: "public", full_name: j.full_name, size_kb: typeof j.size === "number" ? j.size : 0 };
  } catch (e) {
    return { state: "unknown", why: (e as Error).message };
  }
}

/** The free reading of packages/runtime/src/unit-setup.ts: null when a unit can exist, else the sentence that says why not. Throws when the repository cannot be read now. */
export type ReadRepo = (url: string) => Promise<string | null>;

/**
 * The reading clones the repository. It gets a directory of its own (set as UNITS_HOME before the
 * sandbox code loads) and the clone is removed after every reading, so asked-for repositories do not
 * pile up on disk.
 */
export function readRepoFree(scratch: string): ReadRepo {
  return async (url) => {
    process.env.UNITS_HOME = scratch;
    const [{ readRepo }, { rmSync }] = await Promise.all([import("../../runtime/src/unit-setup.ts"), import("node:fs")]);
    try {
      const r = await readRepo(url);
      return r.ok ? null : r.impossible;
    } finally {
      for (const d of ["mirrors", "work"]) rmSync(`${scratch}/${d}`, { recursive: true, force: true });
    }
  };
}

// GitHub's unauthenticated REST limit is 60 requests an hour per address. Before a page calls the
// API it asks /rate_limit (free, and always 200), so a spent allowance shows as "not readable now"
// instead of a failed request; the answer is kept for a minute.
let cached: { at: number; left: Promise<number | null> } | null = null;

export function githubCallsLeft(): Promise<number | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.left;
  const left = fetch("https://api.github.com/rate_limit", { headers: { accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (typeof j?.resources?.core?.remaining === "number" ? (j.resources.core.remaining as number) : null))
    .catch(() => null);
  cached = { at: Date.now(), left };
  return left;
}

/** Note one call spent (the cached count stays honest between reads). */
export async function spendGithubCall() {
  if (!cached) return;
  const n = await cached.left;
  if (typeof n === "number") cached.left = Promise.resolve(Math.max(0, n - 1));
}

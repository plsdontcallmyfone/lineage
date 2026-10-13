// The launch form's check that agents can work on the repository, before the launcher pays (owner
// 2026-10-13, "clear comms"). Core reads the repository for free (GET /v1/repo-check, the same reading
// the hosted runtime makes after a launch) and this module turns its answer into the one plain line
// under the repository field of step "The work", and into whether the step may be left:
//   ready      agents already work on it;
//   set up     it has tests in a language agents can build; the agent sets up its measurement first;
//   cannot     the plain reason, and the step is held unless the launcher ticks "Launch anyway";
//   checking   Next waits;
//   neutral    the check did not run (service down, repository too large): said so, launch allowed.
// Pure except watchRepoCheck, which asks Core and asks again while a reading runs.
import { html, type Raw } from "../src/html.ts";

/** Core's answer (packages/core/src/repo-check.ts RepoCheck), or `failed` when the check itself did not answer. */
export type RepoCheck =
  | { state: "ready" }
  | { state: "can_set_up"; language: string; tests: number; tests_in: string[]; setup_minutes: number | null }
  | { state: "cannot"; cause: "tests" | "language" | "verifier" | "address"; language: string | null; seen: string | null; gpu: string[]; reason: string }
  | { state: "checking" }
  | { state: "unknown"; why: string }
  | { state: "failed" };

export interface RepoLine {
  kind: "ready" | "setup" | "cannot" | "checking" | "neutral";
  text: string;
}

export const CHECKING_LINE = "Checking that agents can work on it ...";
export const ANYWAY_LABEL = "Launch anyway; the agent waits until the repository can be measured";
const CANNOT = "Agents cannot work on this repository yet: ";
const STILL = "You can still launch; the agent reads the repository itself after the launch.";

const list = (a: string[]) => (a.length <= 1 ? (a[0] ?? "") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

/** The one line under the repository field. */
export function repoCheckLine(c: RepoCheck): RepoLine {
  if (c.state === "checking") return { kind: "checking", text: CHECKING_LINE };
  if (c.state === "ready") return { kind: "ready", text: "Agents already work on this repository." };
  if (c.state === "can_set_up") {
    const where = c.tests > 0 ? ` (${c.tests} ${c.tests === 1 ? "file" : "files"}${c.tests_in.length ? `, in ${list(c.tests_in)}` : ""})` : "";
    const usual = typeof c.setup_minutes === "number" && c.setup_minutes > 0 ? `, usually within ${c.setup_minutes} ${c.setup_minutes === 1 ? "minute" : "minutes"}` : "";
    return { kind: "setup", text: `It has tests in ${c.language}${where}; the agent sets up its measurement first${usual}.` };
  }
  if (c.state === "cannot") {
    if (c.cause === "tests") {
      const gpu = c.gpu.length ? ` Its code also needs a GPU (${list(c.gpu)}), and agents are measured on CPUs.` : "";
      return { kind: "cannot", text: `${CANNOT}it has no tests of its own, and every change must be checked by the repository's own tests.${gpu}` };
    }
    if (c.cause === "language") {
      // the languages with a toolchain are the reading's own list (its sentence ends with them)
      const can = /images exist for (.+)$/.exec(c.reason)?.[1] ?? null;
      return { kind: "cannot", text: `${CANNOT}${c.seen ? `it is mostly ${c.seen} files` : "no source code was found in it"}${can ? `, and agents can build ${can}` : ", and agents cannot build its language"}.` };
    }
    if (c.cause === "verifier") return { kind: "cannot", text: `${CANNOT}no verifier on this network checks ${c.language ?? "its language"} work yet.` };
    return { kind: "cannot", text: `${CANNOT}its address is not a public GitHub, GitLab or Codeberg repository.` };
  }
  if (c.state === "unknown") return { kind: "neutral", text: `${/too large/.test(c.why) ? "This repository is too large to check here." : "This repository could not be checked right now."} ${STILL}` };
  return { kind: "neutral", text: `The check that agents can work on it did not answer. ${STILL}` };
}

/** The line as markup, with the "Launch anyway" choice under a cannot. `anyway` keeps the box ticked across a re-render. */
export function repoCheckView(c: RepoCheck, anyway = false): Raw {
  const l = repoCheckLine(c);
  return html`<p class="lz-rc" id="w-repocheck" data-kind="${l.kind}" role="status">${l.text}</p>${l.kind === "cannot"
    ? html`<label class="radio lz-anyway"><input type="checkbox" name="rc_anyway"${anyway ? " checked" : ""}> <span>${ANYWAY_LABEL}</span></label>`
    : ""}`;
}

/** Why step "The work" cannot be left on this answer, or null. */
export function repoCheckProblem(c: RepoCheck | undefined, anyway: boolean): string | null {
  if (!c || c.state === "checking") return CHECKING_LINE;
  if (c.state === "cannot" && !anyway) return `${repoCheckLine(c).text} Tick "Launch anyway" to launch it regardless.`;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks Core, and again every `everyMs` while it answers `checking`; resolves with the final answer.
 * A check that does not answer (the service is down, the gate refuses, a reading that never ends) is
 * `failed`, never a "cannot". `alive` false stops the asking (the launcher typed another repository).
 */
export async function watchRepoCheck(repo: string, alive: () => boolean, o: { fetch?: typeof fetch; everyMs?: number; tries?: number } = {}): Promise<RepoCheck> {
  const f = o.fetch ?? fetch;
  for (let i = 0; i < (o.tries ?? 30) && alive(); i++) {
    try {
      const r = await f(`/api/repo-check?repo=${encodeURIComponent(repo)}`, { headers: { accept: "application/json" } });
      // the gate asks for a short wait: ask once more after it
      if (r.status === 429 && Number(r.headers.get("retry-after") ?? 99) <= 10) {
        await sleep(Number(r.headers.get("retry-after")) * 1000 + 250);
        continue;
      }
      if (!r.ok) return { state: "failed" };
      const b = (await r.json()) as RepoCheck;
      if (!b || typeof b !== "object" || !["ready", "can_set_up", "cannot", "checking", "unknown"].includes(b.state)) return { state: "failed" };
      if (b.state !== "checking") return b;
    } catch {
      return { state: "failed" };
    }
    await sleep(o.everyMs ?? 3000);
  }
  return { state: "failed" };
}

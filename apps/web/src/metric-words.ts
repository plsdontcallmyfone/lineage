// Plain words for a unit's metric (the Bounties post form). Everything here is derived from what Core
// serves about the metric: its name, kind, direction, whether it is deterministic, and, once the unit
// is read, its parser and the recipe's class. Nothing is listed per recipe; a metric nothing can be
// derived for keeps its raw name with its kind. No figure is made here: values come from Core.

export interface MetricFacts { name: string; kind: string; direction: string; deterministic?: boolean; parser?: string | null; cls?: string | null }
export type MetricSort = "instructions" | "bytes" | "compute_units" | "time" | "other";
export interface MetricWords {
  sort: MetricSort;
  /** the option's text: the human label with the raw name after it */
  label: string;
  /** what one unit of the value is, plural ("CPU instructions"); empty when unknown */
  noun: string;
  /** one or two sentences: what is measured */
  what: string;
}

const SUFFIX: [RegExp, MetricSort, string][] = [
  [/_ir$/, "instructions", "CPU instructions"],
  [/_bytes$/, "bytes", "bytes"],
  [/_cu$/, "compute_units", "compute units"],
  [/_ns$/, "time", "nanoseconds"],
  [/_us$/, "time", "microseconds"],
  [/_ms$/, "time", "milliseconds"],
];
// what a build artifact's short name stands for (file kinds, not recipes)
const ARTIFACT: Record<string, string> = { rlib: "library", lib: "library", so: "program", bin: "binary", wasm: "wasm module", exe: "binary" };
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function metricWords(m: MetricFacts): MetricWords {
  const hit = SUFFIX.find(([re]) => re.test(m.name));
  const stem = (hit ? m.name.replace(hit[0], "") : m.name).replace(/_+/g, " ").trim();
  const p = m.parser ?? "";
  const sort: MetricSort = p === "cachegrind-ir" ? "instructions" : p === "bytes" || p === "file-size" ? "bytes" : p === "time" ? "time"
    : hit ? hit[1] : m.cls === "solana" && p === "number" ? "compute_units" : m.kind === "slim" ? "bytes" : "other";
  const better = m.direction === "higher" ? "higher is better" : "lower is better";
  const exact = m.deterministic ? " The count is exact: every replay gets the same number." : "";
  if (sort === "instructions") return { sort, noun: "CPU instructions", label: `${cap(stem)} speed, in CPU instructions (${m.name})`,
    what: `Counts the CPU instructions this unit's ${stem} benchmark executes. Fewer instructions means faster code.${exact}` };
  if (sort === "bytes") {
    const thing = ARTIFACT[stem] ?? stem;
    return { sort, noun: "bytes", label: `${cap(thing)} size, in bytes (${m.name})`, what: `The size of the built ${thing}, in bytes. Smaller is better.${m.deterministic ? " Every replay gets the same number." : ""}` };
  }
  if (sort === "compute_units") return { sort, noun: "compute units", label: `${cap(stem)} cost, in Solana compute units (${m.name})`,
    what: `The Solana compute units the ${stem} path of this program uses. Fewer units means it is cheaper to run.${exact}` };
  if (sort === "time") {
    const noun = hit?.[1] === "time" ? hit[2] : "time";
    return { sort, noun: noun === "time" ? "" : noun, label: `${cap(stem)} time${noun === "time" ? "" : `, in ${noun}`} (${m.name})`,
      what: `The wall-clock time of this unit's ${stem} benchmark. It varies from run to run, so each replay times several runs and medians are compared.` };
  }
  return { sort, noun: "", label: `${m.name} (${m.kind}, ${better})`, what: `A ${m.kind} metric of this unit; ${better}.` };
}

const whole = (n: number) => Math.round(n).toLocaleString("en-US");
/** A measured value in the metric's own terms: "643,223,147 CPU instructions". */
export const metricValue = (value: number, w: MetricWords): string => `${whole(value)}${w.noun ? ` ${w.noun}` : ""}`;

/**
 * What an improvement of `pct` percent asks for, counted from a value Core measured:
 * "from 149,988,301 CPU instructions to 142,488,885 or fewer". Null when either number is unusable.
 */
export function improvementExample(value: number | null | undefined, pct: number, m: MetricFacts, w: MetricWords): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0 || !Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  const higher = m.direction === "higher";
  // never round toward the easy side: the number shown always meets the requirement
  const goal = higher ? Math.ceil(value * (1 + pct / 100)) : Math.floor(value * (1 - pct / 100));
  return `from ${metricValue(value, w)} to ${whole(goal)} or ${higher ? "more" : w.sort === "bytes" || w.sort === "time" ? "less" : "fewer"}`;
}

/** A repository as owner/repo, or null for a unit whose repository is not a public one (a test fixture). */
export function publicRepo(url: string | null | undefined): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? m[1]! : null;
}

/** The deadline choices the on-chain limits allow, in days, and the one selected first (a week where allowed). */
export function deadlineChoices(minTtlS: number, maxTtlS: number): { days: number[]; first: number | null } {
  const days = [1, 3, 7, 14, 30].filter((d) => d * 86_400 >= minTtlS && d * 86_400 <= maxTtlS);
  return { days, first: days.includes(7) ? 7 : days.filter((d) => d < 7).pop() ?? days[0] ?? null };
}
export const daysLabel = (d: number): string => (d === 1 ? "1 day" : d === 7 ? "1 week" : d === 14 ? "2 weeks" : `${d} days`);

/** A pledge as typed, in US dollars to the cent; null when it is not a usable figure. */
export function pledgeUsd(text: string, max = 100_000): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return 0;
  const n = Number(t);
  return /^\d+(\.\d+)?$/.test(t) && Number.isFinite(n) && n <= max ? Math.round(n * 100) / 100 : null;
}

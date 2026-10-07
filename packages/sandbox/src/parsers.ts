// Output parsers named by recipes (SPEC 6). Test parsers return passing and failing test ids;
// metric parsers return one number per run.

export interface TestOutcome {
  pass: string[];
  fail: string[];
  /** true when the output looked like a test run at all; false means the harness crashed */
  recognised: boolean;
}

/**
 * Rust libtest human output from `cargo test`. Ids are `<target>::<test name>`.
 * Hardened against output printed BY the tested code (adversarial review 2026-10-07):
 * - lines inside a failed test's captured output ("---- name stdout ----") are ignored;
 * - every name in a "failures:" list is failing, whatever ok lines say;
 * - per target, the parsed counts must equal libtest's "test result:" totals, or every test of
 *   that target counts as failing;
 * - an id reported more than once counts as failing.
 */
export function parseLibtest(out: string): TestOutcome {
  const pass: string[] = [];
  const fail: string[] = [];
  let target = "unknown";
  let recognised = false;
  let inCaptured = false;
  let inFailureList = false;
  let tPass: string[] = [];
  let tFail: string[] = [];
  const listed = new Set<string>();
  const close = (declaredPass: number, declaredFail: number) => {
    const forced = tPass.filter((id) => listed.has(id));
    let p = tPass.filter((id) => !listed.has(id));
    let f = [...tFail, ...forced];
    if (p.length + f.length !== declaredPass + declaredFail || p.length > declaredPass) {
      f = [...f, ...p];
      p = [];
    }
    pass.push(...p);
    fail.push(...f);
    tPass = [];
    tFail = [];
    listed.clear();
  };
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    if (/^---- .+ (stdout|stderr) ----$/.test(line)) {
      inCaptured = true;
      continue;
    }
    if (line === "failures:") {
      inCaptured = false;
      inFailureList = true;
      continue;
    }
    let m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line);
    if (m) {
      inCaptured = false;
      inFailureList = false;
      close(Number(m[1]), Number(m[2]));
      continue;
    }
    if (inCaptured) continue;
    if (inFailureList) {
      const n = /^ {4}(\S.*)$/.exec(raw);
      if (n) listed.add(`${target}::${n[1]!.trim()}`);
      continue;
    }
    m = /^\s*Running (?:unittests )?(\S+)/.exec(line);
    if (m) {
      target = m[1]!;
      recognised = true;
      continue;
    }
    m = /^\s*Doc-tests (\S+)/.exec(line);
    if (m) {
      target = `doc:${m[1]}`;
      recognised = true;
      continue;
    }
    m = /^test (.+?) \.\.\. (ok|FAILED|ignored.*)$/.exec(line);
    if (m) {
      recognised = true;
      const id = `${target}::${m[1]}`;
      if (m[2] === "ok") tPass.push(id);
      else if (m[2] === "FAILED") tFail.push(id);
    }
  }
  // a target whose summary never printed (crash, or output cut off) fails everything it reported
  fail.push(...tPass, ...tFail);
  return dedupe({ pass, fail, recognised });
}

/** JUnit XML (pytest --junitxml, many others). Ids are `<classname>::<name>`. */
export function parseJunit(xml: string): TestOutcome {
  const pass: string[] = [];
  const fail: string[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1] ?? "";
  let m: RegExpExecArray | null;
  let recognised = /<testsuite/.test(xml);
  while ((m = re.exec(xml))) {
    recognised = true;
    const id = `${attr(m[1]!, "classname")}::${attr(m[1]!, "name")}`;
    const body = m[3] ?? "";
    if (/<skipped\b/.test(body)) continue;
    if (/<(failure|error)\b/.test(body)) fail.push(id);
    else pass.push(id);
  }
  return dedupe({ pass, fail, recognised });
}

/**
 * TAP version 13/14. Ids are the test descriptions. An id seen more than once fails, and when a
 * plan line ("1..N") is present the number of distinct ids must equal N or every test fails.
 */
export function parseTap(out: string): TestOutcome {
  let pass: string[] = [];
  let fail: string[] = [];
  let recognised = false;
  let plan: number | null = null;
  const skipped: string[] = [];
  for (const line of out.split("\n")) {
    const p = /^1\.\.(\d+)\s*$/.exec(line.trim());
    if (p) {
      plan = plan === null ? Number(p[1]) : -1; // two plans: someone else is printing TAP
      continue;
    }
    const m = /^(not ok|ok)\s+\d+\s*(?:-\s*)?(.*?)(\s+#\s*(SKIP|TODO).*)?$/i.exec(line.trim());
    if (!m) continue;
    recognised = true;
    if (m[4]) {
      skipped.push(m[2]!);
      continue;
    }
    (m[1] === "ok" ? pass : fail).push(m[2]!);
  }
  const ids = new Set([...pass, ...fail, ...skipped]);
  if (plan !== null && plan !== ids.size) {
    fail = [...fail, ...pass];
    pass = [];
  }
  return dedupe({ pass, fail, recognised });
}

/** Any id reported more than once, or both passing and failing, is failing. */
function dedupe(o: TestOutcome): TestOutcome {
  const seen = new Map<string, number>();
  for (const id of [...o.pass, ...o.fail]) seen.set(id, (seen.get(id) ?? 0) + 1);
  const failSet = new Set(o.fail);
  const pass = [...new Set(o.pass.filter((id) => !failSet.has(id) && seen.get(id) === 1))];
  const fail = [...new Set([...o.fail, ...o.pass.filter((id) => failSet.has(id) || (seen.get(id) ?? 0) > 1)])];
  return { pass, fail, recognised: o.recognised };
}

export function parseTests(parser: string, stdout: string, stderr: string, junit?: string): TestOutcome {
  switch (parser) {
    case "libtest":
      return parseLibtest(stdout + "\n" + stderr);
    case "junit":
      return parseJunit(junit ?? "");
    case "tap":
      return parseTap(stdout);
    default:
      throw new Error(`unknown test parser ${parser}`);
  }
}

/**
 * Instruction count from a cachegrind or callgrind summary ("==12== I refs: 47,137,386"). Only
 * lines carrying the pid valgrind printed in its own banner count, and the LAST such summary wins
 * (valgrind writes it after the client exits). The sandbox also routes valgrind's log to its own
 * descriptor and discards the program's output (evaluate.ts isolateMetric).
 */
export function parseCachegrindIr(out: string): number {
  const banner = /^==(\d+)== (?:Cachegrind|Callgrind), a /m.exec(out);
  if (!banner) throw new Error("valgrind banner not found");
  const pid = banner[1];
  const re = new RegExp(`^==${pid}== I\\s+refs:\\s+([\\d,]+)\\s*$`, "gm");
  let last: string | null = null;
  for (let m = re.exec(out); m; m = re.exec(out)) last = m[1]!;
  if (last === null) throw new Error("valgrind summary not found");
  return Number(last.replace(/,/g, ""));
}

/** Last numeric line of stdout. */
export function parseNumber(out: string): number {
  const lines = out.trim().split("\n").reverse();
  for (const l of lines) {
    const v = Number(l.trim());
    if (l.trim() !== "" && Number.isFinite(v)) {
      if (v <= 0) throw new Error(`metric value must be positive, got ${v}`);
      return v;
    }
  }
  throw new Error("no number in output");
}

/** Size in bytes reported by `stat -c %s` or `wc -c` (first integer in output). */
export function parseBytes(out: string): number {
  const m = /(\d+)/.exec(out);
  if (!m) throw new Error("no byte count in output");
  const v = Number(m[1]);
  if (v <= 0) throw new Error("byte count must be positive");
  return v;
}

/** One CSV record (RFC 4180 quoting, as Nsight Compute writes it). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export const NCU_INST_METRIC = "smsp__inst_executed.sum";
const UNIT_SCALE: Record<string, number> = { inst: 1, Kinst: 1e3, Minst: 1e6, Ginst: 1e9 };

/**
 * Executed warp instructions from `ncu --csv --metrics smsp__inst_executed.sum` (SPEC 6.1, cuda
 * class): the metric summed over every profiled kernel launch, optionally only launches whose
 * kernel name matches `kernel` (a regular expression). Accepts the default long format (one row
 * per kernel and metric: "Kernel Name", "Metric Name", "Metric Value") and `--page raw` (one row per
 * kernel, one column per metric, a units row first). Lines that are not part of the CSV table
 * (==PROF== messages, program output) are ignored. Thousands separators are removed.
 */
export function parseNcuInst(out: string, kernel?: string): number {
  const re = kernel ? new RegExp(kernel) : null;
  let header: string[] | null = null;
  let total = 0;
  let rows = 0;
  let rawScale = 1;
  const num = (v: string) => {
    const x = Number(v.replace(/,/g, "").trim());
    if (!Number.isFinite(x) || x < 0) throw new Error(`ncu metric value is not a non-negative number: ${v}`);
    return x;
  };
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const f = parseCsvLine(line);
    if (f[0] === "ID" && f.includes("Kernel Name")) {
      // a later header restarts the table: only ncu's own (final) report counts
      header = f;
      total = 0;
      rows = 0;
      rawScale = 1;
      continue;
    }
    if (!header) continue;
    const col = (name: string) => header!.indexOf(name);
    const kname = f[col("Kernel Name")] ?? "";
    if (re && !re.test(kname)) continue;
    const mName = col("Metric Name");
    if (mName >= 0) {
      if (f[mName] !== NCU_INST_METRIC) continue;
      // `--print-units base` keeps "inst"; the default auto-scaling may print Kinst, Minst, Ginst
      const unit = f[col("Metric Unit")] ?? "inst";
      const scale = UNIT_SCALE[unit];
      if (scale === undefined) throw new Error(`unexpected ncu unit ${unit} for ${NCU_INST_METRIC}`);
      total += Math.round(num(f[col("Metric Value")] ?? "") * scale);
      rows++;
    } else {
      const c = col(NCU_INST_METRIC);
      if (c < 0) continue;
      if (f[0] === "") {
        const unitScale = UNIT_SCALE[f[c] ?? "inst"]; // the units row of --page raw
        if (unitScale === undefined) throw new Error(`unexpected ncu unit ${f[c]} for ${NCU_INST_METRIC}`);
        rawScale = unitScale;
        continue;
      }
      total += Math.round(num(f[c] ?? "") * rawScale);
      rows++;
    }
  }
  if (!header) throw new Error("ncu CSV header not found");
  if (rows === 0) throw new Error(`no ${NCU_INST_METRIC} rows${kernel ? ` for kernels matching ${kernel}` : ""}`);
  return total;
}

export function parseMetric(parser: string, stdout: string, stderr: string): number {
  // ncu-inst or ncu-inst:<kernel name regex>
  if (parser === "ncu-inst" || parser.startsWith("ncu-inst:")) return parseNcuInst(stdout + "\n" + stderr, parser.slice("ncu-inst:".length) || undefined);
  switch (parser) {
    case "cachegrind-ir":
      return parseCachegrindIr(stderr + "\n" + stdout);
    case "number":
      return parseNumber(stdout);
    case "bytes":
      return parseBytes(stdout);
    default:
      throw new Error(`unknown metric parser ${parser}`);
  }
}

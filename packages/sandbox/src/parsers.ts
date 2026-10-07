// Output parsers named by recipes (SPEC 6). Test parsers return passing and failing test ids;
// metric parsers return one number per run.

export interface TestOutcome {
  pass: string[];
  fail: string[];
  /** true when the output looked like a test run at all; false means the harness crashed */
  recognised: boolean;
}

/** Rust libtest human output from `cargo test`. Ids are `<target>::<test name>`. */
export function parseLibtest(out: string): TestOutcome {
  const pass: string[] = [];
  const fail: string[] = [];
  let target = "unknown";
  let recognised = false;
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    let m = /^\s*Running (?:unittests )?(\S+)/.exec(line);
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
      if (m[2] === "ok") pass.push(id);
      else if (m[2] === "FAILED") fail.push(id);
    }
  }
  return { pass, fail, recognised };
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
  return { pass, fail, recognised };
}

/** TAP version 13/14. Ids are the test descriptions. */
export function parseTap(out: string): TestOutcome {
  const pass: string[] = [];
  const fail: string[] = [];
  let recognised = false;
  for (const line of out.split("\n")) {
    const m = /^(not ok|ok)\s+\d+\s*(?:-\s*)?(.*?)(\s+#\s*(SKIP|TODO).*)?$/i.exec(line.trim());
    if (!m) continue;
    recognised = true;
    if (m[4]) continue;
    (m[1] === "ok" ? pass : fail).push(m[2]!);
  }
  return { pass, fail, recognised };
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

/** Instruction count from cachegrind's summary ("I refs: 47,137,386"). */
export function parseCachegrindIr(out: string): number {
  const m = /I\s+refs:\s+([\d,]+)/.exec(out);
  if (!m) throw new Error("cachegrind summary not found");
  return Number(m[1]!.replace(/,/g, ""));
}

/** Last numeric line of stdout. */
export function parseNumber(out: string): number {
  const lines = out.trim().split("\n").reverse();
  for (const l of lines) {
    const v = Number(l.trim());
    if (l.trim() !== "" && Number.isFinite(v)) return v;
  }
  throw new Error("no number in output");
}

/** Size in bytes reported by `stat -c %s` or `wc -c` (first integer in output). */
export function parseBytes(out: string): number {
  const m = /(\d+)/.exec(out);
  if (!m) throw new Error("no byte count in output");
  return Number(m[1]);
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
    if (!Number.isFinite(x)) throw new Error(`ncu metric value is not a number: ${v}`);
    return x;
  };
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const f = parseCsvLine(line);
    if (f[0] === "ID" && f.includes("Kernel Name")) {
      header = f;
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
        rawScale = UNIT_SCALE[f[c] ?? "inst"]; // the units row of --page raw
        if (rawScale === undefined) throw new Error(`unexpected ncu unit ${f[c]} for ${NCU_INST_METRIC}`);
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

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

export function parseMetric(parser: string, stdout: string, stderr: string): number {
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

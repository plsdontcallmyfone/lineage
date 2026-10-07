import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ensureCommit on a repository seen for the first time makes a single-commit shallow mirror,
// and a later commit is fetched into it by id.
test("ensureCommit fetches one commit into a new shallow mirror", async () => {
  const home = mkdtempSync(join(tmpdir(), "lineage-shallow-"));
  const prev = process.env.LINEAGE_HOME;
  process.env.LINEAGE_HOME = home;
  try {
    const src = join(home, "src");
    const run = (args: string[], cwd = src) => {
      const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
      return p.stdout.toString().trim();
    };
    Bun.spawnSync(["mkdir", "-p", src]);
    run(["init", "-q", "-b", "main"]);
    const shas: string[] = [];
    for (const n of [1, 2, 3]) {
      writeFileSync(join(src, "f.txt"), `v${n}\n`);
      run(["add", "-A"]);
      run(["commit", "-q", "-m", `c${n}`]);
      shas.push(run(["rev-parse", "HEAD"]));
    }
    const url = `file://${src}`;
    const repo = await import(`../src/repo.ts?shallow=${Date.now()}`);
    const mirror: string = repo.ensureCommit(url, shas[1]);
    expect(mirror.startsWith(home)).toBe(true);
    expect(existsSync(mirror)).toBe(true);
    expect(run(["rev-parse", "--is-shallow-repository"], mirror)).toBe("true");
    expect(run(["rev-list", "--count", shas[1]!], mirror)).toBe("1");
    expect(run(["cat-file", "-t", shas[1]!], mirror)).toBe("commit");
    // a later commit arrives by id, still without history
    expect(repo.ensureCommit(url, shas[2])).toBe(mirror);
    expect(run(["cat-file", "-t", shas[2]!], mirror)).toBe("commit");
    expect(Bun.spawnSync(["git", "cat-file", "-e", `${shas[0]}^{commit}`], { cwd: mirror }).exitCode).not.toBe(0);
    // materialize works from the shallow mirror
    const dest = join(home, "tree");
    repo.materialize(url, shas[1], null, dest);
    expect(Bun.file(join(dest, "f.txt")).size).toBe(3);
  } finally {
    if (prev === undefined) delete process.env.LINEAGE_HOME;
    else process.env.LINEAGE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// Regression (adversarial review 2026-10-07): repository symlinks must not let the author ToolBox read or write outside the tree.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBox } from "../src/proposers/anthropic.ts";


test("read_file and write_file refuse repo symlinks that point outside the tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "lineage-tb-"));
  try {
    const tree = join(root, "tree");
    mkdirSync(join(tree, "src"), { recursive: true });
    // stand-ins for host secrets outside the tree (e.g. ~/.config/lineage/model.env, an agent key)
    writeFileSync(join(root, "model.env"), "ANTHROPIC_API_KEY=sk-ant-SECRET\n");
    writeFileSync(join(root, "victim.txt"), "original\n");
    // a malicious upstream repo ships these symlinks (git archive preserves them)
    symlinkSync(join(root, "model.env"), join(tree, "src", "notes.txt"));
    symlinkSync(join(root, "victim.txt"), join(tree, "src", "lib.rs"));
    const ctx: any = {
      tree,
      loaded: { recipe: { patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 5, max_lines: 200 } } },
      activity: () => {},
      log: () => {},
    };
    const tb = new ToolBox(ctx, 1);
    await expect(tb.run("read_file", { path: "src/notes.txt" })).rejects.toThrow();
    await expect(tb.run("write_file", { path: "src/lib.rs", contents: "pwned\n" })).rejects.toThrow();
    await expect(tb.run("edit_file", { path: "src/lib.rs", old_string: "original", new_string: "pwned" })).rejects.toThrow();
    expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("original\n");
    // a symlinked directory is refused too
    symlinkSync(root, join(tree, "src", "outside"));
    await expect(tb.run("read_file", { path: "src/outside/model.env" })).rejects.toThrow();
    // normal files still work
    writeFileSync(join(tree, "src", "ok.rs"), "fn a() {}\n");
    expect(await tb.run("read_file", { path: "src/ok.rs" })).toContain("fn a()");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

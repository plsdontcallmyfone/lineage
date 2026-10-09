#!/usr/bin/env bun
// Builds packages/embed/dist/lineage-embed.js: one dependency-free file (an IIFE, so it works as a
// classic <script> and also when loaded with type="module"). apps/web/server.ts serves the same build
// at /embed/lineage-embed.js.
//
//   bun packages/embed/scripts/build.ts [--out <file>] [--dev]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// the stylesheet modules are template strings of CSS: drop indentation and comments before bundling
const cssWhitespace: import("bun").BunPlugin = {
  name: "css-whitespace",
  setup(b) {
    b.onLoad({ filter: /(live-panel\/style|embed\/src\/styles)\.ts$/ }, async (a) => {
      const src = await Bun.file(a.path).text();
      const out = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n[ \t]+/g, "\n").replace(/\n{2,}/g, "\n").replace(/ *([{};,]) *\n/g, "$1\n");
      return { contents: out, loader: "ts" };
    });
  },
};

export async function buildEmbed(opts: { dev?: boolean; entry?: "index" | "explorer-entry" } = {}): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(import.meta.dir, `../src/${opts.entry ?? "index"}.ts`)],
    target: "browser",
    format: "iife",
    minify: !opts.dev,
    sourcemap: opts.dev ? "inline" : "none",
    plugins: opts.dev ? [] : [cssWhitespace],
  });
  if (!out.success) throw new Error(out.logs.map((l) => String(l)).join("\n"));
  return `/* ${opts.entry === "explorer-entry" ? "lineage-explorer.js" : "lineage-embed.js"} ${new Date().toISOString().slice(0, 10)}, docs/EMBED.md */\n${await out.outputs[0]!.text()}`;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out");
  const file = i > 0 ? process.argv[i + 1]! : join(import.meta.dir, "../dist/lineage-embed.js");
  const dev = process.argv.includes("--dev");
  mkdirSync(dirname(file), { recursive: true });
  for (const [f, js] of [[file, await buildEmbed({ dev })], [join(dirname(file), "lineage-explorer.js"), await buildEmbed({ dev, entry: "explorer-entry" })]] as const) {
    writeFileSync(f, js);
    const gz = Bun.gzipSync(new TextEncoder().encode(js)).length;
    console.log(`${f}: ${(js.length / 1024).toFixed(1)} KB minified, ${(gz / 1024).toFixed(1)} KB gzip`);
  }
}

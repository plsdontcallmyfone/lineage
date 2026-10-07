// Bun.build plugin for a browser bundle that imports @lineage/chain or @lineage/protocol: maps the
// node builtins those packages import to the browser stand-ins in this directory. Entries must
// import "@lineage/chain/browser" (or ./buffer.ts) first so globalThis.Buffer exists at load.
import type { BunPlugin } from "bun";
import { join } from "node:path";

const here = import.meta.dir;
export const chainBrowserPlugin: BunPlugin = {
  name: "lineage-chain-browser",
  setup(build) {
    build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: join(here, "node-crypto.ts") }));
    build.onResolve({ filter: /^(node:)?(fs|path|os)$/ }, () => ({ path: join(here, "node-stub.ts") }));
  },
};

/** Builds one browser entry with the plugin; returns the JS text. */
export async function buildBrowserBundle(entry: string, opts: { minify?: boolean; sourcemap?: boolean } = {}): Promise<string> {
  const out = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: opts.minify ?? true, sourcemap: opts.sourcemap ? "inline" : "none",
    plugins: [chainBrowserPlugin] });
  if (!out.success) throw new Error(out.logs.map((l) => String(l)).join("\n"));
  return out.outputs[0]!.text();
}

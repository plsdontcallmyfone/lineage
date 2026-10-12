#!/usr/bin/env bun
// Builds the two bundles the dashboard server builds (app and wallet) into <out>/app.js and
// <out>/wallet.js, the same way apps/web/server.ts does. Run as its own process by
// bundle-leak.test.ts: inside `bun test` an earlier in-process Bun.build from another test file
// (at the time: the docs build) leaves the bundler unable to resolve a package installed only under
// apps/web/node_modules ("Could not resolve: lightweight-charts"), which the server never sees.
import { join } from "node:path";
import { chainBrowserPlugin } from "../../../packages/chain/src/browser/plugin.ts";

const ROOT = join(import.meta.dir, "../../..");
const out = process.argv[2];
if (!out) throw new Error("usage: build-bundles.ts <out dir>");
const app = await Bun.build({ entrypoints: [join(ROOT, "apps/web/src/main.ts")], target: "browser", minify: true });
const wallet = await Bun.build({ entrypoints: [join(ROOT, "apps/web/wallet/main.ts")], target: "browser", format: "esm", minify: true, plugins: [chainBrowserPlugin] });
if (!app.success || !wallet.success) {
  for (const l of [...app.logs, ...wallet.logs]) console.error(String(l));
  process.exit(1);
}
await Bun.write(join(out, "app.js"), await app.outputs[0]!.text());
await Bun.write(join(out, "wallet.js"), await wallet.outputs[0]!.text());

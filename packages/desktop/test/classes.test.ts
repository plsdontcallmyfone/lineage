import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSES } from "../src/layout.ts";

// The driver finds each tile's window by its X11 class, and the geometry guard reads the same
// classes from desk-geom. The image sets them (images/desktop/rootfs). If the code and the image
// name them differently, no window is found, nothing is driven and no stream ever starts.

const ROOTFS = join(import.meta.dir, "../../../images/desktop/rootfs");
const read = (p: string) => readFileSync(join(ROOTFS, p), "utf8");

test("the window classes in the code are the ones the desktop image sets", () => {
  const session = read("usr/local/bin/desk-session");
  const geom = read("usr/local/bin/desk-geom");
  const rc = read("etc/lineage-desktop/rc.xml");
  // what the image starts each window as
  const started = [...session.matchAll(/-{1,2}class[= ]([A-Za-z]+)/g)].map((m) => m[1]!);
  for (const [tile, cls] of Object.entries(CLASSES)) {
    expect({ tile, cls, started: started.includes(cls) }).toEqual({ tile, cls, started: true });
    expect({ tile, cls, in_geom: new RegExp(`\\b${cls}\\b`).test(geom) }).toEqual({ tile, cls, in_geom: true });
    expect({ tile, cls, placed: rc.includes(`class="${cls}"`) }).toEqual({ tile, cls, placed: true });
  }
  // and the image starts no window class the code does not know
  expect([...new Set(started)].sort()).toEqual(Object.values(CLASSES).sort());
});

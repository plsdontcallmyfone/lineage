import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageClass, localImageId, localImagesPath, parsePinnedImage, resolvePinnedImage } from "../src/index.ts";

test("pins, classes and the map path", () => {
  const id = "a".repeat(64);
  expect(parsePinnedImage(`lineage/rust:m1@sha256:${id}`)).toEqual({ ref: "lineage/rust:m1", id });
  expect(parsePinnedImage("lineage/rust:m1")).toBeNull();
  expect(imageClass("lineage/zig:0.15.2")).toBe("zig");
  expect(imageClass("ubuntu:24.04")).toBeNull();
  expect(localImagesPath({ LINEAGE_LOCAL_IMAGES: "off" })).toBeNull();
  expect(localImagesPath({ LINEAGE_LOCAL_IMAGES: "/x/map.json" })).toBe("/x/map.json");
  expect(localImagesPath({})).toMatch(/\.lineage\/local-images\.json$/);
});

// Real Docker: substitutes a made-up committed id with any lineage image this machine has.
const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;
const anyLocal = dockerUp
  ? Bun.spawnSync(["docker", "images", "-q", "--no-trunc", "--filter", "reference=lineage/*"]).stdout.toString().split("\n").filter(Boolean)[0]
  : undefined;
(anyLocal ? describe : describe.skip)("local pin map (docker)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lineage-local-images-"));
  const prev = process.env.LINEAGE_LOCAL_IMAGES;
  afterAll(() => {
    if (prev === undefined) delete process.env.LINEAGE_LOCAL_IMAGES;
    else process.env.LINEAGE_LOCAL_IMAGES = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("used only when the committed id is absent and the map names a present image, and logged", () => {
    const local = localImageId(anyLocal!)!;
    const absent = "0".repeat(63) + "1";
    const missing = "0".repeat(63) + "2";
    const map = join(dir, "map.json");
    writeFileSync(map, JSON.stringify({ version: 1, images: {
      [absent]: { ref: "lineage/x:t", local, context: "images/x", built_at: "" },
      [missing]: { ref: "lineage/x:t", local: "f".repeat(64), context: "images/x", built_at: "" },
      [local]: { ref: "lineage/x:t", local: "f".repeat(64), context: "images/x", built_at: "" },
    } }));
    process.env.LINEAGE_LOCAL_IMAGES = map;
    const lines: string[] = [];
    // committed id present: used as is even though the map has an entry for it
    expect(resolvePinnedImage(`lineage/x:t@sha256:${local}`, (l) => lines.push(l))).toBe(`sha256:${local}`);
    // map entry whose local image does not exist: committed id unchanged
    expect(resolvePinnedImage(`lineage/x:t@sha256:${missing}`, (l) => lines.push(l))).toBe(`sha256:${missing}`);
    expect(lines).toHaveLength(0);
    // absent committed id with a present rebuild: substituted and logged once
    expect(resolvePinnedImage(`lineage/x:t@sha256:${absent}`, (l) => lines.push(l))).toBe(`sha256:${local}`);
    expect(resolvePinnedImage(`lineage/x:t@sha256:${absent}`, (l) => lines.push(l))).toBe(`sha256:${local}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("local image rebuild");
  });

  test("LINEAGE_LOCAL_IMAGES=off disables substitution", () => {
    process.env.LINEAGE_LOCAL_IMAGES = "off";
    const absent = "0".repeat(63) + "3";
    expect(resolvePinnedImage(`lineage/x:t@sha256:${absent}`, () => {})).toBe(`sha256:${absent}`);
  });
});

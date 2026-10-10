import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Local image pins (RUNBOOK "Fresh clone or lost images").
//
// Recipes pin sandbox images by local Docker image id (`lineage/<class>:<tag>@sha256:<id>`). Docker
// builds are not reproducible, so a fresh clone (or a machine that lost its images) rebuilds
// images/<class> and gets a different id than the committed one. `bun scripts/local-images.ts`
// builds them and writes a map { committed id -> local id } to this machine's local pin file. The
// sandbox resolves a pinned image through that map when, and only when, the committed id is not
// present locally and the map has an entry whose local image exists, and logs that it ran a local
// rebuild.
//
// Recipe ids: a substitution does NOT change the recipe file, so the recipe id stays the committed
// one. That is meant for local tests and development only, and it is never silent: the log line
// names both ids and the evidence records the local id as env.image_digest. Anything submitted to a
// real Core must not run on a substitute: set LINEAGE_LOCAL_IMAGES=off there and re-pin with
// scripts/deploy/arch-recipes.ts, which writes the local id into the recipe and so gives it a new
// recipe id (a different image is a different recipe).
//
// LINEAGE_LOCAL_IMAGES: path of the map file (default ~/.lineage/local-images.json, machine-wide
// like the Docker daemon it describes, outside every repository), or "off" to disable substitution.

export interface LocalImageEntry {
  /** the image reference without the pin, e.g. lineage/rust:m1 */
  ref: string;
  /** local image id, 64 hex */
  local: string;
  /** directory the image was built from, relative to the repository */
  context: string;
  built_at: string;
}

export interface LocalImageMap {
  version: 1;
  /** committed image id (64 hex) -> local rebuild */
  images: Record<string, LocalImageEntry>;
}

export function localImagesPath(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.LINEAGE_LOCAL_IMAGES?.trim();
  if (v && /^(off|0|false|no)$/i.test(v)) return null;
  return v || join(homedir(), ".lineage", "local-images.json");
}

export function readLocalImageMap(path: string | null = localImagesPath()): LocalImageMap {
  if (!path || !existsSync(path)) return { version: 1, images: {} };
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as LocalImageMap;
    return m && typeof m.images === "object" ? m : { version: 1, images: {} };
  } catch {
    return { version: 1, images: {} };
  }
}

export function writeLocalImageMap(map: LocalImageMap, path: string | null = localImagesPath()): void {
  if (!path) throw new Error("LINEAGE_LOCAL_IMAGES is off; no local pin map to write");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n");
}

/** Splits a pinned image `name@sha256:<id>` into its reference and 64-hex id (null when unpinned). */
export function parsePinnedImage(image: string): { ref: string; id: string } | null {
  const m = /^([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(image.trim());
  return m ? { ref: m[1]!, id: m[2]! } : null;
}

/** The image class directory for a `lineage/<class>:<tag>` reference ("rust"), or null. */
export function imageClass(ref: string): string | null {
  const m = /^lineage\/([a-z0-9-]+):[A-Za-z0-9._-]+$/.exec(ref);
  return m ? m[1]! : null;
}

/** Id (64 hex, no prefix) of a local image reference or id, or null when Docker does not have it. */
export function localImageId(refOrId: string): string | null {
  const p = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", refOrId], { stdout: "pipe", stderr: "pipe" });
  const id = p.stdout.toString().trim().replace(/^sha256:/, "");
  return p.exitCode === 0 && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

const resolved = new Map<string, string>();
const logged = new Set<string>();

/**
 * The image id to run for a pinned image: the committed id when Docker has it, else the local
 * rebuild named by the local pin map (logged once per process), else the committed id unchanged
 * (callers then report it unavailable). Unpinned references are returned as they are.
 */
export function resolvePinnedImage(image: string, log: (line: string) => void = (l) => console.warn(l)): string {
  const pin = parsePinnedImage(image);
  if (!pin) return image.includes("@") ? image.slice(image.indexOf("@") + 1) : image;
  const committed = `sha256:${pin.id}`;
  const hit = resolved.get(committed);
  if (hit) return hit;
  if (localImageId(committed)) return committed;
  const entry = readLocalImageMap().images[pin.id];
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.local) || !localImageId(`sha256:${entry.local}`)) return committed;
  const local = `sha256:${entry.local}`;
  resolved.set(committed, local);
  if (!logged.has(committed)) {
    logged.add(committed);
    log(`[lineage] local image rebuild: ${pin.ref} pinned ${pin.id.slice(0, 12)} is not on this machine, running local rebuild ${entry.local.slice(0, 12)} (local pin map ${localImagesPath()}); recipe ids are unchanged, for local tests and development only`);
  }
  return local;
}

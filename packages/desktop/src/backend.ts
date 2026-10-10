// Desktop backends (owner decision 2026-10-10): our server's own containers first (local.ts, at most
// `desktops_max`), then E2B Desktop for overflow (e2b.ts, at most `e2b_max`, within
// `desktop_usd_per_day`). Both run the same session scripts (images/desktop/rootfs) and the same
// encoder with the same redaction; the stream always reaches viewers through our gate, never through a
// backend's own viewer URL.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One running desktop. Every command runs as the desktop's unprivileged user with DISPLAY set. */
export interface DesktopInstance {
  readonly id: string;
  readonly backend: "local" | "e2b";
  /** where the live HLS files are written inside the desktop */
  readonly streamDir: string;
  /** where the live HLS files are on this host (the gate serves from here) */
  readonly hostStreamDir: string;
  exec(argv: string[], o?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<ExecResult>;
  /** a file inside the desktop, or null */
  read(path: string): Promise<Uint8Array | null>;
  /** copies a file of the host tree into the desktop's copy (E2B); absent where the tree is mounted */
  push?(rel: string, bytes: Uint8Array): Promise<void>;
  /** brings new stream files to hostStreamDir (E2B); a no-op where the directory is shared */
  sync(): Promise<void>;
  /** stops and removes the desktop; idempotent */
  destroy(): Promise<void>;
  /** USD per second this desktop costs while it runs (0 for our own server) */
  readonly usdPerS: number;
}

export interface CreateOpts {
  /** the agent's working tree on this host, shown read only at /work/repo */
  tree: string;
  /** first page in the browser */
  homeUrl: string;
  /** host names the desktop may reach (each with its subdomains) */
  allow: string[];
  /** a name for logs and container names */
  label: string;
}

export interface DesktopBackend {
  readonly name: "local" | "e2b";
  /** null when this backend can start a desktop now, else why not */
  unavailable(): string | null;
  create(o: CreateOpts): Promise<DesktopInstance>;
}

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

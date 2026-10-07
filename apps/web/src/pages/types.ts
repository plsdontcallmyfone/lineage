import type { Ev } from "../api.ts";
import type { Raw } from "../html.ts";

export interface Page {
  title: string;
  body: Raw;
  /** Return true when this event should trigger a (debounced) re-fetch of the page. */
  refreshOn?: (e: Ev) => boolean;
  /** Re-fetch in the background at this period (live views whose state also changes by time). */
  pollMs?: number;
}

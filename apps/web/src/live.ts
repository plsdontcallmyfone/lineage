import type { Ev } from "./api.ts";

// Live event state shared by the shell and the overview feed.
export const live = {
  events: [] as Ev[], // newest first
  lastId: 0,
  mode: "key" as "key" | "all",
  upstream: "connecting" as string,
};
export const MAX_FEED = 400;

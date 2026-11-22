/**
 * One colour per state, the same on every screen — so green always means "up" or "passed",
 * red always means something went wrong, and grey always means "stopped, as asked".
 */
export const TONE = {
  /** Running, healthy, passed. */
  up: "green",
  /** Failed, crashed, unhealthy — needs you. */
  failed: "red",
  /** Stopped on purpose, or not running: nothing wrong. */
  stopped: "gray",
  /** Starting, waiting, restarting, not allowed yet. */
  busy: "yellow",
  /** Wisp itself: what is selected, focused, in progress. */
  accent: "#a78bfa",
} as const;

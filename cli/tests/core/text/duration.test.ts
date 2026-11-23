import { describe, expect, it } from "vitest";

import { describeDuration, parseDuration } from "../../../src/core/text/duration.js";

describe("durations", () => {
  it("reads seconds, or text in seconds, minutes or hours", () => {
    expect([90, "90", "45s", "10m", "1.5h", " 2m "].map(parseDuration)).toEqual([90, 90, 45, 600, 5400, 120]);
  });

  it("refuses nothing, zero, words and units it doesn't know", () => {
    expect([0, -5, "0s", "soon", "10 minutes", "1d", "", true, null].map(parseDuration)).toEqual(Array(9).fill(undefined));
  });

  it("says a duration the way people write it", () => {
    expect([0.5, 45, 600, 5400, 3661].map(describeDuration)).toEqual(["0.5s", "45s", "10m", "1h 30m", "1h 1m 1s"]);
  });

  it("keeps tenths of a second only under a minute", () => {
    expect([47.3, 59.97, 92.8, 184, 119.6, 3599.7].map(describeDuration)).toEqual(["47.3s", "1m", "1m 33s", "3m 4s", "2m", "1h"]);
  });
});

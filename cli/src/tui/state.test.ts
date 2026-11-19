import { describe, expect, it } from "vitest";

import { since } from "./state.js";

describe("since", () => {
  const before = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  it("counts whole units, so a day never reads as 24h", () => {
    expect(since(before(30))).toBe("just now");
    expect(since(before(59 * 60 + 50))).toBe("59m ago");
    expect(since(before(23.6 * 3600))).toBe("23h ago");
    expect(since(before(25 * 3600))).toBe("1d ago");
    expect(since(before(47 * 3600))).toBe("1d ago");
  });
});

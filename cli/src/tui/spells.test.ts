import { describe, expect, it } from "vitest";

import { SPELLS, spell } from "./spells.js";

describe("the words shown while waiting", () => {
  it("change every 2.5 seconds, and a seed keeps two places apart", () => {
    expect(spell(0, 0)).toBe(SPELLS[0]);
    expect(spell(0, 2499)).toBe(SPELLS[0]);
    expect(spell(0, 2500)).toBe(SPELLS[1]);
    expect(spell(3, 0)).toBe(SPELLS[3]);
    expect(spell(0, 2500 * SPELLS.length)).toBe(SPELLS[0]);
  });

  it("fit a narrow place when asked, and never come back longer than it", () => {
    for (let at = 0; at < SPELLS.length; at += 1) expect(spell(at, 0, 12).length).toBeLessThanOrEqual(12);
    const shortest = Math.min(...SPELLS.map((words) => words.length));
    expect(spell(0, 0, 3).length).toBe(shortest);
  });
});

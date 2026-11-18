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
});

import { describe, expect, it } from "vitest";

import { filterLog, pieces, plain } from "./logfilter.js";

describe("filtering a log", () => {
  const log = ["\u001B[32mready\u001B[0m on :3000", "GET /cart 200", "ERROR cart total is NaN", "GET /cart 500", "error: retrying the cart"];

  it("keeps the lines with every word, in any order and any case, with where they were", () => {
    expect(filterLog(log, "error")).toEqual([
      { at: 2, text: "ERROR cart total is NaN" },
      { at: 4, text: "error: retrying the cart" },
    ]);
    expect(filterLog(log, "cart error").map((line) => line.at)).toEqual([2, 4]);
    expect(filterLog(log, "500 get").map((line) => line.at)).toEqual([3]);
    expect(filterLog(log, "nothing like this")).toEqual([]);
  });

  it("matches the text as shown, without its colours", () => {
    expect(plain(log[0] as string)).toBe("ready on :3000");
    expect(filterLog(log, "32m")).toEqual([]);
  });

  it("lights every place each word is", () => {
    expect(pieces("Error: cart error", "error")).toEqual([
      { text: "Error", hit: true },
      { text: ": cart ", hit: false },
      { text: "error", hit: true },
    ]);
    expect(pieces("GET /cart 500", "cart 500")).toEqual([
      { text: "GET /", hit: false },
      { text: "cart", hit: true },
      { text: " ", hit: false },
      { text: "500", hit: true },
    ]);
  });
});

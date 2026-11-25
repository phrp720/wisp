import { describe, expect, it } from "vitest";

import { diffLines, hunks, unifiedDiff } from "../../../src/core/text/diff.js";

describe("diffLines", () => {
  it("marks what was added and removed, line by line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("treats a missing file as empty", () => {
    expect(diffLines("", "x")).toEqual([{ kind: "added", text: "x" }]);
    expect(diffLines("x", "")).toEqual([{ kind: "removed", text: "x" }]);
  });

  it("sees no change in a file that only gained a final newline", () => {
    expect(diffLines("a\nb", "a\nb\n").every((line) => line.kind === "same")).toBe(true);
  });
});

describe("hunks and unifiedDiff", () => {
  const before = Array.from({ length: 20 }, (_, at) => `line ${at}`).join("\n");
  const after = before.replace("line 2\n", "line two\n").replace("line 17\n", "line seventeen\n");

  it("keeps a little context around each change and leaves the rest out", () => {
    const groups = hunks(diffLines(before, after), 1);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((line) => line.text)).toEqual(["line 1", "line 2", "line two", "line 3"]);
  });

  it("writes them with + and -, a … between", () => {
    expect(unifiedDiff(diffLines(before, after), 0)).toBe("- line 2\n+ line two\n…\n- line 17\n+ line seventeen");
  });
});

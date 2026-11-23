import { describe, expect, it } from "vitest";

import { fitGraph, type GraphNode } from "../../../src/tui/components/graph.js";
import { dagText } from "../../../src/tui/components/dag.js";
import { glyphs } from "../../../src/tui/terminal/glyphs.js";

const unicode = glyphs({ LANG: "en_US.UTF-8" }, "darwin");
const step = (label: string, ...after: number[]): GraphNode => ({ label, ok: true, state: "waiting", after });
const dev = [step("postgres"), step("port 6543", 0), step("api", 1), step("web"), step("up", 2), step("http://localhost:5173", 4, 3)];

describe("fitting a pipeline's graph", () => {
  it("draws boxes when they fit on one line", () => {
    const fitted = fitGraph(dev, 140, 20, unicode);
    expect(fitted?.compact).toBe(false);
  });

  it("draws one line a step rather than wrapping boxes onto a line of their own", () => {
    const fitted = fitGraph(dev, 80, 20, unicode);
    expect(fitted?.compact).toBe(true);
    expect(dagText(fitted?.lines ?? []).some((line) => line === "")).toBe(false);
  });
});

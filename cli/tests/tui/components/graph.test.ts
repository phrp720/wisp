import { describe, expect, it } from "vitest";

import { fitGraph, groupByPipeline, type GraphNode, type StepNode } from "../../../src/tui/components/graph.js";
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

  it("shortens the arrows between boxes before it gives the boxes up", () => {
    const chain = ["clean main, up to date", "⚡ Bump the version", "commit", "push main", "push the tag", "watch the release"].map((label, at) => step(label, ...(at ? [at - 1] : [])));
    const fitted = fitGraph(chain, 149, 20, unicode);
    expect(fitted?.compact).toBe(false);
    expect(dagText(fitted?.lines ?? [])[1]).toContain("│ ──▶ │");
  });

  it("keeps boxes where the view scrolls, wrapping them when they are too wide", () => {
    const fitted = fitGraph(dev, 60, Number.POSITIVE_INFINITY, unicode);
    expect(fitted?.compact).toBe(false);
    expect(dagText(fitted?.lines ?? []).join("\n")).toContain("│ · postgres │");
  });
});

describe("a run's graph", () => {
  it("shows each pipeline it needed as one box, and its own steps one by one, like the pipeline view", () => {
    const done = (label: string, ms: number, after: number[], owner?: string): StepNode => ({ label, ok: true, ms, after, ...(owner ? { owner } : {}) });
    const graph = groupByPipeline([done("postgres", 1500, [], "Database"), done("port 6543", 10, [0], "Database"), done("api", 1600, [1]), done("web", 1600, []), done("up", 14, [2]), done("open", 360, [4, 3])], "⚡ ");
    expect(graph.map((node) => [node.label, node.detail ?? "", node.after.map((at) => graph[at]?.label)])).toEqual([
      ["⚡ Database", "2 steps 1.5s", []],
      ["api", "", ["⚡ Database"]],
      ["web", "", []],
      ["up", "", ["api"]],
      ["open", "", ["up", "web"]],
    ]);
  });

  it("marks a pipeline box running while any of its steps runs, and failed if one failed", () => {
    const step = (label: string, extra: Partial<StepNode>): StepNode => ({ label, ok: true, after: [], owner: "Database", ...extra });
    expect(groupByPipeline([step("postgres", { ms: 10 }), step("port", { state: "running" })], "")[0]?.state).toBe("running");
    expect(groupByPipeline([step("postgres", { ms: 10 }), step("port", { ok: false, ms: 5 })], "")[0]?.ok).toBe(false);
  });
});

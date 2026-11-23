import { describe, expect, it } from "vitest";

import { cellWidth, clip, dagText, drawDag, layerDag, reduceDeps, type DagNode } from "../../../src/tui/components/dag.js";

const step = (label: string, ...after: number[]): DagNode => ({ mark: "·", label, after });
const draw = (nodes: DagNode[], width = 120, boxed = false, ascii = false) => dagText(drawDag(nodes, { width, boxed, ascii }));

describe("drawing a pipeline", () => {
  it("draws a straight line of steps on one row", () => {
    expect(draw([step("a"), step("b", 0), step("c", 1)])).toEqual(["· a ───▶ · b ───▶ · c"]);
  });

  it("forks, and keeps each branch connected to what follows it", () => {
    expect(draw([step("up"), step("session", 0), step("ready", 0), step("open", 2)])).toEqual([
      "· up ─┬─▶ · session",
      "      ╰─▶ · ready ─────▶ · open",
    ]);
  });

  it("merges two steps into the one that waits for both", () => {
    expect(draw([step("typecheck"), step("test"), step("build", 0, 1)])).toEqual([
      "· typecheck ─┬─▶ · build",
      "· test ──────╯",
    ]);
  });

  it("carries an edge that skips a column straight past it", () => {
    expect(draw([step("a"), step("b", 0), step("c", 1), step("web"), step("d", 2, 3)])).toEqual([
      "· a ─────▶ · b ───▶ · c ─┬─▶ · d",
      "· web ───────────────────╯",
    ]);
  });

  it("leaves out a line another path already implies", () => {
    expect(reduceDeps([step("postgres"), step("port", 0), step("api", 0, 1), step("web"), step("open", 2, 3)])).toEqual([[], [0], [1], [], [2, 3]]);
    expect(draw([step("postgres"), step("port", 0), step("api", 0, 1), step("web"), step("open", 2, 3)])).toEqual([
      "· postgres ───▶ · port ───▶ · api ─┬─▶ · open",
      "· web ─────────────────────────────╯",
    ]);
  });

  it("draws boxes, with the edge leaving each box from its middle", () => {
    expect(draw([step("up"), step("session", 0), step("ready", 0)], 120, true)).toEqual([
      "╭──────╮      ╭───────────╮",
      "│ · up │ ─┬─▶ │ · session │",
      "╰──────╯  │   ╰───────────╯",
      "          │   ╭─────────╮",
      "          ╰─▶ │ · ready │",
      "              ╰─────────╯",
    ]);
  });

  it("falls back to plain characters", () => {
    expect(draw([step("up"), step("session", 0), step("ready", 0)], 120, false, true)).toEqual([
      "· up -+-> · session",
      "      +-> · ready",
    ]);
  });

  it("wraps a pipeline too wide for the screen, marking where it carries on", () => {
    const lines = draw([step("first step"), step("second step", 0), step("third step", 1), step("fourth step", 2)], 40);
    expect(lines).toEqual(["· first step ───▶ · second step ─…", "", "…─▶ · third step ───▶ · fourth step"]);
    expect(Math.max(...lines.map(cellWidth))).toBeLessThanOrEqual(40);
  });

  it("shows every step of a large pipeline, quickly, within the width", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const nodes = Array.from({ length: 200 }, (_node, at) => step(`step-${at}`, ...(at === 0 ? [] : Array.from({ length: Math.floor(random() * 3) }, () => Math.floor(random() * at)))));
    const began = performance.now();
    const lines = draw(nodes, 100);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(new Set(lines.join("\n").match(/step-\d+/g)).size).toBe(200);
    expect(Math.max(...lines.map(cellWidth))).toBeLessThanOrEqual(100);
  });

  it("survives steps that wait for each other, or for themselves", () => {
    expect(() => draw([step("a", 1), step("b", 0), step("c", 2)])).not.toThrow();
    expect(layerDag([step("a", 1), step("b", 0)]).every((layer) => layer >= 0)).toBe(true);
  });

  it("shortens long names", () => {
    expect(clip("http://grace1.fit.vutbr.cz:64000", 20)).toBe("http://grace1.fit.v…");
    expect(cellWidth("⚡ Deploy")).toBe(9);
  });
});

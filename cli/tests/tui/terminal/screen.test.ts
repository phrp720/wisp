import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { inPlaceStdout, paintInPlace } from "../../../src/tui/terminal/screen.js";

describe("painting a full-screen frame in place", () => {
  it("turns clearing the screen into overwriting it line by line, so it never shows blank", () => {
    expect(paintInPlace("\u001B[2J\u001B[3J\u001B[Hone\ntwo")).toBe("\u001B[Hone\u001B[K\ntwo\u001B[K\u001B[J");
  });

  it("does the same with the clear old Windows consoles get", () => {
    expect(paintInPlace("\u001B[2J\u001B[0fone")).toBe("\u001B[Hone\u001B[K\u001B[J");
  });

  it("leaves anything else as it is", () => {
    expect(paintInPlace("\u001B[2Kone\ntwo\n")).toBe("\u001B[2Kone\ntwo\n");
  });

  it("is still the terminal it wraps, for its size and events", () => {
    const stream = Object.assign(new PassThrough(), { rows: 30, columns: 100, isTTY: true }) as unknown as NodeJS.WriteStream;
    const written: string[] = [];
    stream.on("data", (data: Buffer) => written.push(data.toString()));
    const wrapped = inPlaceStdout(stream);
    expect([wrapped.rows, wrapped.columns, wrapped.isTTY]).toEqual([30, 100, true]);
    wrapped.write("\u001B[2J\u001B[3J\u001B[Hhi");
    expect(written.join("")).toBe("\u001B[Hhi\u001B[K\u001B[J");
  });
});

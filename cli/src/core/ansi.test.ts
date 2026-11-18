import { describe, expect, it } from "vitest";

import { cleanOutput } from "./ansi.js";

describe("a log with the screen cleared in it", () => {
  // What Vite prints for each message: a screenful of blank lines, home, clear below, the message.
  const vite = (message: string) => `${"\r\n".repeat(50)}\u001B[1;1H\u001B[0J\u001B[2m9:13 PM\u001B[22m ${message}\r\n`;

  it("keeps every message, without the blank screenfuls pushed up before each clear", () => {
    const log = `vite ready in 300 ms\r\n${vite("page reload a.html")}${vite("page reload b.html")}`;
    expect(cleanOutput(log)).toBe("vite ready in 300 ms\n\u001B[2m9:13 PM\u001B[22m page reload a.html\n\u001B[2m9:13 PM\u001B[22m page reload b.html\n");
  });

  it("reads a full erase and a reset as a clear too, and keeps what came before them", () => {
    expect(cleanOutput("compiling\n\n\n\u001B[2J\u001B[3J\u001B[Hcompiled")).toBe("compiling\ncompiled");
    expect(cleanOutput("old\n\n\u001Bcnew")).toBe("old\nnew");
  });

  it("leaves blank lines alone where nothing was cleared", () => {
    expect(cleanOutput("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("does not take a cursor move or a line erase for a clear", () => {
    expect(cleanOutput("a\n\n\u001B[5;1H\u001B[2Kb")).toBe("a\n\nb");
  });
});

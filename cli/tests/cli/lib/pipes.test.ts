import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { quietOnClosedPipe } from "../../../src/cli/lib/pipes.js";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("quietOnClosedPipe", () => {
  it("exits quietly when whatever reads the output closes early, like head", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    quietOnClosedPipe(stream, exit);
    stream.emit("error", failure("EPIPE"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("leaves any other write error alone", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    quietOnClosedPipe(stream, exit);
    expect(() => stream.emit("error", failure("ENOSPC"))).toThrow("ENOSPC");
    expect(exit).not.toHaveBeenCalled();
  });
});

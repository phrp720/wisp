import { describe, expect, it } from "vitest";

import { MOUSE_OFF, MOUSE_ON, mouseStdin, takeMouse, terminalMouse, WHEEL_KEYS, type MouseEvent } from "./mouse.js";

const click = (x: number, y: number) => `\u001B[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\u001B[<0;${x + 1};${y + 1}m`;
const wheel = (by: -1 | 1, x: number, y: number) => `\u001B[<${by < 0 ? 64 : 65};${x + 1};${y + 1}M`;

/** A stdin that hands out the chunks it was given, one per read, as a TTY's does. */
function fakeStdin(chunks: string[]) {
  return {
    isTTY: true,
    read: () => chunks.shift() ?? null,
    setRawMode(this: { raw?: boolean }, on: boolean) {
      this.raw = on;
    },
  };
}

function readAll(stdin: { read(): unknown }): string[] {
  const out: string[] = [];
  for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) out.push(String(chunk));
  return out;
}

describe("mouse reports", () => {
  it("are taken out of the input, leaving the keys around them in order", () => {
    const taken = takeMouse(`j${click(10, 4)}k${release(10, 4)}${wheel(1, 50, 9)}`);
    expect(taken.rest).toBe("jk");
    expect(taken.events).toEqual<MouseEvent[]>([
      { kind: "click", x: 10, y: 4 },
      { kind: "wheel", x: 50, y: 9, by: 1 },
    ]);
  });

  it("ignore the right button, a sideways wheel and dragging", () => {
    expect(takeMouse("\u001B[<2;5;5M\u001B[<66;5;5M\u001B[<32;5;5M").events).toEqual([]);
  });

  it("keep a click with Shift or Ctrl held a click", () => {
    expect(takeMouse("\u001B[<4;3;2M\u001B[<16;3;2M").events).toEqual([
      { kind: "click", x: 2, y: 1 },
      { kind: "click", x: 2, y: 1 },
    ]);
  });

  it("read the older X10 form too, from terminals without SGR", () => {
    const x10 = (code: number, x: number, y: number) => `\u001B[M${String.fromCharCode(code + 32, x + 33, y + 33)}`;
    const taken = takeMouse(`${x10(0, 7, 3)}${x10(3, 7, 3)}${x10(65, 1, 1)}q`);
    expect(taken.rest).toBe("q");
    expect(taken.events).toEqual([
      { kind: "click", x: 7, y: 3 },
      { kind: "wheel", x: 1, y: 1, by: 1 },
    ]);
  });

  it("hold back a report cut in two, and leave a lone Escape alone", () => {
    const first = takeMouse("a\u001B[<0;12");
    expect(first).toMatchObject({ rest: "a", partial: "\u001B[<0;12" });
    expect(takeMouse(`${first.partial};3M`).events).toEqual([{ kind: "click", x: 11, y: 2 }]);
    expect(takeMouse("\u001B")).toEqual({ rest: "\u001B", events: [], partial: "" });
    expect(takeMouse("\u001B[A")).toEqual({ rest: "\u001B[A", events: [], partial: "" });
  });
});

describe("the stdin Ink reads", () => {
  it("passes keys through, and mouse reports to the dashboard", () => {
    const seen: MouseEvent[] = [];
    const stdin = mouseStdin(fakeStdin(["j", click(3, 4), `${click(5, 6)}k`]), (event) => {
      seen.push(event);
      return true;
    });
    expect(readAll(stdin)).toEqual(["j", "k"]);
    expect(seen).toEqual([
      { kind: "click", x: 3, y: 4 },
      { kind: "click", x: 5, y: 6 },
    ]);
  });

  it("turns a wheel turn nobody handled into the arrow key a terminal would send", () => {
    const stdin = mouseStdin(fakeStdin([wheel(-1, 1, 1), wheel(1, 1, 1), click(1, 1)]), () => false);
    expect(readAll(stdin)).toEqual([WHEEL_KEYS.up, WHEEL_KEYS.down]);
  });

  it("finishes a report that arrived in two reads", () => {
    const seen: MouseEvent[] = [];
    const stdin = mouseStdin(fakeStdin(["\u001B[<0;2", ";2Mx"]), (event) => seen.push(event) > 0);
    expect(readAll(stdin)).toEqual(["x"]);
    expect(seen).toEqual([{ kind: "click", x: 1, y: 1 }]);
  });

  it("is still the real stdin for everything else", () => {
    const real = fakeStdin([]) as ReturnType<typeof fakeStdin> & { raw?: boolean };
    const stdin = mouseStdin(real, () => true);
    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    expect(real.raw).toBe(true);
  });
});

describe("the terminal's mouse", () => {
  it("asks for reports once, stops on pause, and comes back only if it was on", () => {
    const written: string[] = [];
    const mouse = terminalMouse((data) => written.push(data));
    mouse.enable(true);
    mouse.enable(true);
    expect(written).toEqual([MOUSE_ON]);
    mouse.pause();
    mouse.resume();
    expect(written).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON]);
    mouse.enable(false);
    mouse.pause();
    mouse.resume();
    expect(written).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON, MOUSE_OFF]);
  });

  it("says an event was handled when any listener handled it", () => {
    const mouse = terminalMouse(() => undefined);
    mouse.subscribe(() => false);
    expect(mouse.emit({ kind: "click", x: 0, y: 0 })).toBe(false);
    const stop = mouse.subscribe(() => true);
    expect(mouse.emit({ kind: "click", x: 0, y: 0 })).toBe(true);
    stop();
    expect(mouse.emit({ kind: "click", x: 0, y: 0 })).toBe(false);
  });
});

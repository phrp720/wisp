/**
 * Clicks and the scroll wheel, the way lazydocker takes them.
 *
 * The terminal reports the mouse as escape sequences on stdin, mixed in with the keys
 * (SGR: `ESC [ < button ; column ; row M`). Ink has no mouse support, so Wisp hands Ink a
 * view of stdin with those reports taken out, and passes them on as events instead.
 * Without that, a click would arrive as typed text, in a search box say.
 *
 * It works over SSH and in tmux (with `set -g mouse on`), since the reports are just bytes
 * the user's own terminal sends. While it is on, selecting text takes Shift (or Option in
 * iTerm2), as in any TUI that takes the mouse: hence the setting to turn it off.
 */

import type { DOMElement } from "ink";
import { createContext, useContext, useEffect, useRef } from "react";

/** Ask the terminal for clicks and wheel turns, reported as SGR sequences. */
export const MOUSE_ON = "\u001B[?1000h\u001B[?1006h";
export const MOUSE_OFF = "\u001B[?1006l\u001B[?1000l";

/** `x` and `y` count from 0, from the top-left corner. `by` is -1 for up, 1 for down. */
export type MouseEvent = { kind: "click"; x: number; y: number } | { kind: "wheel"; x: number; y: number; by: -1 | 1 };

/** Gets each event; returns true when it did something with it. */
export type MouseListener = (event: MouseEvent) => boolean | void;

/** The mouse, as the dashboard sees it. */
export interface MouseSource {
  subscribe(listener: MouseListener): () => void;
  /** Ask the terminal for mouse reports, or stop asking. */
  enable(on: boolean): void;
}

// SGR reports, and the older X10 form a terminal without SGR sends: ESC [ M and three bytes.
const SGR = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;
const X10 = /\u001B\[M([\s\S])([\s\S])([\s\S])/g;
/** The start of a report cut off at the end of a read, to be finished by the next one. */
const CUT = /\u001B\[<[\d;]*$|\u001B\[M[\s\S]{0,2}$/;

export const WHEEL_KEYS = { up: "\u001B[A", down: "\u001B[B" } as const;

/**
 * Take the mouse reports out of a piece of input. `rest` is what is left for the keyboard,
 * in order; `partial` is a report cut off at the end, held back for the next piece.
 */
export function takeMouse(text: string): { rest: string; events: MouseEvent[]; partial: string } {
  const events: MouseEvent[] = [];
  let rest = text.replace(SGR, (_all, code: string, x: string, y: string, end: string) => {
    const event = toEvent(Number(code), Number(x) - 1, Number(y) - 1, end === "M");
    if (event) events.push(event);
    return "";
  });
  rest = rest.replace(X10, (_all, code: string, x: string, y: string) => {
    const button = code.charCodeAt(0) - 32;
    // X10 says "released" without saying which button: 3. Only presses and wheels matter.
    const event = (button & 3) === 3 && !(button & 64) ? undefined : toEvent(button, x.charCodeAt(0) - 33, y.charCodeAt(0) - 33, true);
    if (event) events.push(event);
    return "";
  });
  const cut = CUT.exec(rest);
  return cut ? { rest: rest.slice(0, cut.index), events, partial: cut[0] } : { rest, events, partial: "" };
}

function toEvent(code: number, x: number, y: number, press: boolean): MouseEvent | undefined {
  // Movement with a button held: not asked for, and not used.
  if (code & 32) return undefined;
  if (code & 64) {
    // 64 up, 65 down; 66 and 67 are a sideways wheel.
    const button = code & 3;
    return press && button < 2 ? { kind: "wheel", x, y, by: button === 0 ? -1 : 1 } : undefined;
  }
  // A press of the left button. Releases, the middle and the right button: nothing.
  return press && (code & 3) === 0 ? { kind: "click", x, y } : undefined;
}

/**
 * The mouse for the screens below the tabs along the top: `top` is the line they start on,
 * so each screen gets points counted from its own top border.
 */
export const MouseContext = createContext<{ source: MouseSource; top: number } | undefined>(undefined);

/** Where a `<Box>` was drawn, from the screen's top-left corner. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where a `<Box>` was drawn: the layout Ink worked out for it (what its own `measureElement`
 * reads), each box's place in its parent added up to the screen. For forms, whose fields
 * grow and shrink (a hint shows under the field you are on, a long intro wraps), this is
 * where things really are, rather than a count of lines that could drift from it.
 */
export function rectOf(node: DOMElement | null | undefined): Rect | undefined {
  if (!node?.yogaNode) return undefined;
  let x = 0;
  let y = 0;
  for (let at: DOMElement | undefined = node; at; at = at.parentNode) {
    x += at.yogaNode?.getComputedLeft() ?? 0;
    y += at.yogaNode?.getComputedTop() ?? 0;
  }
  return { x, y, width: node.yogaNode.getComputedWidth(), height: node.yogaNode.getComputedHeight() };
}

/** Where a click fell inside an element: its column and line there, or nothing when it missed it. */
export type Within = (node: DOMElement | null | undefined) => { x: number; y: number } | undefined;

/**
 * Clicks and wheel turns for a screen that keeps its own state, as History and the forms
 * do: `y` counts from the screen's top border, and is below 0 over the tabs along the top.
 * `at` says where the click fell inside an element drawn with a `ref`. The handler returns
 * true when it did something, as a `MouseListener` does. `active` works like `useInput`'s
 * `isActive`: a screen hidden behind another hears nothing.
 */
export function useMouse(handler: (event: MouseEvent, at: Within) => boolean | void, active = true): void {
  const area = useContext(MouseContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!area || !active) return;
    return area.source.subscribe((event) => {
      if (event.y < area.top) return false;
      const at: Within = (node) => {
        const rect = rectOf(node);
        if (!rect || event.x < rect.x || event.x >= rect.x + rect.width || event.y < rect.y || event.y >= rect.y + rect.height) return undefined;
        return { x: event.x - rect.x, y: event.y - rect.y };
      };
      return latest.current({ ...event, y: event.y - area.top }, at);
    });
  }, [area, active]);
}

/** Collects the elements of a list by key, for `ref={refs.set(key)}`, so a click can be matched to one. */
export function useRefs<K>(): { set: (key: K) => (node: DOMElement | null) => void; get: (key: K) => DOMElement | undefined; entries: () => [K, DOMElement][] } {
  const nodes = useRef(new Map<K, DOMElement>());
  return {
    set: (key) => (node) => {
      if (node) nodes.current.set(key, node);
      else nodes.current.delete(key);
    },
    get: (key) => nodes.current.get(key),
    entries: () => [...nodes.current.entries()],
  };
}

/**
 * The stdin Ink reads: the real one, with mouse reports taken out and handed to `emit`.
 * A wheel turn nobody handled becomes an arrow key, which is what terminals send for the
 * wheel when nothing asked for the mouse: every list keeps scrolling the way it did.
 *
 * A Proxy rather than a new stream, so raw mode, `ref` and the listeners stay the real
 * stdin's, and handing the terminal to an editor works as before.
 */
export function mouseStdin<T extends { read(size?: number): unknown }>(stdin: T, emit: (event: MouseEvent) => boolean): T {
  let carry = "";
  const read = (size?: number) => {
    for (;;) {
      const chunk = stdin.read(size);
      if (chunk === null || chunk === undefined) return null;
      const taken = takeMouse(carry + String(chunk));
      carry = taken.partial;
      let rest = taken.rest;
      for (const event of taken.events) {
        if (!emit(event) && event.kind === "wheel") rest += event.by < 0 ? WHEEL_KEYS.up : WHEEL_KEYS.down;
      }
      if (rest) return rest;
    }
  };
  return new Proxy(stdin, {
    get(target, property) {
      if (property === "read") return read;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * The mouse for a real terminal: who is listening, and whether the terminal was asked for
 * reports. `pause` and `resume` go around handing the terminal to an editor.
 */
export function terminalMouse(write: (data: string) => void): MouseSource & { emit(event: MouseEvent): boolean; pause(): void; resume(): void } {
  const listeners = new Set<MouseListener>();
  let wanted = false;
  let on = false;
  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    write(next ? MOUSE_ON : MOUSE_OFF);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    enable(next) {
      wanted = next;
      set(next);
    },
    emit(event) {
      let handled = false;
      for (const listener of listeners) handled = listener(event) === true || handled;
      return handled;
    },
    pause: () => set(false),
    resume: () => set(wanted),
  };
}

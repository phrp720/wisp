import { describe, expect, it } from "vitest";

import { eventually } from "../../support/tui-app.js";

describe("editing text", () => {
  it("moves the cursor with the arrows, and edits where it is", async () => {
    const { editAt } = await import("../../../src/tui/components/forms.js");
    const key = (extra: Record<string, boolean> = {}) => ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, ...extra }) as never;
    let state = { value: "npm strt", cursor: 8 };
    for (let at = 0; at < 2; at += 1) state = editAt(state.value, state.cursor, "", key({ leftArrow: true }))!;
    state = editAt(state.value, state.cursor, "a", key())!;
    await eventually(() => expect(state).toEqual({ value: "npm start", cursor: 7 }));
    state = editAt(state.value, state.cursor, "a", key({ ctrl: true }))!;
    expect(state.cursor).toBe(0);
  });
});

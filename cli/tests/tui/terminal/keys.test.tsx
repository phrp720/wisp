import { Text } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { KeysContext, useKeyRoot, useKeys } from "../../../src/tui/terminal/keys.js";
import { eventually, tick } from "../../support/tui-app.js";

function Counter() {
  const keys = useKeyRoot();
  const [count, setCount] = useState(0);
  useKeys((input) => {
    if (input === "+") setCount(count + 1);
  }, {}, keys);
  return <Text>count {count}</Text>;
}

function Opener() {
  const keys = useKeyRoot();
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState("");
  useKeys((input) => {
    if (input === "o") setOpen(true);
  }, { isActive: !open }, keys);
  return (
    <KeysContext.Provider value={keys}>
      <Text>{open ? `open, heard ${heard || "nothing"}` : "closed"}</Text>
      {open ? <Child onKey={(input) => setHeard((before) => before + input)} /> : null}
    </KeysContext.Provider>
  );
}

function Child({ onKey }: { onKey: (input: string) => void }) {
  useKeys((input) => onKey(input));
  return null;
}

function onEachFrame(app: ReturnType<typeof render>, then: (frame: string) => void) {
  const write = app.stdout.write;
  app.stdout.write = (frame: string) => {
    write(frame);
    queueMicrotask(() => then(frame));
  };
}

describe("keys", () => {
  it("gives a key pressed the moment the screen changes the state it shows", async () => {
    const app = render(<Counter />);
    await tick();
    onEachFrame(app, (frame) => {
      if (frame !== "count 5") app.stdin.write("+");
    });
    app.stdin.write("+");
    await eventually(() => expect(app.lastFrame()).toBe("count 5"));
  });

  it("lets a screen hear a key pressed the moment it appears", async () => {
    const app = render(<Opener />);
    await tick();
    let sent = false;
    onEachFrame(app, (frame) => {
      if (frame.startsWith("open") && !sent) {
        sent = true;
        app.stdin.write("x");
      }
    });
    app.stdin.write("o");
    await eventually(() => expect(app.lastFrame()).toBe("open, heard x"));
  });
});

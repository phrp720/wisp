import { render } from "ink";

import { stopAttached } from "../core/switch.js";
import { App } from "./App.js";
import { ENTER_SCREEN, LEAVE_SCREEN, realServices } from "./services.js";

/**
 * Open the TUI full screen, the way htop and btop do: the alternate screen, so quitting
 * gives you back your terminal exactly as it was.
 */
export async function startTui(): Promise<void> {
  const { stdout, stdin } = process;
  let instance: ReturnType<typeof render> | undefined;

  const leave = () => stdout.write(LEAVE_SCREEN + "\u001B[?25h");
  stdout.write(ENTER_SCREEN + "\u001B[?25l");
  process.once("exit", leave);
  // Closed window, `kill`, logged out: whatever Wisp was running attached goes with it,
  // rather than carrying on where nobody can see it.
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopAttached();
      leave();
      process.exit(128 + (signal === "SIGHUP" ? 1 : 15));
    });
  }

  const services = realServices({
    // An editor needs the real screen and the keyboard back while it is open.
    suspend: () => {
      stdin.setRawMode?.(false);
      leave();
    },
    resume: () => {
      stdout.write(ENTER_SCREEN + "\u001B[?25l");
      stdin.setRawMode?.(true);
      instance?.clear();
    },
  });

  instance = render(<App services={services} />, { exitOnCtrlC: true, patchConsole: false });
  try {
    await instance.waitUntilExit();
  } finally {
    leave();
    process.removeListener("exit", leave);
  }
}

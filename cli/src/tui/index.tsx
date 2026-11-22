import { render } from "ink";

import { stopAttached } from "../core/run/index.js";
import { App } from "./App.js";
import { mouseStdin, terminalMouse } from "./terminal/mouse.js";
import { inPlaceStdout } from "./terminal/screen.js";
import { ENTER_SCREEN, LEAVE_SCREEN, realServices } from "./services.js";

/**
 * Open the TUI full screen, the way htop and btop do: the alternate screen, so quitting
 * gives you back your terminal exactly as it was.
 */
export async function startTui(): Promise<void> {
  const { stdout, stdin } = process;
  let instance: ReturnType<typeof render> | undefined;

  // Clicks and the wheel come in on stdin with the keys: Ink is given a view of stdin with
  // them taken out, and the dashboard gets them as events.
  const mouse = terminalMouse((data) => stdout.write(data));
  const input = mouseStdin(stdin, (event) => mouse.emit(event));

  const leave = () => {
    // Never leave the shell with the mouse still reported: clicks would type escape codes.
    mouse.pause();
    stdout.write(LEAVE_SCREEN + "\u001B[?25h");
  };
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
      mouse.resume();
      stdin.setRawMode?.(true);
      instance?.clear();
    },
  });

  const initial = await services.load().catch(() => undefined);
  stdout.write(ENTER_SCREEN + "\u001B[?25l");
  instance = render(<App services={services} mouse={mouse} {...(initial ? { initial } : {})} />, { stdin: input, stdout: inPlaceStdout(stdout), exitOnCtrlC: true, patchConsole: false });
  try {
    await instance.waitUntilExit();
  } finally {
    leave();
    process.removeListener("exit", leave);
  }
}

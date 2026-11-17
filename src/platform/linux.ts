import type { Invocation } from "../core/types.js";
import { which } from "../core/which.js";
import { launch } from "./spawn.js";
import { LINUX_TERMINALS, findIn } from "./terminals.js";
import type { Platform, TerminalRequest } from "./types.js";

/** `xdg-open`, or `gio open` on the desktops that ship that instead. */
async function systemOpen(target: string): Promise<void> {
  if (which("xdg-open")) return launch("xdg-open", [target]);
  if (which("gio")) return launch("gio", ["open", target]);
  throw new Error("nothing to open it with — install xdg-utils");
}

/**
 * An app as Linux names it: a command on PATH (`code`, `slack`), or a desktop entry id
 * (`org.gnome.Nautilus`, `code.desktop`) for `gtk-launch` to find.
 */
async function startApp(app: string, args: string[] = []): Promise<void> {
  if (!app.endsWith(".desktop") && which(app)) return launch(app, args);
  if (which("gtk-launch")) return launch("gtk-launch", [app.replace(/\.desktop$/, ""), ...args]);
  throw new Error(`"${app}" is not a command on PATH, and there is no gtk-launch to find it as an app`);
}

export const linux: Platform = {
  os: "linux",

  async openUrl(url) {
    await systemOpen(url);
  },

  async openPath(path, options = {}) {
    const app = options.app?.trim();
    if (app) return startApp(app, [path]);
    await systemOpen(path);
  },

  async launchApp(app) {
    // Bringing an already-running app forward needs the window manager, and Wayland does
    // not let one program raise another's window. Starting it again is what most apps
    // treat as "come to the front" anyway.
    await startApp(app);
  },

  async runInTerminal(invocation: Invocation, request: TerminalRequest) {
    const spec = LINUX_TERMINALS.find((terminal) => terminal.name === request.terminal);
    if (!spec?.binary) throw new Error(`Wisp cannot drive "${request.terminal}" on Linux`);
    await launch(spec.binary, spec.args(invocation, request.title));
  },

  knownTerminals: () => LINUX_TERMINALS.map((terminal) => terminal.name),
  findTerminal: (ref) => findIn(LINUX_TERMINALS, ref),

  defaultTerminal() {
    // `$TERMINAL` is the closest Linux has to a stated preference.
    const stated = process.env["TERMINAL"]?.trim();
    if (stated) {
      const found = findIn(LINUX_TERMINALS, stated.split("/").pop() ?? stated);
      if (found) return found;
    }
    const program = process.env["TERM_PROGRAM"];
    if (program) {
      const found = findIn(LINUX_TERMINALS, program);
      if (found) return found;
    }
    if (process.env["KITTY_WINDOW_ID"]) return "kitty";
    return LINUX_TERMINALS.find((terminal) => terminal.binary && which(terminal.binary))?.name;
  },
};

/** For tests: the command line a terminal would be started with. */
export function linuxTerminalCommand(name: string, invocation: Invocation, title: string): string[] {
  const spec = LINUX_TERMINALS.find((terminal) => terminal.name === name);
  if (!spec?.binary) throw new Error(`unknown terminal ${name}`);
  return [spec.binary, ...spec.args(invocation, title)];
}


import type { Invocation } from "../core/types.js";
import { which } from "../core/which.js";
import { launch } from "./spawn.js";
import { CROSS_PLATFORM_TERMINALS, findIn, type TerminalSpec } from "./terminals.js";
import type { Platform, TerminalRequest } from "./types.js";

/**
 * Terminals Windows can hand a command to.
 *
 * "Console" is the fallback that needs nothing installed: a detached console program gets
 * a window of its own, which is all a terminal window is on Windows.
 */
const TERMINALS: TerminalSpec[] = [
  {
    name: "Windows Terminal",
    aliases: ["wt", "wt.exe", "windows-terminal"],
    binary: "wt",
    // `wt` splits its own arguments on `;` to open several tabs, so a PowerShell script
    // full of `;` has to have them escaped or it becomes several broken tabs.
    args: (invocation, title) => [
      "-w",
      "new",
      "--title",
      title,
      invocation.file,
      ...invocation.args.map((arg) => arg.replace(/;/g, "\\;")),
    ],
  },
  ...CROSS_PLATFORM_TERMINALS.filter((terminal) => terminal.name !== "Ghostty"),
  { name: "Console", aliases: ["conhost", "cmd"], args: (invocation) => [invocation.file, ...invocation.args] },
];

export function windowsTerminalCommand(name: string, invocation: Invocation, title: string): string[] {
  const spec = TERMINALS.find((terminal) => terminal.name === name);
  if (!spec) throw new Error(`unknown terminal ${name}`);
  const args = spec.args(invocation, title);
  return spec.binary ? [spec.binary, ...args] : args;
}

export const win32: Platform = {
  os: "win32",

  async openUrl(url) {
    // The shell's own URL handler, and no `cmd /c start` — whose quoting would let an `&`
    // in a query string end the command and start another.
    await launch("rundll32", ["url.dll,FileProtocolHandler", url]);
  },

  async openPath(path, options = {}) {
    const app = options.app?.trim();
    if (app) {
      const found = which(app);
      if (!found) throw new Error(`"${app}" is not on PATH`);
      return launch(found, [path]);
    }
    await launch("explorer.exe", [path]);
  },

  async launchApp(app) {
    const found = which(app);
    if (found) return launch(found, []);
    // `start` also finds what Windows registers under App Paths — `chrome`, `excel` —
    // which is how most installed apps are known by name. It goes through cmd, which reads
    // `&` and friends as its own syntax, so a name carrying them is refused rather than
    // allowed to start a second program.
    if (/[&|<>^%"\r\n]/.test(app)) throw new Error(`"${app}" is not a name Windows can start`);
    await launch("cmd.exe", ["/d", "/c", "start", "", app]);
  },

  async runInTerminal(invocation: Invocation, request: TerminalRequest) {
    const [file, ...args] = windowsTerminalCommand(request.terminal, invocation, request.title);
    if (!file) throw new Error("nothing to run");
    // Not hidden: for the console fallback, the window is the point.
    await launch(file, args, { windowsHide: false });
  },

  knownTerminals: () => TERMINALS.map((terminal) => terminal.name),
  findTerminal: (ref) => findIn(TERMINALS, ref),

  defaultTerminal() {
    if (process.env["WT_SESSION"] || which("wt")) return "Windows Terminal";
    const program = process.env["TERM_PROGRAM"];
    if (program) {
      const found = findIn(TERMINALS, program);
      if (found) return found;
    }
    return "Console";
  },
};

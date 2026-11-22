import { posixCommandLine } from "../core/system/shell.js";
import type { Invocation } from "../core/types.js";
import { run } from "./spawn.js";
import { CROSS_PLATFORM_TERMINALS, findIn, type TerminalSpec } from "./terminals.js";
import type { Platform, Tab, TerminalRequest } from "./types.js";

/** `com.acme.App` style identifiers, as opposed to a plain application name. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Terminals macOS can drive. Terminal and iTerm take a command through their own
 * AppleScript dictionary, which reuses the running app; the rest go through `open -na`,
 * which is also what gets a new window rather than a second copy of the app.
 */
const APPLESCRIPT_TERMINALS: TerminalSpec[] = [
  { name: "Terminal", aliases: ["com.apple.Terminal", "Apple_Terminal"], args: () => [] },
  { name: "iTerm", aliases: ["com.googlecode.iterm2", "iTerm2", "iTerm.app"], args: () => [] },
];

const TERMINALS: TerminalSpec[] = [...APPLESCRIPT_TERMINALS, ...CROSS_PLATFORM_TERMINALS];

/** `open -a Name` and `open -b bundle.id` are how macOS takes an app by either. */
export function appArgs(app: string): string[] {
  return BUNDLE_ID.test(app) ? ["-b", app] : ["-a", app];
}

export function terminalArgs(name: string, invocation: Invocation, title: string): { file: string; args: string[] } {
  if (name === "Terminal") {
    const script = `tell application "Terminal"\n  activate\n  do script "${forAppleScript(posixCommandLine(invocation))}"\nend tell`;
    return { file: "osascript", args: ["-e", script] };
  }
  if (name === "iTerm") {
    const script = `tell application "iTerm"\n  activate\n  create window with default profile command "${forAppleScript(
      posixCommandLine(invocation),
    )}"\nend tell`;
    return { file: "osascript", args: ["-e", script] };
  }

  const spec = TERMINALS.find((terminal) => terminal.name === name);
  if (!spec) throw new Error(`Wisp cannot drive "${name}" on macOS`);
  return { file: "open", args: ["-na", name, "--args", ...spec.args(invocation, title)] };
}

/** Escape for embedding inside an AppleScript double-quoted string. */
function forAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function notificationScript(title: string, message: string): string {
  return `display notification "${forAppleScript(message)}" with title "${forAppleScript(title)}"`;
}

export const darwin: Platform = {
  os: "darwin",

  async notify(title, message) {
    await run("osascript", ["-e", notificationScript(title, message)]);
  },

  async openUrl(url, options = {}) {
    await run("open", [...(options.background ? ["-g"] : []), url]);
  },

  async openPath(path, options = {}) {
    const app = options.app?.trim();
    await run("open", [...(options.background ? ["-g"] : []), ...(app ? appArgs(app) : []), path]);
  },

  async launchApp(app, options = {}) {
    const background = options.background ? ["-g"] : [];
    // A path to an .app is opened as itself; anything else is looked up by name or id.
    await run("open", [...background, ...(app.includes("/") ? [app] : appArgs(app))]);
  },

  async runInTerminal(invocation: Invocation, request: TerminalRequest) {
    const { file, args } = terminalArgs(request.terminal, invocation, request.title);
    await run(file, args);
  },

  knownTerminals: () => TERMINALS.map((terminal) => terminal.name),
  findTerminal: (ref) => findIn(TERMINALS, ref),

  defaultTerminal() {
    // The one you are typing in, which is the one you would pick.
    const program = process.env["TERM_PROGRAM"];
    if (program) {
      const found = findIn(TERMINALS, program);
      if (found) return found;
    }
    if (process.env["KITTY_WINDOW_ID"]) return "kitty";
    if (process.env["ALACRITTY_WINDOW_ID"] || process.env["ALACRITTY_SOCKET"]) return "Alacritty";
    return "Terminal";
  },

  tabs: { snapshot: snapshotTabs, focus: focusTab },
};

/**
 * The browsers Wisp can look inside.
 *
 * Firefox is absent on purpose: it exposes no tab list to AppleScript. Everything here is
 * Safari or a Chromium fork, and the two dictionaries differ only in how a tab is selected.
 */
const BROWSERS: { name: string; kind: "safari" | "chromium" }[] = [
  { name: "Safari", kind: "safari" },
  { name: "Google Chrome", kind: "chromium" },
  { name: "Arc", kind: "chromium" },
  { name: "Microsoft Edge", kind: "chromium" },
  { name: "Brave Browser", kind: "chromium" },
  { name: "Vivaldi", kind: "chromium" },
];

/**
 * Ask one browser for its tabs, or give up quietly.
 *
 * `is running` is what keeps this from launching anything: naming an application in a
 * `tell` block would start it, turning "reuse a tab" into "open a browser you did not ask
 * for". The tab character is bound outside the `tell` block, because inside one `tab`
 * means the browser's tab class.
 */
async function tabsOf(browser: string): Promise<Tab[]> {
  const script = `
set delim to character id 9
if application "${browser}" is not running then return ""
set out to {}
tell application "${browser}"
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    try
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        try
          set end of out to (wi as text) & delim & (ti as text) & delim & (URL of t as text)
        end try
      end repeat
    end try
  end repeat
end tell
set AppleScript's text item delimiters to linefeed
return out as text
`;

  let stdout: string;
  try {
    stdout = await run("osascript", ["-e", script]);
  } catch {
    // Not installed, not scriptable, or automation permission was refused. Either way
    // there is nothing to reuse, and plain `open` still works.
    return [];
  }

  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .flatMap(([window, index, ...rest]) => {
      const url = rest.join("\t").trim();
      if (!window || !index || !url) return [];
      return [{ browser, window: Number(window), index: Number(index), url }];
    });
}

/** Every tab open in every running scriptable browser, gathered once per run. */
async function snapshotTabs(): Promise<Tab[]> {
  return (await Promise.all(BROWSERS.map((browser) => tabsOf(browser.name)))).flat();
}

/** Bring an already-open tab to the front instead of opening a second copy of it. */
async function focusTab(tab: Tab): Promise<void> {
  const select =
    tab.browser === "Safari"
      ? `set current tab of window ${tab.window} to tab ${tab.index} of window ${tab.window}`
      : `set active tab index of window ${tab.window} to ${tab.index}`;

  await run("osascript", [
    "-e",
    `
if application "${tab.browser}" is not running then return
tell application "${tab.browser}"
  ${select}
  set index of window ${tab.window} to 1
  activate
end tell
`,
  ]);
}

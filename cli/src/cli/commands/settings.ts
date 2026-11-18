import { getOpenWithDefaults, setOpenWithDefaults } from "../../core/config.js";
import { detectEnvironment } from "../../core/environment.js";
import { WispError } from "../../core/errors.js";
import { getPlatform } from "../../platform/index.js";
import { MULTIPLEXERS } from "../../platform/terminals.js";
import { dim } from "../format.js";
import type { CommandDef } from "../lib/define.js";

const KINDS: Record<string, "folder" | "file" | "terminal"> = {
  folder: "folder",
  folders: "folder",
  file: "file",
  files: "file",
  terminal: "terminal",
  terminals: "terminal",
};

export const openWith: CommandDef<{ folder?: string; file?: string; terminal?: string }> = {
  name: "open-with",
  summary: "Choose the editor for folders and files, and the terminal for commands",
  args: [
    ["[what]", "folder, file or terminal"],
    ["[app]", "the app to use; omitted shows what is set"],
  ],
  options: [
    ["--folder <app>", "app that opens folders; blank to clear"],
    ["--file <app>", "app that opens files; blank to clear"],
    ["--terminal <app>", "terminal that runs commands; blank to go back to automatic"],
  ],
  examples: [
    "wisp open-with",
    'wisp open-with folder "Visual Studio Code"',
    "wisp open-with folder code          # on Linux, a command on PATH",
    "wisp open-with terminal ghost       # a prefix is enough",
    "wisp open-with terminal tmux",
  ],

  async run(args, flags) {
    const options = { ...flags, ...positional(args) };
    const platform = getPlatform();

    if (options.terminal?.trim()) {
      const name = options.terminal.trim().toLowerCase();
      const multiplexer = (MULTIPLEXERS as readonly string[]).find((entry) => entry === name);
      const terminal = multiplexer ?? platform.findTerminal(options.terminal);
      if (!terminal) {
        throw new WispError(
          `Wisp cannot drive "${options.terminal}". Known: ${[...platform.knownTerminals(), ...MULTIPLEXERS].join(", ")}`,
          "INVALID_INPUT",
        );
      }
      options.terminal = terminal;
    }

    const changing = options.folder !== undefined || options.file !== undefined || options.terminal !== undefined;
    const defaults = changing
      ? await setOpenWithDefaults({
          ...(options.folder !== undefined ? { folder: options.folder } : {}),
          ...(options.file !== undefined ? { file: options.file } : {}),
          ...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
        })
      : await getOpenWithDefaults();

    const environment = detectEnvironment();
    const automatic = environment.multiplexer ?? platform.defaultTerminal() ?? "background";

    console.log(`${dim("folders ")} ${defaults.folder ?? dim("the system default")}`);
    console.log(`${dim("files   ")} ${defaults.file ?? dim("the system default")}`);
    console.log(`${dim("commands")} ${defaults.terminal ?? dim(`automatic — ${automatic} here`)}`);

    if (!changing) {
      console.log();
      console.log(dim(`Terminals here: ${[...platform.knownTerminals(), ...MULTIPLEXERS].join(", ")}`));
    }
  },
};

/** `open-with terminal ghost` as the flags the rest of the command already understands. */
function positional(args: string[]): { folder?: string; file?: string; terminal?: string } {
  const [what, app] = args;
  if (!what) return {};

  const key = KINDS[what.trim().toLowerCase()];
  if (!key) throw new WispError(`Say what to set: folder, file or terminal — not "${what}"`, "INVALID_INPUT");

  // Naming the kind alone asks what is set, rather than clearing it: clearing is something
  // you should have to be explicit about, and `--folder ""` is.
  return app === undefined ? {} : { [key]: app };
}

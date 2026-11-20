import { getNotify, getOpenWithDefaults, setNotify, setOpenWithDefaults } from "../../core/config.js";
import { detectEnvironment } from "../../core/environment.js";
import { WispError } from "../../core/errors.js";
import { LONG_RUN_MS, sendNotification, webhookProblem } from "../../core/notify.js";
import type { NotifyWhen } from "../../core/types.js";
import { getPlatform } from "../../platform/index.js";
import { MULTIPLEXERS } from "../../platform/terminals.js";
import { dim, green, red } from "../format.js";
import { emitJson } from "../lib/context.js";
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

const WHEN: Record<NotifyWhen, string> = {
  failures: `a run fails that you might have missed: one nobody watched (cron, a script), or one over ${LONG_RUN_MS / 1000}s`,
  all: `any run ends that you might have missed: one nobody watched, or one over ${LONG_RUN_MS / 1000}s`,
  off: "never",
};

export const notify: CommandDef<{ webhook?: string; test?: boolean; json?: boolean }> = {
  name: "notify",
  summary: "Choose when Wisp tells you a run failed, and where: this screen, a webhook",
  args: [["[when]", "failures (the default), all, or off"]],
  options: [
    ["--webhook <url>", "also post to this address: Slack, Discord, ntfy or your own; blank to stop"],
    ["--test", "send a test notification now"],
    ["--json", "print the setting as JSON"],
  ],
  examples: ["wisp notify", "wisp notify all", "wisp notify --webhook https://ntfy.sh/my-server", "wisp notify --test"],

  async run([when], options) {
    if (when !== undefined && !(when in WHEN)) throw new WispError(`Say failures, all or off, not "${when}"`, "INVALID_INPUT");
    const webhook = options.webhook?.trim();
    const refused = webhook ? webhookProblem(webhook) : undefined;
    if (refused) throw new WispError(`"${webhook}": ${refused}`, "INVALID_INPUT");
    const changing = when !== undefined || options.webhook !== undefined;
    const settings = changing
      ? await setNotify({ ...(when ? { when: when as NotifyWhen } : {}), ...(options.webhook !== undefined ? { webhook: webhook ?? "" } : {}) })
      : await getNotify();
    const environment = detectEnvironment();
    const screen = environment.ssh ? "none: this is an SSH session" : environment.gui ? "this one" : "none: no display here";

    const problems = options.test
      ? await sendNotification(
          { ok: false, bolt: "A test", workspace: "Wisp", failedStep: "nothing, it's a test", durationMs: 0, watched: false },
          { platform: getPlatform(), environment, settings },
        )
      : undefined;
    if (problems && problems.length > 0) process.exitCode = 1;

    if (options.json) {
      return emitJson({ when: settings.when, webhook: settings.webhook ?? null, screen: environment.gui && !environment.ssh, ...(problems ? { test: { ok: problems.length === 0, problems } } : {}) });
    }
    console.log(`${dim("when   ")} ${settings.when}${dim(` — ${WHEN[settings.when]}`)}`);
    console.log(`${dim("screen ")} ${screen}`);
    console.log(`${dim("webhook")} ${settings.webhook ?? dim("none")}`);
    if (problems) {
      console.log();
      if (problems.length === 0) console.log(`${green("✓")} sent`);
      for (const problem of problems) console.log(`${red("✗")} ${problem}`);
    }
  },
};

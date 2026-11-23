import { getNotify, getOpenWithDefaults, type NotifyChoice, setNotify, setOpenWithDefaults } from "../../core/config.js";
import { detectEnvironment } from "../../core/system/environment.js";
import { WispError } from "../../core/errors.js";
import { addWebhook, type Delivery, lastDelivery, LONG_RUN_MS, maskWebhook, readDeliveries, removeWebhook, sendNotification } from "../../core/notify.js";
import { readProjectFile } from "../../core/project/index.js";
import type { NotifyWhen } from "../../core/types.js";
import { getPlatform } from "../../platform/index.js";
import { MULTIPLEXERS } from "../../platform/terminals.js";
import { ago, dim, green, red } from "../lib/format.js";
import { emitJson, everything, workspaceFor } from "../lib/context.js";
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
  changes: "a pipeline starts failing, and when it works again: once each, for checks that run every few minutes",
  all: `any run ends that you might have missed: one nobody watched, or one over ${LONG_RUN_MS / 1000}s`,
  off: "never",
};

function describeDelivery(delivery: Delivery | undefined): string {
  if (!delivery) return dim("nothing sent yet");
  if (delivery.ok) return dim(`sent ${ago(delivery.at)} ago`);
  return red(`✗ failed ${ago(delivery.at)} ago: ${delivery.problem ?? "no reason given"}`);
}

export const notify: CommandDef<{ test?: boolean; reveal?: boolean; json?: boolean }> = {
  name: "notify",
  summary: "Choose when Wisp tells you a run failed, and where: this screen, webhooks",
  args: [["[what...]", "failures (the default), changes, all or off; screen on or off; add <url> [workspace...]; remove <url | number> [workspace...]"]],
  options: [
    ["--test", "send a test notification now, to every webhook"],
    ["--reveal", "show the webhooks' whole addresses, secret included"],
    ["--json", "print the setting as JSON"],
  ],
  examples: [
    "wisp notify",
    "wisp notify changes",
    "wisp notify screen off            # webhooks only, nothing pops up here",
    "wisp notify add https://ntfy.sh/my-server",
    "wisp notify add https://hooks.slack.com/services/... staging production",
    "wisp notify remove 2",
    "wisp notify --test",
    "wisp notify --reveal              # whole addresses, to copy one",
  ],

  async run(args, options) {
    const [first, ref, ...names] = args;
    let settings: NotifyChoice;
    if (first === "add" || first === "remove") {
      if (!ref) throw new WispError(`Say which webhook: wisp notify ${first} <url>`, "INVALID_INPUT");
      const files = await Promise.all(names.map(async (name) => (await workspaceFor(name)).workspace.file));
      const { webhooks } = await getNotify();
      settings = await setNotify({ webhooks: first === "add" ? addWebhook(webhooks, ref.trim(), files) : removeWebhook(webhooks, ref, files) });
    } else if (first === "screen") {
      if ((ref !== "on" && ref !== "off") || args.length > 2) throw new WispError(`Say on or off: wisp notify screen ${ref ?? "<on | off>"}`, "INVALID_INPUT");
      settings = await setNotify({ screen: ref === "on" });
    } else if (first !== undefined) {
      if (!(first in WHEN) || args.length > 1) throw new WispError(`Say failures, changes, all or off, screen, or add or remove: not "${args.join(" ")}"`, "INVALID_INPUT");
      settings = await setNotify({ when: first as NotifyWhen });
    } else settings = await getNotify();

    const environment = detectEnvironment();
    const screen = !settings.screen ? "off" : environment.ssh ? "none: this is an SSH session" : environment.gui ? "this one" : "none: no display here";
    const files = [...new Set(settings.webhooks.flatMap((hook) => hook.workspaces ?? []))];
    const reads = files.length > 0 ? await everything() : [];
    const nameOf = new Map(
      await Promise.all(
        files.map(async (file) => [file, reads.find((read) => read.workspace.file === file)?.workspace.name ?? (await readProjectFile(file).then((read) => read.workspace.name).catch(() => file))] as const),
      ),
    );
    const named = (file: string) => ({ name: nameOf.get(file) ?? file, file });

    const problems = options.test
      ? await sendNotification(
          { ok: false, bolt: "A test", workspace: "Wisp", failedStep: "nothing", error: "it's a test", durationMs: 0, watched: false },
          { platform: getPlatform(), environment, settings: { ...settings, webhooks: settings.webhooks.map(({ url }) => ({ url })) } },
        )
      : undefined;
    if (problems && problems.length > 0) process.exitCode = 1;
    const deliveries = await readDeliveries();
    const shown = (url: string) => (options.reveal ? url : maskWebhook(url));

    if (options.json) {
      return emitJson({
        when: settings.when,
        webhooks: settings.webhooks.map((hook, at) => ({
          number: at + 1,
          url: shown(hook.url),
          workspaces: hook.workspaces ? hook.workspaces.map(named) : null,
          lastDelivery: lastDelivery(deliveries, hook.url) ?? null,
        })),
        screen: settings.screen && environment.gui && !environment.ssh,
        screenSetting: settings.screen,
        ...(problems ? { test: { ok: problems.length === 0, problems } } : {}),
      });
    }
    console.log(`${dim("when    ")} ${settings.when}${dim(` — ${WHEN[settings.when]}`)}`);
    console.log(`${dim("screen  ")} ${screen}`);
    if (settings.webhooks.length === 0) console.log(`${dim("webhooks")} ${dim("none: wisp notify add <url> [workspace...]")}`);
    else {
      console.log(dim("webhooks"));
      settings.webhooks.forEach((hook, at) => {
        console.log(`  ${dim(`${at + 1}`)}  ${shown(hook.url)}  ${dim(!hook.workspaces ? "every workspace" : reads.length > 1 && reads.every((read) => hook.workspaces?.includes(read.workspace.file)) ? "all workspaces" : hook.workspaces.map((file) => named(file).name).join(", "))}`);
        console.log(`     ${describeDelivery(lastDelivery(deliveries, hook.url))}`);
      });
    }
    if (problems) {
      console.log();
      if (problems.length === 0) console.log(`${green("✓")} sent`);
      for (const problem of problems) console.log(`${red("✗")} ${problem}`);
    }
  },
};

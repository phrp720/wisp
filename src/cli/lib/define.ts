import { Command } from "commander";

import { WispError } from "../../core/errors.js";
import { dim, red } from "../format.js";

/**
 * One command, declared rather than assembled.
 *
 * Commander's fluent form puts a command's name, arguments, options and body inside one
 * expression. A command is a small record; this lets it be written as one, and keeps the
 * wiring — help, examples, errors, the exit code — in a single place.
 */
export interface CommandDef<Options = Record<string, never>> {
  name: string;
  aliases?: string[];
  /** One line, sentence case, no full stop — shown in `wisp --help`. */
  summary: string;
  args?: [name: string, description: string][];
  options?: [flags: string, description: string, fallback?: string | boolean][];
  /** Lines shown under the command's own `--help`: what is usual, not just what is possible. */
  examples?: string[];
  /**
   * Where `wisp --help` lists it. Everyday commands come first and alone, so the help
   * answers "what do I type" before it answers "what else is there".
   */
  group?: "everyday" | "more";
  run: (args: string[], options: Options) => Promise<void>;
}

export function register<Options>(program: Command, def: CommandDef<Options>): Command {
  const command = new Command(def.name).description(def.summary);
  command.helpGroup(def.group === "everyday" ? "Everyday:" : "More:");

  for (const alias of def.aliases ?? []) command.alias(alias);
  for (const [name, description] of def.args ?? []) command.argument(name, description);
  for (const [flags, description, fallback] of def.options ?? []) {
    if (fallback === undefined) command.option(flags, description);
    else command.option(flags, description, fallback);
  }

  if (def.examples?.length) {
    command.addHelpText("after", `\nExamples\n${def.examples.map((line) => `  ${dim(line)}`).join("\n")}`);
  }

  // Commander hands the action every declared argument, then the options, then itself.
  command.action(async (...received: unknown[]) => {
    const declared = def.args ?? [];
    const options = received[declared.length] as Options;
    const args = received
      .slice(0, declared.length)
      .flatMap((value) => (Array.isArray(value) ? (value as string[]) : value === undefined ? [] : [value as string]));

    try {
      await def.run(declared.some(([name]) => name.includes("...")) ? args : (received.slice(0, declared.length) as string[]), options);
    } catch (error) {
      fail(error);
    }
  });

  program.addCommand(command);
  return command;
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${red("✗")} ${message}`);

  if (error instanceof WispError) {
    const hint = HINTS[error.code];
    if (hint) console.error(dim(hint));
  }

  process.exit(1);
}

/** What to try next, for the failures that have an obvious next thing to try. */
const HINTS: Record<string, string> = {
  NOT_FOUND: "Run `wisp list` to see what's available.",
  NO_BOLT: "Run `wisp` to see this project's bolts.",
  AMBIGUOUS: "Name it more precisely.",
  PROJECT_INVALID: "Run `wisp check` to see what is wrong with the file.",
  PROJECT_EXISTS: "Run `wisp check` to see what the existing file declares.",
  NO_PROJECT: "Run `wisp init` to give this project a .wisp.json.",
  NO_DISPLAY: "Run it with --detach to start it in the background, or from inside tmux.",
  UNKNOWN_TERMINAL: "Set one with `wisp open-with terminal <name>`, or clear it with `wisp open-with --terminal \"\"`.",
  NO_SHELL: "Set `shell` on the command, or give it a per-OS `run`.",
  CYCLE: "Run `wisp check` to see the dependencies.",
  NOTHING_TO_RETRY: "`wisp history` shows how its last runs went.",
  HOOK_EXISTS: "Look at it first: it may be another tool's, like husky's.",
};

#!/usr/bin/env node
import { Command } from "commander";

import { status } from "./commands/status.js";
import { dim } from "./format.js";
import { withImplicitUse } from "./lib/argv.js";
import { COMMANDS, verbs } from "./lib/commands.js";
import { fail, register } from "./lib/define.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("specter")
  .description("Start a project's working context with one word: its links, folders, files, apps and commands")
  .version(VERSION)
  .showHelpAfterError()
  // Bare `specter` answers "what can I run from here", the question you have every day,
  // rather than the help, which answers one you have once.
  .action(async () => {
    try {
      // At a terminal, the TUI; anywhere else — a pipe, a script, an agent — the plain
      // answer, so nothing ever waits on keys nobody will press.
      if (interactive()) {
        const { startTui } = await import("../tui/index.js");
        await startTui();
      } else {
        await status();
      }
    } catch (error) {
      fail(error);
    }
  });

function interactive(): boolean {
  if (process.env["SPECTER_NO_TUI"] || process.env["CI"]) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

for (const command of COMMANDS) register(program, command);

// The plain-text view the TUI replaces, for when you want it at a terminal anyway.
program
  .command("status")
  .helpGroup("More:")
  .description("Print what this project can run, without opening the TUI")
  .action(async () => {
    try {
      await status();
    } catch (error) {
      fail(error);
    }
  });

program.addHelpText(
  "after",
  `
${dim("In a project with a .specter.json:")}
${dim("  specter            open the TUI: every workspace, its bolts, ⏎ to run")}
${dim("  specter api        run its api bolt")}
${dim("  specter init       give a project a .specter.json")}
`,
);

program.parseAsync(withImplicitUse(process.argv, verbs())).catch(fail);

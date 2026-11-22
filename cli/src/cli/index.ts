#!/usr/bin/env node
import { Command } from "commander";

import { securePrivateFolders } from "../core/paths.js";
import { status } from "./commands/status.js";
import { dim } from "./format.js";
import { withImplicitUse } from "./lib/argv.js";
import { COMMANDS, verbs } from "./lib/commands.js";
import { fail, register } from "./lib/define.js";
import { quietOnClosedPipe } from "./lib/pipes.js";
import { VERSION } from "./version.js";

quietOnClosedPipe(process.stdout);
quietOnClosedPipe(process.stderr);

const program = new Command()
  .name("wisp")
  .description("Pipelines for your own machines: your dev stack, checks, deploys and backups, run by name from any folder")
  .version(VERSION)
  .showHelpAfterError()
  // Bare `wisp` answers "what can I run from here", the question you have every day,
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
  if (process.env["WISP_NO_TUI"] || process.env["CI"]) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

for (const command of COMMANDS) register(program, command);

// The plain-text view the TUI replaces, for when you want it at a terminal anyway.
program
  .command("status")
  .helpGroup("More:")
  .description("Print what this project can run, without opening the dashboard")
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
${dim("In a project with a .wisp.json:")}
${dim("  wisp            open the dashboard: every workspace, its pipelines, ⏎ to run")}
${dim("  wisp api        run its api pipeline")}
${dim("  wisp init       give a project a .wisp.json")}

${dim("AI agents: run `wisp help agents` for the full reference. Most commands take --json.")}

${dim("Wisp, as in will-o'-the-wisp: the little light that leads the way.")}
`,
);

// What the shells' completion scripts call on ⇥: the suggestions for the word being typed,
// one per line. Quiet and quick, and never an error: a broken completion is just no help.
if (process.argv[2] === "__complete") {
  const words = process.argv.slice(3);
  if (words[0] === "--") words.shift();
  try {
    const { complete, formatCandidates } = await import("./lib/complete.js");
    const text = formatCandidates(await complete(words.length > 0 ? words : [""]));
    if (text) process.stdout.write(`${text}\n`);
  } catch {
    // no suggestions
  }
} else {
  await securePrivateFolders().catch(() => undefined);
  program.parseAsync(withImplicitUse(process.argv, verbs())).catch(fail);
}

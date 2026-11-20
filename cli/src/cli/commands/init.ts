import { relative } from "node:path";

import { tildify } from "../../core/paths.js";
import { WispError } from "../../core/errors.js";
import { PROJECT_FILE, findProjectFile } from "../../core/project.js";
import { bolts as draftBolts, draftProject, writeProjectDraft } from "../../core/scaffold.js";

import { cyan, dim, green, yellow } from "../format.js";
import type { CommandDef } from "../lib/define.js";
import { Prompter, checklist } from "../prompt.js";

export const init: CommandDef<{ force?: boolean; yes?: boolean; print?: boolean; only?: string }> = {
  name: "init",
  summary: `Write a ${PROJECT_FILE} for this project, guessed from what is here`,
  options: [
    ["-f, --force", "replace an existing project file"],
    ["-y, --yes", "write it without showing it first"],
    ["--print", "print the draft to stdout and write nothing"],
    ["--only <bolts>", 'only these of the suggested bolts, comma separated: "Check,Services"'],
  ],
  examples: ["wisp init", "wisp init --print", 'wisp init --only "Check,Work on api"', "wisp init --force"],

  async run(_args, options) {
    const only = options.only?.split(",").map((name) => name.trim()).filter(Boolean);
    let draft = await draftProject(process.cwd(), only ? { only } : {});

    // Said before anything is chosen, not after: choosing bolts for a file that then isn't
    // written would be time wasted.
    if (!options.print) {
      const existing = await findProjectFile();
      // Already set up: nothing to suggest. `--force` starts over.
      if (existing && existing === draft.file && !options.force) {
        throw new WispError(`This project is already initialized: ${PROJECT_FILE} exists. Edit it in \`wisp\`, or start over with \`wisp init --force\``, "PROJECT_EXISTS");
      }
      if (existing && existing !== draft.file && !options.force) {
        console.log(yellow(`! a project file already governs this directory: ${dim(existing)}`));
        console.log(dim("  Writing one here would shadow it. Pass --force if that is what you want."));
        return;
      }
    }

    // At a terminal: a checklist, right here in it. Each suggested bolt with what it does,
    // untick what you don't want, ⏎ writes it; esc writes nothing. That is the look before
    // it goes in the repository.
    const atTerminal = !only && !options.yes && !options.print && process.stdin.isTTY && process.stdout.isTTY;
    if (atTerminal && draftBolts(draft.detected).length > 0) {
      const { setupSuggestion } = await import("../../tui/services.js");
      const suggestion = setupSuggestion(process.cwd(), draft);
      if (suggestion.found.length > 0) console.log(dim(`Found: ${suggestion.found.join(" · ")}`));

      // Suggestions are optional: say no, or tick none, and the file starts with no bolts.
      const prompt = new Prompter();
      let wanted = true;
      try {
        wanted = await prompt.confirm("Suggest bolts from what Wisp found?", true);
      } catch {
        console.log(dim("Nothing written."));
        return;
      } finally {
        prompt.close();
      }
      const chosen = wanted
        ? await checklist(
            "Which bolts should Wisp set up?",
            suggestion.bolts.map((bolt) => ({ label: bolt.label, hint: bolt.steps.join(", then ") })),
          )
        : [];
      if (!chosen) {
        console.log(dim("Nothing written."));
        return;
      }
      draft = await draftProject(process.cwd(), { only: chosen });
      await writeProjectDraft(draft, options.force ?? false);
      const where = cyan(relative(process.cwd(), draft.file) || draft.file);
      if (chosen.length > 0) {
        console.log(`${green("✓")} wrote ${where} ${dim(`· ${chosen.join(", ")}`)}`);
        console.log(dim("Next: `wisp trust` to allow its commands, then `wisp` or `wisp <bolt>`. Commit it: your team gets it too."));
      } else {
        console.log(`${green("✓")} wrote ${where} ${dim("· no bolts yet")}`);
        console.log(dim("Next: open `wisp` and press a to add your first bolt."));
      }
      return;
    }

    if (options.print) {
      process.stdout.write(draft.contents);
      return;
    }

    // A project file is committed and read in review, so the one thing `init` must not do
    // is put a file in someone's repository before they have seen what it says.
    if (!options.yes) {
      console.log(dim(tildify(draft.file)));
      console.log();
      console.log(draft.contents.trimEnd());
      console.log();
      console.log(describe(draft.detected));

      if (process.stdin.isTTY) {
        const prompt = new Prompter();
        try {
          if (!(await prompt.confirm("Write it?", true))) {
            console.log(dim("Nothing written."));
            return;
          }
        } finally {
          prompt.close();
        }
      }
    }

    await writeProjectDraft(draft, options.force ?? false);

    console.log(`${green("✓")} wrote ${cyan(relative(process.cwd(), draft.file) || draft.file)}`);
    console.log(dim("Run it with `wisp`. Check it any time with `wisp check`."));
    console.log(dim("Commit it: the repository carries its own context."));
  },
};

/** Why the draft looks the way it does, so the guesses can be judged rather than trusted. */
function describe(detected: { remote?: string; sources: string[] }): string {
  const parts = [detected.remote ? `remote ${dim(detected.remote)}` : dim("no git remote"), ...detected.sources];
  return `${dim("from")} ${parts.join(dim(" · "))}`;
}

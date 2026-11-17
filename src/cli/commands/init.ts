import { relative } from "node:path";

import { PROJECT_FILE, findProjectFile } from "../../core/project.js";
import { draftProject, writeProjectDraft } from "../../core/scaffold.js";

import { bold, cyan, dim, green, yellow } from "../format.js";
import type { CommandDef } from "../lib/define.js";
import { Prompter } from "../prompt.js";

export const init: CommandDef<{ force?: boolean; yes?: boolean; print?: boolean }> = {
  name: "init",
  summary: `Write a ${PROJECT_FILE} for this project, guessed from what is here`,
  options: [
    ["-f, --force", "replace an existing project file"],
    ["-y, --yes", "write it without showing it first"],
    ["--print", "print the draft to stdout and write nothing"],
  ],
  examples: ["specter init", "specter init --print", "specter init --force"],

  async run(_args, options) {
    const draft = await draftProject();

    if (options.print) {
      process.stdout.write(draft.contents);
      return;
    }

    // A project file is committed and read in review, so the one thing `init` must not do
    // is put a file in someone's repository before they have seen what it says.
    if (!options.yes) {
      console.log(dim(`${draft.file}`));
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

    const existing = await findProjectFile();
    if (existing && existing !== draft.file && !options.force) {
      console.log(
        yellow(`! a project file already governs this directory: ${dim(existing)}`),
      );
      console.log(dim("  Writing one here would shadow it. Pass --force if that is what you want."));
      return;
    }

    await writeProjectDraft(draft, options.force ?? false);

    console.log(`${green("✓")} wrote ${cyan(relative(process.cwd(), draft.file) || draft.file)}`);
    console.log(dim("Run it with `specter`. Check it any time with `specter check`."));
    console.log(dim("Commit it — that is the point: the repository carries its own context."));
  },
};

/** Why the draft looks the way it does, so the guesses can be judged rather than trusted. */
function describe(detected: { remote?: string; sources: string[] }): string {
  const parts = [detected.remote ? `remote ${dim(detected.remote)}` : dim("no git remote"), ...detected.sources];
  return `${dim("from")} ${parts.join(dim(" · "))}`;
}

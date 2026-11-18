import { relative } from "node:path";

import { tildify } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile } from "../../core/project.js";
import { bolts as draftBolts, draftProject, writeProjectDraft } from "../../core/scaffold.js";

import { bold, cyan, dim, green, yellow } from "../format.js";
import type { CommandDef } from "../lib/define.js";
import { Prompter } from "../prompt.js";

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
    let only = options.only?.split(",").map((name) => name.trim()).filter(Boolean);
    let draft = await draftProject(process.cwd(), only ? { only } : {});

    // At a terminal, choose which of the suggested bolts to keep before seeing the file.
    if (!only && !options.yes && !options.print && process.stdin.isTTY) {
      const suggested = draftBolts(draft.detected);
      if (suggested.length > 1) {
        console.log(bold("Wisp suggests these bolts:"));
        suggested.forEach((bolt, at) => console.log(`  ${dim(String(at + 1).padStart(2))}  ${bolt.label}${bolt.job ? dim(" (a job)") : ""}`));
        console.log();
        const prompt = new Prompter();
        try {
          const answer = (await prompt.ask("Which to keep? ⏎ for all, or their numbers, like 1 3", "")).trim();
          if (answer) {
            const picked = [...answer.matchAll(/\d+/g)].map((match) => suggested[Number(match[0]) - 1]?.label).filter((label): label is string => Boolean(label));
            if (picked.length > 0) {
              only = picked;
              draft = await draftProject(process.cwd(), { only });
            }
          }
        } finally {
          prompt.close();
        }
        console.log();
      }
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
    console.log(dim("Run it with `wisp`. Check it any time with `wisp check`."));
    console.log(dim("Commit it — that is the point: the repository carries its own context."));
  },
};

/** Why the draft looks the way it does, so the guesses can be judged rather than trusted. */
function describe(detected: { remote?: string; sources: string[] }): string {
  const parts = [detected.remote ? `remote ${dim(detected.remote)}` : dim("no git remote"), ...detected.sources];
  return `${dim("from")} ${parts.join(dim(" · "))}`;
}

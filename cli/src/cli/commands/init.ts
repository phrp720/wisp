import { relative } from "node:path";

import { createPersonalWorkspace } from "../../core/edit.js";
import { tildify } from "../../core/paths.js";
import { WispError } from "../../core/errors.js";
import { PROJECT_FILE, findProjectFile } from "../../core/project/index.js";
import { bolts as draftPipelines, draftProject, emptyProject, guessName, writeProjectDraft } from "../../core/init/scaffold.js";
import { slugify } from "../../core/workspaces.js";

import { cyan, dim, green, yellow } from "../lib/format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { Prompter, checklist } from "../lib/prompt.js";

export const init: CommandDef<{ force?: boolean; yes?: boolean; print?: boolean; only?: string; empty?: boolean; name?: string; personal?: boolean; json?: boolean }> = {
  name: "init",
  summary: `Write a ${PROJECT_FILE} for this project, guessed from what is here`,
  options: [
    ["-f, --force", "replace an existing project file"],
    ["-y, --yes", "write it without showing it first"],
    ["--print", "print the draft to stdout and write nothing"],
    ["--only <pipelines>", 'only these of the suggested pipelines, comma separated: "Dev,Verify"'],
    ["--empty", "write a file with no pipelines, without looking through the project"],
    ["--name <name>", "the workspace's name; at a terminal Wisp asks, offering the one it found"],
    ["-p, --personal", "create a personal workspace instead, for what belongs to no repository"],
    ["--json", "with --personal: print the new workspace as JSON"],
  ],
  examples: ["wisp init", "wisp init --empty", "wisp init --print", 'wisp init --only "Dev,Verify"', "wisp init --personal --name Homelab"],

  async run(_args, options) {
    const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    if (options.personal) {
      const given = options.name?.trim();
      if (!given && !terminal) throw new WispError("Give it a name: `wisp init --personal --name Homelab`", "INVALID_INPUT");
      const name = given || (await askName("Name of the personal workspace"));
      const file = await createPersonalWorkspace(name);
      if (options.json) return emitJson({ name, file, personal: true });
      console.log(`${green("✓")} created ${name} ${dim(`· ${tildify(file)}`)}`);
      console.log(dim(`Next: add pipelines with \`wisp\` (a), or in the file. Run one from any folder with \`wisp ${slugify(name)} <pipeline>\`.`));
      return;
    }

    const only = options.only?.split(",").map((name) => name.trim()).filter(Boolean);
    let empty = emptyProject(process.cwd());

    // Said before anything is chosen, not after: choosing pipelines for a file that then
    // isn't written would be time wasted.
    if (!options.print) {
      const existing = await findProjectFile();
      // Already set up: nothing to suggest. `--force` starts over.
      if (existing && existing === empty.file && !options.force) {
        throw new WispError(`This project is already initialized: ${PROJECT_FILE} exists. Edit it in \`wisp\`, or start over with \`wisp init --force\``, "PROJECT_EXISTS");
      }
      if (existing && existing !== empty.file && !options.force) {
        console.log(yellow(`! a project file already governs this directory: ${dim(existing)}`));
        console.log(dim("  Writing one here would shadow it. Pass --force if that is what you want."));
        return;
      }
    }

    const interactive = terminal && !only && !options.yes && !options.print;
    let name = options.name?.trim() || (await guessName(process.cwd()));
    if (interactive && !options.name) name = await askName("Workspace name", name);
    empty = emptyProject(process.cwd(), name);

    const writeEmpty = async () => {
      await writeProjectDraft(empty, options.force ?? false);
      console.log(`${green("✓")} wrote ${cyan(relative(process.cwd(), empty.file) || empty.file)} ${dim("· no pipelines yet")}`);
      console.log(dim("Next: open `wisp` and press a to add your first pipeline, or write them in the file."));
    };
    if (options.empty) return writeEmpty();

    const atTerminal = interactive;
    if (atTerminal) {
      const prompt = new Prompter();
      let look = true;
      try {
        look = await prompt.confirm("Look through the project and suggest pipelines?", true);
      } catch {
        console.log(dim("Nothing written."));
        return;
      } finally {
        prompt.close();
      }
      if (!look) return writeEmpty();
    }

    let draft = await draftProject(process.cwd(), { name, ...(only ? { only } : {}) });

    if (atTerminal) {
      if (draftPipelines(draft.detected).length === 0) {
        console.log(dim("Found nothing to suggest here, so it starts empty."));
        return writeEmpty();
      }
      const { setupSuggestion } = await import("../../tui/services.js");
      const suggestion = setupSuggestion(process.cwd(), draft);
      if (suggestion.found.length > 0) console.log(dim(`Found: ${suggestion.found.join(" · ")}`));
      const chosen = await checklist(
        "Which pipelines should Wisp set up?",
        suggestion.bolts.map((bolt) => ({ label: bolt.label, hint: bolt.steps.join(", then ") })),
      );
      if (!chosen) {
        console.log(dim("Nothing written."));
        return;
      }
      draft = await draftProject(process.cwd(), { name, only: chosen });
      await writeProjectDraft(draft, options.force ?? false);
      const where = cyan(relative(process.cwd(), draft.file) || draft.file);
      if (chosen.length > 0) {
        console.log(`${green("✓")} wrote ${where} ${dim(`· ${chosen.join(", ")}`)}`);
        console.log(dim("Next: `wisp trust` to allow its commands, then `wisp` or `wisp <pipeline>`. Commit it: your team gets it too."));
      } else {
        console.log(`${green("✓")} wrote ${where} ${dim("· no pipelines yet")}`);
        console.log(dim("Next: open `wisp` and press a to add your first pipeline."));
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

async function askName(question: string, suggested = ""): Promise<string> {
  const prompt = new Prompter();
  try {
    for (;;) {
      const answer = (await prompt.ask(question, suggested)).trim();
      if (answer) return answer;
      console.log(dim("  It needs a name."));
    }
  } finally {
    prompt.close();
  }
}

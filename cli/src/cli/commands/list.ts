import { tildify } from "../../core/paths.js";
import { discoverWorkspaces, slugify, sharedNames } from "../../core/workspaces.js";
import { counts, cyan, dim, green, red, title, yellow } from "../lib/format.js";
import { emitJson, maybeProject } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import type { WorkspaceRead } from "../../core/types.js";

export const list: CommandDef<{ json?: boolean }> = {
  name: "list",
  aliases: ["ls"],
  summary: "List every workspace Wisp knows: yours, and the projects you have used",
  options: [["--json", "print them as JSON"]],
  examples: ["wisp list", "wisp list --json | jq '.[].name'"],

  async run(_args, options) {
    const { reads, unreadable } = await discoverWorkspaces();
    const here = await maybeProject();
    if (here && !reads.some((read) => read.workspace.file === here.workspace.file)) reads.unshift(here);

    if (options.json) {
      return emitJson(workspaceSummaries(reads));
    }

    if (reads.length === 0 && unreadable.length === 0) {
      console.log(dim("No workspaces yet. `wisp init` in a project, or `wisp scan ~/dev` to find them."));
      return;
    }

    for (const read of reads) {
      const { workspace } = read;
      const current = here?.workspace.file === workspace.file ? green("●") : " ";
      const where = workspace.personal ? dim("personal") : dim(tildify(workspace.file));
      const trust =
        !workspace.personal && read.declaredCommands.length > 0
          ? workspace.trusted
            ? green(" ✓")
            : yellow(read.trust === "stale" ? " ! changed" : " ! untrusted")
          : "";
      // What to type for it from any folder: `wisp payments-service`, or `wisp payments-service <pipeline>`.
      console.log(`${current} ${title(workspace)} ${cyan(slugify(workspace.name))}  ${counts(workspace)}  ${where}${trust}`);
    }

    for (const failure of unreadable) console.log(`${red("✗")} ${dim(tildify(failure.file))} ${failure.error}`);
    for (const shared of sharedNames(reads.map((read) => read.workspace))) {
      const same = reads.filter((read) => slugify(read.workspace.name) === shared);
      console.log(yellow(`\n! ${same.length} workspaces are called ${same[0]?.workspace.name}, so \`wisp ${shared} …\` can't tell them apart.`));
      console.log(dim(`  Give one another name (e on it in the dashboard), or run it by its file: \`wisp use ${tildify(same[0]?.workspace.file ?? "")} <pipeline>\`.`));
    }
    console.log(dim("\n`wisp show <name>` lists a workspace's pipelines · `wisp <name> <pipeline>` runs one, from any folder · `wisp pick <name>` chooses"));
  },
};

export function workspaceSummaries(reads: WorkspaceRead[]) {
  return reads.map((read) => ({
    name: read.workspace.name,
    file: read.workspace.file,
    personal: read.workspace.personal,
    trust: read.workspace.personal ? "personal" : read.trust,
    pipelines: read.workspace.pipelines.map((pipeline) => pipeline.label),
  }));
}

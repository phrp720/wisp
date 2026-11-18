import { tildify } from "../../core/paths.js";
import { discoverWorkspaces, slugify } from "../../core/workspaces.js";
import { counts, cyan, dim, green, red, title, yellow } from "../format.js";
import { emitJson, maybeProject } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";

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
      return emitJson(
        reads.map((read) => ({
          name: read.workspace.name,
          file: read.workspace.file,
          personal: read.workspace.personal,
          trust: read.workspace.personal ? "personal" : read.trust,
          bolts: read.workspace.bolts.map((bolt) => bolt.label),
        })),
      );
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
      // What to type for it from any folder: `wisp flower-testbed`, or `wisp flower-testbed <bolt>`.
      console.log(`${current} ${title(workspace)} ${cyan(slugify(workspace.name))}  ${counts(workspace)}  ${where}${trust}`);
    }

    for (const failure of unreadable) console.log(`${red("✗")} ${dim(tildify(failure.file))} ${failure.error}`);
    console.log(dim("\n`wisp <name>` lists a workspace's bolts · `wisp <name> <bolt>` runs one, from any folder"));
  },
};

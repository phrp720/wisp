import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import { discoverWorkspaces } from "../../core/workspaces.js";
import { counts, dim, plural, red, title } from "../format.js";
import { maybeProject } from "../lib/context.js";
import { diagnosticSummary, printBolts, shortest, trustLine } from "../lib/render.js";

/**
 * What bare `wisp` shows when it is not opening the TUI.
 *
 * Standing in a project: what that project can run. Anywhere else: every workspace you
 * have, since "what can I run" has an answer wherever you are.
 */
export async function status(): Promise<void> {
  const here = await maybeProject();

  if (here) {
    const { workspace } = here;
    console.log(`${title(workspace)}  ${counts(workspace)}`);
    console.log(dim(tildify(workspace.file)));

    if (workspace.bolts.length > 0) {
      console.log();
      printBolts(workspace, false, here.withheld, await listRuns());
      console.log();
      console.log(dim(`Run one with \`wisp ${shortest(workspace.bolts[0]!, workspace.bolts, true)}\`, or \`wisp pick\` to choose.`));
    } else {
      console.log();
      console.log(dim("No pipelines in this file yet. Add some, then `wisp <pipeline>`."));
    }

    const trust = trustLine(here);
    const health = diagnosticSummary(here);
    if (trust || health) console.log();
    if (trust) console.log(trust);
    if (health) console.log(health);
    return;
  }

  const { reads, unreadable } = await discoverWorkspaces();

  if (reads.length === 0 && unreadable.length === 0) {
    console.log(dim("No workspaces yet."));
    console.log(dim("  `wisp init`   a .wisp.json for the project you are in"));
    console.log(dim("  `wisp scan ~/dev`   find the ones you already have"));
    return;
  }

  console.log(dim(`${plural(reads.length, "workspace")} — none in this directory`));
  console.log();
  for (const read of reads) {
    console.log(`${title(read.workspace)}  ${counts(read.workspace)}  ${dim(read.workspace.personal ? "personal" : tildify(read.workspace.file))}`);
  }
  for (const failure of unreadable) console.log(`${red("✗")} ${dim(tildify(failure.file))} ${failure.error}`);
  console.log();
  console.log(dim("`wisp show <workspace>` lists its pipelines, `wisp <workspace> <pipeline>` runs one, `wisp pick` chooses."));
}

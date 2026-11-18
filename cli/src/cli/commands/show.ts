import { dirname } from "node:path";

import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import { collectTargets } from "../../core/switch.js";
import { bold, counts, dim, title } from "../format.js";
import { emitJson, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, printBolts, targetLine, trustLine } from "../lib/render.js";

export const show: CommandDef<{ json?: boolean }> = {
  name: "show",
  summary: "Show everything a workspace holds, and what each bolt does",
  args: [["[workspace]", "workspace name; omitted uses this directory's project"]],
  options: [["--json", "print the resolved workspace as JSON"]],
  examples: ["wisp show", "wisp show acme", "wisp show --json"],

  async run([query], options) {
    const read = await workspaceFor(query);
    const { workspace } = read;

    if (options.json) {
      return emitJson({ ...workspace, trust: read.trust, diagnostics: read.diagnostics, withheld: read.withheld });
    }

    console.log(`${title(workspace)}  ${counts(workspace)}`);
    console.log(dim(tildify(workspace.file)));
    if (workspace.local) console.log(dim(`+ ${tildify(workspace.local)}`));
    if (workspace.notes) console.log(dim(workspace.notes));

    const targets = collectTargets(workspace);
    if (targets.length > 0) console.log();
    for (const target of targets) console.log(targetLine(target, "  ", dirname(workspace.file)));

    const trust = trustLine(read);
    const health = diagnosticSummary(read);
    if (trust || health) console.log();
    if (trust) console.log(trust);
    if (health) console.log(health);

    if (workspace.bolts.length === 0) {
      console.log();
      console.log(dim("No bolts yet — a bolt lists some of these and starts them together."));
      return;
    }

    console.log();
    console.log(bold("Bolts"));
    printBolts(workspace, true, read.withheld, await listRuns());
  },
};

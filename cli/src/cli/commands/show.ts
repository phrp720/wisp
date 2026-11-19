import { dirname } from "node:path";

import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import { collectTargets } from "../../core/switch.js";
import { bold, counts, dim, title } from "../format.js";
import { emitJson, maybeProject, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, printBolts, shortest, targetLine, trustLine } from "../lib/render.js";
import { slugify } from "../../core/workspaces.js";

export const show: CommandDef<{ json?: boolean }> = {
  name: "show",
  summary: "Show a workspace: its bolts and what each does, then everything it holds",
  args: [["[workspace]", "workspace name; omitted uses this directory's project"]],
  options: [["--json", "print the resolved workspace as JSON"]],
  examples: ["wisp show", "wisp show acme", "wisp show --json"],

  async run([query], options) {
    const read = await workspaceFor(query);
    const { workspace } = read;

    if (options.json) {
      return emitJson({
        ...workspace,
        bolts: workspace.bolts.map((bolt) => ({ ...bolt, slug: slugify(bolt.label) })),
        trust: read.trust,
        diagnostics: read.diagnostics,
        withheld: read.withheld,
      });
    }

    console.log(`${title(workspace)}  ${counts(workspace)}`);
    console.log(dim(tildify(workspace.file)));
    if (workspace.local) console.log(dim(`+ ${tildify(workspace.local)}`));
    if (workspace.notes) console.log(dim(workspace.notes));

    console.log();
    if (workspace.bolts.length === 0) {
      console.log(dim("No bolts yet. A bolt lists some of what is below and starts it together."));
    } else {
      console.log(bold("Bolts"));
      printBolts(workspace, true, read.withheld, await listRuns());
    }

    const targets = collectTargets(workspace);
    if (targets.length > 0) {
      console.log();
      console.log(bold("Holds"));
      for (const target of targets) console.log(targetLine(target, "  ", dirname(workspace.file)));
    }

    const trust = trustLine(read);
    const health = diagnosticSummary(read);
    if (trust || health) console.log();
    if (trust) console.log(trust);
    if (health) console.log(health);

    const first = workspace.bolts[0];
    if (first) {
      const here = await maybeProject().catch(() => undefined);
      const prefix = here?.workspace.file === workspace.file ? "" : `${slugify(workspace.name)} `;
      console.log();
      console.log(dim(`Run one with \`wisp ${prefix}${shortest(first, workspace.bolts)}\`, or \`wisp pick${prefix ? ` ${prefix.trim()}` : ""}\` to choose.`));
    }
  },
};

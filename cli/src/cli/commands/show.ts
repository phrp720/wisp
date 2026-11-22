import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import { collectBoltTargets, collectDownTargets } from "../../core/switch.js";
import { bold, counts, dim, title } from "../format.js";
import { emitJson, maybeProject, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, printBolts, shortest, trustLine } from "../lib/render.js";
import { slugify } from "../../core/workspaces.js";

export const show: CommandDef<{ json?: boolean }> = {
  name: "show",
  summary: "Show a workspace: its pipelines, and what each one does",
  args: [["[workspace]", "workspace name; omitted uses this directory's project"]],
  options: [["--json", "print the resolved workspace as JSON"]],
  examples: ["wisp show", "wisp show acme", "wisp show --json"],

  async run([query], options) {
    const read = await workspaceFor(query);
    const { workspace } = read;

    if (options.json) {
      const { links: _links, folders: _folders, files: _files, apps: _apps, commands: _commands, bolts, ...rest } = workspace;
      return emitJson({
        ...rest,
        pipelines: bolts.map(({ steps: _steps, down, ...bolt }) => ({
          ...bolt,
          slug: slugify(bolt.label),
          steps: collectBoltTargets(workspace, { ...bolt, steps: _steps }),
          ...(down ? { down: collectDownTargets(workspace, { ...bolt, steps: _steps, down }) } : {}),
        })),
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
      console.log(dim("No pipelines yet. `wisp` opens the dashboard, where `a` adds one."));
    } else {
      console.log(bold("Pipelines"));
      printBolts(workspace, true, read.withheld, await listRuns());
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
      console.log(dim(`Run one with \`wisp ${prefix}${shortest(first, workspace.bolts, prefix === "")}\`, or \`wisp pick${prefix ? ` ${prefix.trim()}` : ""}\` to choose.`));
    }
  },
};

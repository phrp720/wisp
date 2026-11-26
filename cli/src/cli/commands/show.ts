import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/system/processes.js";
import { collectPipelineTargets, collectDownTargets } from "../../core/run/index.js";
import { bold, counts, dim, title } from "../lib/format.js";
import { emitJson, maybeProject, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import type { WorkspaceRead } from "../../core/types.js";
import { diagnosticSummary, noPipelinesLine, printPipelines, shortest, trustLine } from "../lib/render.js";
import { slugify, pipelineSlug } from "../../core/workspaces.js";

export const show: CommandDef<{ json?: boolean }> = {
  name: "show",
  summary: "Show a workspace: its pipelines, and what each one does",
  args: [["[workspace]", "workspace name; omitted uses this directory's project"]],
  options: [["--json", "print the resolved workspace as JSON"]],
  examples: ["wisp show", "wisp show acme", "wisp show --json"],

  async run([query], options) {
    const read = await workspaceFor(query);
    const { workspace } = read;

    if (options.json) return emitJson(workspaceJson(read));

    console.log(`${title(workspace)}  ${counts(workspace)}`);
    console.log(dim(tildify(workspace.file)));
    if (workspace.local) console.log(dim(`+ ${tildify(workspace.local)}`));
    if (workspace.notes) console.log(dim(workspace.notes));

    console.log();
    if (workspace.pipelines.length === 0) {
      console.log(noPipelinesLine(read, "No pipelines yet. `wisp` opens the dashboard, where `a` adds one."));
    } else {
      console.log(bold("Pipelines"));
      printPipelines(workspace, true, read.withheld, await listRuns());
    }

    const trust = trustLine(read);
    const health = diagnosticSummary(read);
    if (trust || health) console.log();
    if (trust) console.log(trust);
    if (health) console.log(health);

    const first = workspace.pipelines[0];
    if (first) {
      const here = await maybeProject().catch(() => undefined);
      const prefix = here?.workspace.file === workspace.file ? "" : `${slugify(workspace.name)} `;
      console.log();
      console.log(dim(`Run one with \`wisp ${prefix}${shortest(first, workspace.pipelines, prefix === "")}\`, or \`wisp pick${prefix ? ` ${prefix.trim()}` : ""}\` to choose.`));
    }
  },
};

export function workspaceJson(read: WorkspaceRead) {
  const { workspace } = read;
  const { links: _links, folders: _folders, files: _files, apps: _apps, commands: _commands, pipelines, ...rest } = workspace;
  return {
    ...rest,
    pipelines: pipelines.map(({ steps: _steps, down, ...pipeline }) => ({
      ...pipeline,
      slug: pipelineSlug(pipeline),
      steps: collectPipelineTargets(workspace, { ...pipeline, steps: _steps }),
      ...(down ? { down: collectDownTargets(workspace, { ...pipeline, steps: _steps, down }) } : {}),
    })),
    trust: read.trust,
    diagnostics: read.diagnostics,
    withheld: read.withheld,
  };
}

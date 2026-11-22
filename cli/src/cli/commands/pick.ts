import { WispError } from "../../core/errors.js";
import { tildify } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import type { WorkspaceRead } from "../../core/types.js";
import { discoverWorkspaces, slugify, pipelineSlug } from "../../core/workspaces.js";
import { counts, dim } from "../format.js";
import { maybeProject, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { upMark } from "../lib/render.js";
import { choose } from "../prompt.js";
import { list } from "./list.js";
import { show } from "./show.js";
import { use, type UseOptions } from "./use.js";

type PickOptions = Pick<UseOptions, "dryRun" | "inline" | "detach" | "window" | "skipUntrusted" | "json">;

export const pick: CommandDef<PickOptions> = {
  name: "pick",
  summary: "Choose a pipeline from a list and run it",
  args: [["[workspace]", "workspace name; omitted uses this directory's project, or asks which"]],
  options: [
    ["--dry-run", "show what would happen, and where each command would run"],
    ["-i, --inline", "run commands here, in this terminal"],
    ["-w, --window", "run commands in terminal windows (or tmux windows, inside tmux)"],
    ["-d, --detach", "run commands in the background, even if you chose a terminal"],
    ["--skip-untrusted", "run only what the file is allowed to, skipping what waits for `wisp trust`"],
    ["--json", "print the pipelines it would offer as JSON, and ask nothing"],
  ],
  examples: ["wisp pick              # a pipeline of this project", "wisp pick acme         # a pipeline of another workspace", "wisp pick --detach     # and run its commands in the background"],

  async run([query], options) {
    const here = await maybeProject();
    let read: WorkspaceRead | undefined = query ? await workspaceFor(query) : here;
    const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.json;

    if (!terminal) {
      if (read) return show.run([read.workspace.file], { json: options.json ?? false });
      return list.run([], { json: options.json ?? false });
    }

    if (!read) {
      const reads = (await discoverWorkspaces()).reads.filter((entry) => entry.workspace.bolts.length > 0);
      if (reads.length === 0) throw new WispError("No workspace has pipelines yet", "NOT_FOUND");
      const index = await choose(
        "Which workspace?",
        reads.map(({ workspace }) => ({
          label: workspace.icon ? `${workspace.icon} ${workspace.name}` : workspace.name,
          slug: slugify(workspace.name),
          hint: `${counts(workspace)}  ${workspace.personal ? "personal" : tildify(workspace.file)}`,
        })),
        "choose",
      );
      if (index === undefined) return void console.log(dim("Nothing ran."));
      read = reads[index] as WorkspaceRead;
    }

    const { workspace } = read;
    if (workspace.bolts.length === 0) throw new WispError(`${workspace.name} has no pipelines yet`, "NO_PIPELINE");

    const runs = await listRuns();
    const index = await choose(
      `Run which pipeline of ${workspace.name}?`,
      workspace.bolts.map((bolt) => ({
        label: bolt.label,
        ...(upMark(workspace, bolt, runs) ? { mark: upMark(workspace, bolt, runs) } : {}),
        slug: pipelineSlug(bolt),
        ...(bolt.notes ? { hint: bolt.notes } : {}),
      })),
    );
    if (index === undefined) return void console.log(dim("Nothing ran."));

    const bolt = workspace.bolts[index];
    if (!bolt) return;
    const { json: _json, ...run } = options;
    await use.run([workspace.file, bolt.label], run);

    if (process.exitCode === 1) return;
    const typed = here?.workspace.file === workspace.file ? pipelineSlug(bolt) : `${slugify(workspace.name)} ${pipelineSlug(bolt)}`;
    console.log(dim(`Next time: \`wisp ${typed}\``));
  },
};

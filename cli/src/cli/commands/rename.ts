import { renamePipeline } from "../../core/edit.js";
import { WispError } from "../../core/errors.js";
import { readProjectFile } from "../../core/project/index.js";
import { matchPipeline } from "../../core/run/index.js";
import { slugify } from "../../core/workspaces.js";
import { bold, dim, green, yellow } from "../lib/format.js";
import { emitJson, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { shortest } from "../lib/render.js";

export const rename: CommandDef<{ json?: boolean }> = {
  name: "rename",
  summary: "Rename a pipeline, and every step that runs it",
  args: [["<names...>", "[workspace] <pipeline> <new name>"]],
  options: [["--json", "print the result as JSON"]],
  examples: ['wisp rename database "Postgres"', 'wisp rename acme database "Postgres"'],

  async run(names, options) {
    if (names.length < 2 || names.length > 3) {
      throw new WispError('Say which pipeline, then its new name: `wisp rename database "Postgres"`', "INVALID_INPUT");
    }
    const [query, ref, label] = names.length === 3 ? names : [undefined, names[0], names[1]];
    const read = await workspaceFor(query);
    const { pipeline, candidates } = matchPipeline(read.workspace, ref as string);
    if (!pipeline) {
      if (candidates.length > 1) throw new WispError(`"${ref}" could be ${candidates.map((candidate) => `"${candidate.label}"`).join(" or ")}: say more of the name`, "AMBIGUOUS");
      throw new WispError(`${read.workspace.name} has no pipeline called "${ref}"`, "NO_PIPELINE");
    }

    const name = (label as string).trim();
    await renamePipeline(read.workspace.file, pipeline.label, name, { keepTrust: false });
    const after = await readProjectFile(read.workspace.file);
    const renamed = after.workspace.pipelines.find((entry) => entry.label === name);
    const trust = read.workspace.personal ? "personal" : after.trust;

    if (options.json) return emitJson({ workspace: read.workspace.name, file: read.workspace.file, from: pipeline.label, to: name, trust });

    console.log(`${green("✓")} renamed ${bold(pipeline.label)} to ${bold(name)} in ${read.workspace.name} ${dim("· with the steps that run it")}`);
    if (read.trust === "trusted" && trust !== "trusted") console.log(yellow("The file changed, so its commands wait for `wisp trust` again."));
    if (renamed) console.log(dim(`Run it from any folder with \`wisp ${slugify(read.workspace.name)} ${shortest(renamed, after.workspace.pipelines)}\`.`));
  },
};

import { dirname } from "node:path";

import { SpecterError } from "../../core/errors.js";
import { tildify } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile, readProjectFile } from "../../core/project.js";
import { listTrustedProjects, revokeProject, trustProject } from "../../core/trust.js";
import { bold, cyan, dim, green, kindLabel, plural, red, yellow } from "../format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { named, whereLine } from "../lib/render.js";
import { Prompter } from "../prompt.js";

export const trust: CommandDef<{ revoke?: boolean; list?: boolean; yes?: boolean; json?: boolean }> = {
  name: "trust",
  summary: `Allow a ${PROJECT_FILE} to run the code it declares`,
  args: [["[path]", `a ${PROJECT_FILE}, or the folder with one; omitted walks up from here`]],
  options: [
    ["--revoke", "withdraw trust from this project file"],
    ["--list", "list every project file you have trusted"],
    ["-y, --yes", "skip the confirmation"],
    ["--json", "print the result as JSON"],
  ],
  examples: ["specter trust", "specter trust --list", "specter trust --revoke"],

  async run([given], options) {
    if (options.list) return listGrants(options.json ?? false);

    // A folder means the file in it: `specter check ../shop` as well as `../shop/.specter.json`.
    const file = given ? await fileIn(given) : await findProjectFile();
    if (!file) throw new SpecterError(`No ${PROJECT_FILE} above this directory`, "NO_PROJECT");

    if (options.revoke) {
      const had = await revokeProject(file);
      if (options.json) return emitJson({ file, trusted: false, changed: had });
      console.log(had ? `${green("✓")} revoked ${dim(file)}` : dim(`${file} was not trusted anyway`));
      return;
    }

    const read = await readProjectFile(file);
    const path = read.workspace.file;

    if (read.workspace.personal) {
      console.log(dim(`${tildify(path)} is one of your own workspaces — it is trusted already.`));
      return;
    }
    if (read.workspace.trusted) {
      console.log(`${green("✓")} already trusted ${dim(tildify(path))}`);
      return;
    }
    if (read.withheld.length === 0) {
      console.log(dim(`${tildify(path)} declares nothing that runs code, so there is nothing to trust.`));
      return;
    }

    // Trust is granted to what you have read, so what you are granting it to is printed
    // first — every time, including the re-grant after a change. A prompt that asks
    // "trust this file?" without saying what is in it is a rubber stamp, not a decision.
    console.log(dim(tildify(path)));
    if (read.workspace.local) console.log(dim(`+ ${tildify(read.workspace.local)}`));
    if (read.trust === "stale") console.log(yellow("! this file has changed since you last trusted it"));
    console.log();
    console.log(bold(`Would allow ${plural(read.withheld.length, "item")} to run:`));
    for (const item of read.withheld) {
      const where = whereLine(item.cwd, dirname(path));
      const why = item.reason ? dim(` (${item.reason})`) : "";
      console.log(`  ${dim(kindLabel(item.kind))} ${named(item.label, tildify(item.value))}${where}${why}`);
    }
    console.log();
    console.log(dim("These run on your machine, with your shell, as you."));

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new SpecterError("Trusting a project file needs a terminal, or --yes if you have read it", "NEEDS_CONFIRMATION");
      }
      const prompt = new Prompter();
      try {
        if (!(await prompt.confirm("Trust it?"))) {
          console.log(dim("Not trusted. Nothing in it that runs code will run."));
          return;
        }
      } finally {
        prompt.close();
      }
    }

    // The hash of what was shown: if the file changed while you read, this refuses.
    const grant = await trustProject(path, read.hash);
    if (options.json) return emitJson(grant);

    console.log(`${green("✓")} trusted ${dim(tildify(path))}`);
    console.log(dim("Trust is tied to this exact file — any edit, a `git pull` included, asks again."));
  },
};

async function listGrants(json: boolean): Promise<void> {
  const grants = await listTrustedProjects();
  if (json) return emitJson(grants);

  if (grants.length === 0) {
    console.log(dim("No project files trusted. That is the default, and a fine place to stay."));
    return;
  }

  for (const grant of grants) {
    // Re-read rather than believe the record: the interesting case is a grant that has
    // stopped applying, which is only visible by looking at the file.
    const state = await readProjectFile(grant.path).then((read) => read.trust).catch(() => "missing" as const);
    const mark = state === "trusted" ? green("✓") : state === "stale" ? yellow("!") : red("✗");
    const note = state === "stale" ? dim(" changed since — will not run") : state === "missing" ? dim(" gone") : "";
    console.log(`${mark} ${tildify(grant.path)}${note}`);
    console.log(`  ${dim(grant.at)}`);
  }
}

async function fileIn(path: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const found = await stat(path).catch(() => undefined);
  return found?.isDirectory() ? join(path, PROJECT_FILE) : path;
}

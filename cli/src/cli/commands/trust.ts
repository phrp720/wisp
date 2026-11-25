
import { WispError } from "../../core/errors.js";
import { tildify } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile, readProjectFile } from "../../core/project/index.js";
import { changesSinceTrust, listTrustedProjects, revokeProject, trustProject } from "../../core/trust.js";
import { bold, cyan, dim, green, plural, red, yellow } from "../lib/format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { printChanges, printWithheld } from "../lib/render.js";
import { Prompter } from "../lib/prompt.js";

export const trust: CommandDef<{ revoke?: boolean; list?: boolean; yes?: boolean; json?: boolean }> = {
  name: "trust",
  summary: `Allow a ${PROJECT_FILE} to run the code it declares`,
  args: [["[path]", `a ${PROJECT_FILE}, or the folder with one; omitted walks up from here`]],
  options: [
    ["--revoke", "withdraw trust from this project file"],
    ["--list", "list every project file you have trusted"],
    ["-y, --yes", "skip the question (still needs a person at a terminal)"],
    ["--json", "print the result as JSON"],
  ],
  examples: ["wisp trust", "wisp trust --list", "wisp trust --revoke"],

  async run([given], options) {
    if (options.list) return listGrants(options.json ?? false);

    // A folder means the file in it: `wisp check ../shop` as well as `../shop/.wisp.json`.
    const file = given ? await fileIn(given) : await findProjectFile();
    if (!file) throw new WispError(`No ${PROJECT_FILE} above this directory`, "NO_PROJECT");

    if (options.revoke) {
      const had = await revokeProject(file);
      if (options.json) return emitJson({ file, trusted: false, changed: had });
      console.log(had ? `${green("✓")} revoked ${dim(file)}` : dim(`${file} was not trusted anyway`));
      return;
    }

    const read = await readProjectFile(file);
    const path = read.workspace.file;

    if (read.workspace.personal) {
      if (options.json) return emitJson({ path, trusted: true, changed: false, personal: true });
      console.log(dim(`${tildify(path)} is one of your own workspaces — it is trusted already.`));
      return;
    }
    if (read.workspace.trusted) {
      if (options.json) return emitJson({ path, trusted: true, changed: false });
      console.log(`${green("✓")} already trusted ${dim(tildify(path))}`);
      return;
    }
    if (read.withheld.length === 0) {
      if (options.json) return emitJson({ path, trusted: false, changed: false, runsCode: false });
      console.log(dim(`${tildify(path)} declares nothing that runs code, so there is nothing to trust.`));
      return;
    }

    // Trust is granted to what you have read, so what you are granting it to is printed
    // first — every time, including the re-grant after a change. A prompt that asks
    // "trust this file?" without saying what is in it is a rubber stamp, not a decision.
    const print = options.json ? console.error : console.log;
    const since = read.trust === "stale" ? await changesSinceTrust(path) : undefined;
    if (since) printChanges(since, print);
    printWithheld(read, print);

    if (!process.stdin.isTTY) {
      throw new WispError("Trusting a project file is for a person at a terminal, not a script or an agent", "NEEDS_CONFIRMATION");
    }
    if (!options.yes) {
      if (options.json) {
        throw new WispError("With --json, nothing is asked: pass --yes once you have read the list above", "NEEDS_CONFIRMATION", "Or run `wisp trust` without --json to be asked.");
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
    if (options.json) return emitJson({ ...grant, trusted: true, changed: true });

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

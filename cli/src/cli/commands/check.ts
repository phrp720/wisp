import { dirname } from "node:path";

import { WispError } from "../../core/errors.js";
import { tildify } from "../../core/paths.js";
import { PROJECT_FILE, checkProject, findProjectFile } from "../../core/project.js";
import { bold, counts, cyan, dim, green, kindLabel, plural, title, yellow } from "../format.js";
import { emitJson } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { countDiagnostics, named, printBolts, printDiagnostics, trustLine, whereLine } from "../lib/render.js";

export const check: CommandDef<{ json?: boolean }> = {
  name: "check",
  aliases: ["lint"],
  summary: `Check a ${PROJECT_FILE}: what it declares, what would run, and what it does not mean`,
  args: [["[path]", `a ${PROJECT_FILE}, or the folder with one; omitted walks up from here`]],
  options: [["--json", "print the findings as JSON"]],
  examples: ["wisp check", "wisp check ../other/.wisp.json"],

  async run([given], options) {
    // A folder means the file in it: `wisp check ../shop` as well as `../shop/.wisp.json`.
    const file = given ? await fileIn(given) : await findProjectFile();
    if (!file) throw new WispError(`No ${PROJECT_FILE} above this directory`, "NO_PROJECT");

    const read = await checkProject(file);
    const { errors, warnings } = countDiagnostics(read.diagnostics);

    if (options.json) {
      if (errors > 0) process.exitCode = 1;
      return emitJson({
        file: read.workspace.file,
        local: read.workspace.local ?? null,
        name: read.workspace.name,
        trust: read.workspace.personal ? "personal" : read.trust,
        errors,
        warnings,
        diagnostics: read.diagnostics,
        commands: read.declaredCommands,
        withheld: read.withheld,
      });
    }

    console.log(`${title(read.workspace)}  ${counts(read.workspace)}`);
    console.log(dim(tildify(read.workspace.file)));
    if (read.workspace.local) console.log(dim(`+ ${tildify(read.workspace.local)}`));

    if (read.diagnostics.length > 0) {
      console.log();
      printDiagnostics(read.diagnostics);
    }

    // The reason to read a file before trusting it: everything that would run, in full,
    // always. You cannot decide about something you have to open another window to see.
    if (read.declaredCommands.length > 0 || read.withheld.length > 0) {
      console.log();
      console.log(`${bold("Runs code")} ${dim(read.workspace.trusted ? "— allowed" : "— waiting for `wisp trust`")}`);
      for (const command of read.declaredCommands) {
        const where = whereLine(command.cwd, dirname(read.workspace.file));
        const env = command.env ? dim(` with ${Object.keys(command.env).join(", ")}`) : "";
        const quiet = command.background ? dim(" (background)") : "";
        console.log(`  ${dim(kindLabel("command"))} ${named(command.label, command.run)}${where}${env}${quiet}`);
      }
      for (const item of read.withheld.filter((entry) => entry.kind !== "command")) {
        console.log(`  ${dim(kindLabel(item.kind))} ${named(item.label, tildify(item.value))} ${dim(`(${item.reason})`)}`);
      }
      const line = trustLine(read);
      if (line) console.log(`  ${line}`);
    }

    if (read.workspace.bolts.length > 0) {
      console.log();
      console.log(bold("Pipelines"));
      printBolts(read.workspace, true, read.withheld);
    }

    console.log();
    if (errors === 0 && warnings === 0) {
      console.log(`${green("✓")} nothing to report`);
      return;
    }

    const summary = [errors > 0 ? plural(errors, "problem") : "", warnings > 0 ? plural(warnings, "warning") : ""]
      .filter(Boolean)
      .join(" · ");
    console.log(`${yellow("!")} ${summary}`);
    if (errors > 0) process.exitCode = 1;
  },
};

async function fileIn(path: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const found = await stat(path).catch(() => undefined);
  return found?.isDirectory() ? join(path, PROJECT_FILE) : path;
}

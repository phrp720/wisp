import { dirname } from "node:path";
import { tildify } from "../../core/paths.js";
import type { RunStatus } from "../../core/processes.js";
import { boltStatus, collectBoltTargets, collectDownTargets, stagesOfTargets } from "../../core/switch.js";
import type { Bolt, Diagnostic, SwitchTarget, Withheld, Workspace, WorkspaceRead } from "../../core/types.js";
import { hasWords, slugify } from "../../core/workspaces.js";
import { bold, cyan, dim, green, kindLabel, plural, red, yellow } from "../format.js";

/**
 * A label and the thing it names — once, when they are the same. An inline `{ "run":
 * "pnpm dev" }` is labelled by its own command, and printing it twice is just noise.
 */
export function named(label: string, value: string, from = ""): string {
  return label === value ? `${cyan(value)}${from}` : `${label}${from} ${dim("—")} ${cyan(value)}`;
}

/** One asset, as every command shows it: kind, label, then the thing itself. */
export function targetLine(target: SwitchTarget, indent = "  ", root?: string): string {
  const via = target.openWith ? dim(` ↦ ${target.openWith}`) : "";
  const where = whereLine(target.cwd, root);
  const from = target.workspace ? dim(` (${target.workspace})`) : "";
  return `${indent}${dim(kindLabel(target.kind))} ${named(target.label, shown(target), from)}${where}${via}`;
}

/**
 * Where a command runs — said only when it is somewhere other than the project's own
 * folder, which is where every command runs unless it says otherwise.
 */
export function whereLine(cwd: string | undefined, root: string | undefined): string {
  if (!cwd || (root && cwd === root)) return "";
  return dim(` in ${root && cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : tildify(cwd)}`);
}

/** Paths shown from home, so they read as yours rather than as a wall of directories. */
function shown(target: { kind: SwitchTarget["kind"]; value: string }): string {
  return target.kind === "folder" || target.kind === "file" ? tildify(target.value) : target.value;
}

/**
 * A workspace's bolts, with what each one does when `expand` asks for it.
 *
 * What it will actually do, not what it names: a step waiting for trust is shown as
 * waiting, rather than counted as if it would run or left out as if it did not exist.
 */
export function printBolts(workspace: Workspace, expand = false, withheld: Withheld[] = [], runs: RunStatus[] = []): void {
  const held = new Map(withheld.map((item) => [item.id, item]));

  for (const bolt of workspace.bolts) {
    const steps = collectBoltTargets(workspace, bolt);
    const waiting = bolt.steps.flatMap((step) => {
      const id = step.kind === "asset" ? step.id : step.kind === "compose" ? `compose:${step.file}` : undefined;
      return id && held.has(id) ? [held.get(id) as Withheld] : [];
    });
    const note = waiting.length > 0 ? yellow(` · ${waiting.length} waiting for trust`) : "";
    const asks = bolt.confirm ? dim(" · asks first") : "";
    console.log(`  ${upMark(workspace, bolt, runs)}${bold(bolt.label)} ${cyan(slugify(bolt.label))} ${dim(plural(steps.length, "step"))}${asks}${note}`);
    if (bolt.notes) console.log(`    ${dim(bolt.notes)}`);
    if (!expand) continue;
    const stages = stagesOfTargets(steps);
    steps.forEach((step, at) => {
      console.log(`  ${dim(String(stages[at]).padStart(3))} ${dim(kindLabel(step.kind))} ${step.label}${step.after ? dim(` · after ${step.after.join(", ")}`) : ""}`);
    });
    for (const item of waiting) console.log(`    ${dim(kindLabel(item.kind))} ${dim(item.label)} ${yellow("(not trusted)")}`);
    const down = collectDownTargets(workspace, bolt);
    if (down.length > 0) console.log(dim(`    down: ${down.map((step) => step.label).join(", ")}`));
  }
}

/** `● ` when all of a bolt's commands are running, `◐ ` when some are, nothing otherwise. */
export function upMark(workspace: Workspace, bolt: Workspace["bolts"][number], runs: RunStatus[]): string {
  if (runs.length === 0) return "";
  const { commands, running } = boltStatus(workspace, bolt, runs);
  if (commands === 0 || running === 0) return "";
  return running === commands ? green("● ") : yellow("◐ ");
}

/**
 * What to run, when a command needed a bolt and was not given one. Ends on a line that
 * can be pasted, naming the workspace whenever the workspace was named.
 */
export const COMMAND_WORDS: ReadonlySet<string> = new Set(["agents", "check", "completion", "doctor", "down", "help", "history", "hook", "init", "lint", "list", "logs", "ls", "notify", "open-with", "pick", "ps", "restart", "run", "scan", "show", "spec", "status", "stop", "trust", "use"]);

const FILLER = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "into", "it", "my", "of", "off", "on", "or", "our", "the", "to", "up", "with"]);

/**
 * A short word that still names this bolt among the ones it sits with: the last word that
 * means something, since a label names its object last ("Work on storefront"). Typed on its
 * own (`alone`), it never suggests a command's name, which `wisp <word>` would run instead.
 */
export function shortest(bolt: Bolt, among: Bolt[] = [], alone = false): string {
  const others = among.filter((candidate) => candidate.id !== bolt.id);
  const slug = slugify(bolt.label);
  const words = slug.split("-").filter((word) => word && !FILLER.has(word)).reverse();

  for (const word of words) {
    if (alone && COMMAND_WORDS.has(word)) continue;
    if (!others.some((other) => hasWords(other.label, word))) return word;
  }

  return alone && COMMAND_WORDS.has(slug) ? `use ${slug}` : slug;
}

/** Everything a workspace file had to say about itself, worst first. */
export function printDiagnostics(diagnostics: Diagnostic[], indent = "", includeNotes = true): void {
  const rank = { error: 0, warning: 1, note: 2 } as const;
  const ordered = [...diagnostics]
    .filter((entry) => includeNotes || entry.level !== "note")
    .sort((left, right) => rank[left.level] - rank[right.level]);

  for (const entry of ordered) {
    const mark = entry.level === "error" ? red("✗") : entry.level === "warning" ? yellow("!") : dim("·");
    const message = entry.level === "note" ? dim(entry.message) : entry.message;
    console.log(`${indent}${mark} ${dim(entry.at)} ${message}`);
    if (entry.hint) console.log(`${indent}  ${dim(entry.hint)}`);
  }
}

export function countDiagnostics(diagnostics: Diagnostic[]): { errors: number; warnings: number; notes: number } {
  return {
    errors: diagnostics.filter((entry) => entry.level === "error").length,
    warnings: diagnostics.filter((entry) => entry.level === "warning").length,
    notes: diagnostics.filter((entry) => entry.level === "note").length,
  };
}

/** The one-line health of a file, shown wherever its workspace is. Notes are not health. */
export function diagnosticSummary(read: WorkspaceRead): string | undefined {
  const { errors, warnings } = countDiagnostics(read.diagnostics.filter((entry) => entry.at !== "trust"));
  if (errors === 0 && warnings === 0) return undefined;

  const parts: string[] = [];
  if (errors > 0) parts.push(red(plural(errors, "problem")));
  if (warnings > 0) parts.push(yellow(plural(warnings, "warning")));
  return `${parts.join(" · ")} ${dim("— `wisp check` for detail")}`;
}

/** How the file's code-running parts stand, in the words the trust states mean. */
export function trustLine(read: WorkspaceRead): string | undefined {
  if (read.workspace.personal) return undefined;

  const declared = read.declaredCommands.length;
  if (read.workspace.trusted) {
    return declared > 0 ? `${green("✓")} ${plural(declared, "command")} ${dim("— trusted, will run")}` : undefined;
  }
  if (read.withheld.length === 0) return undefined;

  const count = plural(read.withheld.length, "item");
  if (read.trust === "stale") {
    return `${yellow("!")} ${count} withheld ${dim("— the file changed since you trusted it; `wisp check`, then `wisp trust`")}`;
  }
  return `${yellow("!")} ${count} withheld ${dim("— not trusted; read them with `wisp check`, allow with `wisp trust`")}`;
}

/** What a run did to one step, as a line. */
export function resultLine(result: {
  ok: boolean;
  durationMs?: number;
  skipped?: boolean;
  kind: SwitchTarget["kind"];
  label: string;
  value: string;
  workspace?: string;
  error?: string;
  note?: string;
}): string {
  const mark = result.skipped ? dim("–") : !result.ok ? red("✗") : green("✓");
  const from = result.workspace ? dim(` (${result.workspace})`) : "";
  const detail = result.error ? ` ${red(`(${result.error})`)}` : result.note ? ` ${dim(`· ${result.note}`)}` : "";
  const time = result.durationMs && result.durationMs >= 1000 ? dim(` ${(result.durationMs / 1000).toFixed(1)}s`) : "";
  return `  ${mark} ${dim(kindLabel(result.kind))} ${named(result.label, shown(result), from)}${time}${detail}`;
}

/**
 * Everything a file would be allowed to run, as `wisp trust` and a run that needs trust both
 * show it. Trust is granted to what you have read, so it is printed every time.
 */
export function printWithheld(read: WorkspaceRead): void {
  const path = read.workspace.file;
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
}

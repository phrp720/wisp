import { recordProject } from "../../core/config.js";
import { listHistory } from "../../core/history.js";
import { SpecterError } from "../../core/errors.js";
import { planRetry, runPlan, switchToWorkspace, type RunDeps } from "../../core/switch.js";
import type { Bolt, RunMode, SwitchOptions, SwitchResult, SwitchTarget, TargetResult, Workspace } from "../../core/types.js";
import { bold, cyan, dim, green, kindLabel, plural, red, title, yellow } from "../format.js";
import { emitJson, findWorkspaceForDependency, resolveRun } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, resultLine, suggestBolts, trustLine } from "../lib/render.js";
import { Prompter } from "../prompt.js";

interface Options {
  dryRun?: boolean;
  all?: boolean;
  inline?: boolean;
  detach?: boolean;
  window?: boolean;
  retry?: boolean;
  json?: boolean;
}

export const use: CommandDef<Options> = {
  name: "use",
  aliases: ["run"],
  summary: "Run a bolt: start what it lists, in the order it lists it",
  args: [
    ["[workspace]", "workspace name; omitted uses this directory's project"],
    ["[bolt]", "which bolt — any distinctive part of its name will do"],
  ],
  options: [
    ["-n, --dry-run", "show what would happen, and where each command would run"],
    ["-a, --all", "open everything the workspace holds"],
    ["-i, --inline", "run commands here, in this terminal"],
    ["-w, --window", "run commands in terminal windows (or tmux windows, inside tmux)"],
    ["-d, --detach", "run commands in the background, even if you chose a terminal"],
    ["-r, --retry", "run again only what failed last time — and what that kept from running"],
    ["--json", "print the result as JSON"],
  ],
  examples: [
    "specter api                          # a bolt of this project — `use` is implied",
    'specter use acme "API development"   # a bolt of a named workspace',
    "specter api --dry-run                # what would happen, and where",
    "specter api --detach                 # commands in the background, on a server",
  ],

  async run([first, second], options) {
    const { read, bolt: named, workspaceRef } = await resolveRun(first, second, undefined);
    const { workspace } = read;
    const mode: RunMode = options.inline ? "inline" : options.detach ? "background" : options.window ? "terminal" : "auto";

    const bolt = named ?? (options.all ? undefined : await chooseBolt(workspace, options));
    if (!options.all && !bolt) {
      if (options.json) return emitJson({ workspace: workspace.name, bolts: workspace.bolts });
      console.log(`${dim("in")} ${title(workspace)}`);
      suggestBolts(workspace, workspaceRef);
      return;
    }

    // Remembered when you run it, so it can be listed and run from anywhere after.
    if (!workspace.personal && !options.dryRun) await recordProject(workspace.file).catch(() => undefined);

    const json = options.json ?? false;
    const label = bolt ? boltLabel(workspace, bolt) : undefined;
    const isJob = workspace.bolts.find((entry) => entry.label === label)?.job ?? false;
    if (!json) {
      const prefix = options.dryRun ? yellow("dry run") : green(isJob ? "job" : "running");
      console.log(`${prefix} ${title(workspace)}${label ? ` ${dim("·")} ${bold(label)}` : ""}`);
    }

    // Each step is reported as it finishes, and an attached command's output arrives under
    // its own header — so a long job reads as it goes, not all at once at the end.
    let lastWasOutput = false;
    const runOptions: SwitchOptions = {
      // A git hook says so in its environment; anything else typed this.
      trigger: process.env["SPECTER_TRIGGER"] ?? "cli",
      dryRun: options.dryRun ?? false,
      all: options.all ?? false,
      mode,
      echo: !json,
      ...(json
        ? {}
        : {
            onStep: (target: SwitchTarget, info: { attached: boolean }) => {
              if (!info.attached) return;
              const detail = target.label === target.value ? "" : ` ${dim(target.value)}`;
              console.log(`\n${bold("▸")} ${bold(target.label)}${detail}`);
              lastWasOutput = true;
            },
            onResult: (target: TargetResult) => {
              if (lastWasOutput) console.log();
              lastWasOutput = false;
              console.log(resultLine(target));
            },
          }),
    };
    const find = { findWorkspace: findWorkspaceForDependency };
    const result =
      options.retry && label
        ? await retryLast(workspace, label, isJob, runOptions, find)
        : await switchToWorkspace(workspace, { ...runOptions, ...(bolt ? { bolt } : {}) }, find);

    if (json) {
      return emitJson({
        workspace: workspace.name,
        bolt: result.bolt?.label,
        job: result.bolt?.job ?? false,
        ok: result.ok,
        dryRun: result.dryRun,
        history: result.historyId ?? null,
        targets: result.targets,
      });
    }

    if (result.targets.length === 0) {
      // A bolt that resolved to nothing ran nothing. Say why, rather than listing bolts as
      // if the name had been wrong — and fail, so a script or an agent notices.
      if (result.bolt) {
        const waiting = read.withheld.length > 0 && !workspace.trusted;
        console.log(dim(waiting ? "  nothing ran — every step waits for `specter trust` (see `specter check`)" : "  nothing ran — this bolt has no steps here"));
        process.exitCode = 1;
        return;
      }
      suggestBolts(workspace, workspaceRef);
      return;
    }

    // Headless, the links are the one thing you still need, so they are said again plainly
    // at the end, where a terminal will let you click or copy them.
    const unopened = result.targets.filter((target) => target.kind === "link" && target.note?.startsWith("no display"));
    if (unopened.length > 0 && !result.dryRun) {
      console.log();
      for (const link of unopened) console.log(`  ${dim(kindLabel("link"))} ${cyan(link.value)}`);
    }

    const backgrounded = result.targets.filter((target) => target.run);
    if (backgrounded.length > 0) {
      console.log(dim(`\n${plural(backgrounded.length, "command")} running — watch them in \`specter\` (p), or \`specter logs <name> -f\``));
    }

    if (!workspace.trusted && read.withheld.length > 0) {
      const line = trustLine(read);
      if (line) console.log(line);
    }
    const health = diagnosticSummary(read);
    if (health) console.log(health);

    const failed = result.targets.filter((target) => !target.ok && !target.skipped).length;
    if (result.historyId && (isJob || failed > 0)) {
      console.log(dim(`\n${result.ok ? "passed" : "failed"} · \`specter history ${result.historyId}\` for the details`));
    }
    if (!result.ok) {
      console.error(red(failed > 0 ? `${plural(failed, "step")} failed` : "stopped"));
      process.exitCode = 1;
    }
  },
};

function boltLabel(workspace: Workspace, ref: string): string {
  return workspace.bolts.find((bolt) => bolt.id === ref || bolt.label === ref)?.label ?? ref;
}

/**
 * Which bolt, when nothing said. Only on a terminal: a script that pipes `specter use`
 * somewhere must not stop on a question nobody is there to answer.
 */
async function chooseBolt(workspace: Workspace, options: Options): Promise<string | undefined> {
  const bolts = workspace.bolts;
  if (bolts.length === 0 || options.json) return undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  if (bolts.length === 1) return (bolts[0] as Bolt).id;

  console.log(`${dim("in")} ${title(workspace)}`);
  bolts.forEach((bolt, index) => {
    console.log(`  ${dim(`${index + 1}.`)} ${bold(bolt.label)} ${dim(plural(bolt.steps.length, "step"))}`);
  });

  const prompt = new Prompter();
  try {
    const answer = await prompt.ask(dim("  which"), "1");
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < bolts.length) return (bolts[index] as Bolt).id;
    return answer.trim() || undefined;
  } finally {
    prompt.close();
  }
}

/**
 * Run again what failed last time, and what that kept from running — not the whole bolt.
 * Matched step by step against the bolt as it is now, so a bolt edited since is refused
 * rather than half-matched.
 */
async function retryLast(
  workspace: Workspace,
  label: string,
  job: boolean,
  options: SwitchOptions,
  deps: RunDeps,
): Promise<SwitchResult> {
  const [last] = (await listHistory({ workspace: workspace.file, bolt: label })).filter((entry) =>
    entry.bolt.replace(/ \(retry\)$/, "").toLowerCase() === label.toLowerCase(),
  );
  if (!last) throw new SpecterError(`"${label}" has not run yet — run it whole first`, "NOTHING_TO_RETRY");
  const again = await planRetry(workspace, last, deps);
  return runPlan(workspace, again, { ...options, label: `${label} (retry)`, job, trigger: "retry" }, deps);
}

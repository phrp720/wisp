import { recordProject } from "../../core/config.js";
import { listHistory, type HistoryEntry } from "../../core/history.js";
import { WispError } from "../../core/errors.js";
import { matchPipeline, planRetry, resolvePipeline, runPlan, switchToWorkspace, type PlannedStep } from "../../core/run/index.js";
import { beforeRun } from "../lib/ask.js";
import type { RunMode, SwitchOptions, SwitchResult, SwitchTarget, TargetResult, Workspace } from "../../core/types.js";
import { bold, cyan, dim, green, kindLabel, plural, red, title, yellow } from "../lib/format.js";
import { emitJson, resolveRun } from "../lib/context.js";
import { withFailureOutput } from "../lib/failures.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, named as showNamed, printWithheld, resultLine, trustLine } from "../lib/render.js";
import { tildify } from "../../core/paths.js";
import { trustProject } from "../../core/trust.js";
import { waitingForTrust } from "../../core/waiting.js";
import { slugify, pipelineSlug } from "../../core/workspaces.js";
import { Prompter } from "../lib/prompt.js";

export interface UseOptions {
  dryRun?: boolean;
  inline?: boolean;
  detach?: boolean;
  window?: boolean;
  retry?: boolean;
  skipUntrusted?: boolean;
  yes?: boolean;
  input?: string[];
  json?: boolean;
}

export const use: CommandDef<UseOptions> = {
  name: "use",
  aliases: ["run"],
  summary: "Run a pipeline: start what it lists, in the order it lists it",
  args: [
    ["[workspace]", "workspace name; omitted uses this directory's project"],
    ["[pipeline]", "which pipeline — any distinctive part of its name will do"],
  ],
  options: [
    ["--dry-run", "show what would happen, and where each command would run"],
    ["-i, --inline", "run commands here, in this terminal"],
    ["-w, --window", "run commands in terminal windows (or tmux windows, inside tmux)"],
    ["-d, --detach", "run commands in the background, even if you chose a terminal"],
    ["-r, --retry", "run again only what failed last time — and what that kept from running"],
    ["--skip-untrusted", "run only what the file is allowed to, skipping what waits for `wisp trust`"],
    ["--input <name=value>", "a value the pipeline asks for, like --input env=staging; once for each", []],
    ["-y, --yes", "don't ask: answer yes, and take each input's default"],
    ["--json", "print the result as JSON"],
  ],
  examples: [
    "wisp api                  # a pipeline of this project: `use` is implied",
    "wisp acme api             # a pipeline of another workspace, from any folder",
    "wisp api --dry-run        # what would happen, and where",
    "wisp api --detach         # commands in the background, on a server",
  ],

  async run([first, second], options) {
    const resolved = await resolveRun(first, second, undefined);
    const { pipeline, workspaceRef } = resolved;
    let { read } = resolved;
    let { workspace } = read;
    const mode: RunMode = options.inline ? "inline" : options.detach ? "background" : options.window ? "terminal" : "auto";

    if (!pipeline) {
      const prefix = workspaceRef ? `${workspaceRef} ` : "";
      throw new WispError(
        workspace.pipelines.length > 0
          ? `Name a pipeline of ${workspace.name}: ${workspace.pipelines.map((entry) => `\`wisp ${prefix}${pipelineSlug(entry)}\``).join(", ")}`
          : `${workspace.name} has no pipelines yet`,
        "NO_PIPELINE",
      );
    }

    // Not half a run: when steps it needs wait for trust, ask (at a terminal) or stop, and
    // start nothing. A dry run goes ahead, since showing what would be skipped is its point.
    if (!options.dryRun && !options.skipUntrusted) {
      const waitLabel = pipelineLabel(workspace, pipeline);
      const waiting = waitingForTrust(read, waitLabel);
      if (waiting.length > 0) {
        const needs = `"${waitLabel}" needs ${plural(waiting.length, "thing")} this file isn't allowed to run yet`;
        if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) throw new WispError(needs, "NOT_TRUSTED");
        console.log(yellow(`! ${needs}. Run without them, it would start only part of it.`));
        console.log();
        printWithheld(read);
        const prompt = new Prompter();
        let yes = false;
        try {
          yes = await prompt.confirm(`Trust it and run "${waitLabel}"?`);
        } finally {
          prompt.close();
        }
        if (!yes) {
          console.log(dim("Nothing ran. `wisp check` shows the file, `wisp trust` allows it."));
          process.exitCode = 1;
          return;
        }
        // The hash of what was shown: if the file changed while you read, this refuses.
        await trustProject(workspace.file, read.hash);
        console.log(`${green("✓")} trusted ${dim(tildify(workspace.file))}`);
        console.log();
        read = (await resolveRun(first, second, undefined)).read;
        workspace = read.workspace;
      }
    }

    const last = options.retry ? await lastRun(workspace, pipelineLabel(workspace, pipeline)) : undefined;
    if (last && (options.input ?? []).length > 0) throw new WispError("A retry runs with the values its run had: leave out --input", "INVALID_INPUT");
    const inputs = await beforeRun(workspace, resolvePipeline(workspace, pipeline), options, last ? (last.inputs ?? {}) : undefined);
    if (!inputs) {
      console.log(dim("Nothing ran."));
      process.exitCode = 1;
      return;
    }

    // Remembered when you run it, so it can be listed and run from anywhere after.
    if (!workspace.personal && !options.dryRun) await recordProject(workspace.file).catch(() => undefined);

    const json = options.json ?? false;
    const label = pipelineLabel(workspace, pipeline);
    if (!json) {
      const prefix = options.dryRun ? yellow("dry run") : green("running");
      console.log(`${prefix} ${title(workspace)} ${dim("·")} ${bold(label)}`);
    }

    // Each step is reported as it finishes, and an attached command's output arrives under
    // its own header — so a long run reads as it goes, not all at once at the end.
    let lastWasOutput = false;
    const attachedSteps = new Set<string>();
    const dryRun = options.dryRun ?? false;
    const runOptions: SwitchOptions = {
      // A git hook says so in its environment; anything else typed this.
      trigger: process.env["WISP_TRIGGER"] ?? "cli",
      dryRun: options.dryRun ?? false,
      inputs,
      watched: json || process.stdout.isTTY === true || process.stderr.isTTY === true,
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
              attachedSteps.add(target.id);
            },
            onResult: (target: TargetResult) => {
              if (dryRun) return;
              if (lastWasOutput) console.log();
              lastWasOutput = false;
              // Its command was just printed above its output: the result line need not
              // say it again — what happened, and how long it took, is enough.
              console.log(attachedSteps.has(target.id) ? compactLine(target) : resultLine(target));
            },
          }),
    };
    const result = last ? await retryLast(workspace, label, last, runOptions) : await switchToWorkspace(workspace, { ...runOptions, ...(pipeline ? { pipeline } : {}) });

    const untrusted = waitingForTrust(read, result.pipeline?.label ?? label);

    if (json) {
      if (!result.ok) process.exitCode = 1;
      return emitJson({
        workspace: workspace.name,
        pipeline: result.pipeline?.label,
        ok: result.ok,
        ...(result.cancelled ? { cancelled: true } : {}),
        dryRun: result.dryRun,
        history: result.historyId ?? null,
        ...(result.inputs ? { inputs: result.inputs } : {}),
        steps: await withFailureOutput(result.targets),
        running: result.targets.flatMap((target) => (target.run ? [{ label: target.label, run: target.run }] : [])),
        waitingForTrust: untrusted.map(({ kind, label: name, value, cwd }) => ({ kind, label: name, value, ...(cwd ? { cwd } : {}) })),
      });
    }

    if (result.targets.length === 0) {
      if (result.pipeline) {
        if (result.dryRun && untrusted.length > 0) {
          console.log(dim("  every step waits for `wisp trust`. Once allowed, it would run:"));
          for (const item of untrusted) console.log(`  ${dim(kindLabel(item.kind))} ${showNamed(item.label, tildify(item.value))}`);
          console.log(dim("  `wisp check` shows the whole file, `wisp trust` allows it"));
          return;
        }
        // A pipeline that resolved to nothing ran nothing. Say why, rather than listing pipelines as
        // if the name had been wrong — and fail, so a script or an agent notices.
        console.log(dim(untrusted.length > 0 ? "  nothing ran — every step waits for `wisp trust` (see `wisp check`)" : "  nothing ran — this pipeline has no steps here"));
        process.exitCode = 1;
        return;
      }
      return;
    }

    if (result.dryRun && result.plan) printPlan(result.plan, result.targets);

    // Headless, the links are the one thing you still need, so they are said again plainly
    // at the end, where a terminal will let you click or copy them.
    const unopened = result.targets.filter((target) => target.kind === "link" && target.note?.startsWith("no display"));
    if (unopened.length > 0 && !result.dryRun) {
      console.log();
      for (const link of unopened) console.log(`  ${dim(kindLabel("link"))} ${cyan(link.value)}`);
    }

    const backgrounded = result.targets.filter((target) => target.run);
    if (backgrounded.length > 0) {
      console.log(dim(`\n${plural(backgrounded.length, "command")} running — watch them in \`wisp\` (p), or \`wisp logs <name> -f\``));
    }

    if (!workspace.trusted && read.withheld.length > 0) {
      const line = trustLine(read);
      if (line) console.log(line);
    }
    const health = diagnosticSummary(read);
    if (health) console.log(health);

    // One line that says how it went and what to do next — not two that say the same.
    const failedAt = result.targets.find((target) => !target.ok && !target.skipped);
    const name = result.pipeline?.label ?? label;
    const total = result.targets.reduce((sum, target) => sum + (target.durationMs ?? 0), 0);
    if (result.cancelled) {
      console.error(`\n${dim("⊘")} ${bold(name)} was cancelled${failedAt?.error ? dim(`: ${failedAt.error}`) : ""}${result.historyId ? dim(` · \`wisp history ${result.historyId}\``) : ""}`);
      process.exitCode = 130;
    } else if (!result.ok) {
      const next = [
        result.historyId ? `\`wisp history ${result.historyId}\`` : "",
        failedAt && result.historyId ? `\`wisp ${workspaceRef ? `${workspaceRef} ` : ""}${slugify(name)} --retry\` runs only what failed` : "",
      ].filter(Boolean);
      console.error(`\n${red("✗")} ${bold(name)} ${failedAt ? `failed at ${failedAt.label}` : "was stopped"}${next.length > 0 ? dim(` · ${next.join(" · ")}`) : ""}`);
      process.exitCode = 1;
    } else if (result.targets.some((target) => target.finishes) && backgrounded.length === 0 && !result.dryRun) {
      console.log(`\n${green("✓")} ${bold(name)} finished ${dim(`in ${formatMs(total)}`)}`);
    }
  },
};

function pipelineLabel(workspace: Workspace, ref: string): string {
  // The pipeline's own name, not the word typed for it: `wisp api` runs "Work on api".
  const exact = workspace.pipelines.find((pipeline) => pipeline.id === ref || pipeline.label === ref);
  if (exact) return exact.label;
  return matchPipeline(workspace, ref).pipeline?.label ?? ref;
}

/**
 * Run again what failed last time, and what that kept from running — not the whole pipeline.
 * Matched step by step against the pipeline as it is now, so a pipeline edited since is refused
 * rather than half-matched.
 */
async function lastRun(workspace: Workspace, label: string): Promise<HistoryEntry> {
  const [last] = (await listHistory({ workspace: workspace.file, pipeline: label })).filter((entry) =>
    !entry.running && entry.pipeline.replace(/ \(retry\)$/, "").toLowerCase() === label.toLowerCase(),
  );
  if (!last) throw new WispError(`"${label}" has not run yet — run it whole first`, "NOTHING_TO_RETRY");
  return last;
}

async function retryLast(workspace: Workspace, label: string, last: HistoryEntry, options: SwitchOptions): Promise<SwitchResult> {
  const again = await planRetry(workspace, last);
  return runPlan(workspace, again, { ...options, label: `${label} (retry)`, trigger: "retry" });
}

/** A result line for a step whose command and output were just shown: the outcome and time. */
function compactLine(target: TargetResult): string {
  const mark = target.skipped ? dim("–") : !target.ok ? red("✗") : green("✓");
  const time = target.durationMs ? dim(` ${formatMs(target.durationMs)}`) : "";
  const detail = target.error ? ` ${red(target.error)}` : target.skipped && target.note ? ` ${dim(target.note)}` : "";
  return `  ${mark} ${target.label}${time}${detail}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function printPlan(plan: PlannedStep[], targets: TargetResult[]): void {
  const pipelines = new Set(plan.map((step) => `${step.workspace.file}#${step.pipeline}`));
  let heading: string | undefined;
  targets.forEach((target, at) => {
    const step = plan[at] as PlannedStep;
    const indent = pipelines.size > 1 ? "  " : "";
    if (pipelines.size > 1 && step.pipeline !== heading) {
      heading = step.pipeline;
      console.log(`  ${dim("⚡")}${bold(step.pipeline)}${step.target.workspace ? dim(` (${step.target.workspace})`) : ""}`);
    }
    const after = target.after ? dim(` · after ${target.after.join(", ")}`) : "";
    console.log(`${indent}${dim(String(at + 1).padStart(3))}${resultLine(target).slice(1)}${after}`);
  });
}

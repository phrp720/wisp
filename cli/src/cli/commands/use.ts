import { recordProject } from "../../core/config.js";
import { listHistory } from "../../core/history.js";
import { WispError } from "../../core/errors.js";
import { matchBolt, planRetry, runPlan, switchToWorkspace, type RunDeps } from "../../core/switch.js";
import type { RunMode, SwitchOptions, SwitchResult, SwitchTarget, TargetResult, Workspace } from "../../core/types.js";
import { bold, cyan, dim, green, kindLabel, plural, red, title, yellow } from "../format.js";
import { emitJson, findWorkspaceForDependency, resolveRun, workspaceFor } from "../lib/context.js";
import type { CommandDef } from "../lib/define.js";
import { diagnosticSummary, named as showNamed, printWithheld, resultLine, trustLine } from "../lib/render.js";
import { tildify } from "../../core/paths.js";
import { trustProject } from "../../core/trust.js";
import { waitingForTrust } from "../../core/waiting.js";
import { slugify } from "../../core/workspaces.js";
import { Prompter } from "../prompt.js";

export interface UseOptions {
  dryRun?: boolean;
  all?: boolean;
  inline?: boolean;
  detach?: boolean;
  window?: boolean;
  retry?: boolean;
  skipUntrusted?: boolean;
  json?: boolean;
}

export const use: CommandDef<UseOptions> = {
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
    ["--skip-untrusted", "run only what the file is allowed to, skipping what waits for `wisp trust`"],
    ["--json", "print the result as JSON"],
  ],
  examples: [
    "wisp api                  # a bolt of this project: `use` is implied",
    "wisp acme api             # a bolt of another workspace, from any folder",
    "wisp api --dry-run        # what would happen, and where",
    "wisp api --detach         # commands in the background, on a server",
    "wisp acme --all           # everything a workspace holds",
  ],

  async run([first, second], options) {
    const locate = async () =>
      options.all && !second ? { read: await workspaceFor(first), ...(first ? { workspaceRef: first } : {}) } : await resolveRun(first, second, undefined);
    const resolved = await locate();
    const { bolt, workspaceRef } = resolved;
    let { read } = resolved;
    let { workspace } = read;
    const mode: RunMode = options.inline ? "inline" : options.detach ? "background" : options.window ? "terminal" : "auto";

    if (!options.all && !bolt) {
      const prefix = workspaceRef ? `${workspaceRef} ` : "";
      throw new WispError(
        workspace.bolts.length > 0
          ? `Name a bolt of ${workspace.name}: ${workspace.bolts.map((entry) => `\`wisp ${prefix}${slugify(entry.label)}\``).join(", ")}`
          : `${workspace.name} has no bolts yet`,
        "NO_BOLT",
      );
    }

    // Not half a run: when steps it needs wait for trust, ask (at a terminal) or stop, and
    // start nothing. A dry run goes ahead, since showing what would be skipped is its point.
    if (!options.dryRun && !options.skipUntrusted) {
      const waitLabel = bolt ? boltLabel(workspace, bolt) : undefined;
      const waiting = waitingForTrust(read, waitLabel);
      if (waiting.length > 0) {
        const what = waitLabel ? `"${waitLabel}"` : "Everything";
        const needs = `${what} needs ${plural(waiting.length, "thing")} this file isn't allowed to run yet`;
        if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) throw new WispError(needs, "NOT_TRUSTED");
        console.log(yellow(`! ${needs}. Run without them, it would start only part of it.`));
        console.log();
        printWithheld(read);
        const prompt = new Prompter();
        let yes = false;
        try {
          yes = await prompt.confirm(waitLabel ? `Trust it and run "${waitLabel}"?` : "Trust it and run everything?");
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
        read = (await locate()).read;
        workspace = read.workspace;
      }
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
    const attachedSteps = new Set<string>();
    const runOptions: SwitchOptions = {
      // A git hook says so in its environment; anything else typed this.
      trigger: process.env["WISP_TRIGGER"] ?? "cli",
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
              attachedSteps.add(target.id);
            },
            onResult: (target: TargetResult) => {
              if (lastWasOutput) console.log();
              lastWasOutput = false;
              // Its command was just printed above its output: the result line need not
              // say it again — what happened, and how long it took, is enough.
              // In a job every step reads the same short way; elsewhere a step that opened
              // something says what it opened.
              console.log(attachedSteps.has(target.id) || (isJob && target.kind === "command") ? compactLine(target) : resultLine(target));
            },
          }),
    };
    const find = { findWorkspace: findWorkspaceForDependency };
    const result =
      options.retry && label
        ? await retryLast(workspace, label, isJob, runOptions, find)
        : await switchToWorkspace(workspace, { ...runOptions, ...(bolt ? { bolt } : {}) }, find);

    const untrusted = waitingForTrust(read, result.bolt?.label ?? label);

    if (json) {
      return emitJson({
        workspace: workspace.name,
        bolt: result.bolt?.label,
        job: result.bolt?.job ?? false,
        ok: result.ok,
        dryRun: result.dryRun,
        history: result.historyId ?? null,
        targets: result.targets,
        waitingForTrust: untrusted.map(({ kind, label: name, value, cwd }) => ({ kind, label: name, value, ...(cwd ? { cwd } : {}) })),
      });
    }

    if (result.targets.length === 0) {
      if (result.bolt) {
        if (result.dryRun && untrusted.length > 0) {
          console.log(dim("  every step waits for `wisp trust`. Once allowed, it would run:"));
          for (const item of untrusted) console.log(`  ${dim(kindLabel(item.kind))} ${showNamed(item.label, tildify(item.value))}`);
          console.log(dim("  `wisp check` shows the whole file, `wisp trust` allows it"));
          return;
        }
        // A bolt that resolved to nothing ran nothing. Say why, rather than listing bolts as
        // if the name had been wrong — and fail, so a script or an agent notices.
        console.log(dim(untrusted.length > 0 ? "  nothing ran — every step waits for `wisp trust` (see `wisp check`)" : "  nothing ran — this bolt has no steps here"));
        process.exitCode = 1;
        return;
      }
      console.log(dim("  nothing ran: this workspace holds nothing to open here"));
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
    const name = result.bolt?.label ?? label ?? workspace.name;
    const total = result.targets.reduce((sum, target) => sum + (target.durationMs ?? 0), 0);
    if (!result.ok) {
      const next = [
        result.historyId ? `\`wisp history ${result.historyId}\`` : "",
        failedAt && result.historyId ? `\`wisp ${workspaceRef ? `${workspaceRef} ` : ""}${slugify(name)} --retry\` runs only what failed` : "",
      ].filter(Boolean);
      console.error(`\n${red("✗")} ${bold(name)} ${failedAt ? `failed at ${failedAt.label}` : "was stopped"}${next.length > 0 ? dim(` · ${next.join(" · ")}`) : ""}`);
      process.exitCode = 1;
    } else if (isJob && !result.dryRun) {
      console.log(`\n${green("✓")} ${bold(name)} passed ${dim(`in ${formatMs(total)}`)}`);
    }
  },
};

function boltLabel(workspace: Workspace, ref: string): string {
  // The bolt's own name, not the word typed for it: `wisp api` runs "Work on api".
  const exact = workspace.bolts.find((bolt) => bolt.id === ref || bolt.label === ref);
  if (exact) return exact.label;
  return matchBolt(workspace, ref).bolt?.label ?? ref;
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
    !entry.running && entry.bolt.replace(/ \(retry\)$/, "").toLowerCase() === label.toLowerCase(),
  );
  if (!last) throw new WispError(`"${label}" has not run yet — run it whole first`, "NOTHING_TO_RETRY");
  const again = await planRetry(workspace, last, deps);
  return runPlan(workspace, again, { ...options, label: `${label} (retry)`, job, trigger: "retry" }, deps);
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


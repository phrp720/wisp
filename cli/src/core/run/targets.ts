import { basename } from "node:path";

import { WispError } from "../errors.js";
import { describeWait } from "../system/wait.js";
import { closePipelines, hasWords, slugify, pipelineSlug } from "../workspaces.js";
import type { AssetBase, Pipeline, PipelineStep, SwitchTarget, TargetKind, Workspace } from "../types.js";

/**
 * Apps first, links last, so the browser ends up frontmost when everything has opened.
 *
 * Commands come second: a dev server wants the head start, and its terminal should not be
 * the window on top when everything has finished arriving.
 */
const DEFAULT_ORDER: TargetKind[] = ["app", "command", "folder", "file", "link"];

/** A compose step as a target: what it starts, in words a list can show. */
export function composeTarget(step: { file: string; services?: string[] }, action: "up" | "stop"): SwitchTarget {
  const services = step.services ?? [];
  const label = services.length > 0 ? services.join(", ") : `from ${basename(step.file)}`;
  return {
    kind: "compose",
    id: `compose:${step.file}${services.length > 0 ? `#${services.join(",")}` : ""}`,
    label,
    value: `docker compose -f ${step.file} ${action}`,
    compose: { file: step.file, services, action },
  };
}

/** Every compose file a workspace's pipelines start — what the TUI watches containers for. */
export function composeFiles(workspace: Workspace): string[] {
  if (!workspace.trusted) return [];
  return [...new Set(workspace.pipelines.flatMap((pipeline) => pipeline.steps.flatMap((step) => (step.kind === "compose" ? [step.file] : []))))];
}

/**
 * A pipeline named by any distinctive part of its label.
 *
 * Pipeline labels are written to be read ("API development"), which makes them the worst
 * thing to type. One rule: an exact id or label wins, and otherwise the needle has to
 * be whole words of exactly one label. Not a prefix rule — pipelines are named after jobs and jobs
 * cluster ("Work on core", "Work on the app"), so the distinguishing word is at the end.
 */
export function matchPipeline(workspace: Workspace, ref: string): { pipeline?: Pipeline; candidates: Pipeline[] } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { candidates: [] };

  const pipelines = workspace.pipelines;

  const exact =
    pipelines.find((pipeline) => pipeline.id.toLowerCase() === needle) ??
    pipelines.find((pipeline) => pipeline.label.toLowerCase() === needle);
  if (exact) return { pipeline: exact, candidates: [exact] };

  // A slug is the label with its spaces punched out — the form a shell history hands back.
  const bySlug = pipelines.filter((pipeline) => pipelineSlug(pipeline) === slugify(needle) || slugify(pipeline.label) === slugify(needle));
  if (bySlug.length === 1) return { pipeline: bySlug[0] as Pipeline, candidates: bySlug };
  if (bySlug.length > 1) return { candidates: bySlug };

  const matches = pipelines.filter((pipeline) => hasWords(pipeline.label, needle));
  if (matches.length === 1) return { pipeline: matches[0] as Pipeline, candidates: matches };

  return { candidates: matches };
}

export function findPipeline(workspace: Workspace, ref: string): Pipeline | undefined {
  return matchPipeline(workspace, ref).pipeline;
}

/** Like {@link findPipeline}, but says what went wrong. */
export function resolvePipeline(workspace: Workspace, ref: string): Pipeline {
  const { pipeline, candidates } = matchPipeline(workspace, ref);
  if (pipeline) return pipeline;

  if (candidates.length > 1) {
    throw new WispError(
      `"${ref}" matches several pipelines: ${candidates.map((match) => match.label).join(", ")}`,
      "AMBIGUOUS",
      `Use the full label in quotes, like \`wisp "${candidates[0]?.label}"\`, or give one of them a different "slug".`,
    );
  }

  if (workspace.pipelines.length === 0) throw new WispError(`${workspace.name} has no pipelines yet`, "NOT_FOUND");

  const close = closePipelines(workspace.pipelines, ref);
  throw new WispError(
    close.length > 0
      ? `${workspace.name} has no pipeline called "${ref}". Did you mean ${close.map((match) => `"${match.label}"`).join(", ")}?`
      : `${workspace.name} has no pipeline called "${ref}" — it has ${workspace.pipelines.map((match) => match.label).join(", ")}`,
    "NOT_FOUND",
    close.length > 0 ? "" : undefined,
  );
}

/** The steps a pipeline lists, without its needs — for showing a pipeline rather than running it. */
export function collectPipelineTargets(workspace: Workspace, pipeline: Pipeline): SwitchTarget[] {
  return listSteps(workspace, pipeline.steps);
}

/** The same, for a pipeline's `down` steps. */
export function collectDownTargets(workspace: Workspace, pipeline: Pipeline): SwitchTarget[] {
  return listSteps(workspace, pipeline.down ?? []);
}

function listSteps(workspace: Workspace, steps: PipelineStep[]): SwitchTarget[] {
  return stepTargets(workspace, steps).filter((target): target is SwitchTarget => target !== undefined);
}

export function stepTargets(workspace: Workspace, steps: PipelineStep[]): (SwitchTarget | undefined)[] {
  const byId = new Map(collectTargets(workspace).map((target) => [target.id, target]));
  return steps.map((step) => {
    const target = listStep(step, byId, workspace)[0];
    return target ? { ...target, ...(step.name ? { name: step.name } : {}), ...(step.after && step.after.length > 0 ? { after: step.after } : {}) } : undefined;
  });
}

function listStep(step: PipelineStep, byId: Map<string, SwitchTarget>, workspace: Workspace): SwitchTarget[] {
  return [step].flatMap((step): SwitchTarget[] => {
    if (step.kind === "wait") {
      if (step.held) return [];
      return [{ kind: "wait", id: "wait", label: describeWait(step.wait), value: describeWait(step.wait), wait: step.wait }];
    }
    if (step.kind === "pipeline") {
      return [{ kind: "pipeline", id: `pipeline:${step.pipeline.toLowerCase()}`, label: step.pipeline, value: step.pipeline }];
    }
    if (step.kind === "compose") return workspace.trusted ? [composeTarget(step, "up")] : [];
    const target = byId.get(step.id);
    return target ? [target] : [];
  });
}

/** Every step's target a workspace holds, by kind: what a pipeline's steps are looked up in. */
export function collectTargets(workspace: Workspace): SwitchTarget[] {
  const targets: SwitchTarget[] = [];

  for (const kind of DEFAULT_ORDER) {
    if (kind === "app") for (const app of workspace.apps) targets.push(toTarget(kind, app, app.app));
    else if (kind === "folder") for (const folder of workspace.folders) targets.push(toTarget(kind, folder, folder.path));
    else if (kind === "file") for (const file of workspace.files) targets.push(toTarget(kind, file, file.path));
    else if (kind === "link") for (const link of workspace.links) targets.push(toTarget(kind, link, link.url));
    else {
      for (const command of workspace.commands) {
        const target = toTarget(kind, command, command.run);
        if (command.cwd) target.cwd = command.cwd;
        if (command.background) target.background = true;
        if (command.finishes) target.finishes = true;
        if (command.timeout) target.timeout = command.timeout;
        if (command.restart) target.restart = command.restart;
        if (command.shell) target.shell = command.shell;
        if (command.env) target.env = command.env;
        targets.push(target);
      }
    }
  }

  return targets;
}

function toTarget(kind: TargetKind, item: AssetBase, value: string): SwitchTarget {
  const target: SwitchTarget = { kind, label: item.label, id: item.id, value };
  if (item.openWith?.trim()) target.openWith = item.openWith.trim();
  return target;
}

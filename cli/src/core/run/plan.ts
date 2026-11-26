import { WispError } from "../errors.js";
import { fillTarget, fillText, type InputValues } from "../inputs.js";
import type { HistoryEntry } from "../history.js";
import { describeWait } from "../system/wait.js";
import type { Pipeline, PipelineStep, InputSpec, SwitchTarget, TargetResult, Workspace } from "../types.js";
import { collectTargets, composeTarget, resolvePipeline } from "./targets.js";

/** One step of a plan, the workspace it belongs to, and the pipeline that put it there. */
export interface PlannedStep {
  key: string;
  deps: string[];
  target: SwitchTarget;
  workspace: Workspace;
  /** The pipeline it comes from carries on after one of its steps fails. */
  keepGoing: boolean;
  pipeline: string;
}

/**
 * The steps of a past run worth running again — read back from history and matched step
 * by step against the pipeline as it is now. A pipeline edited since is refused rather than
 * half-matched: retrying the wrong steps is worse than retrying none.
 */
export async function planRetry(workspace: Workspace, entry: HistoryEntry): Promise<PlannedStep[]> {
  if (entry.ok) throw new WispError(`That run of "${entry.pipeline}" passed — there is nothing to retry`, "NOTHING_TO_RETRY");
  const label = entry.pipeline.replace(/ \((retry|down)\)$/, "");
  const plan = fillPlan(await planPipeline(workspace, resolvePipeline(workspace, label)), entry.inputs ?? {});
  // A retry's own history holds only the steps it retried: match those by label instead.
  const steps = entry.steps;
  const byOrder = plan.length === steps.length && plan.every((step, at) => step.target.label === steps[at]?.label);
  const failedLabels = new Set(steps.filter((step) => !step.ok || (step.skipped === true && step.note?.startsWith("not reached"))).map((step) => step.label));
  if (byOrder) {
    return plan.filter((_step, at) => {
      const step = steps[at];
      return step !== undefined && (!step.ok || (step.skipped === true && step.note?.startsWith("not reached")));
    });
  }
  const again = plan.filter((step) => failedLabels.has(step.target.label));
  if (again.length === 0) throw new WispError(`"${label}" has changed since that run — run it whole`, "NOTHING_TO_RETRY");
  return again;
}

/**
 * The steps of a finished run worth running again: the ones that failed, and the ones a
 * failure kept from running — in their order, and nothing that already worked.
 */
export function retryPlan(result: { plan?: PlannedStep[]; targets: TargetResult[] }): PlannedStep[] {
  const plan = result.plan ?? [];
  return plan.filter((_step, at) => {
    const outcome = result.targets[at];
    return outcome !== undefined && (!outcome.ok || (outcome.skipped === true && outcome.note?.startsWith("not reached")));
  });
}

/**
 * A pipeline as the steps it will take, its dependencies expanded in place.
 *
 * A dependency runs where it is listed, once: a pipeline needing "Database" twice over — or
 * two pipelines both needing it — starts it a single time. A dependency that leads back to a
 * pipeline already being expanded is a cycle, and is refused before anything has opened.
 * Each step remembers whether its own pipeline keeps going after a failure.
 */
export async function planPipeline(workspace: Workspace, pipeline: Pipeline): Promise<PlannedStep[]> {
  const plan: PlannedStep[] = [];
  const finished = new Map<string, string[]>();
  const firstOf = new Map<string, string>();

  const expand = async (owner: Workspace, current: Pipeline, stack: string[], startAfter: string[]): Promise<string[]> => {
    const key = `${owner.file}#${current.id}`;
    if (stack.includes(key)) {
      const names = [...stack.slice(stack.indexOf(key)), key].map((entry) => entry.split("#pipeline:")[1] ?? entry);
      throw new WispError(`These pipelines need each other: ${names.join(" → ")}`, "CYCLE");
    }
    const known = finished.get(key);
    if (known) return known;
    if (current.broken) throw new WispError(current.broken, "BROKEN_PIPELINE");

    const byId = new Map(collectTargets(owner).map((target) => [target.id, target]));
    const byName = new Map<string, number>();
    current.steps.forEach((step, at) => {
      if (step.name) byName.set(step.name, at);
    });
    const doneBy = new Map<number, string[]>();
    const all: string[] = [];
    const left = new Set(current.steps.map((_step, at) => at));

    while (left.size > 0) {
      const at = [...left].find((index) => (current.steps[index]?.after ?? []).every((name) => !left.has(byName.get(name) ?? -1)));
      if (at === undefined) throw new WispError(`"${current.label}" can't run: its steps wait for each other`, "BROKEN_PIPELINE");
      left.delete(at);
      const step = current.steps[at] as PipelineStep;
      const after = step.after ?? [];
      const waitsFor = after.length > 0 ? [...new Set(after.flatMap((name) => doneBy.get(byName.get(name) ?? -1) ?? []))] : startAfter;
      const stepKey = `${key}#${at}`;

      if (step.kind === "pipeline") {
        const keys = await expand(owner, resolvePipeline(owner, step.pipeline), [...stack, key], waitsFor);
        doneBy.set(at, keys.length > 0 ? keys : waitsFor);
        all.push(...keys);
        continue;
      }

      const target =
        step.kind === "wait"
          ? step.held
            ? undefined
            : ({ kind: "wait", id: `wait:${stepKey}`, label: describeWait(step.wait), value: describeWait(step.wait), wait: step.wait } satisfies SwitchTarget)
          : step.kind === "compose"
            ? owner.trusted
              ? composeTarget(step, "up")
              : undefined
            : byId.get(step.id);
      if (!target) {
        doneBy.set(at, waitsFor);
        continue;
      }
      const assetKey = `${owner.file}#${target.id}`;
      const seen = target.kind === "wait" ? undefined : firstOf.get(assetKey);
      if (seen) {
        doneBy.set(at, [seen]);
        continue;
      }
      if (target.kind !== "wait") firstOf.set(assetKey, stepKey);
      plan.push({
        key: stepKey,
        deps: waitsFor,
        target: { ...target, ...(step.name ? { name: step.name } : {}), ...(after.length > 0 ? { after } : {}) },
        workspace: owner,
        keepGoing: current.keepGoing ?? false,
        pipeline: current.label,
      });
      doneBy.set(at, [stepKey]);
      all.push(stepKey);
    }

    finished.set(key, all);
    return all;
  };

  await expand(workspace, pipeline, [], []);
  return plan;
}

export function stagesOf(items: { key: string; deps: string[] }[]): number[] {
  const at = new Map(items.map((item, index) => [item.key, index]));
  const known = new Map<number, number>();
  const stage = (index: number, path: Set<number>): number => {
    const cached = known.get(index);
    if (cached !== undefined) return cached;
    if (path.has(index)) return 1;
    const deps = (items[index]?.deps ?? []).flatMap((key) => (at.has(key) ? [at.get(key) as number] : []));
    const value = deps.length === 0 ? 1 : 1 + Math.max(...deps.map((dep) => stage(dep, new Set([...path, index]))));
    known.set(index, value);
    return value;
  };
  return items.map((_item, index) => stage(index, new Set()));
}

export function stagesOfTargets(targets: { name?: string; after?: string[] }[]): number[] {
  return stagesOf(targets.map((target, index) => ({ key: target.name ?? `#${index}`, deps: target.after ?? [] })));
}

export function fillPlan(plan: PlannedStep[], values: InputValues): PlannedStep[] {
  if (Object.keys(values).length === 0) return plan;
  return plan.map((step) => ({ ...step, target: fillTarget(step.target, values) }));
}

async function pipelinesOf(workspace: Workspace, pipeline: Pipeline): Promise<Pipeline[]> {
  const plan = await planPipeline(workspace, pipeline);
  const found = [pipeline, ...uniquePipelines(plan).map((owner) => owner.workspace.pipelines.find((entry) => entry.label === owner.pipeline))];
  return [...new Set(found.filter((entry): entry is Pipeline => entry !== undefined))];
}

export async function questionsFor(workspace: Workspace, pipeline: Pipeline, values: InputValues = {}): Promise<string[]> {
  const questions: string[] = [];
  for (const owner of await pipelinesOf(workspace, pipeline)) {
    const question = owner.confirm ? fillText(owner.confirm, values) : undefined;
    if (question && !questions.includes(question)) questions.push(question);
  }
  return questions;
}

export async function inputsFor(workspace: Workspace, pipeline: Pipeline): Promise<InputSpec[]> {
  const specs: InputSpec[] = [];
  for (const owner of await pipelinesOf(workspace, pipeline)) {
    for (const spec of owner.inputs ?? []) if (!specs.some((known) => known.name === spec.name)) specs.push(spec);
  }
  return specs;
}

export function uniquePipelines(plan: PlannedStep[]): { workspace: Workspace; pipeline: string }[] {
  const seen = new Map<string, { workspace: Workspace; pipeline: string }>();
  for (const step of plan) seen.set(`${step.workspace.file}#${step.pipeline}`, { workspace: step.workspace, pipeline: step.pipeline });
  return [...seen.values()];
}

import { listRuns, stopRun, type RunStatus } from "../system/processes.js";
import type { Pipeline, SwitchResult, TargetResult, Workspace } from "../types.js";
import type { RunDeps } from "./context.js";
import { runPlan } from "./execute.js";
import { type PlannedStep, planPipeline, uniquePipelines } from "./plan.js";
import { composeTarget } from "./targets.js";

export interface DownResult {
  stopped: RunStatus[];
  /** The bolt's own `down` steps, run after stopping. */
  teardown?: SwitchResult;
}

/**
 * Stop what a bolt started, then run its `down` steps.
 *
 * Its own commands by default: `down api` should not take the database out from under
 * `web`, which needs it too. With `deps`, its dependencies' commands and teardown as well.
 */
export async function downPipeline(
  workspace: Workspace,
  bolt: Pipeline,
  options: { deps?: boolean; dryRun?: boolean; echo?: boolean; onResult?: (result: TargetResult) => void } = {},
  deps: RunDeps = {},
): Promise<DownResult> {
  const plan = options.deps
    ? await planPipeline(workspace, bolt)
    : await planPipeline(workspace, { ...bolt, steps: bolt.steps.filter((step) => step.kind !== "pipeline") });

  const commands = plan.filter((step) => step.target.kind === "command");
  const runs = (await listRuns()).filter((run) => run.alive);
  const stopped = runs.filter((run) =>
    commands.some((step) => step.workspace.file === run.workspace && step.target.id === run.asset),
  );
  if (!options.dryRun) for (const run of stopped) stopRun(run);

  // Teardown: the compose services it started, then its `down` steps — this bolt's, and
  // with `deps`, each dependency's — once each.
  const owners = options.deps ? uniquePipelines(plan) : [{ workspace, bolt: bolt.label }];
  const teardownSteps: PlannedStep[] = plan
    .filter((step) => step.target.kind === "compose" && step.target.compose)
    .map((step) => ({ ...step, key: `${step.key}#stop`, deps: [], keepGoing: false, target: composeTarget(step.target.compose!, "stop") }));
  const stopping = teardownSteps.map((step) => step.key);
  for (const owner of owners) {
    const source = owner.workspace.bolts.find((entry) => entry.label === owner.bolt);
    if (!source?.down?.length) continue;
    const steps = await planPipeline(owner.workspace, { ...source, steps: source.down.filter((step) => step.kind !== "pipeline"), keepGoing: false });
    teardownSteps.push(
      ...steps.map((step) => ({
        ...step,
        key: `${step.key}#down`,
        deps: [...stopping, ...step.deps.map((key) => `${key}#down`)],
        target: step.target.kind === "command" ? { ...step.target, finishes: true } : step.target,
      })),
    );
  }

  if (teardownSteps.length === 0) return { stopped };
  const teardown = await runPlan(
    workspace,
    teardownSteps,
    {
      label: `${bolt.label} (down)`,
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.echo ? { echo: true } : {}),
      ...(options.onResult ? { onResult: options.onResult } : {}),
    },
    deps,
  );
  return { stopped, teardown };
}

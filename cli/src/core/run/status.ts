import type { Container } from "../system/docker.js";
import type { RunStatus } from "../system/processes.js";
import type { Pipeline, Workspace, WorkspaceRead } from "../types.js";

/** How much of a pipeline is up: its own commands, against what Wisp has running. */
export function pipelineStatus(
  workspace: Workspace,
  pipeline: Pipeline,
  runs: RunStatus[],
  containers: Container[] = [],
): { commands: number; running: number; failing: number } {
  const ids = new Set(
    pipeline.steps.flatMap((step) => (step.kind === "asset" && step.id.startsWith("command:") ? [step.id] : [])),
  );
  const available = workspace.commands.filter((command) => ids.has(command.id) && !command.finishes);
  let commands = available.length;
  let running = available.filter((command) =>
    runs.some((run) => run.alive && run.workspace === workspace.file && run.asset === command.id),
  ).length;
  let failing = 0;

  // Containers count too: the services a compose step names, or all of its file's.
  for (const step of pipeline.steps) {
    if (step.kind !== "compose" || !workspace.trusted) continue;
    const mine = containers.filter((container) => container.file === step.file && (!step.services?.length || step.services.includes(container.service)));
    const expected = step.services?.length ? step.services.length : Math.max(1, mine.length);
    commands += expected;
    running += mine.filter((container) => container.state === "running").length;
    failing += mine.filter((container) => container.health === "unhealthy" || (container.state === "exited" && container.exitCode !== 0)).length;
  }
  return { commands, running, failing };
}

export function keepsRunning(read: WorkspaceRead, pipeline: Pipeline): string[] {
  const ids = new Set(pipeline.steps.flatMap((step) => (step.kind === "asset" && step.id.startsWith("command:") ? [step.id] : [])));
  return read.declaredCommands.filter((command) => ids.has(command.id) && !command.finishes).map((command) => command.label);
}

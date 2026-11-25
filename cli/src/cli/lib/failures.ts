import { failureOutput } from "../../core/system/processes.js";

interface Step {
  ok: boolean;
  cancelled?: boolean;
  skipped?: boolean;
  log?: string;
}

export async function withFailureOutput<T extends Step>(steps: T[]): Promise<(T & { output?: string })[]> {
  return Promise.all(
    steps.map(async (step) => {
      if (step.ok || step.cancelled || step.skipped || !step.log) return step;
      const output = await failureOutput(step.log);
      return output ? { ...step, output } : step;
    }),
  );
}

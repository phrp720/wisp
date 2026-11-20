import { WispError } from "../../core/errors.js";
import { checkValue, parseGiven, type InputValues } from "../../core/inputs.js";
import { inputsFor, questionsFor } from "../../core/switch.js";
import type { Bolt, InputSpec, Workspace } from "../../core/types.js";
import { choose, Prompter } from "../prompt.js";
import { findWorkspaceForDependency } from "./context.js";

export interface AskOptions {
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  input?: string[];
}

export async function beforeRun(workspace: Workspace, bolt: Bolt, options: AskOptions, recorded?: InputValues): Promise<InputValues | undefined> {
  const find = { findWorkspace: findWorkspaceForDependency };
  const interactive = !options.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const values: InputValues = { ...recorded };

  if (!recorded) {
    const specs = await inputsFor(workspace, bolt, find);
    Object.assign(values, parseGiven(options.input ?? [], specs, bolt.label));
    const missing = specs.filter((spec) => values[spec.name] === undefined);
    for (const spec of missing) {
      if (spec.default !== undefined && (options.dryRun || options.yes || !interactive)) values[spec.name] = spec.default;
    }
    if (options.dryRun) return values;
    const unasked = missing.filter((spec) => values[spec.name] === undefined);
    if (unasked.length > 0 && !interactive) {
      throw new WispError(`"${bolt.label}" needs ${unasked.map((spec) => (spec.ask === spec.name ? spec.name : `${spec.name} (${spec.ask})`)).join(", ")}: pass ${unasked.map((spec) => `--input ${spec.name}=…`).join(" ")}`, "INPUT_NEEDED");
    }
    for (const spec of unasked) {
      const value = await askFor(spec);
      if (value === undefined) return undefined;
      values[spec.name] = value;
    }
  }
  if (options.dryRun) return values;

  const questions = await questionsFor(workspace, bolt, find, values);
  if (questions.length === 0 || options.yes) return values;
  if (!interactive) throw new WispError(`"${bolt.label}" asks before it runs: ${questions.join(" ")}`, "CONFIRM_NEEDED");
  const prompt = new Prompter();
  try {
    for (const question of questions) {
      if (!(await prompt.confirm(question))) return undefined;
    }
  } finally {
    prompt.close();
  }
  return values;
}

async function askFor(spec: InputSpec): Promise<string | undefined> {
  if (spec.choices) {
    const picked = await choose(spec.ask, spec.choices.map((label) => ({ label })), "pick", spec.default ? spec.choices.indexOf(spec.default) : 0);
    return picked === undefined ? undefined : spec.choices[picked];
  }
  const prompt = new Prompter();
  try {
    for (;;) {
      const value = await prompt.ask(spec.ask, spec.default ?? "");
      const problem = checkValue(spec, value);
      if (!problem) return value.trim();
      console.log(problem);
    }
  } finally {
    prompt.close();
  }
}

import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getOpenWithDefaults } from "../config.js";
import { DOCKER_DOWN, usesDocker } from "../system/docker.js";
import { detectEnvironment } from "../system/environment.js";
import { describe } from "../errors.js";
import { envNames, fillEnv } from "../inputs.js";
import { notifyRunEnd } from "../notify.js";
import { baseLabel, gitState, listHistory, newHistoryId, noteNotified, recordHistory, stepLogFile, type HistoryEntry, type HistoryStep } from "../history.js";
import { currentOS, expandHome } from "../paths.js";
import { stoppedOnPurpose, tidyState } from "../system/processes.js";
import { normalizeUrl, sameUrl } from "../text/url.js";
import { waitFor } from "../system/wait.js";
import type { SwitchOptions, SwitchResult, SwitchTarget, TargetResult, Workspace } from "../types.js";
import { attached, describeRoute, runCommand, runCompose } from "./commands.js";
import { type Context, type RunDeps, deadBefore, dockerOf, platformOf, stoppedContainer } from "./context.js";
import { type PlannedStep, fillPlan, planPipeline, stagesOf } from "./plan.js";
import { resolvePipeline } from "./targets.js";

/**
 * Run a bolt and report what happened to each step.
 *
 * Steps run one after another, so the order written is the order things appear. A failure
 * stops the run — the tests failing must not be followed by the deploy — unless the bolt
 * the failed step belongs to says to keep going.
 */
export async function switchToWorkspace(
  workspace: Workspace,
  options: SwitchOptions = {},
  deps: RunDeps = {},
): Promise<SwitchResult> {
  const bolt = options.bolt ? resolvePipeline(workspace, options.bolt) : undefined;

  const steps: PlannedStep[] = bolt ? fillPlan(await planPipeline(workspace, bolt), options.inputs ?? {}) : [];
  const result = await runPlan(workspace, steps, { ...options, label: bolt?.label ?? "" }, deps);
  return { ...result, ...(bolt ? { bolt } : {}) };
}

/** Run a plan already made — a bolt's steps, or its `down` steps. */
export async function runPlan(
  workspace: Workspace,
  steps: PlannedStep[],
  options: SwitchOptions & { label: string },
  deps: RunDeps = {},
): Promise<SwitchResult> {
  const dryRun = options.dryRun ?? false;
  const inputs = options.inputs && Object.keys(options.inputs).length > 0 ? options.inputs : undefined;
  const record = (options.record ?? true) && !dryRun && steps.length > 0;
  const historyId = record ? newHistoryId() : undefined;
  const startedAt = new Date();
  const git = record ? gitState(dirname(workspace.file)) : Promise.resolve(undefined);

  const context: Context = {
    environment: deps.environment ?? detectEnvironment(),
    defaults: deps.defaults ?? (await getOpenWithDefaults()),
    options,
    lazyPlatform: deps.platform,
    tabs: undefined,
    historyId,
    started: [],
    since: Date.now(),
    composeFiles: new Set(),
  };

  const results: (TargetResult | undefined)[] = steps.map(() => undefined);
  const indexOf = new Map(steps.map((step, at) => [step.key, at]));
  const waitsOn = steps.map((step) => step.deps.flatMap((key) => (indexOf.has(key) ? [indexOf.get(key) as number] : [])));
  const inlineAt = steps.map((step) => !dryRun && attached(step, context));
  const sideways = alongsideOthers(waitsOn, inlineAt);
  const width = Math.max(0, ...steps.filter((_step, at) => sideways.has(at)).map((step) => step.target.label.length));
  const runningLogs = new Map<number, string>();
  const stageAt = stagesOf(steps);
  let halted: string | undefined;
  options.onPlan?.(steps.map((step) => step.target));

  const owned = (result: TargetResult, at: number): HistoryStep => {
    const owner = steps[at]?.bolt;
    const waits = waitsOn[at] ?? [];
    return { ...toHistoryStep(result), stage: stageAt[at] ?? 1, at, ...(waits.length > 0 ? { waits } : {}), ...(owner && owner !== options.label.replace(/ \((retry|down)\)$/, "") ? { bolt: owner } : {}) };
  };
  const entry = (done: { ok: boolean; running: boolean }): HistoryEntry => ({
    id: historyId as string,
    workspace: workspace.file,
    workspaceName: workspace.name,
    bolt: options.label,
    ...(options.trigger ? { trigger: options.trigger } : {}),
    ...(inputs ? { inputs } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: done.ok,
    steps: steps.flatMap((_step, at) => (results[at] ? [owned(results[at] as TargetResult, at)] : [])),
    ...(done.running
      ? {
          running: true,
          pid: process.pid,
          total: steps.length,
          pending: steps.flatMap((step, at) => {
            if (results[at]) return [];
            const waiting = owned({ ...step.target, ok: false }, at);
            const log = runningLogs.get(at);
            return [log ? { ...waiting, running: true, log } : waiting];
          }),
        }
      : {}),
  });
  let saving: Promise<void> = Promise.resolve();
  const save = (next: HistoryEntry) => (saving = saving.then(() => recordHistory(next)).catch(() => undefined));

  const active = new Map<number, Promise<void>>();
  const settle = (at: number, result: TargetResult) => {
    results[at] = result;
    options.onResult?.(result);
  };
  const start = (at: number) => {
    const step = steps[at] as PlannedStep;
    const run = async () => {
      const inline = inlineAt[at] as boolean;
      if (inline && historyId) runningLogs.set(at, stepLogFile(historyId, at));
      if (record && historyId) await save(entry({ ok: false, running: true }));
      options.onStep?.(step.target, { attached: inline });
      const began = Date.now();
      const shared = inline && sideways.has(at) ? sideBySide(context, step.target, width) : { context, flush: () => undefined };
      const outcome = dryRun ? await preview(step, context) : await execute(step, at, shared.context);
      shared.flush();
      const result: TargetResult = { ...outcome, durationMs: Date.now() - began };
      // Cut short by a stop, not broken: say so, rather than a signal's exit code.
      if (options.signal?.aborted && !result.ok && !result.skipped) {
        result.error = "you stopped the run";
        result.cancelled = true;
      } else if (!result.ok && !result.skipped && result.run && stoppedOnPurpose(result.run)) {
        result.error = `you stopped ${result.label}`;
        result.cancelled = true;
      }
      if (result.cancelled) halted ??= "the run was cancelled";
      if (result.run && !result.note?.startsWith("already running")) context.started.push({ id: result.run });
      runningLogs.delete(at);
      if (!result.ok && !result.skipped && !step.keepGoing) halted ??= step.target.kind === "wait" ? "an earlier wait gave up" : `"${step.target.label}" failed`;
      settle(at, result);
    };
    active.set(
      at,
      run().finally(() => active.delete(at)),
    );
  };

  try {
    for (;;) {
      if (options.signal?.aborted) halted ??= "the run was cancelled";
      let moved = false;
      for (let at = 0; at < steps.length; at += 1) {
        if (results[at] || active.has(at)) continue;
        if (halted) {
          settle(at, { ...(steps[at] as PlannedStep).target, ok: false, skipped: true, note: `not reached — ${halted}` });
          moved = true;
          continue;
        }
        if ((waitsOn[at] as number[]).every((dep) => results[dep] !== undefined)) {
          start(at);
          moved = true;
        }
      }
      if (active.size === 0 && results.every((result) => result !== undefined)) break;
      if (active.size === 0 && !moved) halted ??= "what it waits for never finished";
      if (active.size === 0) continue;
      await Promise.race(active.values());
    }
  } catch (error) {
    if (record && historyId) await save(entry({ ok: false, running: false }));
    throw error;
  }

  const finished = results as TargetResult[];
  const ok = finished.every((result) => result.ok || result.skipped === true) && !halted;
  const failures = finished.filter((result) => !result.ok && !result.skipped);
  const cancelled = !ok && (Boolean(options.signal?.aborted) || (failures.length > 0 && failures.every((result) => result.cancelled === true)));

  if (record && historyId) {
    const where = await git;
    await save({ ...entry({ ok, running: false }), ...(cancelled ? { cancelled: true } : {}), ...(where ? { git: where } : {}) });
    // The run that dropped out of History takes its output with it.
    await tidyState().catch(() => undefined);
  }

  if (!dryRun && steps.length > 0) {
    const failed = finished.find((result) => !result.ok && !result.skipped);
    const previous = (await listHistory({ workspace: workspace.file }).catch(() => [])).find(
      (other) => other.id !== historyId && !other.running && !other.cancelled && baseLabel(other.bolt) === baseLabel(options.label),
    );
    const notified = await notifyRunEnd(
      {
        ok,
        bolt: options.label,
        workspace: workspace.name,
        workspaceFile: workspace.file,
        ...(cancelled ? { cancelled: true } : {}),
        ...(failed ? { failedStep: failed.label, ...(failed.error && !cancelled ? { error: failed.error } : {}) } : {}),
        ...(historyId ? { historyId } : {}),
        durationMs: Date.now() - startedAt.getTime(),
        watched: options.watched ?? true,
        ...(previous ? { previousOk: previous.ok } : {}),
      },
      { platform: platformOf(context), environment: context.environment },
    ).catch(() => []);
    if (record && historyId && notified.length > 0) await noteNotified(historyId, notified).catch(() => undefined);
  }

  return { workspace, targets: finished, dryRun, ok, ...(cancelled ? { cancelled: true } : {}), plan: steps, ...(historyId ? { historyId } : {}), ...(inputs ? { inputs } : {}) };
}

function alongsideOthers(waitsOn: number[][], inline: boolean[]): Set<number> {
  const before = waitsOn.map(() => new Set<number>());
  const reach = (at: number, seen: Set<number>): Set<number> => {
    for (const dep of waitsOn[at] ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      reach(dep, seen);
    }
    return seen;
  };
  waitsOn.forEach((_deps, at) => reach(at, before[at] as Set<number>));
  const found = new Set<number>();
  for (let one = 0; one < inline.length; one += 1) {
    for (let two = one + 1; two < inline.length; two += 1) {
      if (!inline[one] || !inline[two] || before[one]?.has(two) || before[two]?.has(one)) continue;
      found.add(one);
      found.add(two);
    }
  }
  return found;
}

function sideBySide(context: Context, target: SwitchTarget, width: number): { context: Context; flush: () => void } {
  const prefix = `${target.label.padEnd(width)} │ `;
  const echo = context.options.echo ?? false;
  let open = "";
  const emit = (line: string) => {
    if (echo) process.stdout.write(`${prefix}${line}\n`);
    context.options.onOutput?.(target, `${prefix}${line}\n`);
  };
  const onOutput = (_target: SwitchTarget, chunk: string) => {
    const lines = (open + chunk.replace(/\r(?!\n)/g, "\n")).split(/\r?\n/);
    open = lines.pop() ?? "";
    for (const line of lines) emit(line);
  };
  return {
    context: { ...context, options: { ...context.options, echo: false, onOutput } },
    flush: () => {
      if (open) emit(open);
      open = "";
    },
  };
}

function toHistoryStep(result: TargetResult): HistoryStep {
  return {
    kind: result.kind,
    label: result.label,
    value: result.value,
    ...(result.workspace ? { workspace: result.workspace } : {}),
    ok: result.ok,
    ...(result.skipped ? { skipped: true } : {}),
    ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.finishes ? { finishes: true } : {}),
    ...(result.after ? { after: result.after } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.note ? { note: result.note } : {}),
    durationMs: result.durationMs ?? 0,
    ...(result.log ? { log: result.log } : {}),
  };
}

/** What a dry run reports: the plan, with where each thing would go. */
async function preview(step: PlannedStep, context: Context): Promise<TargetResult> {
  const { target } = step;
  const headless = !context.environment.gui;
  if (target.kind === "folder" || target.kind === "file") {
    const problem = await checkPath(target, step.workspace).then(
      () => undefined,
      (error: unknown) => describe(error),
    );
    if (problem) return { ...target, ok: false, error: problem };
  }

  if (target.kind === "command") return { ...target, ok: true, note: describeRoute(target, step, context) };
  if (target.kind === "compose") {
    return { ...target, ok: true, note: target.compose?.action === "stop" ? "would stop them" : "would start them and wait until they are healthy" };
  }
  if (target.kind === "link" && headless) return { ...target, ok: true, note: "no display — the url would be printed" };
  if ((target.kind === "folder" || target.kind === "file" || target.kind === "app") && headless) {
    return { ...target, ok: true, skipped: true, note: "no display — would be skipped" };
  }
  return { ...target, ok: true };
}

async function execute(step: PlannedStep, index: number, context: Context): Promise<TargetResult> {
  const { target, workspace } = step;

  try {
    switch (target.kind) {
      case "wait":
        if (target.wait) {
          try {
            await waitFor(target.wait, context.options.signal, () => deadBefore(context));
          } catch (error) {
            const by = context.cancelledBy ?? (await stoppedContainer(context, [...context.composeFiles]));
            if (by) return { ...target, ok: false, cancelled: true, error: `you stopped ${by}` };
            throw error;
          }
        }
        return { ...target, ok: true };
      case "command":
        if (usesDocker(target.value) && (await dockerOf(context)) === "down") return { ...target, ok: false, error: DOCKER_DOWN };
        return await runCommand(step, index, context);
      case "compose": {
        const state = await dockerOf(context);
        if (state === "down") return { ...target, ok: false, error: DOCKER_DOWN };
        if (state === "missing") return { ...target, ok: false, error: "Docker isn't installed" };
        return await runCompose(step, index, context);
      }
      case "link":
        return await openLink(target, context);
      case "folder":
      case "file":
        return await openPath(target, workspace, context);
      case "app":
        if (!context.environment.gui) return { ...target, ok: true, skipped: true, note: "no display — skipped" };
        await platformOf(context).launchApp(target.value, { background: context.options.background ?? false });
        return { ...target, ok: true };
      default:
        return { ...target, ok: false, error: "nothing to do" };
    }
  } catch (error) {
    return { ...target, ok: false, error: describe(error) };
  }
}

async function openLink(target: SwitchTarget, context: Context): Promise<TargetResult> {
  const url = normalizeUrl(fillEnv(target.value));
  // Headless, there is no browser to send it to — but the url is still what you wanted,
  // and printing it is how a terminal hands you one.
  if (!context.environment.gui) {
    const names = envNames(target.value);
    if (names.length > 0) return { ...target, ok: true, note: `no display: open it yourself, from ${names.map((name) => `$${name}`).join(", ")}` };
    return { ...target, value: url, ok: true, note: "no display — open it yourself" };
  }

  const platform = platformOf(context);
  if ((context.options.reuseTabs ?? true) && platform.tabs) {
    context.tabs ??= await platform.tabs.snapshot();
    const open = context.tabs.find((tab) => sameUrl(tab.url, url));
    if (open) {
      if (context.options.background) return { ...target, ok: true, note: "already open" };
      try {
        await platform.tabs.focus(open);
        return { ...target, ok: true, note: "focused its open tab" };
      } catch {
        // Fall through and open it, which at least gets the page in front of you.
      }
    }
  }

  await platform.openUrl(url, { background: context.options.background ?? false });
  return { ...target, ok: true };
}

async function checkPath(target: SwitchTarget, workspace: Workspace): Promise<string> {
  const wantsFolder = target.kind === "folder";
  const path = resolve(expandHome(target.value));

  const stats = await stat(path).catch(() => undefined);
  if (!stats) throw new Error(`no such ${target.kind}: ${path}`);
  const bundle = wantsFolder && /\.app\/?$/.test(path);
  if (stats.isDirectory() !== wantsFolder && !bundle) {
    throw new Error(`${path} is a ${wantsFolder ? "file" : "folder"}, not a ${target.kind}`);
  }

  // The parser withholds what runs by its extension; this catches the rest — a script with
  // no extension but an execute bit, which a file manager would happily run.
  if (!workspace.trusted && !wantsFolder && currentOS() !== "win32" && (stats.mode & 0o111) !== 0) {
    throw new Error("this file is executable, so it waits until you trust the workspace — `wisp trust`");
  }
  return path;
}

async function openPath(target: SwitchTarget, workspace: Workspace, context: Context): Promise<TargetResult> {
  const path = await checkPath(target, workspace);
  if (!context.environment.gui) return { ...target, ok: true, skipped: true, note: "no display — skipped" };

  const app = target.openWith?.trim();
  await platformOf(context).openPath(path, {
    background: context.options.background ?? false,
    ...(app ? { app } : {}),
  });
  return { ...target, ok: true };
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { getPlatform, type Platform } from "../platform/index.js";
import { runInTmux, runInZellij } from "../platform/multiplexer.js";
import { MULTIPLEXERS } from "../platform/terminals.js";
import { describeDuration } from "./duration.js";
import { getOpenWithDefaults } from "./config.js";
import { composeStopArgs, composeUpArgs, type Container } from "./docker.js";
import { detectEnvironment, type Environment } from "./environment.js";
import { WispError, describe } from "./errors.js";
import { fillTarget, fillText, type InputValues } from "./inputs.js";
import { notifyRunEnd } from "./notify.js";
import { gitState, newHistoryId, recordHistory, stepLogFile, stepLogPath, type HistoryEntry, type HistoryStep } from "./history.js";
import { currentOS, expandHome, stateDir, withLock } from "./paths.js";
import { listRuns, newRunId, pidFileFor, recordWindowRun, runningFor, startRun, stopHung, stopRun, tidyState, trimLog, type RunStatus } from "./processes.js";
import { restartLoop, shellInvocation, windowInvocation } from "./shell.js";
import { normalizeUrl, sameUrl } from "./url.js";
import { describeWait, waitFor } from "./wait.js";
import { hasWords, slugify } from "./workspaces.js";
import type {
  AssetBase,
  Bolt,
  BoltStep,
  InputSpec,
  Invocation,
  OpenWithDefaults,
  SwitchOptions,
  SwitchResult,
  SwitchTarget,
  TargetKind,
  TargetResult,
  Workspace,
  WorkspaceRead,
} from "./types.js";

/**
 * Apps first, links last, so the browser ends up frontmost when everything has opened.
 *
 * Commands come second: a dev server wants the head start, and its terminal should not be
 * the window on top when everything has finished arriving.
 */
const DEFAULT_ORDER: TargetKind[] = ["app", "command", "folder", "file", "link"];

/** What running needs from the outside world, overridable so tests need none of it. */
export interface RunDeps {
  platform?: Platform;
  environment?: Environment;
  defaults?: OpenWithDefaults;
}

/** One step of a plan, the workspace it belongs to, and the bolt that put it there. */
export interface PlannedStep {
  key: string;
  deps: string[];
  target: SwitchTarget;
  workspace: Workspace;
  /** The bolt it comes from carries on after one of its steps fails. */
  keepGoing: boolean;
  bolt: string;
}

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
  const bolt = options.bolt ? resolveBolt(workspace, options.bolt) : undefined;

  const steps: PlannedStep[] = bolt ? fillPlan(await planBolt(workspace, bolt), options.inputs ?? {}) : [];
  const result = await runPlan(workspace, steps, { ...options, label: bolt?.label ?? "" }, deps);
  return { ...result, ...(bolt ? { bolt } : {}) };
}

/**
 * The steps of a past run worth running again — read back from history and matched step
 * by step against the bolt as it is now. A bolt edited since is refused rather than
 * half-matched: retrying the wrong steps is worse than retrying none.
 */
export async function planRetry(workspace: Workspace, entry: HistoryEntry): Promise<PlannedStep[]> {
  if (entry.ok) throw new WispError(`That run of "${entry.bolt}" passed — there is nothing to retry`, "NOTHING_TO_RETRY");
  const label = entry.bolt.replace(/ \((retry|down)\)$/, "");
  const plan = fillPlan(await planBolt(workspace, resolveBolt(workspace, label)), entry.inputs ?? {});
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
    return { ...toHistoryStep(result), stage: stageAt[at] ?? 1, ...(owner && owner !== options.label.replace(/ \((retry|down)\)$/, "") ? { bolt: owner } : {}) };
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
        result.error = "stopped";
        halted ??= "the run was stopped";
      }
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
      if (options.signal?.aborted) halted ??= "the run was stopped";
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

  if (record && historyId) {
    const where = await git;
    await save({ ...entry({ ok, running: false }), ...(where ? { git: where } : {}) });
    // The run that dropped out of History takes its output with it.
    await tidyState().catch(() => undefined);
  }

  if (!dryRun && steps.length > 0) {
    const failed = finished.find((result) => !result.ok && !result.skipped);
    await notifyRunEnd(
      {
        ok,
        bolt: options.label,
        workspace: workspace.name,
        ...(failed ? { failedStep: failed.label } : {}),
        ...(historyId ? { historyId } : {}),
        durationMs: Date.now() - startedAt.getTime(),
        watched: options.watched ?? true,
      },
      { platform: platformOf(context), environment: context.environment },
    ).catch(() => undefined);
  }

  return { workspace, targets: finished, dryRun, ok, plan: steps, ...(historyId ? { historyId } : {}), ...(inputs ? { inputs } : {}) };
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
    ...(result.finishes ? { finishes: true } : {}),
    ...(result.after ? { after: result.after } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.note ? { note: result.note } : {}),
    durationMs: result.durationMs ?? 0,
    ...(result.log ? { log: result.log } : {}),
  };
}

interface Context {
  /** Set while this run holds the lock on starting one command; see runCommand. */
  starting?: boolean;
  environment: Environment;
  defaults: OpenWithDefaults;
  options: SwitchOptions;
  lazyPlatform: Platform | undefined;
  /** One sweep of the browsers per run, rather than one per link. */
  tabs: Awaited<ReturnType<NonNullable<Platform["tabs"]>["snapshot"]>> | undefined;
  historyId: string | undefined;
  /** Runs this run started, so a wait can notice one has died. */
  started: { id: string }[];
}

/**
 * Why waiting is pointless: a command this run started has already stopped. A wait for a
 * dev server's port should not sit out its whole timeout when the server died at once.
 */
async function deadBefore(context: Context): Promise<string | undefined> {
  if (context.started.length === 0) return undefined;
  const runs = await listRuns();
  for (const started of context.started) {
    const run = runs.find((entry) => entry.id === started.id);
    if (!run || run.alive) continue;
    return run.log
      ? `${run.label} stopped before it was ready — \`wisp logs ${run.id}\``
      : `${run.label} stopped before it was ready — its ${run.where ?? "terminal"} window shows why`;
  }
  return undefined;
}

function platformOf(context: Context): Platform {
  context.lazyPlatform ??= getPlatform();
  return context.lazyPlatform;
}

/**
 * A bolt as the steps it will take, its dependencies expanded in place.
 *
 * A dependency runs where it is listed, once: a bolt needing "Database" twice over — or
 * two bolts both needing it — starts it a single time. A dependency that leads back to a
 * bolt already being expanded is a cycle, and is refused before anything has opened.
 * Each step remembers whether its own bolt keeps going after a failure.
 */
export async function planBolt(workspace: Workspace, bolt: Bolt): Promise<PlannedStep[]> {
  const plan: PlannedStep[] = [];
  const finished = new Map<string, string[]>();
  const firstOf = new Map<string, string>();

  const expand = async (owner: Workspace, current: Bolt, stack: string[], startAfter: string[]): Promise<string[]> => {
    const key = `${owner.file}#${current.id}`;
    if (stack.includes(key)) {
      const names = [...stack.slice(stack.indexOf(key)), key].map((entry) => entry.split("#bolt:")[1] ?? entry);
      throw new WispError(`These bolts need each other: ${names.join(" → ")}`, "CYCLE");
    }
    const known = finished.get(key);
    if (known) return known;
    if (current.broken) throw new WispError(current.broken, "BROKEN_BOLT");

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
      if (at === undefined) throw new WispError(`"${current.label}" can't run: its steps wait for each other`, "BROKEN_BOLT");
      left.delete(at);
      const step = current.steps[at] as BoltStep;
      const after = step.after ?? [];
      const waitsFor = after.length > 0 ? [...new Set(after.flatMap((name) => doneBy.get(byName.get(name) ?? -1) ?? []))] : startAfter;
      const stepKey = `${key}#${at}`;

      if (step.kind === "bolt") {
        const keys = await expand(owner, resolveBolt(owner, step.bolt), [...stack, key], waitsFor);
        doneBy.set(at, keys.length > 0 ? keys : waitsFor);
        all.push(...keys);
        continue;
      }

      const target =
        step.kind === "wait"
          ? ({ kind: "wait", id: `wait:${stepKey}`, label: describeWait(step.wait), value: describeWait(step.wait), wait: step.wait } satisfies SwitchTarget)
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
        bolt: current.label,
      });
      doneBy.set(at, [stepKey]);
      all.push(stepKey);
    }

    finished.set(key, all);
    return all;
  };

  await expand(workspace, bolt, [], []);
  return plan;
}

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
        if (target.wait) await waitFor(target.wait, context.options.signal, () => deadBefore(context));
        return { ...target, ok: true };
      case "command":
        return await runCommand(step, index, context);
      case "compose":
        return await runCompose(step, index, context);
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
  const url = normalizeUrl(target.value);
  // Headless, there is no browser to send it to — but the url is still what you wanted,
  // and printing it is how a terminal hands you one.
  if (!context.environment.gui) return { ...target, value: url, ok: true, note: "no display — open it yourself" };

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

/** Where a command will run — a terminal by name, tmux, the background — before running it. */
type Route =
  | { kind: "terminal"; terminal: string }
  | { kind: "tmux" }
  | { kind: "zellij" }
  | { kind: "background"; reason?: string }
  | { kind: "inline" };

export function routeFor(
  target: SwitchTarget,
  context: Pick<Context, "environment" | "defaults" | "options" | "lazyPlatform">,
): Route {
  // A command that finishes is waited for where you can see it, and its result is the
  // point: it is attached however Wisp was asked to run.
  const mode = target.finishes ? "inline" : target.background ? "background" : (context.options.mode ?? "auto");
  if (mode === "background") return { kind: "background" };
  if (mode === "inline") return { kind: "inline" };

  const { environment } = context;
  const preference = target.openWith?.trim() || context.defaults.terminal?.trim();
  const multiplexer = (MULTIPLEXERS as readonly string[]).find((name) => name === preference?.toLowerCase());

  // Nothing chosen: Wisp keeps it. The command runs in the background with its output
  // kept, and the TUI shows it in a pane of its own — no window appears, and it carries
  // on after you close everything. Asked for a window, you get one.
  if (!preference && mode !== "terminal") return { kind: "background" };

  if (multiplexer === "tmux") return { kind: "tmux" };
  if (multiplexer === "zellij" && environment.multiplexer === "zellij") return { kind: "zellij" };

  const platform = context.lazyPlatform ?? getPlatform(environment.os);
  if (preference && !multiplexer && environment.gui) {
    const terminal = platform.findTerminal(preference);
    if (!terminal) {
      throw new WispError(
        `Wisp cannot drive "${preference}". Known terminals: ${[...platform.knownTerminals(), ...MULTIPLEXERS].join(", ")}`,
        "UNKNOWN_TERMINAL",
      );
    }
    return { kind: "terminal", terminal };
  }

  // A window was asked for — by --window, or a terminal chosen where there is no display:
  // the multiplexer you are in, then the terminal you are in, and failing those, the
  // background rather than nothing.
  if (environment.multiplexer) return { kind: environment.multiplexer };
  if (environment.gui) {
    const terminal = platform.defaultTerminal();
    if (terminal) return { kind: "terminal", terminal };
  }
  if (mode === "terminal") {
    throw new WispError("There is no display to open a terminal window on, and you are not in tmux", "NO_DISPLAY");
  }
  return { kind: "background", reason: "no display for a window — running in the background" };
}

function attached(step: PlannedStep, context: Context): boolean {
  if (step.target.kind === "compose") return true;
  if (step.target.kind !== "command") return false;
  try {
    return routeFor(step.target, context).kind === "inline";
  } catch {
    return false;
  }
}

function describeRoute(target: SwitchTarget, step: PlannedStep, context: Context): string {
  try {
    const route = routeFor(target, context);
    if (route.kind === "terminal") return `in ${route.terminal}`;
    if (route.kind === "background") return route.reason ?? "in the background";
    if (route.kind === "inline") return target.finishes ? `here, and waited for${target.timeout ? ` up to ${describeDuration(target.timeout)}` : ""}` : "here, attached";
    return `in a new ${route.kind} window`;
  } catch (error) {
    return describe(error);
  }
}

async function runCommand(step: PlannedStep, index: number, context: Context): Promise<TargetResult> {
  const { target, workspace } = step;
  const route = routeFor(target, context);

  // Check, then start, as one step: two runs of the same bolt at once (two terminals, a
  // double ⏎) would otherwise both see nothing running and both start the server. The
  // second waits for the first, then finds it up. Other commands never wait on this one.
  if (route.kind !== "inline" && !context.starting) {
    const key = createHash("sha1").update(`${workspace.file}\0${target.id}`).digest("hex").slice(0, 16);
    return withLock(join(stateDir(), "starting", key), () => runCommand(step, index, { ...context, starting: true }));
  }

  // A service that is already up stays up: starting "Database" again while Wisp's own
  // run of it is going would start a second one fighting the first for its port. A command
  // that finishes always runs — running it is the whole point.
  if (route.kind !== "inline") {
    const running = await runningFor(workspace.file, target.id);
    if (running) return { ...target, ok: true, run: running.id, note: `already running (${running.id})` };
  }

  const request = {
    command: target.value,
    ...(target.shell ? { shell: target.shell } : {}),
    ...(target.cwd ? { cwd: target.cwd } : {}),
    ...(target.env ? { env: target.env } : {}),
  };
  const title = target.workspace ? `${target.workspace}: ${target.label}` : target.label;
  const info = {
    label: target.label,
    command: target.value,
    ...(target.cwd ? { cwd: target.cwd } : {}),
    workspace: workspace.file,
    workspaceName: workspace.name,
    asset: target.id,
    bolt: step.bolt,
    ...(context.historyId ? { historyId: context.historyId } : {}),
  };

  if (route.kind === "inline") {
    const invocation = shellInvocation(request);
    if (context.options.runInline) {
      const code = await context.options.runInline(target, invocation);
      return code === 0 ? { ...target, ok: true } : { ...target, ok: false, error: `exited with code ${code}` };
    }
    const log = context.historyId ? await stepLogPath(context.historyId, index) : undefined;
    const { code, timedOut } = await runAttached(invocation, target, context, log);
    if (log) await trimLog(log).catch(() => false);
    const kept = log ? { log } : {};
    if (timedOut) return { ...target, ok: false, error: `ran over its ${describeDuration(target.timeout ?? 0)} timeout, so Wisp stopped it`, ...kept };
    return code === 0 ? { ...target, ok: true, ...kept } : { ...target, ok: false, error: `exited with code ${code}`, ...kept };
  }

  if (route.kind === "background") {
    const started = await startRun({ ...info, invocation: supervised(shellInvocation(request), target) });
    const note = [route.reason, `logs: wisp logs ${started.run.id}`].filter(Boolean).join(" · ");
    // Its log goes into History with the step, so a past run can show what it printed — for
    // as long as the log is kept (`wisp ps --clear` deletes finished runs' logs).
    const log = started.run.log ? { log: started.run.log } : {};
    return started.ok
      ? { ...target, ok: true, run: started.run.id, note, ...log }
      : { ...target, ok: false, run: started.run.id, error: started.error ?? "failed", ...log };
  }

  // A window: it reports its PID as it starts, so it can be found again, and stays open on
  // a failure so you can read why. Windows has no /bin/sh to wrap it in; there the shell
  // reports its own PID.
  const id = newRunId();
  const pidFile = await pidFileFor(id);
  const invocation =
    currentOS() === "win32"
      ? shellInvocation({ ...request, pidFile })
      : windowInvocation(supervised(shellInvocation(request), target), pidFile, target.label);

  if (route.kind === "tmux") {
    const inside = context.environment.multiplexer === "tmux";
    await recordWindowRun(id, pidFile, { ...info, where: inside ? `tmux window "${title}"` : "tmux session wisp" });
    const result = await runInTmux(invocation, title, inside);
    return { ...target, ok: true, run: id, ...(result.note ? { note: result.note } : {}) };
  }
  if (route.kind === "zellij") {
    await recordWindowRun(id, pidFile, { ...info, where: "zellij pane" });
    await runInZellij(invocation, title, context.environment.multiplexer === "zellij");
    return { ...target, ok: true, run: id };
  }

  await recordWindowRun(id, pidFile, { ...info, where: route.terminal });
  await platformOf(context).runInTerminal(invocation, { terminal: route.terminal, title });
  return { ...target, ok: true, run: id, note: `in ${route.terminal}` };
}

/**
 * Start or stop a compose file's services, attached: Compose prints its progress, and
 * `--wait` makes "done" mean healthy, not merely started — so whatever comes next can
 * rely on the database being there.
 */
async function runCompose(step: PlannedStep, index: number, context: Context): Promise<TargetResult> {
  const { target } = step;
  const compose = target.compose;
  if (!compose) return { ...target, ok: false, error: "nothing to do" };

  const args = compose.action === "up" ? composeUpArgs(compose.file, compose.services) : composeStopArgs(compose.file, compose.services);
  const log = context.historyId ? await stepLogPath(context.historyId, index) : undefined;
  const launch = { ...target, cwd: dirname(compose.file) };
  let code: number;
  try {
    code = (await runAttached({ file: "docker", args }, launch, context, log)).code;
    if (log) await trimLog(log).catch(() => false);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { ...target, ok: false, error: failure.code === "ENOENT" ? "Docker isn't installed" : describe(error) };
  }

  const kept = log ? { log } : {};
  if (code === 0) {
    return { ...target, ok: true, note: compose.action === "up" ? "up and healthy" : "stopped", ...kept };
  }
  // Compose's own words say why; the commonest reason gets a plainer one.
  const said = log ? await readTail(log) : "";
  const reason = /Cannot connect to the Docker daemon|docker daemon running|error during connect/i.test(said)
    ? "Docker isn't running — open Docker Desktop, then try again"
    : lastMeaningfulLine(said) ?? `docker compose exited with code ${code}`;
  return { ...target, ok: false, error: reason, ...kept };
}

async function readTail(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(file, "utf8").catch(() => "")).slice(-4000);
}

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").trim())
    .filter(Boolean)
    .pop();
}

/** The invocation, under its restart policy when it has one. */
function supervised(invocation: Invocation, target: SwitchTarget): Invocation {
  return target.restart && currentOS() !== "win32" ? restartLoop(invocation, target.restart, target.label) : invocation;
}

/**
 * A command attached to the caller: its output kept in the run's log, handed to
 * `onOutput`, and — when echoing — printed here too, with this terminal's keyboard.
 */
function runAttached(invocation: Invocation, target: SwitchTarget, context: Context, log?: string): Promise<{ code: number; timedOut: boolean }> {
  const echo = context.options.echo ?? false;
  if (context.options.signal?.aborted) return Promise.resolve({ code: 130, timedOut: false });
  return new Promise((resolvePromise, reject) => {
    const file = log ? createWriteStream(log, { flags: "a", mode: 0o600 }) : undefined;
    const child = spawn(invocation.file, invocation.args, {
      stdio: [echo ? "inherit" : "ignore", "pipe", "pipe"],
      // Not echoing means something else owns this terminal — the TUI. The command is
      // started interactively (`zsh -i`, for your PATH), and an interactive shell takes the
      // terminal it finds for its own; given one, it would push the TUI into the background
      // and the TUI would be stopped the moment it next read a key. In a session of its own
      // it has no terminal to take.
      detached: !echo,
      ...(target.cwd ? { cwd: target.cwd } : {}),
      // Piped output makes most tools drop their colours; on a terminal, ask for them back.
      env: echo && process.stdout.isTTY ? { ...process.env, FORCE_COLOR: process.env["FORCE_COLOR"] ?? "1" } : process.env,
      windowsHide: true,
    });

    const forward = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      file?.write(chunk);
      if (echo) stream.write(chunk);
      context.options.onOutput?.(target, chunk.toString("utf8"));
    };
    child.stdout?.on("data", forward(process.stdout));
    child.stderr?.on("data", forward(process.stderr));

    // Owned by this run: stopped with it, and with Wisp — never left behind unknown.
    attachedChildren.add(child);
    const stop = () => killTree(child, !echo);
    context.options.signal?.addEventListener("abort", stop, { once: true });

    let timedOut = false;
    let forced: NodeJS.Timeout | undefined;
    const limit =
      target.timeout && child.pid !== undefined
        ? setTimeout(() => {
            timedOut = true;
            const force = stopHung(child.pid as number);
            forced = setTimeout(() => {
              force();
              child.stdout?.destroy();
              child.stderr?.destroy();
            }, 5000);
          }, target.timeout * 1000)
        : undefined;
    child.once("exit", () => {
      if (!timedOut) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    const settle = () => {
      clearTimeout(limit);
      clearTimeout(forced);
      attachedChildren.delete(child);
      context.options.signal?.removeEventListener("abort", stop);
      file?.end();
    };

    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code, signal) => {
      settle();
      resolvePromise({ code: code ?? (signal ? 130 : 1), timedOut });
    });
  });
}

/** Commands running attached right now, to stop if Wisp itself goes. */
const attachedChildren = new Set<ReturnType<typeof spawn>>();

function killTree(child: ReturnType<typeof spawn>, ownGroup: boolean): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    // In a session of its own, the whole group: a shell running npm running next.
    if (ownGroup && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Stop every attached command — what Wisp does on its way out, so that quitting in the
 * middle of a build does not leave the build running where nobody can see it.
 */
export function stopAttached(): void {
  for (const child of attachedChildren) killTree(child, true);
}
process.once("exit", stopAttached);

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
export async function downBolt(
  workspace: Workspace,
  bolt: Bolt,
  options: { deps?: boolean; dryRun?: boolean; echo?: boolean; onResult?: (result: TargetResult) => void } = {},
  deps: RunDeps = {},
): Promise<DownResult> {
  const plan = options.deps
    ? await planBolt(workspace, bolt)
    : await planBolt(workspace, { ...bolt, steps: bolt.steps.filter((step) => step.kind !== "bolt") });

  const commands = plan.filter((step) => step.target.kind === "command");
  const runs = (await listRuns()).filter((run) => run.alive);
  const stopped = runs.filter((run) =>
    commands.some((step) => step.workspace.file === run.workspace && step.target.id === run.asset),
  );
  if (!options.dryRun) for (const run of stopped) stopRun(run);

  // Teardown: the compose services it started, then its `down` steps — this bolt's, and
  // with `deps`, each dependency's — once each.
  const owners = options.deps ? uniqueBolts(plan) : [{ workspace, bolt: bolt.label }];
  const teardownSteps: PlannedStep[] = plan
    .filter((step) => step.target.kind === "compose" && step.target.compose)
    .map((step) => ({ ...step, key: `${step.key}#stop`, deps: [], keepGoing: false, target: composeTarget(step.target.compose!, "stop") }));
  const stopping = teardownSteps.map((step) => step.key);
  for (const owner of owners) {
    const source = owner.workspace.bolts.find((entry) => entry.label === owner.bolt);
    if (!source?.down?.length) continue;
    const steps = await planBolt(owner.workspace, { ...source, steps: source.down.filter((step) => step.kind !== "bolt"), keepGoing: false });
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

async function boltsOf(workspace: Workspace, bolt: Bolt): Promise<Bolt[]> {
  const plan = await planBolt(workspace, bolt);
  const found = [bolt, ...uniqueBolts(plan).map((owner) => owner.workspace.bolts.find((entry) => entry.label === owner.bolt))];
  return [...new Set(found.filter((entry): entry is Bolt => entry !== undefined))];
}

export async function questionsFor(workspace: Workspace, bolt: Bolt, values: InputValues = {}): Promise<string[]> {
  const questions: string[] = [];
  for (const owner of await boltsOf(workspace, bolt)) {
    const question = owner.confirm ? fillText(owner.confirm, values) : undefined;
    if (question && !questions.includes(question)) questions.push(question);
  }
  return questions;
}

export async function inputsFor(workspace: Workspace, bolt: Bolt): Promise<InputSpec[]> {
  const specs: InputSpec[] = [];
  for (const owner of await boltsOf(workspace, bolt)) {
    for (const spec of owner.inputs ?? []) if (!specs.some((known) => known.name === spec.name)) specs.push(spec);
  }
  return specs;
}

function uniqueBolts(plan: PlannedStep[]): { workspace: Workspace; bolt: string }[] {
  const seen = new Map<string, { workspace: Workspace; bolt: string }>();
  for (const step of plan) seen.set(`${step.workspace.file}#${step.bolt}`, { workspace: step.workspace, bolt: step.bolt });
  return [...seen.values()];
}

/** How much of a bolt is up: its own commands, against what Wisp has running. */
export function boltStatus(
  workspace: Workspace,
  bolt: Bolt,
  runs: RunStatus[],
  containers: Container[] = [],
): { commands: number; running: number; failing: number } {
  const ids = new Set(
    bolt.steps.flatMap((step) => (step.kind === "asset" && step.id.startsWith("command:") ? [step.id] : [])),
  );
  const available = workspace.commands.filter((command) => ids.has(command.id) && !command.finishes);
  let commands = available.length;
  let running = available.filter((command) =>
    runs.some((run) => run.alive && run.workspace === workspace.file && run.asset === command.id),
  ).length;
  let failing = 0;

  // Containers count too: the services a compose step names, or all of its file's.
  for (const step of bolt.steps) {
    if (step.kind !== "compose" || !workspace.trusted) continue;
    const mine = containers.filter((container) => container.file === step.file && (!step.services?.length || step.services.includes(container.service)));
    const expected = step.services?.length ? step.services.length : Math.max(1, mine.length);
    commands += expected;
    running += mine.filter((container) => container.state === "running").length;
    failing += mine.filter((container) => container.health === "unhealthy" || (container.state === "exited" && container.exitCode !== 0)).length;
  }
  return { commands, running, failing };
}

export function keepsRunning(read: WorkspaceRead, bolt: Bolt): string[] {
  const ids = new Set(bolt.steps.flatMap((step) => (step.kind === "asset" && step.id.startsWith("command:") ? [step.id] : [])));
  return read.declaredCommands.filter((command) => ids.has(command.id) && !command.finishes).map((command) => command.label);
}

/** Every compose file a workspace's bolts start — what the TUI watches containers for. */
export function composeFiles(workspace: Workspace): string[] {
  if (!workspace.trusted) return [];
  return [...new Set(workspace.bolts.flatMap((bolt) => bolt.steps.flatMap((step) => (step.kind === "compose" ? [step.file] : []))))];
}

/**
 * A bolt named by any distinctive part of its label.
 *
 * Bolt labels are written to be read ("API development"), which makes them the worst
 * thing to type. One rule: an exact id or label wins, and otherwise the needle has to
 * be whole words of exactly one label. Not a prefix rule — bolts are named after jobs and jobs
 * cluster ("Work on core", "Work on the app"), so the distinguishing word is at the end.
 */
export function matchBolt(workspace: Workspace, ref: string): { bolt?: Bolt; candidates: Bolt[] } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { candidates: [] };

  const bolts = workspace.bolts;

  const exact =
    bolts.find((bolt) => bolt.id.toLowerCase() === needle) ??
    bolts.find((bolt) => bolt.label.toLowerCase() === needle);
  if (exact) return { bolt: exact, candidates: [exact] };

  // A slug is the label with its spaces punched out — the form a shell history hands back.
  const bySlug = bolts.filter((bolt) => slugify(bolt.label) === slugify(needle));
  if (bySlug.length === 1) return { bolt: bySlug[0] as Bolt, candidates: bySlug };

  const matches = bolts.filter((bolt) => hasWords(bolt.label, needle));
  if (matches.length === 1) return { bolt: matches[0] as Bolt, candidates: matches };

  return { candidates: matches };
}

export function findBolt(workspace: Workspace, ref: string): Bolt | undefined {
  return matchBolt(workspace, ref).bolt;
}

/** Like {@link findBolt}, but says what went wrong. */
export function resolveBolt(workspace: Workspace, ref: string): Bolt {
  const { bolt, candidates } = matchBolt(workspace, ref);
  if (bolt) return bolt;

  if (candidates.length > 1) {
    throw new WispError(
      `"${ref}" matches several bolts: ${candidates.map((match) => match.label).join(", ")}`,
      "AMBIGUOUS",
    );
  }

  if (workspace.bolts.length === 0) throw new WispError(`${workspace.name} has no bolts yet`, "NOT_FOUND");

  throw new WispError(
    `${workspace.name} has no bolt called "${ref}" — it has ${workspace.bolts.map((match) => match.label).join(", ")}`,
    "NOT_FOUND",
  );
}

/** The steps a bolt lists, without its needs — for showing a bolt rather than running it. */
export function collectBoltTargets(workspace: Workspace, bolt: Bolt): SwitchTarget[] {
  return listSteps(workspace, bolt.steps);
}

/** The same, for a bolt's `down` steps. */
export function collectDownTargets(workspace: Workspace, bolt: Bolt): SwitchTarget[] {
  return listSteps(workspace, bolt.down ?? []);
}

function listSteps(workspace: Workspace, steps: BoltStep[]): SwitchTarget[] {
  return stepTargets(workspace, steps).filter((target): target is SwitchTarget => target !== undefined);
}

export function stepTargets(workspace: Workspace, steps: BoltStep[]): (SwitchTarget | undefined)[] {
  const byId = new Map(collectTargets(workspace).map((target) => [target.id, target]));
  return steps.map((step) => {
    const target = listStep(step, byId, workspace)[0];
    return target ? { ...target, ...(step.name ? { name: step.name } : {}), ...(step.after && step.after.length > 0 ? { after: step.after } : {}) } : undefined;
  });
}

function listStep(step: BoltStep, byId: Map<string, SwitchTarget>, workspace: Workspace): SwitchTarget[] {
  return [step].flatMap((step): SwitchTarget[] => {
    if (step.kind === "wait") {
      return [{ kind: "wait", id: "wait", label: describeWait(step.wait), value: describeWait(step.wait), wait: step.wait }];
    }
    if (step.kind === "bolt") {
      return [{ kind: "bolt", id: `bolt:${step.bolt.toLowerCase()}`, label: step.bolt, value: step.bolt }];
    }
    if (step.kind === "compose") return workspace.trusted ? [composeTarget(step, "up")] : [];
    const target = byId.get(step.id);
    return target ? [target] : [];
  });
}

/** Every step's target a workspace holds, by kind: what a bolt's steps are looked up in. */
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

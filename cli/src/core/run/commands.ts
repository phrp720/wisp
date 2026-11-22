import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";

import { getPlatform } from "../../platform/index.js";
import { runInTmux, runInZellij } from "../../platform/multiplexer.js";
import { MULTIPLEXERS } from "../../platform/terminals.js";
import { describeDuration } from "../text/duration.js";
import { composeStopArgs, composeUpArgs } from "../system/docker.js";
import { WispError, describe } from "../errors.js";
import { stepLogPath } from "../history.js";
import { currentOS, stateDir, withLock } from "../paths.js";
import { newRunId, pidFileFor, recordWindowRun, runningFor, startRun, composeMarker, markStopped, stopHung, trimLog } from "../system/processes.js";
import { restartLoop, shellInvocation, windowInvocation } from "../system/shell.js";
import type { Invocation, SwitchTarget, TargetResult } from "../types.js";
import { type Context, platformOf, stoppedContainer } from "./context.js";
import type { PlannedStep } from "./plan.js";

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

export function attached(step: PlannedStep, context: Context): boolean {
  if (step.target.kind === "compose") return true;
  if (step.target.kind !== "command") return false;
  try {
    return routeFor(step.target, context).kind === "inline";
  } catch {
    return false;
  }
}

export function describeRoute(target: SwitchTarget, step: PlannedStep, context: Context): string {
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

export async function runCommand(step: PlannedStep, index: number, context: Context): Promise<TargetResult> {
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
export async function runCompose(step: PlannedStep, index: number, context: Context): Promise<TargetResult> {
  const { target } = step;
  const compose = target.compose;
  if (!compose) return { ...target, ok: false, error: "nothing to do" };

  if (compose.action === "up") context.composeFiles.add(compose.file);
  else markStopped(composeMarker(compose.file));
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
  if (compose.action === "up") {
    const by = await stoppedContainer(context, [compose.file]);
    if (by) return { ...target, ok: false, cancelled: true, error: `you stopped ${by}`, ...kept };
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

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { currentOS, readJson, stateDir, withLock, writeJson } from "./paths.js";
import { cleanOutput, stripAnsi } from "./ansi.js";
import { exitFileFor, recordExit, underTerminal } from "./shell.js";
import type { Invocation } from "./types.js";

/**
 * A command Wisp started and is keeping track of — in the background, or in a window.
 *
 * Without this a command is fire and forget: no way to see whether it is still up, no
 * way to stop it short of hunting for its PID, and running the bolt again starts a second
 * copy fighting the first for its port.
 */
export interface Run {
  /** Short and typeable: `wisp logs 3fa9`. */
  id: string;
  /** `background`: detached, output in `log`. `window`: a terminal or tmux window. */
  kind: "background" | "window";
  label: string;
  command: string;
  cwd?: string;
  /** The workspace file it came from, and the asset it was. */
  workspace: string;
  workspaceName: string;
  asset: string;
  /** The bolt that started it, for showing; `down` goes by asset. */
  bolt?: string;
  /** The run in history that started it. */
  historyId?: string;
  /** 0 until a window's shell has written its PID file. */
  pid: number;
  pidFile?: string;
  startedAt: string;
  /** Background runs only: a window's output is in the window. */
  log?: string;
  /** Where it went, for a window: "Ghostty", `tmux window "api"`. */
  where?: string;
  /** How it was started, for a background run, so it can be started again the same way. */
  invocation?: Invocation;
  /** Run under the `script` terminal shim, whose PID is the one recorded. */
  shim?: boolean;
}

export interface RunStatus extends Run {
  alive: boolean;
  /** How it ended, once it has: 0 finished, anything else failed. Unset: stopped, or unknown. */
  exitCode?: number;
}

/** How many finished runs to keep, logs included. Running ones are always kept. */
const KEEP_FINISHED = 30;

/** A window run with no PID yet is "starting" this long, then presumed never to have. */
const STARTING_MS = 20_000;

function runsFile(): string {
  return join(stateDir(), "runs.json");
}

function logsDir(): string {
  return join(stateDir(), "logs");
}

/** Twelve hex characters, like Docker's short container ids; any unique start of one names it. */
export function newRunId(): string {
  return randomBytes(6).toString("hex");
}

/** Where a window run's shell writes its PID. */
export async function pidFileFor(id: string): Promise<string> {
  await mkdir(logsDir(), { recursive: true });
  return join(logsDir(), `${id}.pid`);
}

export async function listRuns(): Promise<RunStatus[]> {
  const runs = await loadRuns();
  // One look for zombies across every run, rather than one per run.
  const pids = runs.map(pidOf).filter((pid) => signalable(pid));
  const dead = zombies(pids);
  return runs
    .map((run) => withStatus(run, dead))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** The run of this asset that is still going, if Wisp started one. */
export async function runningFor(workspace: string, asset: string): Promise<RunStatus | undefined> {
  return (await listRuns()).find((run) => run.alive && run.workspace === workspace && run.asset === asset);
}

/**
 * A run named by its id, its label, or any distinctive part of the label — the same rule
 * as everything else Wisp lets you name. Running runs win over finished ones.
 */
export function matchRun(query: string, runs: RunStatus[]): { match?: RunStatus; candidates: RunStatus[] } {
  const needle = query.trim().toLowerCase();
  const byId = runs.find((run) => run.id === needle);
  if (byId) return { match: byId, candidates: [byId] };
  // The start of an id, as Docker takes one: enough of it to be the only one.
  if (/^[0-9a-f]{3,}$/.test(needle)) {
    const started = runs.filter((run) => run.id.startsWith(needle));
    if (started.length === 1) return { match: started[0] as RunStatus, candidates: started };
  }

  for (const pool of [runs.filter((run) => run.alive), runs]) {
    const exact = pool.filter((run) => run.label.toLowerCase() === needle);
    if (exact.length >= 1) return { match: exact[0] as RunStatus, candidates: exact };
    const partial = pool.filter((run) => run.label.toLowerCase().includes(needle));
    if (partial.length === 1) return { match: partial[0] as RunStatus, candidates: partial };
    if (partial.length > 1) return { candidates: partial };
  }
  return { candidates: [] };
}

export interface RunInfo {
  label: string;
  command: string;
  cwd?: string;
  workspace: string;
  workspaceName: string;
  asset: string;
  bolt?: string;
  /** The run in history that started it — how the Running list says "#4". */
  historyId?: string;
}

export interface StartRequest extends RunInfo {
  invocation: Invocation;
  /** How long to watch for an immediate failure before calling it started. */
  graceMs?: number;
}

export interface StartResult {
  ok: boolean;
  run: Run;
  /** The end of the log, when it failed straight away. */
  error?: string;
}

/**
 * Start a command detached, with its output going to a log file, and remember it.
 *
 * Watched for a moment first: a command still running after the grace period is a server,
 * and is left to run; one that exits non-zero inside it failed, and says why.
 */
export async function startRun(request: StartRequest): Promise<StartResult> {
  await mkdir(logsDir(), { recursive: true });
  const id = newRunId();
  const log = join(logsDir(), `${id}.log`);
  const handle = await open(log, "a");

  // Under a terminal, so it writes what you would see in one: colours and all. And with
  // its exit code kept, so "it finished" and "it crashed" can be told apart afterwards.
  const recorded = currentOS() === "win32" ? request.invocation : recordExit(request.invocation, exitFileFor(log));
  const shimmed = underTerminal(recorded);
  const child = spawn(shimmed.file, shimmed.args, {
    detached: true,
    stdio: ["ignore", handle.fd, handle.fd],
    windowsHide: true,
    env: { ...process.env, TERM: process.env["TERM"] && process.env["TERM"] !== "dumb" ? process.env["TERM"] : "xterm-256color" },
    ...(request.cwd ? { cwd: request.cwd } : {}),
  });

  // Listen before awaiting anything else: `spawn` fires on the next tick, and a listener
  // attached after an await would miss it and wait forever.
  const started = new Promise<number>((resolve, reject) => {
    child.once("spawn", () => resolve(child.pid ?? 0));
    child.once("error", reject);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));

  const pid = await started
    .catch((error: unknown) => {
      throw new Error(`could not start ${request.invocation.file}: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => handle.close());

  const run: Run = {
    ...info(request),
    id,
    kind: "background",
    pid,
    startedAt: new Date().toISOString(),
    log,
    invocation: request.invocation,
    ...(shimmed !== request.invocation ? { shim: true } : {}),
  };
  await saveRun(run);

  let grace: NodeJS.Timeout | undefined;
  const code = await Promise.race([
    exited,
    new Promise<"running">((resolve) => {
      grace = setTimeout(() => resolve("running"), request.graceMs ?? 1500);
    }),
  ]);
  clearTimeout(grace);
  child.unref();

  if (code === "running" || code === 0) return { ok: true, run };
  // Cleaned: under a terminal the log is full of carriage returns and escape codes.
  const said = stripAnsi(cleanOutput(await tail(log, 20))).trim();
  return { ok: false, run, error: said || `exited with code ${code ?? "unknown"}` };
}

/**
 * Remember a command handed to a window. Its shell writes its PID to `pidFile` as the
 * first thing it does, which is how Wisp finds it again.
 */
export async function recordWindowRun(id: string, pidFile: string, request: RunInfo & { where: string }): Promise<Run> {
  const run: Run = { ...info(request), id, kind: "window", pid: 0, pidFile, startedAt: new Date().toISOString(), where: request.where };
  await saveRun(run);
  return run;
}

function info(request: RunInfo): RunInfo {
  return {
    label: request.label,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    workspace: request.workspace,
    workspaceName: request.workspaceName,
    asset: request.asset,
    ...(request.bolt ? { bolt: request.bolt } : {}),
    ...(request.historyId ? { historyId: request.historyId } : {}),
  };
}

/**
 * Stop a run and everything it started.
 *
 * The whole process group, not just the shell: `pnpm dev` is a shell running pnpm running
 * node, and killing only the shell leaves the server holding its port.
 */
export function stopRun(run: Run): boolean {
  const pid = pidOf(run);
  if (!pid || !isAlive(pid)) return false;
  return stopTree(pid, run.shim ?? false);
}

/**
 * Stop a process and everything under it — at once.
 *
 * Not by asking the top of the tree to pass it on: Linux's `script`, asked to stop, says
 * "killing shell…" and waits two seconds first, holding the port the whole time. And not
 * by process group alone: a command under a terminal shim is in a session of its own, and
 * a dev server's workers can be in theirs. So every descendant is found and signalled,
 * deepest first, then the top.
 */
export function stopTree(pid: number, shim = false): boolean {
  if (currentOS() === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return result.status === 0;
  }

  const tree = descendants(pid);
  const own = ownGroup();
  const groups = new Set(tree.map((entry) => entry.pgid).filter((pgid) => pgid > 1 && pgid !== own));
  for (const entry of [...tree].reverse()) signal(entry.pid);
  for (const pgid of groups) signal(-pgid);
  // The shim has nothing of its own to save, and Linux's waits two seconds before it goes —
  // with the command under it already stopped, it is ended outright.
  const stopped = shim ? signal(pid, "SIGKILL") : signal(-pid) || signal(pid);
  return stopped || tree.length > 0;
}

function signal(target: number, kind: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(target, kind);
    return true;
  } catch {
    return false;
  }
}

/** Every process below `pid`, parents before children — from one look at the process table. */
export function descendants(pid: number): { pid: number; pgid: number }[] {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }).stdout ?? "";
  const rows = parseProcessTable(table);
  const found: { pid: number; pgid: number }[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const row of rows) {
      if (row.ppid === parent && !found.some((entry) => entry.pid === row.pid)) {
        found.push({ pid: row.pid, pgid: row.pgid });
        queue.push(row.pid);
      }
    }
  }
  return found;
}

export function parseProcessTable(output: string): { pid: number; ppid: number; pgid: number }[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : [];
  });
}

/** Wisp's own process group, which must never be signalled along with a run's. */
let ownPgid: number | undefined;
function ownGroup(): number {
  if (ownPgid === undefined) {
    const out = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout ?? "";
    ownPgid = Number.parseInt(out.trim(), 10) || 0;
  }
  return ownPgid;
}

/**
 * Start a background run again, the same way: stopped first if it is still going, then
 * started fresh with a new id. Window runs belong to their window, and cannot be.
 */
export async function restartRun(run: RunStatus): Promise<StartResult> {
  if (!run.invocation) throw new Error(`${run.label} runs in ${run.where ?? "a window"} — restart it there`);
  if (run.alive) {
    stopRun(run);
    // A moment for it to let go of its port.
    for (let waited = 0; waited < 3000 && isAlive(run.pid); waited += 100) await new Promise((done) => setTimeout(done, 100));
  }
  return startRun({
    label: run.label,
    command: run.command,
    ...(run.cwd ? { cwd: run.cwd } : {}),
    workspace: run.workspace,
    workspaceName: run.workspaceName,
    asset: run.asset,
    ...(run.bolt ? { bolt: run.bolt } : {}),
    ...(run.historyId ? { historyId: run.historyId } : {}),
    invocation: run.invocation,
  });
}

/** Forget finished runs and delete their logs. Returns how many went. */
export async function clearFinishedRuns(): Promise<number> {
  return withLock(runsFile(), async () => {
    const runs = (await loadRuns()).map((run) => withStatus(run));
    const finished = runs.filter((run) => !run.alive);
    await Promise.all(finished.map(removeFiles));
    await writeJson(runsFile(), { version: 2, runs: runs.filter((run) => run.alive).map(strip) });
    return finished.length;
  });
}

/**
 * The last lines of a log — read from its end, since a dev server's log grows for days and
 * the TUI asks for it twice a second.
 */
export async function tail(file: string | undefined, lines: number, maxBytes = 256 * 1024): Promise<string> {
  if (!file) return "";
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // Started mid-file, the first line is probably partial: drop it.
    const all = text.split(/\r?\n/);
    if (length < size) all.shift();
    return all.slice(-lines - 1).join("\n");
  } finally {
    await handle.close();
  }
}

/** Bytes a log has grown to, for following it. */
export async function logSize(file: string): Promise<number> {
  return (await stat(file).catch(() => undefined))?.size ?? 0;
}

export function isAlive(pid: number): boolean {
  if (!signalable(pid)) return false;
  return !zombies([pid]).has(pid);
}

function signalable(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Which of these processes have exited but not been collected by their parent — zombies.
 * They still answer a signal, so without this a server that died under a parent that is
 * suspended, or busy, looks like it is running for as long as that parent lives.
 */
export function zombies(pids: number[]): Set<number> {
  const found = new Set<number>();
  if (pids.length === 0 || currentOS() === "win32") return found;

  if (currentOS() === "linux") {
    for (const pid of pids) {
      try {
        // The state is the field after the parenthesised name, which may itself hold spaces.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") found.add(pid);
      } catch {
        // Gone between the signal and the read: not a zombie, just gone.
      }
    }
    return found;
  }

  const result = spawnSync("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], { encoding: "utf8" });
  for (const [pid, stat] of parsePsStates(result.stdout ?? "")) if (stat.startsWith("Z")) found.add(pid);
  return found;
}

/** `ps -o pid=,stat=` output as pid and state. */
export function parsePsStates(output: string): [number, string][] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    return match ? [[Number(match[1]), match[2] as string] as [number, string]] : [];
  });
}

/** A run's PID: recorded, or — for a window — read from the file its shell wrote. */
function pidOf(run: Run): number {
  if (run.pid) return run.pid;
  if (!run.pidFile) return 0;
  try {
    const pid = Number.parseInt(readFileSync(run.pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** The exit code a finished background run left beside its log, if it left one. */
function exitCodeOf(run: Run): number | undefined {
  if (run.kind !== "background" || !run.log) return undefined;
  try {
    const code = Number.parseInt(readFileSync(exitFileFor(run.log), "utf8").trim(), 10);
    return Number.isInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function withStatus(run: Run, dead?: Set<number>): RunStatus {
  const pid = pidOf(run);
  if (pid) {
    const alive = dead ? signalable(pid) && !dead.has(pid) : isAlive(pid);
    const exitCode = alive ? undefined : exitCodeOf(run);
    return { ...run, pid, alive, ...(exitCode === undefined ? {} : { exitCode }) };
  }
  // A window that has not reported in yet is starting, for a while; then it never will.
  const starting = Date.now() - Date.parse(run.startedAt) < STARTING_MS;
  return { ...run, alive: run.kind === "window" && starting };
}

function strip(run: RunStatus): Run {
  const { alive: _alive, exitCode: _exitCode, ...rest } = run;
  return rest;
}

async function removeFiles(run: Run): Promise<void> {
  const files = [run.log, run.log ? exitFileFor(run.log) : undefined, run.pidFile];
  await Promise.all(files.filter((file): file is string => Boolean(file)).map((file) => rm(file, { force: true })));
}

async function saveRun(run: Run): Promise<void> {
  await withLock(runsFile(), async () => {
    const runs = (await loadRuns()).map((run) => withStatus(run));
    const alive = runs.filter((entry) => entry.alive);
    const finished = runs.filter((entry) => !entry.alive);
    await Promise.all(finished.slice(KEEP_FINISHED).map(removeFiles));
    await writeJson(runsFile(), { version: 2, runs: [run, ...alive.map(strip), ...finished.slice(0, KEEP_FINISHED).map(strip)] });
  });
}

async function loadRuns(): Promise<Run[]> {
  const parsed = await readJson(runsFile()).catch(() => undefined);
  const list = (parsed as { runs?: unknown } | undefined)?.runs;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is Run =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Run).id === "string" &&
        typeof (entry as Run).pid === "number",
    )
    .map((entry) => ({ ...entry, kind: entry.kind ?? "background" }));
}

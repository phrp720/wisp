import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { currentOS, privateDir, readJson, stateDir, withLock, writeJson } from "./paths.js";
import { cleanOutput, stripAnsi } from "./ansi.js";
import { listHistory } from "./history.js";
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
  /** The question it seems to be waiting on: gone quiet, its last line asking something. */
  waiting?: string;
}

/** How long a command must have been quiet before a question-like last line counts. */
const QUIET_MS = 3000;

/**
 * Whether output ends on a question: "? ", "(y/n)", "[Y/n]", or a prompt for a password,
 * token or code. Returns that last line, or nothing.
 */
export function questionIn(output: string): string | undefined {
  // Played out as a terminal would show it (progress bars, backspaces), then as plain text.
  const lines = stripAnsi(cleanOutput(output)).split("\n").map((line) => line.trim());
  const last = [...lines].reverse().find((line) => line.length > 0);
  if (!last || last.length > 200) return undefined;
  const asks =
    /\?\s*(\[[^\]]{1,12}\]|\([^)]{1,12}\))?\s*:?$/.test(last) ||
    /[[(]\s*(y\/n|yes\/no)\s*[\])]/i.test(last) ||
    /\b(password|passphrase|token|code|otp|pin)\b[^:]{0,40}:$/i.test(last);
  return asks ? last : undefined;
}

/** The question a running background command is waiting on, judged from the end of its log. */
function waitingOn(run: Run): string | undefined {
  if (run.kind !== "background" || !run.log) return undefined;
  try {
    const { mtimeMs, size } = statSync(run.log);
    if (Date.now() - mtimeMs < QUIET_MS || size === 0) return undefined;
    const length = Math.min(size, 2048);
    const buffer = Buffer.alloc(length);
    const fd = openSync(run.log, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return questionIn(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * How many finished runs Running lists (`o`). Running ones are always listed. Their output
 * is kept longer: for as long as a run in History points to it (see `tidyState`).
 */
export const KEEP_FINISHED = 30;

/** The most one log grows to before its oldest part goes, and how much of its end stays then. */
export const LOG_CAP = 10 * 1024 * 1024;
export const LOG_KEEP = 5 * 1024 * 1024;

/** The most everything Wisp keeps of what it ran (command logs, History's output) takes together. */
export const STATE_CEILING = 500 * 1024 * 1024;

/** A log this new may be one another Wisp is just starting a command with: left alone. */
const NEW_FILE_MS = 10 * 60_000;

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
  await privateDir(logsDir());
  return join(logsDir(), `${id}.pid`);
}

export async function listRuns(): Promise<RunStatus[]> {
  const runs = await loadRuns();
  // One look at the process table across every run, rather than one per run.
  const facts = processFacts(runs.map(pidOf).filter((pid) => signalable(pid)));
  const listed = runs.map((run) => withStatus(run, facts)).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  // A running command's log is only ever appended to: held to its cap here, since Wisp is
  // asked about runs often (the dashboard every second or two, any `wisp` command).
  await Promise.all(listed.map((run) => (run.alive && run.log ? trimLog(run.log).catch(() => false) : false)));
  return listed;
}

/**
 * Keep a log to `cap`: past it, only its last `keep` bytes stay, from a whole line on, under
 * a line saying so. Done in place, as `logrotate`'s copytruncate does: the command writing
 * to it keeps its file, and appends after what stayed. A few lines written at that very
 * moment can be lost, which is the price of never stopping the command.
 */
export async function trimLog(file: string, cap = LOG_CAP, keep = LOG_KEEP): Promise<boolean> {
  const size = (await stat(file).catch(() => undefined))?.size ?? 0;
  if (size <= cap) return false;
  const handle = await open(file, "r+");
  try {
    const buffer = Buffer.alloc(Math.min(keep, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    const kept = buffer.subarray(0, bytesRead);
    const from = kept.indexOf(0x0a) + 1;
    const note = Buffer.from(`[wisp] earlier output trimmed: a log is kept to its last ${Math.round(keep / 1024 / 1024)} MB\n`);
    const body = Buffer.concat([note, from > 0 && from < kept.length ? kept.subarray(from) : kept]);
    await handle.write(body, 0, body.length, 0);
    await handle.truncate(body.length);
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Delete what Wisp no longer needs of what it ran, so nothing piles up:
 *
 * - a command's log once nothing points to it: neither Running's list (`runs.json`, the
 *   ones running and the last finished ones) nor any run History keeps (the last 200). A
 *   run in History shows its output for as long as it is listed there.
 * - then, past `ceiling` (500 MB) for all of it together, the oldest output first: a
 *   run's step logs in History, or a finished command's log. Never a running command's.
 *
 * A file newer than ten minutes that nothing points to yet is left alone: another Wisp may
 * be starting a command with it. Returns the files it deleted.
 */
export async function tidyState(options: { ceiling?: number; newFileMs?: number; now?: number } = {}): Promise<string[]> {
  const ceiling = options.ceiling ?? STATE_CEILING;
  const fresh = options.newFileMs ?? NEW_FILE_MS;
  const now = options.now ?? Date.now();
  const runs = await listRuns();
  const history = await listHistory().catch(() => []);
  const listed = new Set(runs.map((run) => run.id));
  const running = new Set(runs.filter((run) => run.alive).map((run) => run.id));
  const pointedTo = new Set(history.flatMap((entry) => entry.steps.flatMap((step) => (step.log ? [step.log] : []))));
  const removed: string[] = [];
  const remove = async (files: string[]) => {
    await Promise.all(files.map((file) => rm(file, { recursive: true, force: true })));
    removed.push(...files);
  };
  const newest = async (files: string[]) => Math.max(0, ...(await Promise.all(files.map(async (file) => (await stat(file).catch(() => undefined))?.mtimeMs ?? 0))));

  // Command logs come as <id>.log, with <id>.exit and <id>.pid beside them.
  const byRun = new Map<string, string[]>();
  for (const name of await readdir(logsDir()).catch(() => [] as string[])) {
    const id = name.split(".")[0] as string;
    byRun.set(id, [...(byRun.get(id) ?? []), join(logsDir(), name)]);
  }
  for (const [id, files] of byRun) {
    if (listed.has(id) || pointedTo.has(join(logsDir(), `${id}.log`))) continue;
    if (now - (await newest(files)) < fresh) continue;
    byRun.delete(id);
    await remove(files);
  }
  // History's own output, a folder a run: one that History no longer lists is left over.
  const historyDir = join(stateDir(), "history");
  const kept = new Set(history.map((entry) => entry.id));
  const folders = await readdir(historyDir).catch(() => [] as string[]);
  for (const id of folders.filter((name) => !kept.has(name))) {
    const folder = join(historyDir, id);
    // Its files' age, not the folder's: writing a file inside makes the folder look new.
    const inside = (await readdir(folder).catch(() => [] as string[])).map((name) => join(folder, name));
    if (now - (await newest(inside)) >= fresh) await remove([folder]);
  }

  // Past the ceiling: the oldest output goes first, until it is back under it.
  const files: { file: string; size: number; at: number }[] = [];
  const add = async (file: string) => {
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) files.push({ file, size: info.size, at: info.mtimeMs });
  };
  let total = 0;
  for (const [id, group] of byRun) {
    for (const file of group) {
      const info = await stat(file).catch(() => undefined);
      total += info?.size ?? 0;
      if (!running.has(id) && file.endsWith(".log")) await add(file);
    }
  }
  for (const id of folders.filter((name) => kept.has(name))) {
    for (const name of await readdir(join(historyDir, id)).catch(() => [] as string[])) {
      const file = join(historyDir, id, name);
      const before = files.length;
      await add(file);
      total += files.length > before ? (files[files.length - 1] as { size: number }).size : 0;
    }
  }
  if (total <= ceiling) return removed;
  for (const entry of files.sort((left, right) => left.at - right.at)) {
    if (total <= ceiling) break;
    await remove([entry.file]);
    total -= entry.size;
  }
  return removed;
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
  await privateDir(logsDir());
  const id = newRunId();
  const log = join(logsDir(), `${id}.log`);
  const handle = await open(log, "a", 0o600);

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
  if (!pid || !withStatus(run).alive) return false;
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

export function stopHung(pid: number): () => void {
  if (currentOS() === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return () => undefined;
  }
  signal(pid, "SIGSTOP");
  const tree = descendants(pid);
  const own = ownGroup();
  const groups = new Set(tree.map((entry) => entry.pgid).filter((pgid) => pgid > 1 && pgid !== own && pgid !== pid));
  signal(pid, "SIGKILL");
  for (const entry of [...tree].reverse()) signal(entry.pid);
  for (const pgid of groups) signal(-pgid);
  return () => {
    for (const entry of tree) signal(entry.pid, "SIGKILL");
    for (const pgid of groups) signal(-pgid, "SIGKILL");
  };
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
  return !processFacts([pid]).get(pid)?.zombie;
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

export interface ProcessFacts {
  zombie: boolean;
  startedMs?: number;
}

/**
 * Which of these processes have exited but not been collected by their parent — zombies.
 * They still answer a signal, so without this a server that died under a parent that is
 * suspended, or busy, looks like it is running for as long as that parent lives.
 */
export function processFacts(pids: number[], now = Date.now()): Map<number, ProcessFacts> {
  const facts = new Map<number, ProcessFacts>();
  if (pids.length === 0 || currentOS() === "win32") return facts;

  if (currentOS() === "linux") {
    const boot = bootTimeMs();
    for (const pid of pids) {
      try {
        // The state is the field after the parenthesised name, which may itself hold spaces.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[19]);
        facts.set(pid, { zombie: fields[0] === "Z", ...(boot !== undefined && Number.isFinite(ticks) ? { startedMs: boot + ticks * 10 } : {}) });
      } catch {
        // Gone between the signal and the read: not a zombie, just gone.
      }
    }
    return facts;
  }

  const result = spawnSync("ps", ["-o", "pid=,stat=,etime=", "-p", pids.join(",")], { encoding: "utf8" });
  for (const entry of parsePs(result.stdout ?? "")) {
    facts.set(entry.pid, { zombie: entry.stat.startsWith("Z"), ...(entry.elapsed !== undefined ? { startedMs: now - entry.elapsed * 1000 } : {}) });
  }
  return facts;
}

let bootTime: number | undefined;
function bootTimeMs(): number | undefined {
  if (bootTime !== undefined) return bootTime;
  try {
    const line = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    bootTime = line ? Number(line[1]) * 1000 : undefined;
  } catch {
    bootTime = undefined;
  }
  return bootTime;
}

export function parsePs(output: string): { pid: number; stat: string; elapsed?: number }[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)(?:\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+))?\s*$/.exec(line);
    if (!match) return [];
    const [, pid, stat, days, hours, minutes, seconds] = match;
    const elapsed = seconds === undefined ? undefined : Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    return [{ pid: Number(pid), stat: stat as string, ...(elapsed === undefined ? {} : { elapsed }) }];
  });
}

const SAME_START_MS = 60_000;

function sameProcess(run: Run, facts: ProcessFacts | undefined): boolean {
  const recorded = Date.parse(run.startedAt);
  if (facts?.startedMs === undefined || !Number.isFinite(recorded)) return true;
  return Math.abs(facts.startedMs - recorded) <= SAME_START_MS;
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

function withStatus(run: Run, facts?: Map<number, ProcessFacts>): RunStatus {
  const pid = pidOf(run);
  if (pid) {
    const known = signalable(pid) ? (facts ?? processFacts([pid])).get(pid) : undefined;
    const alive = signalable(pid) && !known?.zombie && sameProcess(run, known);
    const exitCode = alive ? undefined : exitCodeOf(run);
    const waiting = alive ? waitingOn(run) : undefined;
    return { ...run, pid, alive, ...(exitCode === undefined ? {} : { exitCode }), ...(waiting ? { waiting } : {}) };
  }
  // A window that has not reported in yet is starting, for a while; then it never will.
  const starting = Date.now() - Date.parse(run.startedAt) < STARTING_MS;
  return { ...run, alive: run.kind === "window" && starting };
}

function strip(run: RunStatus): Run {
  const { alive: _alive, exitCode: _exitCode, waiting: _waiting, ...rest } = run;
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
    await writeJson(runsFile(), { version: 2, runs: [run, ...alive.map(strip), ...finished.slice(0, KEEP_FINISHED).map(strip)] });
  });
  // The runs that dropped off the list keep their logs while History points to them.
  await tidyState().catch(() => undefined);
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

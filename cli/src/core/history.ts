import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { readJson, stateDir, withLock, writeJson } from "./paths.js";
import type { StepKind } from "./types.js";

/** One step of a past run, as it went. */
export interface HistoryStep {
  kind: StepKind;
  label: string;
  value: string;
  /** The workspace a dependency brought it from, when not the run's own. */
  workspace?: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  note?: string;
  durationMs: number;
  /** What an attached command printed. Commands in windows keep their output there. */
  log?: string;
  /** The bolt it belongs to, when a dependency brought it in — drawn as one group. */
  bolt?: string;
}

/**
 * A run of a bolt, kept so "did last night's build pass, and what did the tests print?"
 * has an answer. Every real run is kept — jobs most of all, since that is their point.
 */
export interface HistoryEntry {
  id: string;
  workspace: string;
  workspaceName: string;
  bolt: string;
  job: boolean;
  /** What started it: "tui", "cli", "hook", "retry" — the "triggered by" of a CI run. */
  trigger?: string;
  /** The code it ran against, when the project is a git repository. */
  git?: { branch: string; commit: string; subject?: string };
  /** Which run of this bolt it was, counting from one: "Check #7". */
  number?: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: HistoryStep[];
  running?: boolean;
  interrupted?: boolean;
  pid?: number;
  total?: number;
}

/** Enough to see a pattern of failures, not so many that the logs pile up. */
const KEEP = 200;

function historyFile(): string {
  return join(stateDir(), "history.json");
}

/** Twelve hex characters, like a run's; any unique start of one names it. */
export function newHistoryId(): string {
  return randomBytes(6).toString("hex");
}

/** Where step `index` of run `id` writes its output. */
export async function stepLogPath(id: string, index: number): Promise<string> {
  const dir = join(stateDir(), "history", id);
  await mkdir(dir, { recursive: true });
  return join(dir, `${index + 1}.log`);
}

export async function recordHistory(entry: HistoryEntry): Promise<void> {
  await withLock(historyFile(), async () => {
    const entries = await loadHistory();
    // Numbered per bolt, as a CI numbers a workflow's runs — kept with the run, so the
    // number stays the same when older runs are cleared.
    const label = baseLabel(entry.bolt);
    const same = entries.find((other) => other.id === entry.id);
    const previous = entries.filter((other) => other.workspace === entry.workspace && baseLabel(other.bolt) === label && other.id !== entry.id);
    const number = entry.number ?? same?.number ?? Math.max(previous.length, ...previous.map((other) => other.number ?? 0)) + 1;
    const kept = [{ ...entry, number }, ...entries.filter((other) => other.id !== entry.id)];
    await Promise.all(kept.slice(KEEP).map((old) => rm(join(stateDir(), "history", old.id), { recursive: true, force: true })));
    await writeJson(historyFile(), { version: 1, runs: kept.slice(0, KEEP) });
  });
}

/** Past runs, newest first — of one workspace, or one bolt, when asked. */
export async function listHistory(filter: { workspace?: string; bolt?: string } = {}): Promise<HistoryEntry[]> {
  const needle = filter.bolt?.trim().toLowerCase();
  return (await loadHistory()).filter(
    (entry) =>
      (!filter.workspace || entry.workspace === filter.workspace) &&
      (!needle || entry.bolt.toLowerCase().includes(needle)),
  );
}

export async function forgetHistory(filter: { ids?: string[]; workspace?: string; bolt?: string }): Promise<{ removed: HistoryEntry[]; running: HistoryEntry[] }> {
  const ids = filter.ids ? new Set(filter.ids) : undefined;
  const bolt = filter.bolt?.toLowerCase();
  const matches = (entry: HistoryEntry) =>
    (!ids || ids.has(entry.id)) &&
    (!filter.workspace || entry.workspace === filter.workspace) &&
    (!bolt || baseLabel(entry.bolt).toLowerCase() === bolt);
  return withLock(historyFile(), async () => {
    const entries = await loadHistory();
    const chosen = entries.filter(matches);
    const running = chosen.filter((entry) => entry.running);
    const removed = chosen.filter((entry) => !entry.running);
    if (removed.length === 0) return { removed, running };
    const gone = new Set(removed.map((entry) => entry.id));
    await writeJson(historyFile(), { version: 1, runs: entries.filter((entry) => !gone.has(entry.id)) });
    await Promise.all(removed.map((entry) => rm(join(stateDir(), "history", entry.id), { recursive: true, force: true })));
    return { removed, running };
  });
}

export async function getHistory(id: string): Promise<HistoryEntry | undefined> {
  const needle = id.trim().toLowerCase();
  const entries = await loadHistory();
  const exact = entries.find((entry) => entry.id === needle);
  if (exact) return exact;
  // The start of an id, enough of it to be the only one.
  const started = needle.length >= 3 ? entries.filter((entry) => entry.id.startsWith(needle)) : [];
  return started.length === 1 ? started[0] : undefined;
}

async function loadHistory(): Promise<HistoryEntry[]> {
  const parsed = await readJson(historyFile()).catch(() => undefined);
  const runs = (parsed as { runs?: unknown } | undefined)?.runs;
  if (!Array.isArray(runs)) return [];
  const entries = runs.filter(
    (entry): entry is HistoryEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as HistoryEntry).id === "string" && Array.isArray((entry as HistoryEntry).steps),
  );
  // Runs from before numbering get numbers by their order, oldest first, so no run reads "#?".
  const counts = new Map<string, number>();
  for (const entry of [...entries].reverse()) {
    const key = `${entry.workspace}#${baseLabel(entry.bolt)}`;
    const next = Math.max((counts.get(key) ?? 0) + 1, entry.number ?? 0);
    counts.set(key, next);
    if (entry.number === undefined) entry.number = next;
  }
  for (const entry of entries) {
    if (entry.running && !(entry.pid && alive(entry.pid))) {
      delete entry.running;
      entry.interrupted = true;
      entry.ok = false;
    }
  }
  return entries;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** The branch and short commit of a directory, or nothing when it is not a repository. */
/** "Check (retry)" is a run of Check. */
export function baseLabel(label: string): string {
  return label.replace(/ \((retry|down)\)$/, "");
}

export async function gitState(dir: string): Promise<{ branch: string; commit: string; subject?: string } | undefined> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const [branch, commit, subject] = await Promise.all([
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeout: 2000 }),
      run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, timeout: 2000 }),
      run("git", ["log", "-1", "--format=%s"], { cwd: dir, timeout: 2000 }).catch(() => ({ stdout: "" })),
    ]);
    const message = subject.stdout.trim();
    return { branch: branch.stdout.trim(), commit: commit.stdout.trim(), ...(message ? { subject: message } : {}) };
  } catch {
    return undefined;
  }
}

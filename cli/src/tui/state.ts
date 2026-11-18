/** What the TUI's screens share: its views, a run in progress, the Running list's items, and small helpers. */

import { useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Container } from "../core/docker.js";
import type { HistoryEntry, HistoryStep } from "../core/history.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import type { StepKind, SwitchResult, SwitchTarget, TargetResult, WorkspaceRead } from "../core/types.js";
import { describeWait } from "../core/wait.js";
import { type SetupSuggestion } from "./model.js";

export type Focus = "workspaces" | "bolts";

export interface StepState {
  target: SwitchTarget;
  state: "pending" | "running" | "done";
  result?: TargetResult;
}

export type View =
  | { kind: "browse" }
  | { kind: "search"; query: string; index: number }
  | { kind: "run" }
  | { kind: "check"; read?: WorkspaceRead; scroll: number }
  /** `then`: the bolt you pressed ⏎ on, run as soon as you say yes. */
  | { kind: "trust"; read: WorkspaceRead; then?: string }
  | {
      kind: "processes";
      index: number;
      all: boolean;
      /** Lines scrolled back from the end of the pane; 0 follows it as it grows. */
      scroll: number;
      /** The pane fills the screen, without the list. */
      full: boolean;
      /** A run to open on, once it shows up in the list. */
      focus?: string;
      /** Narrows the list to what matches; `typing` while it is being written. */
      query?: string;
      typing?: boolean;
    }
  | { kind: "help" }
  | { kind: "history" }
  /** `adding`: straight to choosing its first step — a bolt was just made. */
  | { kind: "editor"; file: string; bolt: string; adding?: boolean }
  | { kind: "new-bolt"; file: string; workspace: string }
  | { kind: "new-workspace" }
  | { kind: "delete-bolt"; file: string; bolt: string }
  | { kind: "delete-workspace"; file: string; name: string; personal: boolean }
  | { kind: "view"; file: string; bolt: string }
  /** Your own settings: the app for folders and files, where commands run. */
  | { kind: "settings" }
  /** Stopping a bolt that needed others: those too, or only it? */
  | { kind: "stop-bolt"; file: string; bolt: string; needs: string[]; sharedWith: string[] }
  | { kind: "setup"; suggestion: SetupSuggestion };

/** Views that read the keyboard themselves: forms, the editor, confirmations. */
/**
 * Whether each screen takes its own keys. While one does, the dashboard behind it hears
 * nothing: otherwise a dialog's ⏎ or ← would also run or move things underneath it. Every
 * kind of view must be listed, so a new screen can't forget to say.
 */
const TAKES_ITS_OWN_KEYS: Record<View["kind"], boolean> = {
  browse: false,
  search: false,
  run: false,
  check: false,
  trust: false, // the dashboard hands its keys to the trust dialog itself
  processes: false,
  help: false,
  editor: true,
  "new-bolt": true,
  "new-workspace": true,
  "delete-bolt": true,
  "delete-workspace": true,
  view: true,
  "stop-bolt": true,
  settings: true,
  setup: true,
  history: true,
};

export const SELF_DRIVEN = new Set(Object.entries(TAKES_ITS_OWN_KEYS).filter(([, own]) => own).map(([kind]) => kind));

/**
 * The run in progress, or the last one. Kept apart from the screen showing it, so that
 * going to the panes in the middle of a build does not lose the build — it shows there too.
 */
export interface RunState {
  title: string;
  /** The workspace and bolt, so a retry knows what it is retrying. */
  read: WorkspaceRead;
  bolt: string;
  job: boolean;
  dryRun: boolean;
  steps: StepState[];
  done: boolean;
  error?: string;
  output: string[];
  outputOf?: string;
  /** Run ids it started, so stopping one of them stops the run. */
  started: string[];
  result?: SwitchResult;
  /** Set once it was stopped, rather than finished. */
  stopped?: string;
}

/** One line of the activity log. */
export interface Activity {
  at: number;
  text: string;
  tone: "good" | "bad" | "info";
}

/** A notice at the bottom of the screen: what just changed, and whether that is bad news. */
export interface Notice {
  text: string;
  tone: "good" | "bad" | "info";
}

/** One row of the panes: a command Wisp runs, or a container Docker runs for it. */
export type PaneItem =
  /** `depth` 2: inside a bolt another bolt needed, shown under that bolt's line. */
  | { type: "run"; run: RunStatus; group: string; depth?: number }
  | { type: "container"; container: Container; group: string; depth?: number }
  | { type: "current" }
  | { type: "group"; group: PaneGroup }
  /**
   * A step of the bolt's last run that is not something running — a wait, a link, a build,
   * a bolt it needed — so the list reads as the pipeline it is, in order.
   */
  | { type: "step"; step: HistoryStep; entry: HistoryEntry; index: number; group: string; depth?: number };

/**
 * A bolt in the Running list, with what it started under it — the way Dockge shows a stack
 * with its containers. Commands go under the bolt that started them; containers under the
 * bolt whose compose step starts them; anything else under its workspace.
 */
export interface PaneGroup {
  key: string;
  /** The workspace file, to find the bolt again for stopping or restarting it. */
  workspace?: string;
  workspaceName: string;
  bolt?: string;
  title: string;
}

export const KIND: Record<StepKind, string> = {
  app: "app",
  command: "run",
  folder: "folder",
  file: "file",
  link: "link",
  wait: "wait",
  bolt: "needs",
  compose: "docker",
};

/** How long ago, as briefly as it reads. */
export function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** State whose latest value is readable straight away, through the returned ref. */
export function useLatest<T>(initial: T): [T, (next: T | ((prior: T) => T)) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T | ((prior: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (prior: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref];
}

export function useTerminalSize(fixed?: { columns: number; rows: number }): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => fixed ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (fixed) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, fixed]);
  return size;
}

export function stepLabel(target: SwitchTarget): string {
  if (target.kind === "wait" && target.wait) return describeWait(target.wait);
  if ((target.kind === "folder" || target.kind === "file") && target.label === target.value) return tildify(target.value);
  return target.label;
}

export function counts(read: WorkspaceRead): string {
  const { workspace } = read;
  const bolts = workspace.bolts.length;
  return `${bolts} bolt${bolts === 1 ? "" : "s"}`;
}

export function needsTrust(read: WorkspaceRead): boolean {
  return !read.workspace.personal && !read.workspace.trusted && read.withheld.length > 0;
}

export { waitingForTrust } from "../core/waiting.js";

export function visibleRuns(runs: RunStatus[], all: boolean): RunStatus[] {
  const list = all ? runs : runs.filter((run) => run.alive);
  return [...list].sort((left, right) => Number(right.alive) - Number(left.alive));
}

export function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

/**
 * Update the first step matching a target that is still waiting for this event: the plan
 * may list the same kind of step twice (two waits), so position matters, not just id.
 */
export function markFirst(steps: StepState[], target: SwitchTarget, change: (step: StepState) => StepState, finishing = false): StepState[] {
  const index = steps.findIndex(
    (step) =>
      step.target.id === target.id &&
      step.target.kind === target.kind &&
      step.target.workspace === target.workspace &&
      (finishing ? step.state !== "done" : step.state === "pending"),
  );
  if (index === -1) return steps;
  return steps.map((step, at) => (at === index ? change(step) : step));
}

/** A time of day, 24-hour: when something in the activity log happened. */
export function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

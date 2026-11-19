import type { Container, ContainerStats } from "../core/docker.js";
import type { RawBolt, RawStep } from "../core/edit.js";
import type { Environment } from "../core/environment.js";
import type { HistoryEntry } from "../core/history.js";
import type { RunStatus, StartResult } from "../core/processes.js";
import type { DownResult, PlannedStep } from "../core/switch.js";
import type { Bolt, SwitchResult, SwitchTarget, TargetResult, WorkspaceRead } from "../core/types.js";
import type { Unreadable } from "../core/workspaces.js";

/** Everything the TUI shows: the workspaces, in the order the list shows them. */
export interface Library {
  reads: WorkspaceRead[];
  /** The project file of the directory Wisp was started in, if any. */
  here?: string;
  unreadable: Unreadable[];
}

export interface RunCallbacks {
  dryRun: boolean;
  onPlan: (targets: SwitchTarget[]) => void;
  onStep: (target: SwitchTarget, info: { attached: boolean }) => void;
  onResult: (result: TargetResult) => void;
  onOutput?: (target: SwitchTarget, chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * What the TUI asks of the world. Passed in rather than imported, so the whole interface
 * can be driven in a test with none of it real.
 */
export interface Services {
  environment: Environment;
  load(): Promise<Library>;
  run(read: WorkspaceRead, bolt: string, callbacks: RunCallbacks): Promise<SwitchResult>;
  /** The failed part of a past run, planned against the bolt as it is now. */
  planRetry(read: WorkspaceRead, entry: HistoryEntry): Promise<PlannedStep[]>;
  /** Run part of a plan again — the steps that failed, and what they kept from running. */
  retry(read: WorkspaceRead, steps: PlannedStep[], label: string, job: boolean, callbacks: RunCallbacks): Promise<SwitchResult>;
  /** Stop what a bolt started and run its teardown; with `deps`, the bolts it needed too. */
  down(read: WorkspaceRead, bolt: Bolt, options?: { deps?: boolean }): Promise<DownResult>;
  history(): Promise<HistoryEntry[]>;
  readLog(path: string): Promise<string>;
  check(file: string): Promise<WorkspaceRead>;
  trust(file: string, hash: string | undefined): Promise<void>;
  runs(): Promise<RunStatus[]>;
  stop(run: RunStatus): boolean;
  restart(run: RunStatus): Promise<StartResult>;
  /** The end of a log: `lines` of it, from at most `maxBytes` (256 KiB unless said). */
  tail(log: string | undefined, lines: number, maxBytes?: number): Promise<string>;
  /** Hand the terminal to an editor, and take it back when it closes. */
  edit(file: string): Promise<void>;

  /** The containers of these compose files — or why Docker could not say. */
  containers(files: string[]): Promise<{ containers: Container[]; error?: string }>;
  containerStats(names: string[]): Promise<Map<string, ContainerStats>>;
  containerLogs(name: string, lines?: number): Promise<string>;
  containerAction(name: string, action: "start" | "stop" | "restart"): Promise<void>;

  /** What Wisp would set up in the folder it was opened in, if that folder has none. */
  suggestSetup(): Promise<SetupSuggestion | undefined>;
  /** Never offer to set this folder up again. */
  declineSetup(dir: string): Promise<void>;
  /** Write the suggested file. Returns its path. */
  setUp(suggestion: SetupSuggestion, chosen?: string[]): Promise<string>;

  /** Call `onChange` when one of these workspace files changes on disk. */
  watch(files: string[], onChange: (file: string) => void): () => void;

  /** Changing workspace files through forms. */
  editing: Editing;

  /** Your own choices on this machine: what opens folders and files, where commands run. */
  settings: SettingsService;
}

export interface OpenWith {
  folder?: string;
  file?: string;
  terminal?: string;
}

export interface SettingsService {
  get(): Promise<OpenWith>;
  /** A blank value goes back to the default. */
  set(change: OpenWith): Promise<OpenWith>;
  /** What can be chosen here: installed editors, and the terminals Wisp can drive. */
  choices(): { editors: { label: string; value: string }[]; terminals: string[] };
  /** Whether the dashboard takes clicks and the wheel: on unless turned off. */
  mouse(): Promise<boolean>;
  setMouse(on: boolean): Promise<boolean>;
}

/** The edits the TUI's forms make — the core's, passed in so a test can watch them. */
export interface Editing {
  bolt(file: string, bolt: string): Promise<RawBolt>;
  addBolt(file: string, label: string, options?: { job?: boolean }): Promise<void>;
  renameBolt(file: string, bolt: string, label: string): Promise<void>;
  setBoltNotes(file: string, bolt: string, notes: string): Promise<void>;
  removeBolt(file: string, bolt: string): Promise<void>;
  moveBolt(file: string, bolt: string, by: -1 | 1): Promise<void>;
  setJob(file: string, bolt: string, job: boolean): Promise<void>;
  addStep(file: string, bolt: string, step: RawStep, at?: number): Promise<void>;
  replaceStep(file: string, bolt: string, index: number, step: RawStep): Promise<void>;
  removeStep(file: string, bolt: string, index: number): Promise<void>;
  moveStep(file: string, bolt: string, index: number, by: -1 | 1): Promise<void>;
  createPersonalWorkspace(name: string): Promise<string>;
  /** Delete one of your own workspaces' files. */
  removePersonalWorkspace(file: string): Promise<void>;
  /** Stop listing a project; its .wisp.json is left as it is. */
  forgetProject(file: string): Promise<void>;
}

/** A `.wisp.json` Wisp could write for the folder it was opened in. */
export interface SetupSuggestion {
  dir: string;
  name: string;
  /** What it found, in words: "package.json — pnpm dev". */
  found: string[];
  /** What it would add: each bolt, and what it does step by step. */
  bolts: { label: string; job: boolean; steps: string[] }[];
  contents: string;
}

/** The order the list shows workspaces in: here, then yours, then the projects you use. */
export function ordered(library: Library): WorkspaceRead[] {
  const here = library.reads.filter((read) => read.workspace.file === library.here);
  const personal = library.reads.filter((read) => read.workspace.personal && read.workspace.file !== library.here);
  const projects = library.reads.filter((read) => !read.workspace.personal && read.workspace.file !== library.here);
  return [...here, ...projects, ...personal];
}

export interface SearchHit {
  /** Index into the ordered workspaces. */
  workspace: number;
  /** A bolt label, or nothing for the workspace itself. */
  bolt?: string;
  label: string;
  score: number;
}

/**
 * Fuzzy search over workspaces and their bolts, the way a picker should work: the letters
 * in order, anywhere, with consecutive runs and word starts counting for more. "acapi"
 * finds "Acme › Work on api".
 */
export function search(reads: WorkspaceRead[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  const hits: SearchHit[] = [];

  reads.forEach((read, index) => {
    const name = read.workspace.name;
    const own = score(name, needle);
    if (own !== undefined) hits.push({ workspace: index, label: name, score: own });

    for (const bolt of read.workspace.bolts) {
      const label = `${name} › ${bolt.label}`;
      // The bolt alone counts most — it is what you are looking for — but the workspace
      // name helps tell two "Work on api"s apart.
      const value = Math.max(score(bolt.label, needle) ?? -Infinity, (score(label, needle) ?? -Infinity) - 1);
      if (value !== -Infinity) hits.push({ workspace: index, bolt: bolt.label, label, score: value + 1 });
    }
  });

  if (!needle) return hits;
  return hits.sort((left, right) => right.score - left.score);
}

/** How well `needle` matches `text` as a subsequence, or undefined when it does not. */
export function score(text: string, needle: string): number | undefined {
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let total = 0;
  let position = -1;
  let streak = 0;

  for (const char of needle) {
    const found = haystack.indexOf(char, position + 1);
    if (found === -1) return undefined;
    streak = found === position + 1 ? streak + 1 : 0;
    const wordStart = found === 0 || /[\s›/_.-]/.test(haystack[found - 1] ?? "");
    total += 1 + streak * 2 + (wordStart ? 3 : 0);
    position = found;
  }

  // Shorter texts with the same matches are closer to what was meant.
  return total - haystack.length * 0.01;
}

/** The slice of a list that fits in `height` rows and keeps `selected` in view. */
export function windowed<T>(items: T[], selected: number, height: number): { items: T[]; offset: number } {
  if (height <= 0) return { items: [], offset: 0 };
  if (items.length <= height) return { items, offset: 0 };
  const half = Math.floor(height / 2);
  const offset = Math.min(Math.max(0, selected - half), items.length - height);
  return { items: items.slice(offset, offset + height), offset };
}

/**
 * A step as a sentence — for people who would rather not read `wait port 5432`. `doing` is
 * how it reads while it is happening.
 */
export function describeStep(target: SwitchTarget, doing = false, job = false): string {
  switch (target.kind) {
    case "command":
      // A job's command runs to completion; anything else's is started and left running.
      if (job) return doing ? `Running ${target.label}…` : `run ${target.label}`;
      return doing ? `Starting ${target.label}…` : `start ${target.label}`;
    case "compose":
      return doing
        ? `Starting Docker services ${target.label.startsWith("from ") ? target.label : `(${target.label})`} and waiting until they're healthy…`
        : `${target.compose?.action === "stop" ? "stop" : "start"} Docker services ${target.label.startsWith("from ") ? target.label : `: ${target.label}`}`.replace(" :", ":");
    case "wait": {
      const wait = target.wait;
      if (wait && "seconds" in wait) return doing ? `Waiting ${wait.seconds}s…` : `wait ${wait.seconds}s`;
      if (wait && "url" in wait) return doing ? `Waiting for ${wait.url} to answer…` : `wait until ${wait.url} answers`;
      if (wait && "port" in wait) {
        const where = wait.host === "localhost" ? `port ${wait.port}` : `${wait.host}:${wait.port}`;
        return doing ? `Waiting for ${where} to accept connections…` : `wait until ${where} is open`;
      }
      return doing ? "Waiting…" : "wait";
    }
    case "link": {
      // A name says more than a URL, and a URL can be a screen wide: the name with the site
      // when there is one, or the address without its query string when there is not.
      const where = shortUrl(target.value);
      const what = target.label && target.label !== target.value ? `${target.label} (${hostOf(target.value)})` : where;
      return doing ? `Opening ${what}…` : `open ${what}`;
    }
    case "folder":
      return doing ? `Opening the ${target.label} folder…` : `open the ${target.label} folder`;
    case "file":
      return doing ? `Opening ${target.label}…` : `open ${target.label}`;
    case "app":
      return doing ? `Opening ${target.label}…` : `open ${target.label}`;
    case "bolt":
      return `${target.label} first`;
  }
}

/** A web address cut to what a person reads: host and path, no query, no fragment. */
export function shortUrl(value: string, max = 60): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const text = `${local ? `${url.protocol}//` : ""}${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search ? "?…" : ""}`;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

/**
 * A filter as you type: every word must appear somewhere in what the row says about itself,
 * in any order and any case — "acme fail" finds Acme's failed runs.
 */
export function matchesAll(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

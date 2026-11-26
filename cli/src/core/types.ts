/** The operating systems Wisp knows, by Node's own names for them. */
export type OS = "darwin" | "linux" | "win32";

export const OPERATING_SYSTEMS: readonly OS[] = ["darwin", "linux", "win32"];

/**
 * A value that may differ per operating system.
 *
 * A plain value means the same thing everywhere. A map is for the values that genuinely
 * cannot travel — an app is "Visual Studio Code" on macOS and `code` on Linux — and an OS
 * missing from the map simply does not have that asset.
 */
export type PerOS<T> = T | Partial<Record<OS, T>>;

/**
 * What happens when a command stops by itself. `on-failure`: it is started again when it
 * exits with an error — a dev server that crashed. `always`: whenever it exits.
 */
export type RestartPolicy = "on-failure" | "always";

/** Which shell a command is written for. */
export type ShellKind = "sh" | "pwsh" | "cmd";

/**
 * How a command is run.
 *
 * `terminal`: a visible window, or a new tmux/zellij window when you are inside one.
 * `background`: detached and tracked, with its output in a log you can read later.
 * `inline`: attached to whoever asked — the TUI's output pane, or this terminal.
 * `auto`: a terminal when there is somewhere to show one, background when there is not.
 */
export type RunMode = "auto" | "terminal" | "background" | "inline";

/**
 * Shared by every kind of asset.
 *
 * An asset is declared once and says nothing about when it opens. That is a pipeline's job,
 * and a pipeline refers to assets by label, so an asset can belong to any number of them.
 */
export interface AssetBase {
  /** `folder:api` — derived from kind and label, the same on every read. */
  id: string;
  label: string;
  /**
   * Which app opens this. Never read from a project file — a committed file does not get
   * to choose anyone's editor — but filled in from your own `open-with` choices.
   */
  openWith?: string;
}

/** A URL, opened in the default browser. */
export interface Link extends AssetBase {
  url: string;
}

/** A directory, opened in the file manager or the editor you chose. */
export interface Folder extends AssetBase {
  path: string;
}

/** A single file, opened by whatever owns its type, or the app you chose. */
export interface FileRef extends AssetBase {
  path: string;
}

/** An application to launch or bring forward, as this OS names it. */
export interface AppRef extends AssetBase {
  app: string;
}

/**
 * A shell command — `pnpm dev`, a deploy script, the thing you type every morning.
 *
 * Runs in a terminal by default, because anything long-running or interactive needs to be
 * visible and interruptible. `background` is for one-shot automation you only want to
 * hear about if it fails.
 */
export interface Command extends AssetBase {
  /** Passed to the shell, so pipes and `&&` work as they read. */
  run: string;
  /** Absolute by the time it is here; written relative to the file it came from. */
  cwd?: string;
  background?: boolean;
  finishes?: boolean;
  /** Seconds a command that finishes may take before Wisp stops it and calls it failed. */
  timeout?: number;
  /** Brought back when it stops: after a crash, or whenever. Absent: left stopped. */
  restart?: RestartPolicy;
  /** Which shell `run` is written for. Absent means the platform's usual one. */
  shell?: ShellKind;
  /** Set for this command only, on top of your own environment. */
  env?: Record<string, string>;
}

/**
 * A pause in a pipeline until something is ready: the database is listening, the dev server
 * answers, or a few seconds have passed.
 */
export type WaitSpec =
  | { port: number; host: string; timeout: number }
  | { url: string; timeout: number; status?: number }
  | { seconds: number };

/**
 * One step of a pipeline: open an asset, wait for something, or first run another pipeline —
 * this workspace's, or another workspace's when `workspace` names one. A dependency runs
 * once per run however many pipelines need it, and a command it would start is skipped when
 * Wisp already has it running.
 */
export type PipelineStep = (
  | { kind: "asset"; id: string }
  | { kind: "wait"; wait: WaitSpec; held?: string }
  | { kind: "pipeline"; pipeline: string }
  /**
   * Services of a compose file: started with `up --wait`, so the step is done when they are
   * healthy; stopped by `wisp down`; shown with their state, health and logs.
   */
  | { kind: "compose"; file: string; services?: string[] }
) & { name?: string; after?: string[] };


/**
 * A named action over some of a workspace's assets: "API development", "Doc writing".
 *
 * Running one opens its assets in the order listed — the user's order, not any inherent
 * one. A pipeline is a small pipeline, and a wait step is how a pipeline says "not yet".
 */
export interface Pipeline {
  id: string;
  label: string;
  slug?: string;
  notes?: string;
  color?: string;
  steps: PipelineStep[];
  broken?: string;
  keepGoing?: boolean;
  confirm?: string;
  inputs?: InputSpec[];
  /** Run by `wisp down` after stopping what the pipeline started: `docker compose stop`. */
  down?: PipelineStep[];
}

/**
 * A workspace: what one `.wisp.json` describes.
 *
 * There is exactly one format. A project commits its file next to its code; a personal
 * workspace is the same format kept in Wisp's own directory. The only difference is
 * trust — a file you keep in your own config is yours, and its commands run.
 */
export interface Workspace {
  /** The absolute path of the file — the one identity every workspace already has. */
  id: string;
  name: string;
  color?: string;
  icon?: string;
  notes?: string;
  /** The `.wisp.json` this was read from. */
  file: string;
  /** Kept in Wisp's own workspaces directory, rather than committed in a project. */
  personal: boolean;
  /** Whether this file may run code: its commands, and anything that executes when opened. */
  trusted: boolean;
  /** The `.wisp.local.json` merged in beside the file, when there is one. */
  local?: string;
  links: Link[];
  folders: Folder[];
  files: FileRef[];
  apps: AppRef[];
  /** Only the commands that may run: empty for an untrusted project file. */
  commands: Command[];
  pipelines: Pipeline[];
}

/**
 * Which app opens a project's folders and files, and which terminal runs its commands.
 *
 * A committed `.wisp.json` must not name an editor — that is a fight in code review,
 * not a shared fact — so the file says which folder and this says what opens it.
 */
export interface OpenWithDefaults {
  folder?: string;
  file?: string;
  terminal?: string;
}

/** A project file Wisp has seen you use, so it can be listed from anywhere. */
export interface KnownProject {
  /** Absolute path to the `.wisp.json`. */
  path: string;
  /** ISO timestamp of the last time it was run or looked at. */
  lastUsed: string;
}

/** On-disk contents of `config.json`. */
export interface Config {
  version: number;
  openWith?: OpenWithDefaults;
  /** Directories to look in for project files, beyond the ones you have used. */
  roots?: string[];
  projects?: KnownProject[];
  /** Folders where you said "don't ask again" to setting up a .wisp.json. */
  noSetup?: string[];
  /** The dashboard takes clicks and the scroll wheel. Absent means yes; false turns it off. */
  mouse?: boolean;
  notify?: NotifySettings;
}

export type NotifyWhen = "failures" | "changes" | "all" | "off";

export interface Webhook {
  url: string;
  workspaces?: string[];
}

export interface NotifySettings {
  when?: NotifyWhen;
  webhooks?: Webhook[];
  screen?: boolean;
}

/**
 * A `.wisp.json` you have allowed to run commands.
 *
 * The hash is the point: trust is granted to the file you read, not to the path. A pulled
 * change rewrites the hash, the grant stops matching, and the commands are refused again
 * until you have looked at what changed.
 */
export interface TrustedProject {
  path: string;
  /** SHA-256 of the file's bytes at the moment it was trusted. */
  hash: string;
  at: string;
}

/** On-disk contents of `trust.json`. */
export interface TrustFile {
  version: number;
  trusted: TrustedProject[];
}

export type TrustState =
  /** Never trusted. Commands are read but not offered. */
  | "untrusted"
  /** Trusted, and the file is byte-for-byte the one that was trusted. */
  | "trusted"
  /** Trusted once, but the file has changed since. Treated as untrusted. */
  | "stale";

/**
 * Something worth saying about a workspace file that is not worth refusing it over.
 *
 * A committed `.wisp.json` is read by people who did not write it, so a pipeline naming an
 * asset that is not there has to be reported rather than quietly dropped.
 */
export interface Diagnostic {
  /**
   * `error`: something was discarded. `warning`: it works, but read this. `note`: working
   * as written, but worth knowing — an asset declared only for another OS, for example.
   */
  level: "error" | "warning" | "note";
  /** Where in the file, in the words the file uses: `pipelines[1].steps`. */
  at: string;
  message: string;
  hint?: string;
  pipeline?: string;
}

/** Something a file declares that would run code, and so waits for trust. */
export interface Withheld {
  kind: StepKind;
  id: string;
  label: string;
  /** The command line, path or app — what you would be agreeing to. */
  value: string;
  cwd?: string;
  /** Why it counts as running code, for anything that is not plainly a command. */
  reason?: string;
}

/** A workspace file as read: what it declared, and everything Wisp had to say about it. */
export interface WorkspaceRead {
  workspace: Workspace;
  diagnostics: Diagnostic[];
  trust: TrustState;
  /** Every command the file declares for this OS, whether or not it may run. */
  declaredCommands: Command[];
  /**
   * Everything that waits on trust: the commands, plus files and apps that would execute
   * when opened. Empty once trusted — it lists what is being held back, not what exists.
   */
  withheld: Withheld[];
  /** What a grant would be recorded against: the file and its override, as read. */
  hash?: string;
}

export type TargetKind = "app" | "command" | "folder" | "file" | "link";

/** A step a pipeline can take: opening an asset, or waiting for something to be ready. */
export type StepKind = TargetKind | "wait" | "pipeline" | "compose";

/** One asset, flattened to what opening it needs. */
export interface SwitchTarget {
  kind: StepKind;
  label: string;
  id: string;
  /** The url, path, app or shell command. */
  value: string;
  cwd?: string;
  background?: boolean;
  finishes?: boolean;
  timeout?: number;
  restart?: RestartPolicy;
  shell?: ShellKind;
  env?: Record<string, string>;
  openWith?: string;
  /** For a wait step: what it is waiting for. */
  wait?: WaitSpec;
  /** The workspace this step belongs to, when a dependency brought it in from another. */
  workspace?: string;
  /** For a compose step: which file, which services, and whether it starts or stops them. */
  compose?: { file: string; services: string[]; action: "up" | "stop" };
  name?: string;
  after?: string[];
}

export interface TargetResult extends SwitchTarget {
  ok: boolean;
  /** Cut short because the run was stopped, not because it broke. */
  cancelled?: boolean;
  error?: string;
  /** Said when the platform did something less than asked, like opening a new tab. */
  note?: string;
  /** Not opened, on purpose — there is no display to open it on, for one. */
  skipped?: boolean;
  /** The tracked run a command became, so it can be found and stopped again. */
  run?: string;
  durationMs?: number;
  /** Where an attached command's output was kept. */
  log?: string;
}

export interface SwitchResult {
  workspace: Workspace;
  targets: TargetResult[];
  dryRun: boolean;
  pipeline?: Pipeline;
  /** The run's entry in history, for `wisp history <id>`. */
  historyId?: string;
  ok: boolean;
  /** Stopped before it finished, by you: neither a success nor a failure. */
  cancelled?: boolean;
  /** What it set out to do, step by step — so the failed part can be run again. */
  plan?: import("./run/index.js").PlannedStep[];
  inputs?: Record<string, string>;
}

export interface InputSpec {
  name: string;
  ask: string;
  choices?: string[];
  default?: string;
}

export interface SwitchOptions {
  inputs?: Record<string, string>;
  watched?: boolean;
  dryRun?: boolean;
  /** Open without stealing focus, where the platform can. */
  background?: boolean;
  /** Which pipeline to run, by id or any distinctive part of its label. */
  pipeline?: string;
  /** Focus a link's existing tab rather than opening a second one, where possible. */
  reuseTabs?: boolean;
  /** How commands run. Defaults to `auto`. */
  mode?: RunMode;
  /** Called once with every step the run will take, before the first starts. */
  onPlan?: (targets: SwitchTarget[], waits?: number[][], owners?: (string | undefined)[]) => void;
  /**
   * Called before each step starts, so a caller can show progress. `attached` says the
   * step is a command whose output is about to arrive through `onOutput`.
   */
  onStep?: (target: SwitchTarget, info: { attached: boolean }) => void;
  /** Called as each step finishes. */
  onResult?: (result: TargetResult) => void;
  /**
   * Runs an attached command for the caller instead, resolving with its exit code. Without
   * one, Wisp runs it, keeps its output in history, and passes it to `onOutput`.
   */
  runInline?: (target: SwitchTarget, invocation: Invocation) => Promise<number>;
  /** Also print attached commands' output here, and give them this terminal's input. */
  echo?: boolean;
  /** Each chunk an attached command prints, as it prints it. */
  onOutput?: (target: SwitchTarget, chunk: string) => void;
  /** Keep this run in history. On by default for anything but a dry run. */
  record?: boolean;
  /** Cancels the run: nothing more starts, and an attached command is stopped. */
  signal?: AbortSignal;
  /** What started it, for history: "tui", "cli", "hook", "retry". */
  trigger?: string;
}

/** A program and its arguments, ready to spawn — no shell parsing in between. */
export interface Invocation {
  file: string;
  args: string[];
}

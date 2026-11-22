import { SLUG, pipelineSlug } from "./workspaces.js";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseDuration } from "./duration.js";
import { getOpenWithDefaults } from "./config.js";
import { WispError, describe } from "./errors.js";
import { INPUT_NAME, INPUT_VALUE, envNames, notPlain, placeholders } from "./inputs.js";
import { currentOS, expandHome, workspacesDir } from "./paths.js";
import { hashContents, localFileFor, readTrustedBytes, trustStateOf } from "./trust.js";
import type {
  AppRef,
  Pipeline,
  PipelineStep,
  Command,
  Diagnostic,
  FileRef,
  Folder,
  InputSpec,
  Link,
  OS,
  OpenWithDefaults,
  ShellKind,
  TargetKind,
  TrustState,
  WaitSpec,
  Withheld,
  Workspace,
  WorkspaceRead,
} from "./types.js";

/** What a project file is called, wherever it sits. */
export const PROJECT_FILE = ".wisp.json";

/** The personal override beside it, meant to be gitignored. */
export const LOCAL_FILE = ".wisp.local.json";

/**
 * Where the schema lives, so a file can point an editor at it.
 *
 * Unversioned on purpose: the format only ever gains optional keys, and a file pinned to
 * last year's copy would start complaining about a key that works.
 */
export const PROJECT_SCHEMA_URL =
  "https://raw.githubusercontent.com/phrp720/wisp/main/schema/wisp.schema.json";

const OS_NAMES: Record<OS, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

export function osName(os: OS): string {
  return OS_NAMES[os];
}

/**
 * An OS as a person writes it. Node's names are `darwin` and `win32`, which nobody says
 * out loud, so the names people do say are accepted too.
 */
export function parseOS(value: string): OS | undefined {
  return OS_ALIASES[value.trim().toLowerCase()];
}

const OS_ALIASES: Record<string, OS> = {
  darwin: "darwin",
  macos: "darwin",
  mac: "darwin",
  osx: "darwin",
  linux: "linux",
  win32: "win32",
  windows: "win32",
  win: "win32",
};

const KNOWN_OS_KEYS = "macos, linux, windows";

/** Keys a workspace file may set. Anything else is a typo worth reporting. */
const KNOWN_KEYS = new Set([
  // Not read by Wisp — it is there so editors validate the file as you type.
  "$schema",
  "name",
  "icon",
  "color",
  "notes",
  "pipelines",
]);

const PIPELINE_KEYS = new Set(["label", "slug", "notes", "color", "keepGoing", "confirm", "inputs", "steps", "down"]);
const INPUT_KEYS = new Set(["ask", "choices", "default"]);

const SHELLS: readonly ShellKind[] = ["sh", "pwsh", "cmd"];

/** Seconds a wait gives up after, unless it says otherwise. */
const DEFAULT_WAIT_TIMEOUT = 60;

/**
 * Extensions that run code when opened, on at least one OS.
 *
 * Checked whatever OS you are on: a file is committed once and read everywhere, and the
 * point is that a repository you cloned cannot run anything until you have said so.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // macOS
  ".app", ".command", ".tool", ".terminal", ".workflow", ".scpt", ".scptd", ".applescript", ".pkg", ".mpkg",
  // Windows
  ".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".msi", ".msc", ".scr", ".lnk", ".reg", ".hta", ".cpl", ".pif", ".appref-ms",
  // Linux and everywhere
  ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".pl", ".jar", ".desktop", ".appimage", ".run", ".bin",
  ".deb", ".rpm",
]);

/**
 * Find the project file governing a directory.
 *
 * Walks up the way git looks for `.git`, and deliberately does not require a repository:
 * a project made of several repositories keeps its file in the directory above them all.
 */
export async function findProjectFile(from: string = process.cwd()): Promise<string | undefined> {
  let dir = resolve(expandHome(from));

  for (;;) {
    const candidate = join(dir, PROJECT_FILE);
    const found = await stat(candidate).catch(() => undefined);
    if (found?.isFile()) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether a file really lives in Wisp's own workspaces directory, and so is yours.
 *
 * By real path, both sides: a personal workspace runs its commands without asking, so a
 * symlink in that directory pointing at some repository's file must not borrow the trust.
 */
export async function isPersonalFile(file: string): Promise<boolean> {
  const dir = await realpath(workspacesDir()).catch(() => undefined);
  if (!dir) return false;
  const real = await realpath(file).catch(() => undefined);
  if (!real) return false;
  return real.startsWith(dir + sep) && dirname(real) === dir;
}

export interface ReadOptions {
  /** Read as if on this OS. Defaults to the one Wisp is running on. */
  os?: OS;
}

/**
 * Read a workspace file — and its local override, when it has one — with everything
 * Wisp had to say about it.
 *
 * Paths are relative to the file, since a committed file cannot know where anyone cloned
 * it. Pipelines name their assets by label — ids are derived here, because a hand-written,
 * code-reviewed file has no business carrying UUIDs. And nothing is dropped in silence.
 */
export async function readProjectFile(file: string, options: ReadOptions = {}): Promise<WorkspaceRead> {
  const given = resolve(expandHome(file));
  // The real path is the identity, so trust and the personal check cannot be fooled by a
  // link, and a project reached through two different symlinks is one project.
  const path = await realpath(given).catch((error: unknown) => {
    throw new WispError(`Could not read ${given}: ${describe(error)}`, "PROJECT_READ_FAILED");
  });

  const personal = await isPersonalFile(path);
  const bytes = await readTrustedBytes(path);
  const main = parseObject(bytes.main, path);
  // A personal workspace has no override: it is already yours to edit.
  const local = bytes.local && !personal ? parseObject(bytes.local, localFileFor(path)) : undefined;

  // Hashed from the bytes just read, not read again, so the file checked is the file run.
  const hash = hashContents(bytes.main, bytes.local);
  const trust: TrustState = personal ? "trusted" : await trustStateOf(path, hash);

  const read = interpret(
    { main, ...(local ? { local } : {}) },
    { file: path, personal, trust, os: options.os ?? currentOS(), defaults: await getOpenWithDefaults() },
  );
  if (local) read.workspace.local = localFileFor(path);
  return { ...read, hash };
}

function parseObject(bytes: Buffer, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new WispError(`${file} is not valid JSON: ${describe(error)}`, "PROJECT_INVALID");
  }
  if (!isRecord(parsed)) throw new WispError(`${file} does not contain an object`, "PROJECT_INVALID");
  return parsed;
}

/** The two files a workspace may be made of. */
export interface Sources {
  main: Record<string, unknown>;
  local?: Record<string, unknown>;
}

interface Context {
  root: string;
  os: OS;
  personal: boolean;
  trusted: boolean;
  defaults: OpenWithDefaults;
  found: Diagnostic[];
  /** Ids declared but not for this OS — real, just not here. */
  elsewhere: Set<string>;
  withheld: Withheld[];
  /** The id each entry ended up with, by where it was written — how inline steps find theirs. */
  idsByAt: Map<string, string>;
  /** What each id was declared as, so two bolts listing the same thing inline share it. */
  valueById: Map<string, string>;
}

interface Entry {
  value: unknown;
  /** Where it was written: `links[2]`, or `local links[0]` for the override. */
  at: string;
}

/** The parsed JSON of a workspace file, as a workspace. Separate from reading, for tests. */
export function interpret(
  sources: Sources,
  input: { file: string; personal: boolean; trust: TrustState; os: OS; defaults?: OpenWithDefaults },
): WorkspaceRead & { hash?: string } {
  const trusted = input.personal || input.trust === "trusted";
  const ctx: Context = {
    root: dirname(input.file),
    os: input.os,
    personal: input.personal,
    trusted,
    defaults: input.defaults ?? {},
    found: [],
    elsewhere: new Set(),
    withheld: [],
    idsByAt: new Map(),
    valueById: new Map(),
  };

  for (const [prefix, source] of [["", sources.main], ["local ", sources.local]] as const) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      if (KNOWN_KEYS.has(key)) continue;
      ctx.found.push({
        level: "warning",
        at: `${prefix}${key}`,
        message: `"${key}" is not something a workspace file can set — it is ignored`,
        hint:
          Array.isArray(source[key]) && !("pipelines" in sources.main) && !("pipelines" in (sources.local ?? {}))
            ? `Did you mean "pipelines"? Known keys: ${[...KNOWN_KEYS].join(", ")}`
            : `Known keys: ${[...KNOWN_KEYS].join(", ")}`,
      });
    }
  }

  // Scalars from the override win; lists from it are added after the project's own.
  const scalar = (key: string) => optionalString(sources.local?.[key]) ?? optionalString(sources.main[key]);
  const section = (key: string) => sectionEntries(sources, key, ctx);

  const pipelineEntries = section("pipelines");
  const inline = inlineEntries(pipelineEntries);

  const links = assets<Link>(inline.links, LINKS, ctx);
  const folders = assets<Folder>(inline.folders, FOLDERS, ctx);
  const files = assets<FileRef>(inline.files, FILES, ctx);
  const apps = assets<AppRef>(inline.apps, APPS, ctx);
  const declaredCommands = commands(inline.commands, ctx);

  const workspace: Workspace = {
    id: input.file,
    name: scalar("name") ?? defaultName(input.file, input.personal),
    file: input.file,
    personal: input.personal,
    trusted,
    links: links.filter((link) => allow(ctx, "link", link, link.url)),
    folders: folders.filter((folder) => allow(ctx, "folder", folder, folder.path)),
    files: files.filter((file) => allow(ctx, "file", file, file.path)),
    apps: apps.filter((app) => allow(ctx, "app", app, app.app)),
    // The line between reading a command and running one. A project file's commands are
    // parsed and shown whatever happens; they only become part of the workspace once you
    // have looked at them and said yes to these bytes.
    commands: trusted ? declaredCommands : [],
    bolts: [],
  };

  if (!trusted) {
    for (const command of declaredCommands) {
      ctx.withheld.push({
        kind: "command",
        id: command.id,
        label: command.label,
        value: command.run,
        ...(command.cwd ? { cwd: command.cwd } : {}),
      });
    }
  }

  const icon = scalar("icon");
  if (icon) workspace.icon = icon;
  const color = scalar("color");
  if (color) workspace.color = color;
  const notes = scalar("notes");
  if (notes) workspace.notes = notes;

  workspace.bolts = bolts(pipelineEntries, ctx);

  if (!trusted && ctx.withheld.length > 0) {
    const commandCount = ctx.withheld.filter((item) => item.kind === "command").length;
    const linkCount = ctx.withheld.filter((item) => item.kind === "link" || item.kind === "wait").length;
    const other = ctx.withheld.length - commandCount - linkCount;
    const parts = [
      commandCount > 0 ? plural(commandCount, "command") : "",
      other > 0 ? `${plural(other, "item")} that would run code when opened` : "",
      linkCount > 0 ? `${plural(linkCount, "website")} that ${linkCount === 1 ? "reads" : "read"} your environment` : "",
    ].filter(Boolean);

    ctx.found.push({
      level: "warning",
      at: "trust",
      message:
        input.trust === "stale"
          ? `this file has changed since you trusted it — ${parts.join(" and ")} will not run`
          : `${parts.join(" and ")} declared but will not run`,
      hint:
        input.trust === "stale"
          ? "Read what changed with `wisp check`, then `wisp trust` again"
          : "Read them with `wisp check`, then allow them with `wisp trust`",
    });
  }

  return { workspace, diagnostics: tagPipelines(ctx.found, pipelineEntries), trust: input.trust, declaredCommands, withheld: ctx.withheld };
}

function tagPipelines(found: Diagnostic[], pipelineEntries: Entry[]): Diagnostic[] {
  const places = pipelineEntries.flatMap(({ value, at }) => {
    const label = isRecord(value) ? optionalString(value["label"]) : undefined;
    return label ? [{ at, label }] : [];
  });
  return found.map((entry) => {
    if (entry.pipeline) return entry;
    const place = places.find(({ at }) => entry.at === at || entry.at.startsWith(`${at}.`));
    return place ? { ...entry, pipeline: place.label } : entry;
  });
}

/**
 * Whether an asset may open without trust. Most may — a folder is a folder — but a file
 * that executes when opened, or an app given as a path rather than a name, is running
 * code the repository chose, which is exactly what trust exists to gate.
 */
function allow(ctx: Context, kind: TargetKind, asset: { id: string; label: string }, value: string): boolean {
  const reason = runsCode(kind, value);
  if (!reason || ctx.trusted) return true;
  ctx.withheld.push({ kind, id: asset.id, label: asset.label, value, reason });
  return false;
}

/** Why opening this would run code, or nothing when it would not. */
export function runsCode(kind: TargetKind, value: string): string | undefined {
  if (kind === "link") {
    const names = envNames(value);
    return names.length > 0 ? `reads ${names.map((name) => `$${name}`).join(", ")} from your environment` : undefined;
  }
  if (kind === "app") {
    // A name or bundle id is looked up among installed apps; a path is whatever is there.
    return /[\\/]/.test(value) ? "an app given as a path runs whatever is at that path" : undefined;
  }
  if (kind !== "file" && kind !== "folder") return undefined;

  const extension = extname(value.replace(/[\\/]+$/, "")).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(extension)) return `a ${extension} file runs when opened`;
  return undefined;
}

/** `acme` for `~/dev/acme/.wisp.json`, `Morning` for `workspaces/Morning.wisp.json`. */
function defaultName(file: string, personal: boolean): string {
  if (personal) {
    const name = basename(file).replace(/(\.wisp)?\.json$/i, "");
    if (name) return name;
  }
  return basename(dirname(file)) || "Project";
}

/** The key that makes an object target an inline asset, and which section it belongs to. */
const INLINE_KINDS = [
  ["url", "links"],
  ["folder", "folders"],
  ["file", "files"],
  ["app", "apps"],
  ["run", "commands"],
] as const;

type InlineSection = (typeof INLINE_KINDS)[number][1];

function inlineKind(target: Record<string, unknown>): InlineSection | undefined {
  return INLINE_KINDS.find(([key]) => target[key] !== undefined)?.[1];
}

/** Every inline asset in every bolt, sorted into the section it would have been written in. */
function inlineEntries(pipelineEntries: Entry[]): Record<InlineSection, Entry[]> {
  const found: Record<InlineSection, Entry[]> = { links: [], folders: [], files: [], apps: [], commands: [] };
  for (const { value: bolt, at } of pipelineEntries) {
    if (!isRecord(bolt)) continue;
    for (const list of ["steps", "down"] as const) {
      if (!Array.isArray(bolt[list])) continue;
      (bolt[list] as unknown[]).forEach((target, index) => {
        if (!isRecord(target)) return;
        const section = inlineKind(target);
        if (section) found[section].push({ value: target, at: `${at}.${list}[${index}]` });
      });
    }
  }
  return found;
}

function sectionEntries(sources: Sources, key: string, ctx: Context): Entry[] {
  const entries: Entry[] = [];
  for (const [prefix, source] of [["", sources.main], ["local ", sources.local]] as const) {
    const value = source?.[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      ctx.found.push({ level: "error", at: `${prefix}${key}`, message: `"${key}" must be an array — it was ignored` });
      continue;
    }
    value.forEach((entry, index) => entries.push({ value: entry, at: `${prefix}${key}[${index}]` }));
  }
  return entries;
}

/**
 * How one kind of asset is written in a file.
 *
 * `keys` lists the field that holds the value: the canonical name, then any older spelling
 * still accepted. `perOS` says whether that value may be a per-OS map.
 */
interface AssetSpec<T> {
  kind: TargetKind;
  keys: string[];
  perOS: boolean;
  build: (base: { id: string; label: string }, value: string, ctx: Context) => T;
}

const LINKS: AssetSpec<Link> = {
  kind: "link",
  keys: ["url"],
  perOS: false,
  build: (base, url) => ({ ...base, url }),
};

const FOLDERS: AssetSpec<Folder> = {
  kind: "folder",
  keys: ["folder"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.folder ? { openWith: ctx.defaults.folder } : {}),
  }),
};

const FILES: AssetSpec<FileRef> = {
  kind: "file",
  keys: ["file"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.file ? { openWith: ctx.defaults.file } : {}),
  }),
};

const APPS: AssetSpec<AppRef> = {
  kind: "app",
  keys: ["app"],
  perOS: true,
  build: (base, app) => ({ ...base, app }),
};

/**
 * One section of assets, with ids derived from what they are and what they are called.
 *
 * `link:staging` rather than a UUID, so a bolt can name the asset the way a human would,
 * and so the id is the same every time the file is read. The kind is part of the id: a
 * folder and a file may both be called `Spec`, and they are not the same asset.
 */
function assets<T>(entries: Entry[], spec: AssetSpec<T>, ctx: Context): T[] {
  const items: T[] = [];
  const taken = new Set<string>();

  for (const { value: entry, at } of entries) {
    const record = isRecord(entry) ? entry : undefined;

    let written: unknown;
    let key = spec.keys[0] as string;
    if (record) {
      const present = spec.keys.find((candidate) => record[candidate] !== undefined);
      if (present) {
        key = present;
        written = record[present];
      }
    }

    const value = spec.perOS ? perOS(written, `${at}.${key}`, ctx) : plain(written);
    if (value.kind === "missing") {
      ctx.found.push({ level: "error", at, message: `dropped: no "${spec.keys[0]}" to open` });
      continue;
    }

    const label = optionalString(record?.["label"]) ?? value.label;

    // A shared file does not get to choose anyone's editor; your own workspace does.
    const openWith = optionalString(record?.["openWith"]);
    if (openWith && !ctx.personal) {
      ctx.found.push({
        level: "warning",
        at: `${at}.openWith`,
        message: "a shared workspace file does not choose anyone's editor — this is ignored",
        hint: 'Set your own with `wisp open-with folder "Visual Studio Code"`',
      });
    }

    const base = `${spec.kind}:${label.toLowerCase()}`;
    const fingerprint = JSON.stringify(written);
    // The same thing listed inline in two bolts is one asset, not a duplicate to warn about.
    if (taken.has(base) && ctx.valueById.get(base) === fingerprint) {
      ctx.idsByAt.set(at, base);
      continue;
    }

    const id = uniqueId(base, taken);
    ctx.idsByAt.set(at, id);
    ctx.valueById.set(id, fingerprint);

    if (value.kind !== "here" || !allowedHere(record?.["os"], `${at}.os`, ctx)) {
      ctx.elsewhere.add(id);
      ctx.found.push({ level: "note", at, message: `"${label}" is not declared for ${osName(ctx.os)} — skipped here` });
      continue;
    }

    const built = spec.build({ id, label }, value.value, ctx);
    if (openWith && ctx.personal && (spec.kind === "folder" || spec.kind === "file")) {
      (built as { openWith?: string }).openWith = openWith;
    }
    items.push(built);
  }

  return items;
}

/** A file's commands, for this OS, whether or not they may run. */
function commands(entries: Entry[], ctx: Context): Command[] {
  const found: Command[] = [];
  const taken = new Set<string>();

  for (const { value: entry, at } of entries) {
    if (!isRecord(entry)) {
      ctx.found.push({ level: "error", at, message: "dropped: not an object" });
      continue;
    }

    const script = perOS(entry["run"], `${at}.run`, ctx);
    if (script.kind === "missing") {
      ctx.found.push({ level: "error", at, message: 'dropped: no "run" to execute' });
      continue;
    }

    const label = optionalString(entry["label"]) ?? script.label;
    const base = `command:${label.toLowerCase()}`;
    const fingerprint = JSON.stringify([entry["run"], entry["cwd"], entry["shell"], entry["env"], entry["background"], entry["finishes"], entry["timeout"]]);
    if (taken.has(base) && ctx.valueById.get(base) === fingerprint) {
      ctx.idsByAt.set(at, base);
      continue;
    }

    const id = uniqueId(base, taken);
    ctx.idsByAt.set(at, id);
    ctx.valueById.set(id, fingerprint);

    if (script.kind !== "here" || !allowedHere(entry["os"], `${at}.os`, ctx)) {
      ctx.elsewhere.add(id);
      ctx.found.push({ level: "note", at, message: `"${label}" is not declared for ${osName(ctx.os)} — skipped here` });
      continue;
    }

    const command: Command = { id, label, run: script.value };
    // A command's `cwd` is relative to the file too, so `packages/api` means the same
    // thing here as it does in a folder's path.
    // Where it runs: what it says, relative to the file — and otherwise the project's own
    // directory, since `pnpm dev` means this project's dev script, not whatever directory a
    // new terminal window happens to open in. A personal workspace belongs to no
    // directory, so its commands start where your shell does.
    const cwd = optionalString(entry["cwd"]);
    if (cwd) command.cwd = absolute(cwd, ctx.root);
    else if (!ctx.personal) command.cwd = ctx.root;
    if (entry["background"] === true) command.background = true;
    if (entry["finishes"] !== undefined) {
      if (typeof entry["finishes"] === "boolean") {
        if (entry["finishes"]) command.finishes = true;
        if (entry["finishes"] && entry["background"] === true) {
          ctx.found.push({ level: "warning", at: `${at}.background`, message: '"background" does nothing on a command that finishes: Wisp waits for it here' });
        }
      } else {
        ctx.found.push({ level: "warning", at: `${at}.finishes`, message: '"finishes" must be true or false — it is ignored' });
      }
    }
    if (entry["timeout"] !== undefined) {
      const timeout = parseDuration(entry["timeout"]);
      if (timeout === undefined) {
        ctx.found.push({ level: "warning", at: `${at}.timeout`, message: `"${String(entry["timeout"])}" is not a timeout — it is ignored`, hint: 'Use seconds, or "30s", "10m", "1h"' });
      } else if (!command.finishes) {
        ctx.found.push({ level: "warning", at: `${at}.timeout`, message: '"timeout" only applies to a command that finishes — it is ignored', hint: 'Add "finishes": true, or remove the timeout' });
      } else {
        command.timeout = timeout;
      }
    }

    const restart = entry["restart"];
    if (restart !== undefined && restart !== "no" && restart !== false) {
      if (restart === "on-failure" || restart === "always") command.restart = restart;
      else {
        ctx.found.push({
          level: "warning",
          at: `${at}.restart`,
          message: `"${String(restart)}" is not a restart policy — it is ignored`,
          hint: 'Use "on-failure" (after a crash) or "always"',
        });
      }
    }

    const shell = entry["shell"];
    if (shell !== undefined) {
      if (typeof shell === "string" && (SHELLS as readonly string[]).includes(shell)) {
        command.shell = shell as ShellKind;
      } else {
        ctx.found.push({
          level: "warning",
          at: `${at}.shell`,
          message: `"${String(shell)}" is not a shell Wisp knows — the platform's usual one is used`,
          hint: `Known shells: ${SHELLS.join(", ")}`,
        });
      }
    }

    const env = environment(entry["env"], `${at}.env`, ctx);
    if (env) command.env = env;

    found.push(command);
  }

  return found;
}

/** A command's `env`: names to values, with numbers and booleans written as they read. */
function environment(value: unknown, at: string, ctx: Context): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    ctx.found.push({ level: "warning", at, message: '"env" must be an object of names to values — it is ignored' });
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      ctx.found.push({ level: "warning", at: `${at}.${name}`, message: `"${name}" is not a valid variable name — it is ignored` });
      continue;
    }
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      env[name] = String(entry);
    } else {
      ctx.found.push({ level: "warning", at: `${at}.${name}`, message: "a value must be a string, number or boolean — it is ignored" });
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Pipelines, with their steps: something to open or run, a wait, or another bolt to run first.
 * A bolt in the override replaces the project's bolt of the same name, which is how you
 * make a shared bolt your own.
 */
function bolts(entries: Entry[], ctx: Context): Pipeline[] {
  const result: Pipeline[] = [];
  const index = new Map<string, number>();
  const skippedSteps = new Map<string, number>();

  for (const { value: entry, at } of entries) {
    if (!isRecord(entry)) {
      ctx.found.push({ level: "error", at, message: "dropped: not an object" });
      continue;
    }

    const label = optionalString(entry["label"]);
    if (!label) {
      ctx.found.push({ level: "error", at, message: 'dropped: no "label"' });
      continue;
    }

    const id = `pipeline:${label.toLowerCase()}`;
    const existing = index.get(id);
    const fromLocal = at.startsWith("local ");
    if (existing !== undefined && !fromLocal) {
      ctx.found.push({ level: "error", at: `${at}.label`, message: `dropped: a second pipeline called "${label}"` });
      continue;
    }

    const listed = Array.isArray(entry["steps"]) ? (entry["steps"] as unknown[]) : [];
    if (!Array.isArray(entry["steps"])) {
      ctx.found.push({ level: "warning", at: `${at}.steps`, message: `"${label}" names nothing to open` });
    }

    const { steps, skipped, broken } = parseSteps(listed, `${at}.steps`, ctx);

    if (steps.length === 0 && listed.length > 0 && skipped === 0) {
      ctx.found.push({ level: "error", at, message: `"${label}" resolved to nothing — running it would open nothing` });
    }
    if (steps.length === 0 && skipped > 0) {
      ctx.found.push({ level: "note", at, message: `"${label}" opens nothing on ${osName(ctx.os)}` });
    }
    skippedSteps.set(id, skipped);

    const bolt: Pipeline = { id, label, steps, ...(broken ? { broken: `"${label}" can't run: ${broken}` } : {}) };
    const notes = optionalString(entry["notes"]);
    if (notes) bolt.notes = notes;
    const slug = optionalString(entry["slug"]);
    if (slug && SLUG.test(slug)) bolt.slug = slug;
    else if (slug) ctx.found.push({ level: "warning", at: `${at}.slug`, message: `"${slug}" is not a slug, so it is ignored`, hint: "Lowercase letters, digits and hyphens, like dev-stack" });
    const color = optionalString(entry["color"]);
    if (color) bolt.color = color;

    for (const key of Object.keys(entry)) {
      if (PIPELINE_KEYS.has(key)) continue;
      ctx.found.push({ level: "warning", at: `${at}.${key}`, message: `"${key}" is not something a pipeline can set — it is ignored`, hint: `Known keys: ${[...PIPELINE_KEYS].join(", ")}` });
    }

    if (entry["confirm"] !== undefined) {
      if (entry["confirm"] === true) bolt.confirm = `Run "${label}"?`;
      else if (typeof entry["confirm"] === "string" && entry["confirm"].trim()) bolt.confirm = entry["confirm"].trim();
      else if (entry["confirm"] !== false) {
        ctx.found.push({ level: "warning", at: `${at}.confirm`, message: '"confirm" is the question to ask before it runs, or true — it is ignored' });
      }
    }

    if (entry["inputs"] !== undefined) {
      const inputs = parseInputs(entry["inputs"], `${at}.inputs`, ctx);
      if (inputs.length > 0) bolt.inputs = inputs;
    }
    const declared = new Set((bolt.inputs ?? []).map((input) => input.name));
    const undeclared = (text: string, where: string, address?: string) => {
      const inAddress = new Set(address ? placeholders(address) : []);
      for (const name of new Set(placeholders(text))) {
        if (declared.has(name)) continue;
        const hint = `Add it to the pipeline: "inputs": { "${name}": { "ask": "…" } }`;
        if (inAddress.has(name)) ctx.found.push({ level: "error", at: where, message: `{{${name}}} is not one of "${label}"'s inputs, so "${address}" can't be opened`, hint });
        else ctx.found.push({ level: "warning", at: where, message: `{{${name}}} is not one of "${label}"'s inputs — it is left as written`, hint });
      }
    };
    if (bolt.confirm) undeclared(bolt.confirm, `${at}.confirm`);
    for (const key of ["steps", "down"]) {
      const list = Array.isArray(entry[key]) ? (entry[key] as unknown[]) : [];
      list.forEach((step, position) => undeclared(JSON.stringify(step), `${at}.${key}[${position}]`, stepAddress(step)));
    }

    if (entry["keepGoing"] !== undefined) {
      if (typeof entry["keepGoing"] === "boolean") {
        if (entry["keepGoing"]) bolt.keepGoing = true;
      } else {
        ctx.found.push({ level: "warning", at: `${at}.keepGoing`, message: '"keepGoing" must be true or false — it is ignored' });
      }
    }

    // What `wisp down` runs after stopping what the bolt started: the teardown that is
    // not a process Wisp can stop, like `docker compose stop`.
    if (entry["down"] !== undefined) {
      if (Array.isArray(entry["down"])) {
        const parsed = parseSteps(entry["down"] as unknown[], `${at}.down`, ctx);
        const down = parsed.steps;
        if (parsed.broken && !bolt.broken) bolt.broken = `"${label}" can't be taken down: ${parsed.broken}`;
        if (down.length > 0) bolt.down = down;
      } else {
        ctx.found.push({ level: "error", at: `${at}.down`, message: '"down" must be a list of steps — it was ignored' });
      }
    }

    if (existing !== undefined) {
      result[existing] = bolt;
    } else {
      index.set(id, result.length);
      result.push(bolt);
    }
  }

  checkDependencies(result, ctx);
  checkSlugs(result, ctx);
  return result;
}

function parseInputs(value: unknown, at: string, ctx: Context): InputSpec[] {
  const warn = (where: string, message: string) => ctx.found.push({ level: "warning", at: where, message });
  if (!isRecord(value)) {
    warn(at, '"inputs" names each value the pipeline asks for, like { "env": { "ask": "Deploy where?" } } — it is ignored');
    return [];
  }
  const word = (item: unknown) => (typeof item === "string" || typeof item === "number" ? String(item).trim() : "");
  const specs: InputSpec[] = [];
  for (const [name, raw] of Object.entries(value)) {
    const where = `${at}.${name}`;
    if (!INPUT_NAME.test(name)) {
      warn(where, `"${name}" can't name an input: use letters, digits, - and _, starting with a letter — it is ignored`);
      continue;
    }
    if (!isRecord(raw)) {
      warn(where, `${name} is described by an object, like { "ask": "Deploy where?" } — it is ignored`);
      continue;
    }
    const spec: InputSpec = { name, ask: optionalString(raw["ask"]) ?? name };
    if (raw["choices"] !== undefined) {
      const listed = Array.isArray(raw["choices"]) ? [...new Set(raw["choices"].map(word).filter(Boolean))] : [];
      const choices = listed.filter((choice) => INPUT_VALUE.test(choice));
      for (const choice of listed.filter((entry) => !choices.includes(entry))) warn(`${where}.choices`, `${notPlain(name, choice)} — it is left out`);
      if (choices.length > 0) spec.choices = choices;
      else if (listed.length === 0) warn(`${where}.choices`, `"choices" is a list of the values to pick from — it is ignored`);
    }
    if (raw["default"] !== undefined) {
      const fallback = word(raw["default"]);
      if (!fallback) warn(`${where}.default`, `"default" is the value used when none is given — it is ignored`);
      else if (!INPUT_VALUE.test(fallback)) warn(`${where}.default`, `${notPlain(name, fallback)} — it is ignored`);
      else if (spec.choices && !spec.choices.includes(fallback)) warn(`${where}.default`, `"${fallback}" is not one of its choices — it is ignored`);
      else spec.default = fallback;
    }
    for (const key of Object.keys(raw)) {
      if (!INPUT_KEYS.has(key)) warn(`${where}.${key}`, `"${key}" is not something an input can set — it is ignored`);
    }
    specs.push(spec);
  }
  return specs;
}

/** One list of steps: a bolt's `steps` or its `down`. */
function parseSteps(listed: unknown[], at: string, ctx: Context): { steps: PipelineStep[]; skipped: number; broken?: string } {
  const steps: PipelineStep[] = [];
  let skipped = 0;
  const declared: { name?: string; after: string[]; where: string }[] = [];

  for (const [position, target] of listed.entries()) {
    const where = `${at}[${position}]`;
    if (!isRecord(target)) {
      ctx.found.push({ level: "error", at: where, message: 'dropped: a step is an object, like { "run": "pnpm dev" } or { "url": "localhost:3000" }' });
      continue;
    }
    const name = optionalString(target["label"]);
    const after = readAfter(target["after"], `${where}.after`, ctx);
    declared.push({ ...(name ? { name } : {}), after: after ?? [], where });
    const extra = { ...(name ? { name } : {}), ...(after && after.length > 0 ? { after } : {}) };

    if (inlineKind(target)) {
      const inlineId = ctx.idsByAt.get(where);
      if (!inlineId) continue;
      if (ctx.elsewhere.has(inlineId)) {
        skipped += 1;
        continue;
      }
      steps.push({ kind: "asset", id: inlineId, ...extra });
      continue;
    }

    const step = specialStep(target, where, ctx);
    if (step) steps.push({ ...step, ...extra });
  }

  const broken = checkAfter(declared, ctx);
  return { steps, skipped, ...(broken ? { broken } : {}) };
}

function readAfter(value: unknown, at: string, ctx: Context): string[] | undefined {
  if (value === undefined) return undefined;
  const listed = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  const names = listed?.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (!names || names.length !== (listed?.length ?? -1)) {
    ctx.found.push({ level: "error", at, message: '"after" names the steps this one waits for, by their label: "after": "install" or ["lint", "test"]' });
    return undefined;
  }
  return [...new Set(names)];
}

function checkAfter(steps: { name?: string; after: string[]; where: string }[], ctx: Context): string | undefined {
  let broken: string | undefined;
  const fail = (at: string, message: string) => {
    ctx.found.push({ level: "error", at, message });
    broken ??= message;
  };
  const count = new Map<string, number>();
  for (const step of steps) if (step.name) count.set(step.name, (count.get(step.name) ?? 0) + 1);
  for (const step of steps) {
    for (const name of step.after) {
      if (name === step.name) fail(`${step.where}.after`, `"${name}" can't wait for itself`);
      else if (!count.has(name)) fail(`${step.where}.after`, `waits for "${name}", but no step has that label`);
      else if ((count.get(name) ?? 0) > 1) fail(`${step.where}.after`, `waits for "${name}", but more than one step has that label`);
    }
  }
  if (broken) return broken;

  const byName = new Map(steps.flatMap((step) => (step.name ? [[step.name, step] as const] : [])));
  const state = new Map<object, "visiting" | "done">();
  const visit = (step: (typeof steps)[number], path: string[]): void => {
    if (state.get(step) === "done") return;
    if (state.get(step) === "visiting") {
      const cycle = [...path.slice(path.indexOf(step.name ?? "")), step.name ?? ""];
      fail(step.where, `these steps wait for each other: ${cycle.join(" → ")}`);
      return;
    }
    state.set(step, "visiting");
    for (const name of step.after) {
      const next = byName.get(name);
      if (next) visit(next, [...path, step.name ?? ""]);
    }
    state.set(step, "done");
  };
  for (const step of steps) visit(step, []);
  return broken;
}

/** A step written as an object: `{ "wait": … }` or `{ "pipeline": … }`. */
function specialStep(target: Record<string, unknown>, at: string, ctx: Context): PipelineStep | undefined {
  if (target["wait"] !== undefined) {
    const wait = parseWait(target["wait"]);
    if (!wait) {
      ctx.found.push({
        level: "error",
        at,
        message: "dropped: a wait needs seconds, a port or a url",
        hint: 'e.g. { "wait": 5 }, { "wait": "localhost:5432" }, { "wait": { "url": "http://localhost:3000", "timeout": 90 } }',
      });
      return undefined;
    }
    const names = "url" in wait ? envNames(wait.url) : [];
    if (names.length > 0 && !ctx.trusted && "url" in wait) {
      const id = `wait:${at}`;
      ctx.withheld.push({ kind: "wait", id, label: `wait for ${wait.url}`, value: wait.url, reason: `reads ${names.map((name) => `$${name}`).join(", ")} from your environment` });
      return { kind: "wait", wait, held: id };
    }
    return { kind: "wait", wait };
  }

  const compose = optionalString(target["compose"]);
  if (compose) {
    const services = Array.isArray(target["services"])
      ? (target["services"] as unknown[]).filter((service): service is string => typeof service === "string" && !!service.trim())
      : [];
    const file = absolute(compose, ctx.root);
    // A compose file runs whatever images it names, with whatever of your disk it mounts:
    // as much code as a command, so it waits for trust the same way.
    if (!ctx.trusted && !ctx.withheld.some((item) => item.id === `compose:${file}`)) {
      const what = services.length > 0 ? `Docker services: ${services.join(", ")}` : "Docker services";
      ctx.withheld.push({ kind: "compose", id: `compose:${file}`, label: what, value: compose, reason: "starts containers" });
    }
    return { kind: "compose", file, ...(services.length > 0 ? { services } : {}) };
  }

  const bolt = optionalString(target["pipeline"]);
  if (bolt) {
    if (target["workspace"] !== undefined) {
      ctx.found.push({
        level: "error",
        at,
        message: `dropped: a pipeline step runs a pipeline of this file. To run "${bolt}" from another project, run it as a command: { "run": "wisp use <its .wisp.json> ${bolt}", "finishes": true }`,
      });
      return undefined;
    }
    return { kind: "pipeline", bolt };
  }

  ctx.found.push({
    level: "error",
    at,
    message: 'dropped: a step needs one of "url", "folder", "file", "app", "run", "compose", "wait" or "pipeline"',
  });
  return undefined;
}

/**
 * A wait, however it was written.
 *
 * `5` waits five seconds. `"5432"` or `"db:5432"` waits for a port, `"http://…"` for a url
 * to answer. The object form says the same with a `timeout`.
 */
const WAIT_URL = /^(https?:\/\/|\{\{\s*(env\.)?[A-Za-z_][A-Za-z0-9_-]*\s*\}\})/i;

export function parseWait(value: unknown): WaitSpec | undefined {
  if (typeof value === "number") return value > 0 ? { seconds: value } : undefined;

  if (typeof value === "string") {
    const text = value.trim();
    if (WAIT_URL.test(text)) return { url: text, timeout: DEFAULT_WAIT_TIMEOUT };
    const port = /^(?:([\w.-]+):)?(\d{1,5})$/.exec(text);
    if (port) return { port: Number(port[2]), host: port[1] ?? "localhost", timeout: DEFAULT_WAIT_TIMEOUT };
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(text);
    if (seconds) return { seconds: Number(seconds[1]) };
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  const timeout =
    typeof value["timeout"] === "number" && value["timeout"] > 0 ? value["timeout"] : DEFAULT_WAIT_TIMEOUT;

  if (typeof value["url"] === "string" && WAIT_URL.test(value["url"].trim())) {
    const status = value["status"];
    return { url: value["url"], timeout, ...(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? { status: status as number } : {}) };
  }
  if (typeof value["port"] === "number" && value["port"] > 0 && value["port"] < 65536) {
    const host = optionalString(value["host"]) ?? "localhost";
    return { port: value["port"], host, timeout };
  }
  if (typeof value["seconds"] === "number" && value["seconds"] > 0) return { seconds: value["seconds"] };
  return undefined;
}

/**
 * Dependencies within this file: each must name a bolt that exists, and no bolt may end
 * up needing itself. Dependencies on other workspaces can only be checked when they run.
 */
function checkSlugs(bolts: Pipeline[], ctx: Context): void {
  const seen = new Map<string, string>();
  for (const bolt of bolts) {
    const slug = pipelineSlug(bolt);
    const other = seen.get(slug);
    if (other) ctx.found.push({ level: "warning", at: "pipelines", pipeline: bolt.label, message: `"${other}" and "${bolt.label}" both answer to ${slug}`, hint: 'Give one of them a different "slug": until then, neither runs by that name' });
    else seen.set(slug, bolt.label);
  }
}

function checkDependencies(bolts: Pipeline[], ctx: Context): void {
  const byLabel = new Map(bolts.map((bolt) => [bolt.label.toLowerCase(), bolt]));

  for (const bolt of bolts) {
    for (const step of bolt.steps) {
      if (step.kind !== "pipeline") continue;
      if (!byLabel.has(step.bolt.toLowerCase())) {
        ctx.found.push({
          level: "error",
          at: `pipelines`,
          pipeline: bolt.label,
          message: `"${bolt.label}" runs a pipeline called "${step.bolt}", which this file does not declare`,
          hint: `Pick one of this file's pipelines, or add one called "${step.bolt}"`,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const reported = new Set<string>();

  const visit = (bolt: Pipeline, path: string[]): void => {
    if (done.has(bolt.id)) return;
    if (visiting.has(bolt.id)) {
      const cycle = [...path.slice(path.indexOf(bolt.label)), bolt.label];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        ctx.found.push({
          level: "error",
          at: "pipelines",
          pipeline: cycle[0] as string,
          message: `these pipelines need each other: ${cycle.join(" → ")}`,
          hint: "Running any of them would be refused — remove one of the dependencies",
        });
      }
      return;
    }
    visiting.add(bolt.id);
    for (const step of bolt.steps) {
      if (step.kind !== "pipeline") continue;
      const next = byLabel.get(step.bolt.toLowerCase());
      if (next) visit(next, [...path, bolt.label]);
    }
    visiting.delete(bolt.id);
    done.add(bolt.id);
  };

  for (const bolt of bolts) visit(bolt, []);
}

/**
 * Everything wrong with a workspace file, including what only the filesystem can answer.
 *
 * Separate from reading because these checks cost a `stat` per asset: worth paying when
 * you are asking whether the file is right, not on every run.
 */
export async function checkProject(file: string, options: ReadOptions = {}): Promise<WorkspaceRead> {
  const read = await readProjectFile(file, options);
  const os = options.os ?? currentOS();
  const root = dirname(read.workspace.file);
  const found = [...read.diagnostics];

  const bytes = await readTrustedBytes(read.workspace.file);
  const sources: Sources = { main: parseObject(bytes.main, read.workspace.file) };
  if (bytes.local && read.workspace.local) sources.local = parseObject(bytes.local, read.workspace.local);
  const scratch: Context = {
    root,
    os,
    personal: read.workspace.personal,
    trusted: read.workspace.trusted,
    defaults: {},
    found: [],
    elsewhere: new Set(),
    withheld: [],
    idsByAt: new Map(),
    valueById: new Map(),
  };

  const pipelineEntries = sectionEntries(sources, "pipelines", scratch);
  const inline = inlineEntries(pipelineEntries);
  for (const [entries, kind] of [
    [inline.folders, "folder"],
    [inline.files, "file"],
  ] as const) {
    for (const { value: entry, at } of entries) {
      const written = writtenPath(entry, kind);
      if (!written) continue;
      // Only what applies here: a Linux-only folder is not missing on a Mac.
      if (isRecord(entry) && entry["os"] !== undefined && !osListIncludes(entry["os"], os)) continue;

      const path = absolute(written, root);
      const committed = !read.workspace.personal && !at.startsWith("local ");

      if (committed && (written.startsWith("~") || isAbsolute(written))) {
        // Only offer the relative form when the asset is genuinely inside the project —
        // otherwise `relative()` gives a ladder of `..` worse than the absolute path.
        const inside = relative(root, path);
        found.push({
          level: "warning",
          at: `${at}.${kind}`,
          message: `"${written}" is a path on your machine, not this project's`,
          ...(inside && !inside.startsWith("..")
            ? { hint: `Relative to the file is what travels: "${inside}"` }
            : { hint: `A committed path should be relative — or move it to ${LOCAL_FILE}` }),
        });
      }

      const stats = await stat(path).catch(() => undefined);
      if (!stats) {
        found.push({ level: "error", at: `${at}.${kind}`, message: `no such ${kind}: ${path}` });
        continue;
      }
      if (stats.isDirectory() !== (kind === "folder") && !(kind === "folder" && path.endsWith(".app"))) {
        found.push({
          level: "error",
          at: `${at}.${kind}`,
          message: `${path} is a ${kind === "folder" ? "file" : "folder"}, not a ${kind}`,
        });
      }
    }
  }

  for (const link of read.workspace.links) {
    if (!isUrlish(link.url)) {
      found.push({ level: "error", at: "pipelines", message: `"${link.url}" is not a url Wisp can open` });
    }
  }

  return { ...read, diagnostics: tagPipelines(found, pipelineEntries) };
}

type Picked =
  | { kind: "here"; value: string; label: string }
  | { kind: "elsewhere"; label: string }
  | { kind: "missing" };

function plain(value: unknown): Picked {
  const text = optionalString(value);
  return text ? { kind: "here", value: text, label: text } : { kind: "missing" };
}

/**
 * A value that may be written per OS: `"code"`, or `{ "macos": "Visual Studio Code",
 * "linux": "code" }`. A map without this OS means the asset is declared, just not here.
 */
function perOS(value: unknown, at: string, ctx: Context): Picked {
  if (!isRecord(value)) return plain(value);

  const entries: [OS, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    const os = parseOS(key);
    if (!os) {
      ctx.found.push({
        level: "warning",
        at: `${at}.${key}`,
        message: `"${key}" is not an OS Wisp knows — it is ignored`,
        hint: `Known: ${KNOWN_OS_KEYS}`,
      });
      continue;
    }
    const text = optionalString(entry);
    if (text) entries.push([os, text]);
  }

  if (entries.length === 0) return { kind: "missing" };

  // Labelled by the first value written, so the label is the same on every OS — a bolt
  // that names it has to resolve everywhere, not just where it was written.
  const label = (entries[0] as [OS, string])[1];
  const here = entries.find(([os]) => os === ctx.os);
  return here ? { kind: "here", value: here[1], label } : { kind: "elsewhere", label };
}

/** An entry's `os` list, if it has one, says whether it applies here. */
function allowedHere(value: unknown, at: string, ctx: Context): boolean {
  if (value === undefined) return true;

  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!list) {
    ctx.found.push({ level: "warning", at, message: '"os" must be a list of operating systems — it is ignored' });
    return true;
  }

  const known = list.flatMap((entry) => {
    const os = typeof entry === "string" ? parseOS(entry) : undefined;
    return os ? [os] : [];
  });
  if (known.length !== list.length) {
    ctx.found.push({
      level: "warning",
      at,
      message: "some of these are not operating systems Wisp knows",
      hint: `Known: ${KNOWN_OS_KEYS}`,
    });
  }
  return known.length === 0 ? true : known.includes(ctx.os);
}

function osListIncludes(value: unknown, os: OS): boolean {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const known = list.flatMap((entry) => {
    const parsed = typeof entry === "string" ? parseOS(entry) : undefined;
    return parsed ? [parsed] : [];
  });
  return known.length === 0 || known.includes(os);
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

function writtenPath(entry: unknown, key: string): string | undefined {
  return isRecord(entry) && typeof entry[key] === "string" ? entry[key].trim() || undefined : undefined;
}

function stepAddress(step: unknown): string | undefined {
  if (!isRecord(step)) return undefined;
  if (typeof step["url"] === "string") return step["url"];
  const wait = step["wait"];
  if (isRecord(wait) && typeof wait["url"] === "string") return wait["url"];
  return undefined;
}

function isUrlish(value: string): boolean {
  const filled = value.replace(/\{\{\s*(env\.)?[A-Za-z_][A-Za-z0-9_-]*\s*\}\}/g, "1");
  try {
    new URL(/^[a-z][a-z0-9+.-]*:/i.test(filled) ? filled : `https://${filled}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path as written in a workspace file, made absolute.
 *
 * Relative is the norm and the point — `packages/core` means the same thing on every
 * machine. An absolute path or a `~` still works, for the odd asset that genuinely lives
 * at a fixed place.
 */
export function absolute(path: string, root: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("~")) return expandHome(trimmed);
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(root, trimmed);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

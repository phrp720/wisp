import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getOpenWithDefaults } from "./config.js";
import { SpecterError, describe } from "./errors.js";
import { currentOS, expandHome, workspacesDir } from "./paths.js";
import { hashContents, localFileFor, readTrustedBytes, trustStateOf } from "./trust.js";
import type {
  AppRef,
  Bolt,
  BoltStep,
  Command,
  Diagnostic,
  FileRef,
  Folder,
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
export const PROJECT_FILE = ".specter.json";

/** The personal override beside it, meant to be gitignored. */
export const LOCAL_FILE = ".specter.local.json";

/**
 * Where the schema lives, so a file can point an editor at it.
 *
 * Unversioned on purpose: the format only ever gains optional keys, and a file pinned to
 * last year's copy would start complaining about a key that works.
 */
export const PROJECT_SCHEMA_URL =
  "https://raw.githubusercontent.com/phrp720/specter/main/schema/specter.schema.json";

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
  // Not read by Specter — it is there so editors validate the file as you type.
  "$schema",
  "name",
  "icon",
  "color",
  "notes",
  "links",
  "folders",
  "files",
  "apps",
  "commands",
  "bolts",
]);

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
 * Whether a file really lives in Specter's own workspaces directory, and so is yours.
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
  /** Read as if on this OS. Defaults to the one Specter is running on. */
  os?: OS;
}

/**
 * Read a workspace file — and its local override, when it has one — with everything
 * Specter had to say about it.
 *
 * Paths are relative to the file, since a committed file cannot know where anyone cloned
 * it. Bolts name their assets by label — ids are derived here, because a hand-written,
 * code-reviewed file has no business carrying UUIDs. And nothing is dropped in silence.
 */
export async function readProjectFile(file: string, options: ReadOptions = {}): Promise<WorkspaceRead> {
  const given = resolve(expandHome(file));
  // The real path is the identity, so trust and the personal check cannot be fooled by a
  // link, and a project reached through two different symlinks is one project.
  const path = await realpath(given).catch((error: unknown) => {
    throw new SpecterError(`Could not read ${given}: ${describe(error)}`, "PROJECT_READ_FAILED");
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
    throw new SpecterError(`${file} is not valid JSON: ${describe(error)}`, "PROJECT_INVALID");
  }
  if (!isRecord(parsed)) throw new SpecterError(`${file} does not contain an object`, "PROJECT_INVALID");
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
        hint: `Known keys: ${[...KNOWN_KEYS].join(", ")}`,
      });
    }
  }

  // Scalars from the override win; lists from it are added after the project's own.
  const scalar = (key: string) => optionalString(sources.local?.[key]) ?? optionalString(sources.main[key]);
  const section = (key: string) => sectionEntries(sources, key, ctx);

  // Assets written inside a bolt are declared like any other, after the shared ones, so a
  // bolt can list what it opens directly and a shared section is only for sharing.
  const boltEntries = section("bolts");
  const inline = inlineEntries(boltEntries);

  const links = assets<Link>([...section("links"), ...inline.links], LINKS, ctx);
  const folders = assets<Folder>([...section("folders"), ...inline.folders], FOLDERS, ctx);
  const files = assets<FileRef>([...section("files"), ...inline.files], FILES, ctx);
  const apps = assets<AppRef>([...section("apps"), ...inline.apps], APPS, ctx);
  const declaredCommands = commands([...section("commands"), ...inline.commands], ctx);

  const workspace: Workspace = {
    id: input.file,
    name: scalar("name") ?? defaultName(input.file, input.personal),
    file: input.file,
    personal: input.personal,
    trusted,
    links,
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

  // Everything declared for this OS is nameable by a bolt, withheld or not: a withheld
  // asset is "not yet", not "no such thing".
  const declared = [...links, ...folders, ...files, ...apps, ...declaredCommands];
  workspace.bolts = bolts(boltEntries, declared, ctx);

  if (!trusted && ctx.withheld.length > 0) {
    const commandCount = ctx.withheld.filter((item) => item.kind === "command").length;
    const other = ctx.withheld.length - commandCount;
    const parts = [
      commandCount > 0 ? plural(commandCount, "command") : "",
      other > 0 ? `${plural(other, "item")} that would run code when opened` : "",
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
          ? "Read what changed with `specter check`, then `specter trust` again"
          : "Read them with `specter check`, then allow them with `specter trust`",
    });
  }

  return { workspace, diagnostics: ctx.found, trust: input.trust, declaredCommands, withheld: ctx.withheld };
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
  if (kind === "app") {
    // A name or bundle id is looked up among installed apps; a path is whatever is there.
    return /[\\/]/.test(value) ? "an app given as a path runs whatever is at that path" : undefined;
  }
  if (kind !== "file" && kind !== "folder") return undefined;

  const extension = extname(value.replace(/[\\/]+$/, "")).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(extension)) return `a ${extension} file runs when opened`;
  return undefined;
}

/** `acme` for `~/dev/acme/.specter.json`, `Morning` for `workspaces/Morning.specter.json`. */
function defaultName(file: string, personal: boolean): string {
  if (personal) {
    const name = basename(file).replace(/(\.specter)?\.json$/i, "");
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
function inlineEntries(boltEntries: Entry[]): Record<InlineSection, Entry[]> {
  const found: Record<InlineSection, Entry[]> = { links: [], folders: [], files: [], apps: [], commands: [] };
  for (const { value: bolt, at } of boltEntries) {
    if (!isRecord(bolt)) continue;
    for (const list of ["targets", "down"] as const) {
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

function isInline(at: string): boolean {
  return at.includes(".targets[") || at.includes(".down[");
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
  keys: ["path", "folder"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.folder ? { openWith: ctx.defaults.folder } : {}),
  }),
};

const FILES: AssetSpec<FileRef> = {
  kind: "file",
  keys: ["path", "file"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.file ? { openWith: ctx.defaults.file } : {}),
  }),
};

const APPS: AssetSpec<AppRef> = {
  kind: "app",
  // `bundleIdOrAppName` is what the macOS-only format called it.
  keys: ["app", "bundleIdOrAppName"],
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

    let written: unknown = typeof entry === "string" ? entry : undefined;
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
        hint: 'Set your own with `specter open-with folder "Visual Studio Code"`',
      });
    }

    const base = `${spec.kind}:${label.toLowerCase()}`;
    const fingerprint = JSON.stringify(written);
    // The same thing listed inline in two bolts is one asset, not a duplicate to warn about.
    if (isInline(at) && taken.has(base) && ctx.valueById.get(base) === fingerprint) {
      ctx.idsByAt.set(at, base);
      continue;
    }

    const id = uniqueId(base, taken, `${at}.label`, spec.kind, label, ctx);
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
    const fingerprint = JSON.stringify([entry["run"], entry["cwd"], entry["shell"], entry["env"], entry["background"]]);
    if (isInline(at) && taken.has(base) && ctx.valueById.get(base) === fingerprint) {
      ctx.idsByAt.set(at, base);
      continue;
    }

    const id = uniqueId(base, taken, `${at}.label`, "command", label, ctx);
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

    const shell = entry["shell"];
    if (shell !== undefined) {
      if (typeof shell === "string" && (SHELLS as readonly string[]).includes(shell)) {
        command.shell = shell as ShellKind;
      } else {
        ctx.found.push({
          level: "warning",
          at: `${at}.shell`,
          message: `"${String(shell)}" is not a shell Specter knows — the platform's usual one is used`,
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
 * Bolts, with their steps resolved against what the file declared.
 *
 * A step is an asset's label (or its id — `folder:spec` — when a folder and a file share
 * one), a wait, or another bolt to run first. A bolt in the override replaces the
 * project's bolt of the same name, which is how you make a shared bolt your own.
 */
function bolts(entries: Entry[], declared: { id: string; label: string }[], ctx: Context): Bolt[] {
  const byName = new Map<string, string>();
  for (const asset of declared) {
    byName.set(asset.id, asset.id);
    const key = asset.label.toLowerCase();
    if (!byName.has(key)) byName.set(key, asset.id);
  }
  // Declared for another OS: a bolt naming one is right, it is just not here.
  for (const id of ctx.elsewhere) {
    byName.set(id, id);
    const key = id.slice(id.indexOf(":") + 1).replace(/~\d+$/, "");
    if (!byName.has(key)) byName.set(key, id);
  }

  const result: Bolt[] = [];
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

    const id = `bolt:${label.toLowerCase()}`;
    const existing = index.get(id);
    const fromLocal = at.startsWith("local ");
    if (existing !== undefined && !fromLocal) {
      ctx.found.push({ level: "error", at: `${at}.label`, message: `dropped: a second bolt called "${label}"` });
      continue;
    }

    const listed = Array.isArray(entry["targets"]) ? (entry["targets"] as unknown[]) : [];
    if (!Array.isArray(entry["targets"])) {
      ctx.found.push({ level: "warning", at: `${at}.targets`, message: `"${label}" names nothing to open` });
    }

    const { steps, skipped } = parseSteps(listed, `${at}.targets`, label, byName, declared, ctx);

    if (steps.length === 0 && listed.length > 0 && skipped === 0) {
      ctx.found.push({ level: "error", at, message: `"${label}" resolved to nothing — running it would open nothing` });
    }
    if (steps.length === 0 && skipped > 0) {
      ctx.found.push({ level: "note", at, message: `"${label}" opens nothing on ${osName(ctx.os)}` });
    }
    skippedSteps.set(id, skipped);

    const bolt: Bolt = { id, label, steps };
    const color = optionalString(entry["color"]);
    if (color) bolt.color = color;

    if (entry["job"] !== undefined) {
      if (typeof entry["job"] === "boolean") {
        if (entry["job"]) bolt.job = true;
      } else {
        ctx.found.push({ level: "warning", at: `${at}.job`, message: '"job" must be true or false — it is ignored' });
      }
    }

    // What `specter down` runs after stopping what the bolt started: the teardown that is
    // not a process Specter can stop, like `docker compose stop`.
    if (entry["down"] !== undefined) {
      if (Array.isArray(entry["down"])) {
        const down = parseSteps(entry["down"] as unknown[], `${at}.down`, label, byName, declared, ctx).steps;
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
  return result;
}

/** One list of steps — a bolt's `targets` or its `down` — resolved against what was declared. */
function parseSteps(
  listed: unknown[],
  at: string,
  label: string,
  byName: Map<string, string>,
  declared: { id: string; label: string }[],
  ctx: Context,
): { steps: BoltStep[]; skipped: number } {
  const steps: BoltStep[] = [];
  let skipped = 0;

  for (const [position, target] of listed.entries()) {
    const where = `${at}[${position}]`;

    if (isRecord(target) && inlineKind(target)) {
      // Declared already, with the shared sections; dropped there if it was malformed.
      const inlineId = ctx.idsByAt.get(where);
      if (!inlineId) continue;
      if (ctx.elsewhere.has(inlineId)) {
        skipped += 1;
        continue;
      }
      if (!steps.some((step) => step.kind === "asset" && step.id === inlineId)) steps.push({ kind: "asset", id: inlineId });
      continue;
    }

    if (isRecord(target)) {
      const step = specialStep(target, where, ctx);
      if (step) steps.push(step);
      continue;
    }

    if (typeof target !== "string" || !target.trim()) {
      ctx.found.push({ level: "error", at: where, message: "dropped: not the name of an asset, a wait or a bolt" });
      continue;
    }

    const resolved = byName.get(target.trim().toLowerCase());
    if (!resolved) {
      ctx.found.push({
        level: "error",
        at: where,
        message: `"${label}" names "${target}", which this file does not declare`,
        ...hintFor(target, declared),
      });
      continue;
    }
    if (ctx.elsewhere.has(resolved)) {
      skipped += 1;
      continue;
    }
    if (steps.some((step) => step.kind === "asset" && step.id === resolved)) {
      ctx.found.push({ level: "warning", at: where, message: `"${target}" is already in "${label}" — it opens once` });
      continue;
    }
    steps.push({ kind: "asset", id: resolved });
  }

  return { steps, skipped };
}

/** A target written as an object: `{ "wait": … }` or `{ "bolt": …, "workspace"?: … }`. */
function specialStep(target: Record<string, unknown>, at: string, ctx: Context): BoltStep | undefined {
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

  const bolt = optionalString(target["bolt"]);
  if (bolt) {
    const workspace = optionalString(target["workspace"]);
    return { kind: "bolt", bolt, ...(workspace ? { workspace } : {}) };
  }

  ctx.found.push({
    level: "error",
    at,
    message: 'dropped: an object target needs one of "url", "folder", "file", "app", "run", "compose", "wait" or "bolt"',
  });
  return undefined;
}

/**
 * A wait, however it was written.
 *
 * `5` waits five seconds. `"5432"` or `"db:5432"` waits for a port, `"http://…"` for a url
 * to answer. The object form says the same with a `timeout`.
 */
export function parseWait(value: unknown): WaitSpec | undefined {
  if (typeof value === "number") return value > 0 ? { seconds: value } : undefined;

  if (typeof value === "string") {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) return { url: text, timeout: DEFAULT_WAIT_TIMEOUT };
    const port = /^(?:([\w.-]+):)?(\d{1,5})$/.exec(text);
    if (port) return { port: Number(port[2]), host: port[1] ?? "localhost", timeout: DEFAULT_WAIT_TIMEOUT };
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(text);
    if (seconds) return { seconds: Number(seconds[1]) };
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  const timeout =
    typeof value["timeout"] === "number" && value["timeout"] > 0 ? value["timeout"] : DEFAULT_WAIT_TIMEOUT;

  if (typeof value["url"] === "string" && /^https?:\/\//i.test(value["url"])) {
    return { url: value["url"], timeout };
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
function checkDependencies(bolts: Bolt[], ctx: Context): void {
  const byLabel = new Map(bolts.map((bolt) => [bolt.label.toLowerCase(), bolt]));

  for (const bolt of bolts) {
    for (const step of bolt.steps) {
      if (step.kind !== "bolt" || step.workspace) continue;
      if (!byLabel.has(step.bolt.toLowerCase())) {
        ctx.found.push({
          level: "error",
          at: `bolts`,
          message: `"${bolt.label}" needs a bolt called "${step.bolt}", which this file does not declare`,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const reported = new Set<string>();

  const visit = (bolt: Bolt, path: string[]): void => {
    if (done.has(bolt.id)) return;
    if (visiting.has(bolt.id)) {
      const cycle = [...path.slice(path.indexOf(bolt.label)), bolt.label];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        ctx.found.push({
          level: "error",
          at: "bolts",
          message: `these bolts need each other: ${cycle.join(" → ")}`,
          hint: "Running any of them would be refused — remove one of the dependencies",
        });
      }
      return;
    }
    visiting.add(bolt.id);
    for (const step of bolt.steps) {
      if (step.kind !== "bolt" || step.workspace) continue;
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

  for (const [section, kind] of [
    ["folders", "folder"],
    ["files", "file"],
  ] as const) {
    for (const { value: entry, at } of sectionEntries(sources, section, scratch)) {
      const written = writtenPath(entry);
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
          at: `${at}.path`,
          message: `"${written}" is a path on your machine, not this project's`,
          ...(inside && !inside.startsWith("..")
            ? { hint: `Relative to the file is what travels: "${inside}"` }
            : { hint: `A committed path should be relative — or move it to ${LOCAL_FILE}` }),
        });
      }

      const stats = await stat(path).catch(() => undefined);
      if (!stats) {
        found.push({ level: "error", at: `${at}.path`, message: `no such ${kind}: ${path}` });
        continue;
      }
      if (stats.isDirectory() !== (kind === "folder") && !(kind === "folder" && path.endsWith(".app"))) {
        found.push({
          level: "error",
          at: `${at}.path`,
          message: `${path} is a ${kind === "folder" ? "file" : "folder"}, not a ${kind}`,
        });
      }
    }
  }

  for (const link of read.workspace.links) {
    if (!isUrlish(link.url)) {
      found.push({ level: "error", at: `links`, message: `"${link.url}" is not a url Specter can open` });
    }
  }

  return { ...read, diagnostics: found };
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
        message: `"${key}" is not an OS Specter knows — it is ignored`,
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
      message: "some of these are not operating systems Specter knows",
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

/**
 * Two assets of one kind sharing a label is a mistake, but not one worth losing an asset
 * over: both are kept with distinct ids, and a bolt naming that label gets the first.
 */
function uniqueId(base: string, taken: Set<string>, at: string, kind: string, label: string, ctx: Context): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}~${n}`;
  if (id !== base) {
    ctx.found.push({
      level: "warning",
      at,
      message: `a second ${kind} called "${label}" — a bolt naming it gets the first`,
      hint: `Rename it, or say "${id}" in a bolt to mean this one`,
    });
  }
  taken.add(id);
  return id;
}

function writtenPath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() || undefined;
  if (isRecord(entry) && typeof entry["path"] === "string") return entry["path"].trim() || undefined;
  return undefined;
}

function isUrlish(value: string): boolean {
  try {
    new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    return true;
  } catch {
    return false;
  }
}

/** The asset a mistyped target probably meant, when one is close enough to name. */
function hintFor(target: string, assets: { label: string }[]): { hint?: string } {
  const needle = target.trim().toLowerCase();
  const near = assets
    .map((asset) => ({ label: asset.label, distance: distance(needle, asset.label.toLowerCase()) }))
    .filter((candidate) => candidate.distance <= Math.max(2, Math.floor(needle.length / 3)))
    .sort((left, right) => left.distance - right.distance);

  if (near[0]) return { hint: `Did you mean "${near[0].label}"?` };
  if (assets.length > 0) return { hint: `Declared: ${assets.map((asset) => asset.label).join(", ")}` };
  return {};
}

/** Levenshtein, kept small and local — it exists to improve one error message. */
function distance(left: string, right: string): number {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
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

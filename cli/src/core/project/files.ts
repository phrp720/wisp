import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getOpenWithDefaults } from "../config.js";
import { WispError, describe } from "../errors.js";
import { currentOS, expandHome, workspacesDir } from "../paths.js";
import { hashContents, localFileFor, readTrustedBytes, trustStateOf } from "../trust.js";
import type { OS, TrustState, WorkspaceRead } from "../types.js";
import { type Context, type Sources, inlineEntries, sectionEntries } from "./context.js";
import { interpret, tagPipelines } from "./interpret.js";
import { osListIncludes } from "./os.js";
import { absolute, isRecord, isUrlish, writtenPath } from "./values.js";

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
export const PROJECT_SCHEMA_URL = "https://willowisp.dev/schema.json";

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

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SpecterError, describe, isNotFound } from "./errors.js";
import type { OS } from "./types.js";

/** The OS Specter is running on, or the one a test says it is. */
export function currentOS(): OS {
  const forced = process.env["SPECTER_OS"]?.trim();
  if (forced === "darwin" || forced === "linux" || forced === "win32") return forced;
  const platform = process.platform;
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

/**
 * Where Specter keeps its own files.
 *
 * `~/.config/specter` on macOS as well as Linux, rather than Application Support: this is
 * a command-line tool, and that is where a command-line user looks for — and keeps in
 * their dotfiles — a tool's configuration. Windows has its own convention, and gets it.
 */
export function configDir(): string {
  const override = process.env["SPECTER_HOME"]?.trim();
  if (override) return expandHome(override);

  if (currentOS() === "win32") {
    const appData = process.env["APPDATA"]?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "specter");
  }

  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return join(xdg || join(homedir(), ".config"), "specter");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function trustPath(): string {
  return join(configDir(), "trust.json");
}

/** Personal workspaces: the same format as a project file, kept here instead. */
export function workspacesDir(): string {
  return join(configDir(), "workspaces");
}

/**
 * Where Specter keeps what it does, as opposed to what you configured: the runs it is
 * tracking and their logs. Separate from config so a dotfiles repo never picks up logs.
 */
export function stateDir(): string {
  const override = process.env["SPECTER_STATE"]?.trim();
  if (override) return expandHome(override);

  const home = process.env["SPECTER_HOME"]?.trim();
  if (home) return join(expandHome(home), "state");

  if (currentOS() === "win32") {
    const local = process.env["LOCALAPPDATA"]?.trim() || join(homedir(), "AppData", "Local");
    return join(local, "specter", "state");
  }

  const xdg = process.env["XDG_STATE_HOME"]?.trim();
  return join(xdg || join(homedir(), ".local", "state"), "specter");
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

/** `~/dev/acme` rather than `/Users/someone/dev/acme`, for showing a path to its owner. */
export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/") || path.startsWith(home + "\\")) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Read a JSON file, or `undefined` when it does not exist yet. */
export async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new SpecterError(`Could not read ${file}: ${describe(error)}`, "READ_FAILED");
  }

  if (raw.trim() === "") return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw new SpecterError(`${file} is not valid JSON`, "INVALID_JSON");
  }
}

/**
 * Write JSON by way of a temporary file, so a crash mid-write leaves the old file whole
 * rather than half of the new one.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/** A lock older than this belongs to a process that died holding it. */
const STALE_LOCK_MS = 10_000;

/**
 * Run `work` while holding a lock on `file`.
 *
 * Every `specter` run records the project it used, so two terminals running bolts at once
 * would otherwise read the same config, each add their own entry, and the second write
 * would drop the first. A directory is the lock because creating one is atomic everywhere.
 */
export async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;

      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (attempt > 200) {
        throw new SpecterError(`Timed out waiting for ${lock} — remove it if no specter is running`, "LOCKED");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

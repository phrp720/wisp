import { resolve } from "node:path";

import { configPath, expandHome, readJson, withLock, writeJson } from "./paths.js";
import type { Config, KnownProject, NotifySettings, OpenWithDefaults } from "./types.js";

export const CONFIG_VERSION = 1;

/** How many project files to remember. Enough for anyone's active work, not a history. */
const KNOWN_PROJECT_LIMIT = 100;

export async function loadConfig(): Promise<Config> {
  const parsed = await readJson(configPath());
  return normalizeConfig(parsed);
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJson(configPath(), { ...config, version: CONFIG_VERSION });
}

/** Read, change and write the config as one step, so concurrent runs do not lose writes. */
export async function updateConfig(change: (config: Config) => Config): Promise<Config> {
  return withLock(configPath(), async () => {
    const next = change(await loadConfig());
    await saveConfig(next);
    return next;
  });
}

/** Whether you asked never to be offered a .wisp.json for this folder. */
export async function setupDeclined(dir: string): Promise<boolean> {
  const config = await loadConfig().catch(() => undefined);
  return (config?.noSetup ?? []).includes(resolve(expandHome(dir)));
}

/** "Don't ask again here": the dashboard stops offering to set this folder up. */
export async function declineSetup(dir: string): Promise<void> {
  const path = resolve(expandHome(dir));
  await updateConfig((config) => ({ ...config, noSetup: [...(config.noSetup ?? []).filter((entry) => entry !== path), path] }));
}

export async function getOpenWithDefaults(): Promise<OpenWithDefaults> {
  const config = await loadConfig().catch(() => undefined);
  return config?.openWith ?? {};
}

/** Set which app opens folders, files and commands. A blank value clears the entry. */
export async function setOpenWithDefaults(next: OpenWithDefaults): Promise<OpenWithDefaults> {
  const config = await updateConfig((current) => {
    const merged: OpenWithDefaults = { ...current.openWith };
    for (const key of ["folder", "file", "terminal"] as const) {
      if (!(key in next)) continue;
      const value = next[key]?.trim();
      if (value) merged[key] = value;
      else delete merged[key];
    }
    return { ...current, openWith: merged };
  });
  return config.openWith ?? {};
}

/** Whether the dashboard takes clicks and the scroll wheel. On unless you turned it off. */
export async function getMouse(): Promise<boolean> {
  const config = await loadConfig().catch(() => undefined);
  return config?.mouse ?? true;
}

/** Turn the dashboard's mouse support on or off. Only "off" is written down: on is the default. */
export async function setMouse(on: boolean): Promise<boolean> {
  const config = await updateConfig((current) => {
    const { mouse: _previous, ...rest } = current;
    return on ? rest : { ...rest, mouse: false };
  });
  return config.mouse ?? true;
}

export async function getNotify(): Promise<Required<Pick<NotifySettings, "when">> & NotifySettings> {
  const config = await loadConfig().catch(() => undefined);
  return { ...config?.notify, when: config?.notify?.when ?? "failures" };
}

export async function setNotify(change: NotifySettings): Promise<Required<Pick<NotifySettings, "when">> & NotifySettings> {
  const config = await updateConfig((current) => {
    const next: NotifySettings = { ...current.notify, ...change };
    if (next.when === "failures") delete next.when;
    if (!next.webhook?.trim()) delete next.webhook;
    else next.webhook = next.webhook.trim();
    const { notify: _previous, ...rest } = current;
    return Object.keys(next).length > 0 ? { ...rest, notify: next } : rest;
  });
  return { ...config.notify, when: config.notify?.when ?? "failures" };
}

/**
 * Remember a project file, so it can be listed and run from anywhere.
 *
 * Recorded when you use one, not when Wisp merely passes by: walking up out of a
 * directory is not the same as choosing to work in it.
 */
export async function recordProject(file: string, at = new Date()): Promise<void> {
  const path = resolve(expandHome(file));
  await updateConfig((config) => {
    const others = (config.projects ?? []).filter((project) => project.path !== path);
    const projects = [{ path, lastUsed: at.toISOString() }, ...others].slice(0, KNOWN_PROJECT_LIMIT);
    return { ...config, projects };
  });
}

/**
 * Add project files found on disk without marking them used, so they are listed after the
 * ones you actually work in. Returns how many were new.
 */
export async function addKnownProjects(files: string[]): Promise<number> {
  let added = 0;
  await updateConfig((config) => {
    const known = new Set((config.projects ?? []).map((project) => project.path));
    const fresh = files
      .map((file) => resolve(expandHome(file)))
      .filter((path) => !known.has(path))
      .map((path) => ({ path, lastUsed: "" }));
    added = fresh.length;
    return { ...config, projects: [...(config.projects ?? []), ...fresh].slice(0, KNOWN_PROJECT_LIMIT * 5) };
  });
  return added;
}

/** Directories `wisp scan` looks in when not given one. */
export async function setRoots(change: (roots: string[]) => string[]): Promise<string[]> {
  const config = await updateConfig((current) => ({ ...current, roots: change(current.roots ?? []) }));
  return config.roots ?? [];
}

/** Stop listing a project file. Returns false when it was not listed. */
export async function forgetProject(file: string): Promise<boolean> {
  const path = resolve(expandHome(file));
  let removed = false;
  await updateConfig((config) => {
    const projects = (config.projects ?? []).filter((project) => project.path !== path);
    removed = projects.length !== (config.projects ?? []).length;
    return { ...config, projects };
  });
  return removed;
}

export async function knownProjects(): Promise<KnownProject[]> {
  return (await loadConfig()).projects ?? [];
}

function normalizeConfig(value: unknown): Config {
  const config: Config = { version: CONFIG_VERSION };
  if (!isRecord(value)) return config;

  const openWith = value["openWith"];
  if (isRecord(openWith)) {
    const defaults: OpenWithDefaults = {};
    for (const key of ["folder", "file", "terminal"] as const) {
      const entry = openWith[key];
      if (typeof entry === "string" && entry.trim()) defaults[key] = entry.trim();
    }
    config.openWith = defaults;
  }

  const roots = value["roots"];
  if (Array.isArray(roots)) {
    config.roots = roots.filter((root): root is string => typeof root === "string" && !!root.trim());
  }

  const noSetup = value["noSetup"];
  if (Array.isArray(noSetup)) {
    config.noSetup = noSetup.filter((dir): dir is string => typeof dir === "string" && !!dir.trim());
  }

  if (typeof value["mouse"] === "boolean") config.mouse = value["mouse"];

  const notify = value["notify"];
  if (isRecord(notify)) {
    const settings: NotifySettings = {};
    if (notify["when"] === "all" || notify["when"] === "off") settings.when = notify["when"];
    if (typeof notify["webhook"] === "string" && notify["webhook"].trim()) settings.webhook = notify["webhook"].trim();
    if (Object.keys(settings).length > 0) config.notify = settings;
  }

  const projects = value["projects"];
  if (Array.isArray(projects)) {
    config.projects = projects.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry["path"] !== "string") return [];
      const lastUsed = typeof entry["lastUsed"] === "string" ? entry["lastUsed"] : "";
      return [{ path: entry["path"], lastUsed }];
    });
  }

  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

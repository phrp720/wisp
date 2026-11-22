import { extname } from "node:path";

import { envNames } from "../inputs.js";
import type { Diagnostic, OS, OpenWithDefaults, TargetKind, Withheld } from "../types.js";
import { isRecord } from "./values.js";

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

/** The two files a workspace may be made of. */
export interface Sources {
  main: Record<string, unknown>;
  local?: Record<string, unknown>;
}

export interface Context {
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

export interface Entry {
  value: unknown;
  /** Where it was written: `links[2]`, or `local links[0]` for the override. */
  at: string;
}

/**
 * Whether an asset may open without trust. Most may — a folder is a folder — but a file
 * that executes when opened, or an app given as a path rather than a name, is running
 * code the repository chose, which is exactly what trust exists to gate.
 */
export function allow(ctx: Context, kind: TargetKind, asset: { id: string; label: string }, value: string): boolean {
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

/** The key that makes an object target an inline asset, and which section it belongs to. */
const INLINE_KINDS = [
  ["url", "links"],
  ["folder", "folders"],
  ["file", "files"],
  ["app", "apps"],
  ["run", "commands"],
] as const;

type InlineSection = (typeof INLINE_KINDS)[number][1];

export function inlineKind(target: Record<string, unknown>): InlineSection | undefined {
  return INLINE_KINDS.find(([key]) => target[key] !== undefined)?.[1];
}

/** Every inline asset in every bolt, sorted into the section it would have been written in. */
export function inlineEntries(pipelineEntries: Entry[]): Record<InlineSection, Entry[]> {
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

export function sectionEntries(sources: Sources, key: string, ctx: Context): Entry[] {
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

/** A command's `env`: names to values, with numbers and booleans written as they read. */
export function environment(value: unknown, at: string, ctx: Context): Record<string, string> | undefined {
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

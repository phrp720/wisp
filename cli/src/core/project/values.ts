import { isAbsolute, resolve } from "node:path";

import { expandHome } from "../paths.js";

export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

export function writtenPath(entry: unknown, key: string): string | undefined {
  return isRecord(entry) && typeof entry[key] === "string" ? entry[key].trim() || undefined : undefined;
}

export function stepAddress(step: unknown): string | undefined {
  if (!isRecord(step)) return undefined;
  if (typeof step["url"] === "string") return step["url"];
  const wait = step["wait"];
  if (isRecord(wait) && typeof wait["url"] === "string") return wait["url"];
  return undefined;
}

export function isUrlish(value: string): boolean {
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

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { OS } from "../types.js";
import type { Context } from "./context.js";
import { isRecord, optionalString } from "./values.js";

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

type Picked =
  | { kind: "here"; value: string; label: string }
  | { kind: "elsewhere"; label: string }
  | { kind: "missing" };

export function plain(value: unknown): Picked {
  const text = optionalString(value);
  return text ? { kind: "here", value: text, label: text } : { kind: "missing" };
}

/**
 * A value that may be written per OS: `"code"`, or `{ "macos": "Visual Studio Code",
 * "linux": "code" }`. A map without this OS means the asset is declared, just not here.
 */
export function perOS(value: unknown, at: string, ctx: Context): Picked {
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

  // Labelled by the first value written, so the label is the same on every OS — a pipeline
  // that names it has to resolve everywhere, not just where it was written.
  const label = (entries[0] as [OS, string])[1];
  const here = entries.find(([os]) => os === ctx.os);
  return here ? { kind: "here", value: here[1], label } : { kind: "elsewhere", label };
}

/** An entry's `os` list, if it has one, says whether it applies here. */
export function allowedHere(value: unknown, at: string, ctx: Context): boolean {
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

export function osListIncludes(value: unknown, os: OS): boolean {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const known = list.flatMap((entry) => {
    const parsed = typeof entry === "string" ? parseOS(entry) : undefined;
    return parsed ? [parsed] : [];
  });
  return known.length === 0 || known.includes(os);
}

import { parseDuration } from "../text/duration.js";
import type { AppRef, Command, FileRef, Folder, Link, ShellKind, TargetKind } from "../types.js";
import { type Context, type Entry, environment } from "./context.js";
import { allowedHere, osName, perOS, plain } from "./os.js";
import { absolute, isRecord, optionalString, uniqueId } from "./values.js";

const SHELLS: readonly ShellKind[] = ["sh", "pwsh", "cmd"];

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

export const LINKS: AssetSpec<Link> = {
  kind: "link",
  keys: ["url"],
  perOS: false,
  build: (base, url) => ({ ...base, url }),
};

export const FOLDERS: AssetSpec<Folder> = {
  kind: "folder",
  keys: ["folder"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.folder ? { openWith: ctx.defaults.folder } : {}),
  }),
};

export const FILES: AssetSpec<FileRef> = {
  kind: "file",
  keys: ["file"],
  perOS: false,
  build: (base, path, ctx) => ({
    ...base,
    path: absolute(path, ctx.root),
    ...(ctx.defaults.file ? { openWith: ctx.defaults.file } : {}),
  }),
};

export const APPS: AssetSpec<AppRef> = {
  kind: "app",
  keys: ["app"],
  perOS: true,
  build: (base, app) => ({ ...base, app }),
};

/**
 * One section of assets, with ids derived from what they are and what they are called.
 *
 * `link:staging` rather than a UUID, so a pipeline can name the asset the way a human would,
 * and so the id is the same every time the file is read. The kind is part of the id: a
 * folder and a file may both be called `Spec`, and they are not the same asset.
 */
export function assets<T>(entries: Entry[], spec: AssetSpec<T>, ctx: Context): T[] {
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
    // The same thing listed inline in two pipelines is one asset, not a duplicate to warn about.
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
export function commands(entries: Entry[], ctx: Context): Command[] {
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

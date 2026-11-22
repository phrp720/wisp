import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { WispError, describe } from "./errors.js";
import { tildify, workspacesDir } from "./paths.js";
import { readProjectFile, type ReadOptions } from "./project.js";
import type { Workspace, WorkspaceRead } from "./types.js";

/** A workspace file Wisp knows about but could not read. */
export interface Unreadable {
  file: string;
  error: string;
}

export interface Discovered {
  /** Personal workspaces first, then projects most recently used first. */
  reads: WorkspaceRead[];
  unreadable: Unreadable[];
}

/** Files in the personal workspaces directory, by name. */
export async function personalFiles(): Promise<string[]> {
  const dir = workspacesDir();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Every workspace file Wisp knows: your own, then the projects you have used.
 *
 * A known project that has since been deleted is left out quietly — a clone you removed
 * is not an error — but one that exists and cannot be read is reported, since that is a
 * file somebody will want to fix.
 */
export async function workspaceFiles(): Promise<string[]> {
  const config = await loadConfig();
  const files = [...(await personalFiles())];

  const projects = [...(config.projects ?? [])].sort((left, right) =>
    right.lastUsed.localeCompare(left.lastUsed),
  );
  for (const project of projects) {
    const exists = await stat(project.path).catch(() => undefined);
    if (exists?.isFile()) files.push(project.path);
  }

  return [...new Set(files.map((file) => resolve(file)))];
}

/** Read every workspace Wisp knows, collecting what could not be read. */
export async function discoverWorkspaces(options: ReadOptions = {}): Promise<Discovered> {
  const files = await workspaceFiles();
  const settled = await Promise.all(
    files.map(async (file) => {
      try {
        return { ok: true as const, read: await readProjectFile(file, options) };
      } catch (error) {
        return { ok: false as const, failure: { file, error: describe(error) } };
      }
    }),
  );

  return {
    reads: settled.flatMap((entry) => (entry.ok ? [entry.read] : [])),
    unreadable: settled.flatMap((entry) => (entry.ok ? [] : [entry.failure])),
  };
}

export async function loadWorkspaces(options: ReadOptions = {}): Promise<Workspace[]> {
  return (await discoverWorkspaces(options)).reads.map((read) => read.workspace);
}

/**
 * A workspace named by any distinctive part of its name.
 *
 * The same rule bolts use, so there is one rule to learn: an exact name, slug or path
 * wins, and otherwise the needle must be whole words of exactly one name.
 */
export function matchWorkspace<T extends { workspace: Workspace } | Workspace>(
  query: string,
  items: T[],
): { match?: T; candidates: T[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { candidates: [] };

  const of = (item: T): Workspace => ("workspace" in item ? item.workspace : item);

  const exact =
    items.find((item) => of(item).id.toLowerCase() === needle) ??
    items.filter((item) => of(item).name.toLowerCase() === needle);
  if (!Array.isArray(exact)) return { match: exact, candidates: [exact] };
  if (exact.length === 1) return { match: exact[0] as T, candidates: exact };
  if (exact.length > 1) return { candidates: exact };

  const bySlug = items.filter((item) => slugify(of(item).name) === slugify(needle));
  if (bySlug.length === 1) return { match: bySlug[0] as T, candidates: bySlug };

  const byWords = items.filter((item) => hasWords(of(item).name, needle));
  if (byWords.length === 1) return { match: byWords[0] as T, candidates: byWords };

  return { candidates: byWords.length > 0 ? byWords : bySlug };
}

export function sharedNames(workspaces: { name: string }[]): Set<string> {
  const seen = new Map<string, number>();
  for (const workspace of workspaces) seen.set(slugify(workspace.name), (seen.get(slugify(workspace.name)) ?? 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
}

/** Like {@link matchWorkspace}, but says what went wrong. */
export function resolveWorkspace<T extends { workspace: Workspace } | Workspace>(query: string, items: T[]): T {
  const { match, candidates } = matchWorkspace(query, items);
  if (match) return match;

  const of = (item: T): Workspace => ("workspace" in item ? item.workspace : item);

  if (candidates.length > 1) {
    // Two projects can share a name — two clones, two `api` repos — so say where each is.
    const names = candidates.map((item) => `${of(item).name} (${tildify(of(item).file)})`).join(", ");
    const first = tildify(of(candidates[0] as T).file);
    throw new WispError(
      `"${query}" matches several workspaces: ${names}`,
      "AMBIGUOUS",
      `Run one by its file, like \`wisp use ${first} <pipeline>\`, or give one of them another name: e on it in the dashboard, or its "name" in the file.`,
    );
  }

  throw new WispError(`No workspace matching "${query}"`, "NOT_FOUND");
}

export function hasWords(name: string, needle: string): boolean {
  const words = slugify(name).split("-").filter(Boolean);
  const wanted = slugify(needle).split("-").filter(Boolean);
  if (wanted.length === 0) return false;
  for (let at = 0; at + wanted.length <= words.length; at += 1) {
    if (wanted.every((word, offset) => words[at + offset] === word)) return true;
  }
  return false;
}

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function pipelineSlug(bolt: { label: string; slug?: string | undefined }): string {
  return bolt.slug || slugify(bolt.label);
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

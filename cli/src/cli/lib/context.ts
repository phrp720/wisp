import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { WispError } from "../../core/errors.js";
import { expandHome } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile, readProjectFile } from "../../core/project.js";
import { matchBolt } from "../../core/switch.js";
import type { WorkspaceRead } from "../../core/types.js";
import { discoverWorkspaces, matchWorkspace, resolveWorkspace, slugify } from "../../core/workspaces.js";

/**
 * Every workspace Wisp knows, plus the project you are standing in if it is not known
 * yet — a fresh clone is the obvious one to want, and it has never been run.
 */
export async function everything(): Promise<WorkspaceRead[]> {
  const { reads } = await discoverWorkspaces();
  const here = await maybeProject();
  if (here && !reads.some((read) => read.workspace.file === here.workspace.file)) reads.unshift(here);
  return reads;
}

/**
 * The workspace named, or the one this directory belongs to. A path to a workspace file
 * names that file outright — what a git hook or a cron line uses, so it never depends on
 * which projects this machine happens to know.
 */
export async function workspaceFor(query?: string): Promise<WorkspaceRead> {
  if (query && looksLikeFile(query)) {
    const path = resolve(expandHome(query));
    if (await stat(path).then((entry) => entry.isFile()).catch(() => false)) return readProjectFile(path);
  }
  if (query) return resolveWorkspace(query, await everything());
  return currentProject();
}

function looksLikeFile(query: string): boolean {
  return /[\\/]/.test(query) || query.toLowerCase().endsWith(".json");
}

/** The project governing this directory, or a refusal that says how to get one. */
export async function currentProject(): Promise<WorkspaceRead> {
  const file = await findProjectFile();
  if (file) return readProjectFile(file);

  const names = (await everything()).map((read) => read.workspace.name);
  throw new WispError(
    names.length > 0
      ? `Nothing here to run — name a workspace: ${names.join(", ")}`
      : `Name a workspace, or run this inside a project with a ${PROJECT_FILE}`,
    names.length > 0 ? "NO_TARGET" : "NO_PROJECT",
  );
}

export async function maybeProject(): Promise<WorkspaceRead | undefined> {
  const file = await findProjectFile();
  return file ? readProjectFile(file) : undefined;
}

/**
 * What `wisp use <a> [b]` means.
 *
 * Two words are a workspace and a bolt. One word is a bolt of the project you are
 * standing in, and only that: a bolt of another project runs only when you name it.
 */
export async function resolveRun(
  first: string | undefined,
  second: string | undefined,
  flag: string | undefined,
): Promise<{ read: WorkspaceRead; bolt?: string; workspaceRef?: string }> {
  const bolt = second ?? flag;

  if (first && second) return { read: await workspaceFor(first), bolt, workspaceRef: first };

  if (first && !flag && looksLikeFile(first)) return { read: await workspaceFor(first), workspaceRef: first };

  if (first && !flag) {
    const here = await maybeProject();
    if (here) {
      const { bolt: match, candidates } = matchBolt(here.workspace, first);
      if (match) return { read: here, bolt: first };
      if (candidates.length > 1) {
        throw new WispError(
          `"${first}" matches several pipelines: ${candidates.map((candidate) => `${candidate.label} (${slugify(candidate.label)})`).join(", ")}`,
          "AMBIGUOUS",
        );
      }
    }
    throw await noBoltHere(first, here);
  }

  return {
    read: await workspaceFor(first),
    ...(bolt ? { bolt } : {}),
    ...(first ? { workspaceRef: first } : {}),
  };
}

async function noBoltHere(word: string, here: WorkspaceRead | undefined): Promise<WispError> {
  const all = await everything();
  const others = all.filter((read) => read.workspace.file !== here?.workspace.file);
  const workspace = matchWorkspace(word, others).match;
  const elsewhere = boltsEverywhere(word, others);

  const typed = slugify(word);
  const close = typed ? (here?.workspace.bolts ?? []).filter((entry) => slugify(entry.label).split("-").some((part) => part.startsWith(typed))) : [];

  const said = here
    ? `${here.workspace.name} has no pipeline called "${word}".`
    : `"${word}" is not a pipeline here: this folder has no ${PROJECT_FILE}.`;
  const next = [
    close.length > 0 ? `Did you mean ${close.map((entry) => `\`wisp ${slugify(entry.label)}\``).join(", ")}?` : "",
    workspace
      ? `${workspace.workspace.name} is a workspace: \`wisp show ${slugify(workspace.workspace.name)}\` lists its pipelines, \`wisp pick ${slugify(workspace.workspace.name)}\` picks one.`
      : "",
    elsewhere.length > 0
      ? `Elsewhere: ${elsewhere.map((hit) => `\`wisp ${slugify(hit.read.workspace.name)} ${slugify(hit.label)}\``).join(", ")}.`
      : "",
    close.length === 0 && !workspace && elsewhere.length === 0 && here && here.workspace.bolts.length > 0
      ? `It has ${here.workspace.bolts.map((entry) => slugify(entry.label)).join(", ")}.`
      : "",
    !workspace && elsewhere.length === 0 && !here ? "`wisp list` shows your workspaces." : "",
  ].filter(Boolean);
  return new WispError([said, ...next].join(" "), "NO_PIPELINE");
}

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * The bolts named `word` in every workspace: by name or slug when any is, else by the one
 * bolt in a workspace that the word is part of.
 */
function boltsEverywhere(word: string, reads: WorkspaceRead[]): { read: WorkspaceRead; label: string }[] {
  const needle = word.trim().toLowerCase();
  const hits = reads.flatMap((read) => {
    const { bolt } = matchBolt(read.workspace, word);
    if (!bolt) return [];
    const exact = bolt.label.toLowerCase() === needle || slugify(bolt.label) === slugify(word);
    return [{ read, label: bolt.label, exact }];
  });
  const exact = hits.filter((hit) => hit.exact);
  return (exact.length > 0 ? exact : hits).map(({ read, label }) => ({ read, label }));
}

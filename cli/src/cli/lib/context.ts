import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { WispError } from "../../core/errors.js";
import { expandHome } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile, readProjectFile } from "../../core/project/index.js";
import { matchPipeline } from "../../core/run/index.js";
import type { WorkspaceRead } from "../../core/types.js";
import { closePipelines, discoverWorkspaces, matchWorkspace, resolveWorkspace, slugify, pipelineSlug } from "../../core/workspaces.js";

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
 * Two words are a workspace and a pipeline. One word is a pipeline of the project you are
 * standing in, and only that: a pipeline of another project runs only when you name it.
 */
export async function resolveRun(
  first: string | undefined,
  second: string | undefined,
  flag: string | undefined,
): Promise<{ read: WorkspaceRead; pipeline?: string; workspaceRef?: string }> {
  const pipeline = second ?? flag;

  if (first && second) return { read: await workspaceFor(first), pipeline, workspaceRef: first };

  if (first && !flag && looksLikeFile(first)) return { read: await workspaceFor(first), workspaceRef: first };

  if (first && !flag) {
    const here = await maybeProject();
    if (here) {
      const { pipeline: match, candidates } = matchPipeline(here.workspace, first);
      if (match) return { read: here, pipeline: first };
      if (candidates.length > 1) {
        throw new WispError(
          `"${first}" matches several pipelines: ${candidates.map((candidate) => `${candidate.label} (${pipelineSlug(candidate)})`).join(", ")}`,
          "AMBIGUOUS",
          `Use the full label in quotes, like \`wisp "${candidates[0]?.label}"\`, or give one of them a different "slug".`,
        );
      }
    }
    throw await noPipelineHere(first, here);
  }

  return {
    read: await workspaceFor(first),
    ...(pipeline ? { pipeline } : {}),
    ...(first ? { workspaceRef: first } : {}),
  };
}

async function noPipelineHere(word: string, here: WorkspaceRead | undefined): Promise<WispError> {
  const all = await everything();
  const others = all.filter((read) => read.workspace.file !== here?.workspace.file);
  const workspace = matchWorkspace(word, others).match;
  const elsewhere = pipelinesEverywhere(word, others);

  const close = closePipelines(here?.workspace.pipelines ?? [], word);

  const said = here
    ? `${here.workspace.name} has no pipeline called "${word}".`
    : `"${word}" is not a pipeline here: this folder has no ${PROJECT_FILE}.`;
  const next = [
    close.length > 0 ? `Did you mean ${close.map((entry) => `\`wisp ${pipelineSlug(entry)}\``).join(", ")}?` : "",
    workspace
      ? `${workspace.workspace.name} is a workspace: \`wisp show ${slugify(workspace.workspace.name)}\` lists its pipelines, \`wisp pick ${slugify(workspace.workspace.name)}\` picks one.`
      : "",
    elsewhere.length > 0
      ? `Elsewhere: ${elsewhere.map((hit) => `\`wisp ${slugify(hit.read.workspace.name)} ${hit.slug}\``).join(", ")}.`
      : "",
    close.length === 0 && !workspace && elsewhere.length === 0 && here && here.workspace.pipelines.length > 0
      ? `It has ${here.workspace.pipelines.map((entry) => pipelineSlug(entry)).join(", ")}.`
      : "",
    !workspace && elsewhere.length === 0 && !here ? "`wisp list` shows your workspaces." : "",
  ].filter(Boolean);
  return new WispError([said, ...next].join(" "), "NO_PIPELINE", next.length > 0 ? "" : undefined);
}

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * The pipelines named `word` in every workspace: by name or slug when any is, else by the one
 * pipeline in a workspace that the word is part of.
 */
function pipelinesEverywhere(word: string, reads: WorkspaceRead[]): { read: WorkspaceRead; label: string; slug: string }[] {
  const needle = word.trim().toLowerCase();
  const hits = reads.flatMap((read) => {
    const { pipeline } = matchPipeline(read.workspace, word);
    if (!pipeline) return [];
    const exact = pipeline.label.toLowerCase() === needle || pipelineSlug(pipeline) === slugify(word) || slugify(pipeline.label) === slugify(word);
    return [{ read, label: pipeline.label, slug: pipelineSlug(pipeline), exact }];
  });
  const exact = hits.filter((hit) => hit.exact);
  return (exact.length > 0 ? exact : hits).map(({ read, label, slug }) => ({ read, label, slug }));
}

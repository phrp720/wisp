import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { SpecterError } from "../../core/errors.js";
import { expandHome } from "../../core/paths.js";
import { PROJECT_FILE, findProjectFile, readProjectFile } from "../../core/project.js";
import { matchBolt } from "../../core/switch.js";
import type { TargetKind, Workspace, WorkspaceRead } from "../../core/types.js";
import { discoverWorkspaces, matchWorkspace, resolveWorkspace } from "../../core/workspaces.js";

/**
 * Every workspace Specter knows, plus the project you are standing in if it is not known
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
  throw new SpecterError(
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

/** How a dependency on another workspace is looked up while a bolt runs. */
export async function findWorkspaceForDependency(ref: string): Promise<Workspace> {
  return resolveWorkspace(ref, await everything()).workspace;
}

/**
 * What `specter use <a> [b]` means.
 *
 * Two words are a workspace and a bolt. One word is a workspace if one answers to it,
 * and otherwise — only otherwise — a bolt of the project you are standing in. So the
 * documented form keeps working, and `specter api` inside a repository means the obvious
 * thing; the fallback can only fire where the first reading was impossible anyway.
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

    // Standing in a project, its own bolts come first: `specter api` in a repository that
    // has an "API" bolt means that bolt, even if some other workspace is called "api".
    if (here) {
      const { bolt: match, candidates } = matchBolt(here.workspace, first);
      if (match) return { read: here, bolt: first };
      if (candidates.length > 1) {
        throw new SpecterError(
          `"${first}" matches several bolts: ${candidates.map((candidate) => candidate.label).join(", ")}`,
          "AMBIGUOUS",
        );
      }
    }

    const all = await everything();
    const { match } = matchWorkspace(first, all);
    if (match) return { read: match, workspaceRef: first };

    if (here) {
      const bolts = here.workspace.bolts;
      throw new SpecterError(
        bolts.length > 0
          ? `No bolt or workspace called "${first}". ${here.workspace.name} has ${bolts.map((entry) => entry.label).join(", ")}`
          : `No workspace called "${first}", and ${here.workspace.name} has no bolts yet`,
        "NO_BOLT",
      );
    }

    return { read: resolveWorkspace(first, all) };
  }

  return {
    read: await workspaceFor(first),
    ...(bolt ? { bolt } : {}),
    ...(first ? { workspaceRef: first } : {}),
  };
}

/** `links,folders` and friends, as the kinds the runner understands. */
export function parseKinds(value?: string): TargetKind[] | undefined {
  if (!value) return undefined;

  const aliases: Record<string, TargetKind> = {
    link: "link",
    links: "link",
    folder: "folder",
    folders: "folder",
    dir: "folder",
    file: "file",
    files: "file",
    app: "app",
    apps: "app",
    command: "command",
    commands: "command",
    run: "command",
  };

  const kinds = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      const kind = aliases[part];
      if (!kind) {
        throw new SpecterError(
          `Unknown target kind "${part}" — expected links, folders, files, apps or commands`,
          "INVALID_INPUT",
        );
      }
      return kind;
    });

  return kinds.length > 0 ? kinds : undefined;
}

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

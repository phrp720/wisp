import { installedEditors } from "../../core/editors.js";
import { currentOS } from "../../core/paths.js";
import { listRuns } from "../../core/processes.js";
import { matchBolt } from "../../core/switch.js";
import type { Workspace, WorkspaceRead } from "../../core/types.js";
import { matchWorkspace, slugify } from "../../core/workspaces.js";
import { getPlatform } from "../../platform/index.js";
import { MULTIPLEXERS } from "../../platform/terminals.js";
import { COMMANDS } from "./commands.js";
import { everything, maybeProject } from "./context.js";

/** One suggestion for the word being typed, with a few words about it. */
export interface Candidate {
  value: string;
  description: string;
}

/** What the shell scripts ask for: everything is read fresh, so names never go stale. */
export interface CompletionSources {
  here: () => Promise<WorkspaceRead | undefined>;
  workspaces: () => Promise<WorkspaceRead[]>;
  running: () => Promise<{ label: string; id: string; workspaceName: string }[]>;
  terminals: () => string[];
  editors: () => string[];
}

export const SOURCES: CompletionSources = {
  here: () => maybeProject().catch(() => undefined),
  workspaces: () => everything().catch(() => []),
  running: async () => (await listRuns().catch(() => [])).filter((run) => run.alive),
  terminals: () => [...getPlatform().knownTerminals(), ...MULTIPLEXERS],
  editors: () => installedEditors(currentOS()).map((editor) => editor.value),
};

const HOOKS = ["pre-push", "pre-commit", "post-merge", "post-checkout"];
export const SHELLS = ["zsh", "bash", "fish"];

/**
 * The suggestions for the last of `words`, the one being typed. `words` are what follows
 * `wisp` on the line, so `["payments-service", "se"]` asks for that workspace's bolts.
 *
 * Bolts and workspaces are offered as slugs ("work-on-api"), which need no quoting and
 * which Wisp matches like their names.
 */
export async function complete(words: string[], sources: CompletionSources = SOURCES): Promise<Candidate[]> {
  const current = words.at(-1) ?? "";
  const before = words.slice(0, -1).filter((word) => !word.startsWith("-"));
  const first = before[0];
  const command = first ? findCommand(first) : undefined;

  if (current.startsWith("-")) return keep(optionsOf(command ?? findCommand("use")), current);

  const candidates = await (async (): Promise<Candidate[]> => {
    if (!first) return [...commands(), ...(await herebolts(sources)), ...(await workspaceSlugs(sources))];

    // `wisp <name> …`: a bolt here takes nothing more; a workspace takes one of its bolts.
    if (!command) return before.length === 1 ? await boltsOfNamed(first, sources) : [];

    const position = before.length;
    switch (command.name) {
      case "use":
      case "down":
      case "restart":
        if (position === 1) return [...(await herebolts(sources)), ...(await workspaceSlugs(sources))];
        if (position === 2) return boltsOf(await workspaceNamed(before[1] as string, sources));
        return [];
      case "show":
      case "pick":
        return position === 1 ? workspaceSlugs(sources) : [];
      case "logs":
      case "stop":
        if (position !== 1) return [];
        return (await sources.running()).map((run) => ({ value: run.label, description: `running · ${run.workspaceName}` }));
      case "hook":
        if (position === 1) return HOOKS.map((hook) => ({ value: hook, description: "git hook" }));
        return position === 2 ? herebolts(sources) : [];
      case "open-with":
        if (position === 1) {
          return [
            { value: "folder", description: "what opens a pipeline's folders" },
            { value: "file", description: "what opens a pipeline's files" },
            { value: "terminal", description: "where a pipeline's commands run" },
          ];
        }
        if (position !== 2) return [];
        if (before[1] === "terminal") return sources.terminals().map((name) => ({ value: name, description: "terminal" }));
        return sources.editors().map((name) => ({ value: name, description: "installed here" }));
      case "completion":
        return position === 1 ? SHELLS.map((shell) => ({ value: shell, description: "shell" })) : [];
      case "help":
        return position === 1 ? [{ value: "agents", description: "the full reference, for AI agents" }, ...commands()] : [];
      default:
        return [];
    }
  })();
  return keep(candidates, current);
}

/** The words that mean a command, as COMMANDS has them, plus the few registered elsewhere. */
function commands(): Candidate[] {
  return [
    ...COMMANDS.map((command) => ({ value: command.name, description: command.summary })),
    { value: "status", description: "Print what this project can run, as plain text" },
    { value: "help", description: "Help on Wisp or a command" },
  ];
}

function findCommand(word: string): { name: string; options: [string, string][] } | undefined {
  if (word === "status" || word === "help") return { name: word, options: [] };
  const found = COMMANDS.find((command) => command.name === word || (command.aliases ?? []).includes(word));
  return found ? { name: found.name, options: (found.options ?? []).map(([flags, description]) => [flags, description]) } : undefined;
}

function optionsOf(command: { options: [string, string][] } | undefined): Candidate[] {
  const flags = (command?.options ?? []).flatMap(([flags, description]) =>
    flags
      .split(/[ ,]+/)
      .filter((flag) => flag.startsWith("--"))
      .map((flag) => ({ value: flag, description })),
  );
  return [...flags, { value: "--help", description: "help for this command" }];
}

async function herebolts(sources: CompletionSources): Promise<Candidate[]> {
  const here = await sources.here();
  return here ? boltsOf(here.workspace) : [];
}

function boltsOf(workspace: Workspace | undefined): Candidate[] {
  if (!workspace) return [];
  return workspace.bolts.map((bolt) => ({ value: slugify(bolt.label), description: ["pipeline", bolt.label, bolt.notes].filter(Boolean).join(" · ") }));
}

async function workspaceSlugs(sources: CompletionSources): Promise<Candidate[]> {
  const seen = new Set<string>();
  return (await sources.workspaces()).flatMap(({ workspace }) => {
    const value = slugify(workspace.name);
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ value, description: `workspace · ${workspace.name}` }];
  });
}

async function workspaceNamed(name: string, sources: CompletionSources): Promise<Workspace | undefined> {
  return matchWorkspace(name, await sources.workspaces()).match?.workspace;
}

/** After `wisp <name>`: nothing when it is a bolt here, that workspace's bolts when it is one. */
async function boltsOfNamed(name: string, sources: CompletionSources): Promise<Candidate[]> {
  const here = await sources.here();
  if (here && matchBolt(here.workspace, name).bolt) return [];
  return boltsOf(await workspaceNamed(name, sources));
}

function keep(candidates: Candidate[], typed: string): Candidate[] {
  const prefix = typed.toLowerCase();
  return candidates.filter((candidate) => candidate.value.toLowerCase().startsWith(prefix));
}

/** The line each shell's script expects: the value, a tab, what it is. */
export function formatCandidates(candidates: Candidate[]): string {
  return candidates.map((candidate) => `${candidate.value}\t${candidate.description.replace(/[\t\n]/g, " ")}`).join("\n");
}

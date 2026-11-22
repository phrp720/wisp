import { getPlatform, type Platform } from "../../platform/index.js";
import { composeContainers, dockerState, type Container, type DockerState } from "../system/docker.js";
import type { Environment } from "../system/environment.js";
import { listRuns, composeMarker, containerMarker, stoppedOnPurpose } from "../system/processes.js";
import type { OpenWithDefaults, SwitchOptions } from "../types.js";

/** What running needs from the outside world, overridable so tests need none of it. */
export interface RunDeps {
  platform?: Platform;
  environment?: Environment;
  defaults?: OpenWithDefaults;
}

export interface Context {
  /** Set while this run holds the lock on starting one command; see runCommand. */
  starting?: boolean;
  environment: Environment;
  defaults: OpenWithDefaults;
  options: SwitchOptions;
  lazyPlatform: Platform | undefined;
  /** One sweep of the browsers per run, rather than one per link. */
  tabs: Awaited<ReturnType<NonNullable<Platform["tabs"]>["snapshot"]>> | undefined;
  historyId: string | undefined;
  /** Runs this run started, so a wait can notice one has died. */
  started: { id: string }[];
  /** Asked once per run, before the first step that needs Docker. */
  docker?: Promise<DockerState>;
  /** A command this run started that someone stopped on purpose while it went on. */
  cancelledBy?: string;
  /** When the run began: a stop before then was not of this run. */
  since: number;
  /** The compose files this run started, whose containers a wait may depend on. */
  composeFiles: Set<string>;
}

/**
 * Why waiting is pointless: a command this run started has already stopped. A wait for a
 * dev server's port should not sit out its whole timeout when the server died at once.
 */
export async function deadBefore(context: Context): Promise<string | undefined> {
  if (context.started.length === 0) return undefined;
  const runs = await listRuns();
  for (const started of context.started) {
    const run = runs.find((entry) => entry.id === started.id);
    if (!run || run.alive) continue;
    if (stoppedOnPurpose(run.id)) {
      context.cancelledBy = run.label;
      return `you stopped ${run.label}`;
    }
    return run.log
      ? `${run.label} stopped before it was ready — \`wisp logs ${run.id}\``
      : `${run.label} stopped before it was ready — its ${run.where ?? "terminal"} window shows why`;
  }
  return undefined;
}

export function platformOf(context: Context): Platform {
  context.lazyPlatform ??= getPlatform();
  return context.lazyPlatform;
}

export async function stoppedContainer(context: Context, files: string[]): Promise<string | undefined> {
  for (const file of files) {
    if (stoppedOnPurpose(composeMarker(file), context.since)) return "its Docker services";
    const containers = await composeContainers(file).catch((): Container[] => []);
    const stopped = containers.find((container) => stoppedOnPurpose(containerMarker(container.name), context.since));
    if (stopped) return stopped.service;
  }
  return undefined;
}

export function dockerOf(context: Context): Promise<DockerState> {
  context.docker ??= dockerState();
  return context.docker;
}

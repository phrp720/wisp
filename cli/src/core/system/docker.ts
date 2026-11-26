import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { containerMarker, markStopped } from "./processes.js";

const exec = promisify(execFile);

/** A container of a compose project, as the TUI and `wisp ps` show it. */
export interface Container {
  /** The compose file it belongs to — how Wisp knows it is a pipeline's. */
  file: string;
  project: string;
  service: string;
  name: string;
  image: string;
  /** `running`, `exited`, `restarting`, `paused`, `created`, `dead`. */
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or empty when it has no health check. */
  health: string;
  /** Docker's own words: "Up 3 minutes (healthy)", "Exited (1) 2 hours ago". */
  status: string;
  /** Published ports on the host, `5432` or `5432→5433` when they differ. */
  ports: string[];
  exitCode: number;
}

export interface ContainerStats {
  cpu: string;
  memory: string;
}

export type DockerState = "up" | "down" | "missing";

export const DOCKER_DOWN = "Docker isn't running: open Docker Desktop, then try again";

export async function dockerState(timeoutMs = 5000): Promise<DockerState> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: timeoutMs, killSignal: "SIGKILL" });
    return "up";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "down";
  }
}

export function usesDocker(command: string): boolean {
  return /(^|[;&|(]|\$\()\s*(sudo\s+)?docker(\s|$)/.test(command.trim());
}

/** Why Docker cannot be asked, in words that say what to do. */
export class DockerUnavailable extends Error {}

/**
 * The containers of a compose file, stopped ones too — a database that exited is exactly
 * the thing you want to see, not a gap in the list.
 */
export async function composeContainers(file: string): Promise<Container[]> {
  const { stdout } = await docker(["compose", "-f", file, "ps", "-a", "--format", "json"], dirname(file));
  return parseComposePs(stdout, file);
}

/** `compose ps --format json` gives JSON lines on newer Compose and one array on older. */
export function parseComposePs(stdout: string, file: string): Container[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows: unknown[] = text.startsWith("[") ? (JSON.parse(text) as unknown[]) : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);

  return rows.flatMap((row): Container[] => {
    if (typeof row !== "object" || row === null) return [];
    const entry = row as Record<string, unknown>;
    const publishers = Array.isArray(entry["Publishers"]) ? (entry["Publishers"] as Record<string, unknown>[]) : [];
    const ports = [
      ...new Set(
        publishers
          .filter((publisher) => Number(publisher["PublishedPort"]) > 0)
          .map((publisher) =>
            publisher["PublishedPort"] === publisher["TargetPort"]
              ? String(publisher["PublishedPort"])
              : `${String(publisher["PublishedPort"])}→${String(publisher["TargetPort"])}`,
          ),
      ),
    ];
    return [
      {
        file,
        project: String(entry["Project"] ?? ""),
        service: String(entry["Service"] ?? entry["Name"] ?? ""),
        name: String(entry["Name"] ?? ""),
        image: String(entry["Image"] ?? ""),
        state: String(entry["State"] ?? "").toLowerCase(),
        health: String(entry["Health"] ?? "").toLowerCase(),
        status: String(entry["Status"] ?? ""),
        ports,
        exitCode: Number(entry["ExitCode"] ?? 0),
      },
    ];
  });
}

/** CPU and memory for running containers, by name. One call for all of them. */
export async function containerStats(names: string[]): Promise<Map<string, ContainerStats>> {
  const stats = new Map<string, ContainerStats>();
  if (names.length === 0) return stats;
  const { stdout } = await docker(["stats", "--no-stream", "--format", "{{json .}}", ...names]);
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as Record<string, string>;
      const memory = (entry["MemUsage"] ?? "").split("/")[0]?.trim() ?? "";
      stats.set(entry["Name"] ?? "", { cpu: entry["CPUPerc"] ?? "", memory });
    } catch {
      // A line that is not JSON is not stats.
    }
  }
  return stats;
}

/** The last lines a container wrote, stdout and stderr together, as `docker logs` does. */
export async function containerLogs(name: string, lines = 300): Promise<string> {
  const { stdout, stderr } = await docker(["logs", "--tail", String(lines), name]);
  // Interleaving is lost — Docker hands them back separately — but nothing is.
  return stderr ? `${stdout}${stdout.endsWith("\n") || !stdout ? "" : "\n"}${stderr}` : stdout;
}

export async function containerAction(name: string, action: "start" | "stop" | "restart"): Promise<void> {
  if (action !== "start") markStopped(containerMarker(name));
  await docker([action, name]);
}

/** Every service of a compose file, by name — what `up` would start. */
export async function composeServices(file: string): Promise<string[]> {
  const { stdout } = await docker(["compose", "-f", file, "config", "--services"], dirname(file));
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The command a compose step runs to start its services, and waits until they are healthy. */
export function composeUpArgs(file: string, services: string[] = [], wait = true): string[] {
  return ["compose", "-f", file, "up", "-d", ...(wait ? ["--wait", "--wait-timeout", "120"] : []), ...services];
}

export function composeStopArgs(file: string, services: string[] = []): string[] {
  return ["compose", "-f", file, "stop", ...services];
}

/** How a container reads at a glance: the word for it, and whether that is good news. */
export function containerMood(container: Pick<Container, "state" | "health">): { word: string; tone: "good" | "busy" | "bad" | "off" } {
  if (container.state === "running") {
    if (container.health === "unhealthy") return { word: "unhealthy", tone: "bad" };
    if (container.health === "starting") return { word: "starting", tone: "busy" };
    return { word: container.health === "healthy" ? "healthy" : "running", tone: "good" };
  }
  if (container.state === "restarting") return { word: "restarting", tone: "busy" };
  if (container.state === "paused") return { word: "paused", tone: "busy" };
  if (container.state === "exited" || container.state === "dead") return { word: container.state, tone: "bad" };
  return { word: container.state || "created", tone: "off" };
}

/** "Up 3 minutes (healthy)" → "up 3m"; "Exited (1) 2 hours ago" → "exited 2h ago". */
export function shortStatus(status: string): string {
  return status
    .replace(/\s*\((healthy|unhealthy|health: starting)\)/i, "")
    .replace(/^Up /, "up ")
    .replace(/^Exited \(\d+\) /, "exited ")
    .replace(/About an? /i, "1 ")
    .replace(/Less than a second/i, "<1s")
    .replace(/ seconds?/, "s")
    .replace(/ minutes?/, "m")
    .replace(/ hours?/, "h")
    .replace(/ days?/, "d")
    .replace(/ weeks?/, "w");
}

async function docker(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("docker", args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(cwd ? { cwd } : {}) });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new DockerUnavailable("docker is not installed");
    const said = failure.stderr?.trim() ?? "";
    if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect/i.test(said)) {
      throw new DockerUnavailable("Docker is not running — start Docker Desktop, or the docker service");
    }
    throw new Error(said || failure.message);
  }
}

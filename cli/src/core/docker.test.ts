import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Platform } from "../platform/types.js";
import { DOCKER_DOWN, dockerState, usesDocker } from "./docker.js";
import { interpret } from "./project.js";
import { switchToWorkspace } from "./switch.js";

let dir: string;
let path: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-docker-"));
  process.env["WISP_HOME"] = join(dir, "home");
  path = process.env["PATH"];
});

afterEach(async () => {
  process.env["PATH"] = path;
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

async function fakeDocker(body: string): Promise<string> {
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin, { recursive: true });
  const calls = join(dir, "calls");
  await writeFile(join(bin, "docker"), `#!/bin/sh\necho "$*" >> "${calls}"\n${body}\n`);
  await chmod(join(bin, "docker"), 0o755);
  process.env["PATH"] = `${bin}:/bin:/usr/bin`;
  return calls;
}

describe("whether Docker answers", () => {
  it("is up when the daemon answers, down when it refuses or hangs, and missing when there is no docker", async () => {
    await fakeDocker("exit 0");
    expect(await dockerState()).toBe("up");
    await fakeDocker("echo 'Cannot connect to the Docker daemon' >&2; exit 1");
    expect(await dockerState()).toBe("down");
    await fakeDocker("sleep 5");
    const started = Date.now();
    expect(await dockerState(300)).toBe("down");
    expect(Date.now() - started).toBeLessThan(2000);
    process.env["PATH"] = join(dir, "nowhere");
    expect(await dockerState()).toBe("missing");
  });

  it("knows a command that calls docker, wherever in the line", () => {
    for (const command of ["docker compose up -d", "cd tools && docker compose up", "test -f .env || exit 1; docker info", "sudo docker ps", "echo $(docker ps -q)"]) {
      expect(usesDocker(command)).toBe(true);
    }
    for (const command of ["pnpm dev", "./docker-setup.sh", "echo docker", "mydocker run"]) {
      expect(usesDocker(command)).toBe(false);
    }
  });
});

describe("a step that needs Docker while Docker is down", () => {
  const platform = { os: "darwin" } as unknown as Platform;
  const environment = { os: "darwin" as const, gui: false, ssh: false };

  it("fails at once, never starting the command, so nothing fires later when Docker comes up", async () => {
    const calls = await fakeDocker("echo 'Cannot connect to the Docker daemon' >&2; exit 1");
    const ws = interpret(
      { main: { pipelines: [{ label: "Tools db", steps: [{ run: "docker compose -f db.yaml up -d", label: "db", finishes: true }, { run: "echo after", label: "after", finishes: true, after: "db" }] }] } },
      { file: join(dir, ".wisp.json"), personal: false, trust: "trusted", os: "darwin" },
    ).workspace;
    const started = Date.now();
    const result = await switchToWorkspace(ws, { bolt: "Tools db" }, { platform, environment, defaults: {} });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.ok).toBe(false);
    expect(result.targets[0]).toMatchObject({ ok: false, error: DOCKER_DOWN });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["version --format {{.Server.Version}}"]);
  });

  it("asks Docker once a run, and runs the commands when it answers", async () => {
    const calls = await fakeDocker("exit 0");
    const ws = interpret(
      { main: { pipelines: [{ label: "Two", steps: [{ run: "echo docker one >/dev/null; true || docker ps", label: "one", finishes: true }, { run: "true || docker images", label: "two", finishes: true, after: "one" }] }] } },
      { file: join(dir, ".wisp.json"), personal: false, trust: "trusted", os: "darwin" },
    ).workspace;
    const result = await switchToWorkspace(ws, { bolt: "Two" }, { platform, environment, defaults: {} });
    expect(result.ok).toBe(true);
    expect(result.targets.map((target) => target.ok)).toEqual([true, true]);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["version --format {{.Server.Version}}"]);
  });
});

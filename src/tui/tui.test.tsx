import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { interpret } from "../core/project.js";
import type { SwitchResult, TrustState, WorkspaceRead } from "../core/types.js";
import { App } from "./App.js";
import { glyphs } from "./glyphs.js";
import { score, search, windowed, type Library, type Services } from "./model.js";

const unicode = glyphs({ LANG: "en_US.UTF-8" }, "darwin");

function read(file: string, main: Record<string, unknown>, trust: TrustState = "trusted", personal = false): WorkspaceRead {
  return interpret({ main }, { file, personal, trust, os: "darwin" });
}

const acme = read("/dev/acme/.specter.json", {
  name: "Acme",
  bolts: [
    { label: "Work on api", targets: [{ folder: "apps/api" }, { run: "pnpm dev" }] },
    { label: "Work on web", targets: [{ folder: "apps/web" }] },
  ],
});
const infra = read("/dev/infra/.specter.json", { name: "infra", bolts: [{ label: "Database", targets: [{ run: "postgres" }] }] }, "untrusted");
const morning = read("/home/.config/specter/workspaces/Morning.json", { name: "Morning", bolts: [{ label: "Start the day", targets: [{ url: "mail.google.com" }] }] }, "trusted", true);

function services(overrides: Partial<Services> = {}, library: Library = { reads: [morning, infra, acme], here: acme.workspace.file, unreadable: [] }): Services {
  return {
    environment: { os: "darwin", gui: true, ssh: false },
    load: async () => library,
    run: async (target, bolt, callbacks) => {
      const plan = target.workspace.bolts.find((entry) => entry.label === bolt)!;
      const targets = plan.steps.map((step, index) => ({ kind: "folder" as const, id: `s${index}`, label: `step ${index}`, value: `step ${index}` }));
      callbacks.onPlan(targets);
      for (const step of targets) {
        callbacks.onStep(step, { attached: false });
        callbacks.onResult({ ...step, ok: true });
      }
      return { workspace: target.workspace, targets: targets.map((step) => ({ ...step, ok: true })), dryRun: callbacks.dryRun } as SwitchResult;
    },
    containers: async () => ({ containers: [] }),
    containerStats: async () => new Map(),
    containerLogs: async () => "",
    containerAction: async () => undefined,
    planRetry: async () => [],
    suggestSetup: async () => undefined,
    setUp: async () => "",
    watch: () => () => undefined,
    editing: {
      bolt: async (_file, bolt) => ({ label: bolt, targets: [] }),
      addBolt: async () => undefined,
      renameBolt: async () => undefined,
      removeBolt: async () => undefined,
      moveBolt: async () => undefined,
      setJob: async () => undefined,
      addStep: async () => undefined,
      replaceStep: async () => undefined,
      removeStep: async () => undefined,
      moveStep: async () => undefined,
      createPersonalWorkspace: async () => "",
    },
    down: async () => ({ stopped: [] }),
    restart: async (run) => ({ ok: true, run }),
    history: async () => [],
    readLog: async () => "",
    check: async () => acme,
    trust: async () => undefined,
    runs: async () => [],
    stop: () => true,
    tail: async () => "",
    edit: async () => undefined,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const ARROW_DOWN = "\u001B[B";
const ARROW_LEFT = "\u001B[D";

async function open(api: Services) {
  const app = render(<App services={api} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
  await tick();
  return app;
}

describe("the TUI", () => {
  it("starts on the project you are in, with its bolts ready to run", async () => {
    const { lastFrame } = await open(services());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Workspaces");
    expect(frame.indexOf("Acme")).toBeLessThan(frame.indexOf("infra"));
    expect(frame).toContain("❯ Work on api");
    expect(frame).toContain("⚡ Bolts");
    expect(frame).toContain("pnpm dev");
  });

  it("lists projects before personal workspaces, and flags one waiting for trust", async () => {
    const frame = (await open(services())).lastFrame() ?? "";
    expect(frame.indexOf("infra")).toBeLessThan(frame.indexOf("Morning"));
    expect(frame).toContain("infra · not allowed");
    // Grouped, and said in words: no unexplained marks. Read from the list alone — the
    // left column — since the panel beside it names the workspace too.
    const list = frame.split("\n").map((line) => line.slice(0, 28)).join("\n");
    expect(list.indexOf("THIS FOLDER")).toBeLessThan(list.indexOf("Acme"));
    expect(list.indexOf("Acme")).toBeLessThan(list.indexOf("PROJECTS"));
    expect(list.indexOf("PROJECTS")).toBeLessThan(list.indexOf("infra"));
    expect(list.indexOf("YOURS")).toBeLessThan(list.indexOf("Morning"));
  });

  it("moves between bolts and runs the selected one, showing each step", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write(ARROW_DOWN);
    await tick();
    expect(app.lastFrame()).toContain("❯ Work on web");

    app.stdin.write("\r");
    await tick();
    expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.objectContaining({ dryRun: false }));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Acme › Work on web");
    expect(frame).toContain("✓ open the step 0 folder");
    expect(frame).toContain("All done.");

    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Bolts");
  });

  it("handles keys that arrive faster than it redraws", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    // No pause between them: each key must see what the one before it did.
    app.stdin.write(ARROW_DOWN);
    app.stdin.write("\r");
    await tick();
    expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.anything());

    app.stdin.write("\r");
    app.stdin.write("k");
    app.stdin.write("\r");
    await tick();
    expect(run).toHaveBeenLastCalledWith(acme, "Work on api", expect.anything());
  });

  it("dry-runs with n", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write("n");
    await tick();
    expect(run).toHaveBeenCalledWith(acme, "Work on api", expect.objectContaining({ dryRun: true }));
    expect(app.lastFrame()).toContain("dry run");
  });

  it("switches workspace from the list", async () => {
    const app = await open(services());
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    expect(app.lastFrame()).toContain("Database");
    expect(app.lastFrame()).toContain("(not trusted)");
  });

  it("searches across every workspace and runs the hit", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write("/");
    await tick();
    for (const char of "dtbs") {
      app.stdin.write(char);
      await tick();
    }
    expect(app.lastFrame()).toContain("❯ infra › Database");
    app.stdin.write("\r");
    await tick();
    expect(run).toHaveBeenCalledWith(infra, "Database", expect.anything());
  });

  it("shows what trust would allow, and trusts only on y", async () => {
    const trust = vi.fn(async () => undefined);
    const app = await open(services({ trust }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write("t");
    await tick();
    expect(app.lastFrame()).toContain("Trust infra?");
    expect(app.lastFrame()).toContain("postgres");

    app.stdin.write("x");
    await tick();
    expect(trust).not.toHaveBeenCalled();

    app.stdin.write("t");
    await tick();
    app.stdin.write("y");
    await tick();
    expect(trust).toHaveBeenCalledWith(infra.workspace.file, infra.hash);
  });

  it("says so when there are no workspaces at all", async () => {
    const frame = (await open(services({}, { reads: [], unreadable: [] }))).lastFrame() ?? "";
    expect(frame).toContain("No workspaces yet");
    expect(frame).toContain("specter init");
  });

  it("tells you on a server that commands go to the background", async () => {
    const frame = (await open(services({ environment: { os: "linux", gui: false, ssh: true } }))).lastFrame() ?? "";
    expect(frame).toContain("over ssh — links are shown, not opened");
  });

  it("falls back to plain characters where Unicode would show as boxes", () => {
    expect(glyphs({ TERM: "linux", LANG: "C" }, "linux").pointer).toBe(">");
    expect(glyphs({ LANG: "en_US.UTF-8" }, "linux").pointer).toBe("❯");
  });
});

describe("jobs, down and history in the TUI", () => {
  it("streams an attached command's output while it runs", async () => {
    let finish: () => void = () => undefined;
    const app = await open(
      services({
        run: async (target, _bolt, callbacks) => {
          const step = { kind: "command" as const, id: "command:test", label: "test", value: "pnpm test" };
          callbacks.onPlan([step]);
          callbacks.onStep(step, { attached: true });
          // Split mid-line, as real output arrives.
          callbacks.onOutput?.(step, "✓ adds numbers\n✗ divides ");
          callbacks.onOutput?.(step, "by zero\n");
          await new Promise<void>((resolve) => (finish = resolve));
          callbacks.onResult({ ...step, ok: false, error: "exited with code 1" });
          return { workspace: target.workspace, targets: [], dryRun: false, ok: false } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("divides by zero");
    expect(app.lastFrame()).toMatch(/adds numbers *│?\s*\n\s*│ │ ✗ divides by zero/);
    finish();
    await tick();
    expect(app.lastFrame()).toContain("exited with code 1");
  });

  it("takes the selected bolt down with x", async () => {
    const down = vi.fn(async () => ({ stopped: [{ id: "ab12", label: "pnpm dev" }] as never[] }));
    const app = await open(services({ down }));
    app.stdin.write("x");
    await tick();
    expect(down).toHaveBeenCalledWith(acme, acme.workspace.bolts[0]);
    expect(app.lastFrame()).toContain("Work on api: stopped 1");
  });

  it("marks a bolt that is up", async () => {
    const runs = [{ id: "ab12", kind: "window", label: "pnpm dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:pnpm dev", pid: 1, startedAt: new Date().toISOString(), alive: true }];
    const app = await open(services({ runs: async () => runs as never }));
    await tick();
    expect(app.lastFrame()).toMatch(/Work on api ● running/);
  });

  it("shows past runs like a CI: what started them, the commit, each step's time — and the failed step's log", async () => {
    const entry = {
      id: "3f2a1b",
      workspace: acme.workspace.file,
      workspaceName: "Acme",
      bolt: "Check",
      job: true,
      trigger: "hook",
      git: { branch: "main", commit: "a1b2c3d" },
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      finishedAt: new Date(Date.now() - 597_000).toISOString(),
      ok: false,
      steps: [
        { kind: "command" as const, label: "lint", value: "pnpm lint", ok: true, durationMs: 900, log: "/logs/1" },
        { kind: "command" as const, label: "test", value: "pnpm test", ok: false, error: "exited with code 1", durationMs: 2100, log: "/logs/2" },
        { kind: "command" as const, label: "build", value: "pnpm build", ok: false, skipped: true, note: 'not reached — "test" failed', durationMs: 0 },
      ],
    };
    const readLog = vi.fn(async (path: string) => (path === "/logs/2" ? "✓ adds\nFAIL divides by zero" : "lint ok"));
    const app = await open(services({ history: async () => [entry], readLog }));
    app.stdin.write("h");
    await tick();
    await tick();
    let frame = app.lastFrame() ?? "";
    expect(frame).toContain("TODAY");
    expect(frame).toContain("✗ Check");
    expect(frame).toContain("a git hook · main @ a1b2c3d");
    expect(frame).toContain("failed in 3.0s");
    expect(frame).toContain("failed at test");
    // Into the steps: the failed one is already selected; ⏎ opens its whole log.
    app.stdin.write("\u001B[C");
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    frame = app.lastFrame() ?? "";
    expect(readLog).toHaveBeenCalledWith("/logs/2");
    expect(frame).toMatch(/2 FAIL divides by zero/);
    expect(frame).toContain("lines 1–2 of 2");
  });

  it("retries the failed part of a past run from history", async () => {
    const entry = { id: "aa", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Work on api", job: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, steps: [] };
    const planRetry = vi.fn(async () => []);
    const retry = vi.fn(async (read: WorkspaceRead) => ({ workspace: read.workspace, targets: [], dryRun: false, ok: true }) as SwitchResult);
    const app = await open(services({ history: async () => [entry], planRetry: planRetry as never, retry: retry as never }));
    app.stdin.write("h");
    await tick();
    await tick();
    app.stdin.write("r");
    await tick();
    await tick();
    expect(planRetry).toHaveBeenCalledWith(acme, entry);
    expect(retry).toHaveBeenCalled();
  });
});

describe("panes", () => {
  const server = {
    id: "ab12",
    kind: "background",
    label: "web dev",
    command: "pnpm dev",
    workspace: acme.workspace.file,
    workspaceName: "Acme",
    asset: "command:web dev",
    pid: 1,
    startedAt: new Date().toISOString(),
    alive: true,
    log: "/logs/web",
  };

  it("show a running command's output live, cleaned of what a terminal would not show", async () => {
    const app = await open(
      services({
        runs: async () => [server] as never,
        tail: async () => "\u001B[32m▲ Next.js 16\u001B[0m\r\n- Local: http://localhost:3000\r\ncompiling 40%\rcompiling 100%\r\n",
      }),
    );
    await tick();
    app.stdin.write("p");
    await tick();
    await tick();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("web dev");
    expect(frame).toContain("● running");
    expect(frame).toContain("- Local: http://localhost:3000");
    expect(frame).toContain("compiling 100%");
    expect(frame).not.toContain("compiling 40%");
  });

  it("restart the selected command with r, and go full screen with f", async () => {
    const restart = vi.fn(async () => ({ ok: true, run: { ...server, id: "cd34" } }));
    const app = await open(services({ runs: async () => [server] as never, tail: async () => "hello", restart: restart as never }));
    await tick();
    app.stdin.write("p");
    await tick();
    app.stdin.write("r");
    await tick();
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ id: "ab12" }));
    app.stdin.write("f");
    await tick();
    expect(app.lastFrame()).not.toContain("Running  History");
  });
});

describe("doing everything without JSON", () => {
  it("offers to set up a folder that has no file yet, and asks about trust right after", async () => {
    const suggestion = { dir: "/dev/shop", name: "Shop", found: ["package.json pnpm dev", "compose.yaml (postgres)"], bolts: [{ label: "Work on Shop", job: false, steps: ["start Docker services: postgres", "start Shop dev"] }], contents: "{}" };
    const setUp = vi.fn(async () => infra.workspace.file);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp }, { reads: [infra], unreadable: [] }));
    await tick();
    expect(app.lastFrame()).toContain("Set up Shop?");
    expect(app.lastFrame()).toContain("compose.yaml (postgres)");
    expect(app.lastFrame()).toContain("start Docker services: postgres, then start Shop dev");
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(setUp).toHaveBeenCalledWith(suggestion);
    expect(app.lastFrame()).toContain("Trust infra?");
  });

  it("adds a step through a form, never showing JSON", async () => {
    const addStep = vi.fn(async () => undefined);
    const editing = { ...services().editing, addStep };
    const app = await open(services({ editing }));
    app.stdin.write("e");
    await tick();
    expect(app.lastFrame()).toContain('Edit "Work on api"');
    app.stdin.write("a");
    await tick();
    expect(app.lastFrame()).toContain("Run a command");
    app.stdin.write("1"); // pick "Run a command"
    await tick();
    expect(app.lastFrame()).toContain("Command");
    for (const char of "pnpm test") app.stdin.write(char);
    await tick();
    app.stdin.write("\r"); // to Name
    app.stdin.write("\r"); // to In folder
    app.stdin.write("\r"); // add it
    await tick();
    await tick();
    expect(addStep).toHaveBeenCalledWith(acme.workspace.file, "Work on api", { run: "pnpm test" }, 0);
  });

  it("says what is wrong with a field, in words", async () => {
    const app = await open(services());
    app.stdin.write("e");
    await tick();
    app.stdin.write("a");
    await tick();
    app.stdin.write("3"); // "Wait until something is ready"
    await tick();
    for (const char of "soon") app.stdin.write(char);
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Not something Specter can wait for");
  });

  it("creates a new bolt from a form and opens it to add steps", async () => {
    const addBolt = vi.fn(async () => undefined);
    const app = await open(services({ editing: { ...services().editing, addBolt } }));
    app.stdin.write("a");
    await tick();
    expect(app.lastFrame()).toContain("A new bolt in Acme");
    for (const char of "Run the tests") app.stdin.write(char);
    app.stdin.write("\r");
    await tick();
    app.stdin.write("\u001B[C"); // → : a job
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(addBolt).toHaveBeenCalledWith(acme.workspace.file, "Run the tests", { job: true });
    expect(app.lastFrame()).toContain('Edit "Run the tests"');
  });

  it("shows containers next to commands, with how they are doing", async () => {
    const container = { file: "/f", project: "shop", service: "postgres", name: "shop-postgres-1", image: "postgres:16", state: "running", health: "healthy", status: "Up 3 minutes (healthy)", ports: ["5432"], exitCode: 0 };
    const app = await open(
      services({
        containers: async () => ({ containers: [container] }),
        containerStats: async () => new Map([["shop-postgres-1", { cpu: "0.4%", memory: "48MiB" }]]),
        containerLogs: async () => "database system is ready to accept connections",
      }),
    );
    // Containers are only watched for compose files a workspace uses.
    const withCompose = read("/dev/shop/.specter.json", { name: "Shop", bolts: [{ label: "Services", targets: [{ compose: "compose.yaml" }] }] });
    const app2 = await open(
      services(
        {
          containers: async () => ({ containers: [container] }),
          containerStats: async () => new Map([["shop-postgres-1", { cpu: "0.4%", memory: "48MiB" }]]),
          containerLogs: async () => "database system is ready to accept connections",
        },
        { reads: [withCompose], here: withCompose.workspace.file, unreadable: [] },
      ),
    );
    void app;
    await tick();
    app2.stdin.write("p");
    await tick();
    await tick();
    await tick();
    const frame = app2.lastFrame() ?? "";
    expect(frame).toContain("CONTAINERS · SHOP");
    expect(frame).toContain("healthy · 5432 · up 3m");
    expect(frame).toContain("ready to accept connections");
  });

  it("says so the moment something stops by itself", async () => {
    let alive = true;
    const server = { id: "ab12", kind: "background", label: "web dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:x", pid: 1, startedAt: new Date().toISOString(), log: "/l" };
    const app = await open(services({ runs: async () => [{ ...server, alive }] as never }));
    await tick();
    alive = false;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(app.lastFrame()).toContain("! web dev stopped (Acme) — press p to see its last output");
  });
});

describe("search", () => {
  it("prefers bolts whose own words match", () => {
    const hits = search([acme, infra], "api");
    expect(hits[0]?.label).toBe("Acme › Work on api");
  });

  it("matches letters in order, and nothing out of order", () => {
    expect(score("Work on api", "woa")).toBeDefined();
    expect(score("Work on api", "aow")).toBeUndefined();
  });
});

describe("windowed", () => {
  it("keeps the selection in view", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(windowed(items, 0, 5).items).toEqual([0, 1, 2, 3, 4]);
    expect(windowed(items, 19, 5).items).toEqual([15, 16, 17, 18, 19]);
    expect(windowed(items, 10, 5).items).toContain(10);
  });
});

describe("editing text", () => {
  it("moves the cursor with the arrows, and edits where it is", async () => {
    const { editAt } = await import("./forms.js");
    const key = (extra: Record<string, boolean> = {}) => ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, ...extra }) as never;
    let state = { value: "npm strt", cursor: 8 };
    for (let at = 0; at < 2; at += 1) state = editAt(state.value, state.cursor, "", key({ leftArrow: true }))!;
    state = editAt(state.value, state.cursor, "a", key())!;
    expect(state).toEqual({ value: "npm start", cursor: 7 });
    state = editAt(state.value, state.cursor, "a", key({ ctrl: true }))!;
    expect(state.cursor).toBe(0);
  });
});

describe("a run in progress", () => {
  const plan = [
    { target: { kind: "command" as const, id: "command:lint", label: "lint", value: "pnpm lint" }, workspace: acme.workspace, job: true, bolt: "Work on api" },
    { target: { kind: "command" as const, id: "command:test", label: "test", value: "pnpm test" }, workspace: acme.workspace, job: true, bolt: "Work on api" },
  ];

  it("can be stopped with x, which reaches the run", async () => {
    let signal: AbortSignal | undefined;
    const app = await open(
      services({
        run: async (target, _bolt, callbacks) => {
          signal = callbacks.signal;
          callbacks.onPlan([plan[0]!.target]);
          callbacks.onStep(plan[0]!.target, { attached: true });
          await new Promise<void>((resolve) => callbacks.signal?.addEventListener("abort", () => resolve()));
          callbacks.onResult({ ...plan[0]!.target, ok: false, error: "exited with code 130" });
          return { workspace: target.workspace, targets: [], dryRun: false, ok: false } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await tick();
    app.stdin.write("x");
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(app.lastFrame()).toContain("Stopped — you stopped it.");
  });

  it("retries only the failed steps with r", async () => {
    const retry = vi.fn(async (read: WorkspaceRead) => ({ workspace: read.workspace, targets: [], dryRun: false, ok: true }) as SwitchResult);
    const app = await open(
      services({
        retry: retry as never,
        run: async (target, _bolt, callbacks) => {
          callbacks.onPlan(plan.map((step) => step.target));
          const targets = [{ ...plan[0]!.target, ok: true }, { ...plan[1]!.target, ok: false, error: "exited with code 1" }];
          for (const result of targets) callbacks.onResult(result);
          return { workspace: target.workspace, targets, dryRun: false, ok: false, plan } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("r retry the step that didn't work");
    app.stdin.write("r");
    await tick();
    expect(retry).toHaveBeenCalledWith(acme, [plan[1]], "Work on api", false, expect.anything());
  });

  it("is the first pane, with its live output", async () => {
    const app = await open(
      services({
        run: async (target, _bolt, callbacks) => {
          callbacks.onPlan([plan[0]!.target]);
          callbacks.onStep(plan[0]!.target, { attached: true });
          callbacks.onOutput?.(plan[0]!.target, "Creating an optimized production build ...\n");
          await new Promise(() => undefined);
          return { workspace: target.workspace, targets: [], dryRun: false, ok: true } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await tick();
    app.stdin.write("p");
    await tick();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("RUNNING NOW");
    expect(frame).toContain("Starting lint…");
    expect(frame).toContain("Creating an optimized production build");
  });
});

describe("running and history", () => {
  it("are two screens: p for what's running, h for what ran", async () => {
    const app = await open(services());
    app.stdin.write("p");
    await tick();
    expect(app.lastFrame()).toContain("Nothing is running");
    expect(app.lastFrame()).not.toContain("History");
    app.stdin.write("h");
    await tick();
    await tick();
    expect(app.lastFrame()).toContain("History");
    expect(app.lastFrame()).toContain("Nothing has run yet");
    app.stdin.write("p");
    await tick();
    expect(app.lastFrame()).toContain("Nothing is running");
  });
});

describe("long links", () => {
  it("are shown by their name and site, or cut to host and path", async () => {
    const { describeStep, shortUrl } = await import("./model.js");
    const notion = "https://app.notion.com/p/20d57edf20d480048206d7083c40e58b?v=20d57edf20d480cdb210000cfbf13953&assetsVersion=23.13";
    expect(describeStep({ kind: "link", id: "l", label: "Notion", value: notion })).toBe("open Notion (app.notion.com)");
    expect(describeStep({ kind: "link", id: "l", label: notion, value: notion })).toBe("open app.notion.com/p/20d57edf20d480048206d7083c40e58b?…");
    expect(shortUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("never push the workspace list out of shape", async () => {
    const long = read("/dev/notes/.specter.json", { name: "Notes", bolts: [{ label: "Notion", targets: [{ url: `https://app.notion.com/p/${"x".repeat(300)}` }] }] });
    const app = await open(services({}, { reads: [long], here: long.workspace.file, unreadable: [] }));
    const lines = (app.lastFrame() ?? "").split("\n").slice(1, -1);
    // Every row is exactly as wide as the screen: nothing spills, nothing wraps.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(lines.filter((line) => line.startsWith("╰")).length).toBe(1);
  });
});

describe("history steps", () => {
  it("say what each step did, in the words used everywhere else", async () => {
    const { describeHistoryStep } = await import("./history.js");
    const step = (kind: string, label: string, value = label) => ({ kind, label, value, ok: true, durationMs: 1 }) as never;
    expect(describeHistoryStep(step("wait", "port 5432"), false)).toBe("wait until port 5432 is open");
    expect(describeHistoryStep(step("wait", "http://localhost:3000"), false)).toBe("wait until http://localhost:3000 answers");
    expect(describeHistoryStep(step("link", "http://localhost:3000"), false)).toBe("open http://localhost:3000");
    expect(describeHistoryStep(step("command", "Flower Testbed dev", "pnpm dev"), false)).toBe("start Flower Testbed dev");
    expect(describeHistoryStep(step("command", "test", "pnpm test"), true)).toBe("run test");
  });
});

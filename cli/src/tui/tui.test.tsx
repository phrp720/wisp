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

const acme = read("/dev/acme/.wisp.json", {
  name: "Acme",
  bolts: [
    { label: "Work on api", targets: [{ folder: "apps/api" }, { run: "pnpm dev" }] },
    { label: "Work on web", targets: [{ folder: "apps/web" }] },
  ],
});
const infra = read("/dev/infra/.wisp.json", { name: "infra", bolts: [{ label: "Database", targets: [{ run: "postgres" }] }] }, "untrusted");
const morning = read("/home/.config/wisp/workspaces/Morning.json", { name: "Morning", bolts: [{ label: "Start the day", targets: [{ url: "mail.google.com" }] }] }, "trusted", true);

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
    declineSetup: async () => undefined,
    setUp: async () => "",
    watch: () => () => undefined,
    settings: {
      get: async () => ({}),
      set: async (change) => change,
      choices: () => ({ editors: [{ label: "Visual Studio Code", value: "Visual Studio Code" }], terminals: ["Terminal", "Ghostty", "tmux"] }),
    },
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
      removePersonalWorkspace: async () => undefined,
      forgetProject: async () => undefined,
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
const ARROW_RIGHT = "\u001B[C";

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
    expect(frame).toContain("infra !");
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
    // infra isn't trusted and Database runs a command: it asks rather than run half of it.
    expect(app.lastFrame()).toContain("Trust infra?");
    expect(run).not.toHaveBeenCalled();
    app.stdin.write("\r");
    await tick();
    await tick();

    app.stdin.write("/");
    await tick();
    for (const char of "web") {
      app.stdin.write(char);
      await tick();
    }
    expect(app.lastFrame()).toContain("❯ Acme › Work on web");
    app.stdin.write("\r");
    await tick();
    expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.anything());
  });

  it("does nothing else with the ⏎ that cancels a trust dialog — it does not run the bolt behind it", async () => {
    const run = vi.fn(services().run);
    const trust = vi.fn(async () => undefined);
    const app = await open(services({ run, trust }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await tick();
    // On a bolt, t opens the trust dialog; ⏎ on its Cancel must stop there.
    app.stdin.write("t");
    await tick();
    expect(app.lastFrame()).toContain("Trust infra?");
    app.stdin.write("\r");
    await tick();
    await tick();
    await tick();
    expect(trust).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain("Trust infra?");
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

    // Buttons: it starts on Cancel, so ⏎ alone allows nothing; ← then ⏎ trusts.
    app.stdin.write("t");
    await tick();
    expect(app.lastFrame()).toMatch(/Trust this file[\s\S]*Cancel/);
    app.stdin.write("\r");
    await tick();
    expect(trust).not.toHaveBeenCalled();
    app.stdin.write("t");
    await tick();
    app.stdin.write("\u001B[D");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(trust).toHaveBeenCalledWith(infra.workspace.file, infra.hash);
  });

  it("cancelling the delete-workspace dialog leaves the dashboard as it was: no run, focus unmoved", async () => {
    const run = vi.fn(services().run);
    const forgetProject = vi.fn(async () => undefined);
    const base = services({ run });
    const app = await open(services({ run, editing: { ...base.editing, forgetProject } }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    for (const key of ["D", ARROW_RIGHT, "\r", "D", ARROW_RIGHT, ARROW_LEFT, ARROW_RIGHT, "\r"]) {
      app.stdin.write(key);
      await tick();
    }
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(forgetProject).not.toHaveBeenCalled();
    // Still on the workspaces: D asks about the workspace again, not about a bolt.
    app.stdin.write("D");
    await tick();
    expect(app.lastFrame()).toContain('Remove "Acme" from your list?');
  });

  it("D on a project in the list removes it from the list, and never deletes its file", async () => {
    const forgetProject = vi.fn(async () => undefined);
    const removePersonalWorkspace = vi.fn(async () => undefined);
    const base = services();
    const app = await open(services({ editing: { ...base.editing, forgetProject, removePersonalWorkspace } }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("D");
    await tick();
    expect(app.lastFrame()).toContain('Remove "Acme" from your list?');
    expect(app.lastFrame()).toContain("stays in the repository");
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(forgetProject).toHaveBeenCalledWith(acme.workspace.file);
    expect(removePersonalWorkspace).not.toHaveBeenCalled();
  });

  it("offers + add a bolt in an empty workspace, and ⏎ opens the form instead of running", async () => {
    const empty = read("/home/.config/wisp/workspaces/Notes.json", { name: "Notes", bolts: [] }, "trusted", true);
    const run = vi.fn(services().run);
    const app = await open(services({ run }, { reads: [empty], here: empty.workspace.file, unreadable: [] }));
    app.stdin.write(ARROW_RIGHT);
    await tick();
    expect(app.lastFrame()).toContain("+ add a bolt");
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("A new bolt in Notes");
    expect(run).not.toHaveBeenCalled();
  });

  it("asks before running a bolt that would start only half, and runs it once trusted", async () => {
    const shop = (trust: TrustState) =>
      read("/dev/shop/.wisp.json", {
        name: "Shop",
        bolts: [
          { label: "Work on web", targets: [{ bolt: "Database" }, { url: "http://localhost:3000" }] },
          { label: "Database", targets: [{ run: "postgres" }] },
          { label: "Docs", targets: [{ url: "https://docs.shop.test" }] },
        ],
      }, trust);
    let current = shop("untrusted");
    const ran: string[] = [];
    const base = services();
    const api = services({
      load: async () => ({ reads: [current], here: current.workspace.file, unreadable: [] }),
      trust: vi.fn(async () => {
        current = shop("trusted");
      }),
      run: async (target, bolt, callbacks) => {
        ran.push(`${bolt}:${target.workspace.trusted ? "trusted" : "untrusted"}`);
        return base.run(target, bolt, callbacks);
      },
    });
    const app = await open(api);

    // Its own step is a link, but the bolt it needs runs a command: ⏎ asks, nothing starts.
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Trust Shop?");
    expect(app.lastFrame()).toContain('"Work on web" needs some of these');
    expect(app.lastFrame()).toMatch(/Trust and run[\s\S]*Cancel/);
    expect(ran).toEqual([]);

    // Cancel runs nothing at all, rather than the half that was allowed.
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(ran).toEqual([]);
    expect(app.lastFrame()).toContain("didn't run");

    // A bolt with nothing waiting for trust runs straight away.
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(ran).toEqual(["Docs:untrusted"]);
    app.stdin.write("\u001B");
    await tick();

    // Trust and run: trusts the file, then runs the bolt, whole.
    app.stdin.write("\u001B[A");
    await tick();
    app.stdin.write("\u001B[A");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("\r");
    for (let i = 0; i < 5; i++) await tick();
    expect(api.trust).toHaveBeenCalled();
    expect(ran).toEqual(["Docs:untrusted", "Work on web:trusted"]);
  });

  it("shows a bolt whole with v: its order, the bolts it needs opened up, what each runs", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      bolts: [
        { label: "Work on web", targets: [{ bolt: "Database" }, { run: "pnpm dev", label: "web", cwd: "apps/web", restart: "on-failure" }, { wait: "localhost:3000" }, { url: "http://localhost:3000" }] },
        { label: "Database", targets: [{ compose: "compose.yaml", services: ["db"] }] },
      ],
    });
    const app = await open(services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] }));
    await tick();
    app.stdin.write("v");
    await tick();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("order  Database ──▶ Work on web");
    expect(frame).toMatch(/1 +⚡ Database[\s\S]*1\.1 +start Docker services: db[\s\S]*2 +start web[\s\S]*pnpm dev · in apps\/web · restarted if it crashes[\s\S]*3 +wait until port 3000 is open[\s\S]*4 +open/);
    expect(frame).toContain("read-only");
    app.stdin.write("\u001B");
    await tick();
    expect(app.lastFrame()).not.toContain("read-only");
  });

  it("has three tabs along the top, 1–3, and keeps a log of what happened under Running", async () => {
    const app = await open(services({ history: async () => [] }));
    await tick();
    expect(app.lastFrame()).toMatch(/1 Bolts +2 Running +3 History/);
    app.stdin.write("3");
    await tick();
    await tick();
    expect(app.lastFrame()).toContain("Nothing has run yet");
    app.stdin.write("2");
    await tick();
    expect(app.lastFrame()).toContain("Nothing is running");
    app.stdin.write("1");
    await tick();
    expect(app.lastFrame()).toContain("Workspaces");
    // A run started here shows up in the activity log.
    app.stdin.write("\r");
    await tick();
    await tick();
    app.stdin.write("2");
    await tick();
    expect(app.lastFrame()).toMatch(/ACTIVITY[\s\S]*\d\d:\d\d Work on api is up/);
  });

  it("changes your own settings from a screen of their own, with s", async () => {
    const set = vi.fn(async (change: Record<string, string>) => change);
    const app = await open(services({ settings: { get: async () => ({}), set, choices: () => ({ editors: [{ label: "Visual Studio Code", value: "Visual Studio Code" }], terminals: ["Ghostty", "tmux"] }) } }));
    await tick();
    app.stdin.write("s");
    await tick();
    await tick();
    expect(app.lastFrame()).toMatch(/Folders open in +the system default/);
    expect(app.lastFrame()).toContain("in the background, watched in Wisp");
    app.stdin.write("\r"); // Folders
    await tick();
    expect(app.lastFrame()).toContain("Visual Studio Code");
    app.stdin.write("2"); // the first editor, after "the system default"
    await tick();
    await tick();
    expect(set).toHaveBeenCalledWith({ folder: "Visual Studio Code" });
  });

  it("sets up only the suggested bolts left ticked", async () => {
    const suggestion = {
      dir: "/dev/shop",
      name: "Shop",
      found: ["package.json pnpm dev"],
      bolts: [
        { label: "Services", job: false, steps: ["start Docker services: postgres"] },
        { label: "Work on Shop", job: false, steps: ["start Shop dev"] },
        { label: "Check", job: true, steps: ["run test"] },
      ],
      contents: "{}",
    };
    const setUp = vi.fn(async () => infra.workspace.file);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp }, { reads: [infra], unreadable: [] }));
    await tick();
    expect(app.lastFrame()).toMatch(/\[✓\] ⚡ Services[\s\S]*\[✓\] ⚡ Work on Shop[\s\S]*\[✓\] ⚡ Check/);
    app.stdin.write(" "); // untick Services
    await tick();
    expect(app.lastFrame()).toContain("Set up 2 bolts");
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(setUp).toHaveBeenCalledWith(suggestion, ["Work on Shop", "Check"]);
  });

  it("stops offering setup in a folder after d, don't ask again", async () => {
    const suggestion = { dir: "/dev/shop", name: "Shop", found: [], bolts: [{ label: "Services", job: false, steps: ["start Docker services: postgres"] }], contents: "{}" };
    const setUp = vi.fn(async () => infra.workspace.file);
    const declineSetup = vi.fn(async () => undefined);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp, declineSetup }, { reads: [infra], unreadable: [] }));
    await tick();
    expect(app.lastFrame()).toContain("Set up this bolt");
    expect(app.lastFrame()).toContain("d don't ask again");
    app.stdin.write("d");
    await tick();
    await tick();
    expect(declineSetup).toHaveBeenCalledWith("/dev/shop");
    expect(setUp).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Won't ask here again");
  });

  it("says so when there are no workspaces at all", async () => {
    const frame = (await open(services({}, { reads: [], unreadable: [] }))).lastFrame() ?? "";
    expect(frame).toContain("No workspaces yet");
    expect(frame).toContain("wisp init");
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

  it("asks, when the bolt needed others, whether to stop those too", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      bolts: [
        { label: "Work on web", targets: [{ bolt: "Database" }, { run: "pnpm dev", label: "web" }] },
        { label: "Database", targets: [{ run: "postgres", label: "db" }] },
      ],
    });
    const down = vi.fn(async () => ({ stopped: [] as never[] }));
    const app = await open(services({ down }, { reads: [shop], here: shop.workspace.file, unreadable: [] }));
    await tick();
    app.stdin.write("x");
    await tick();
    expect(app.lastFrame()).toContain("It needed Database");
    // esc backs out: nothing stopped.
    app.stdin.write("\u001B");
    await tick();
    await tick();
    expect(down).not.toHaveBeenCalled();
    app.stdin.write("x");
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(down).toHaveBeenCalledWith(shop, shop.workspace.bolts[0], { deps: true });
  });

  it("takes the selected bolt down with x", async () => {
    const down = vi.fn(async () => ({ stopped: [{ id: "ab12", label: "pnpm dev" }] as never[] }));
    const app = await open(services({ down }));
    app.stdin.write("x");
    await tick();
    expect(down).toHaveBeenCalledWith(acme, acme.workspace.bolts[0], { deps: false });
    expect(app.lastFrame()).toContain("Work on api: stopped 1");
  });

  it("marks a bolt that is up", async () => {
    const runs = [{ id: "ab12", kind: "window", label: "pnpm dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:pnpm dev", pid: 1, startedAt: new Date().toISOString(), alive: true }];
    const app = await open(services({ runs: async () => runs as never }));
    await tick();
    expect(app.lastFrame()).toMatch(/Work on api ● running/);
  });

  it("shows past runs like a CI: bolts to filter by, numbered runs, and a run's summary, pipeline and logs", async () => {
    const entry = {
      id: "3f2a1b",
      number: 7,
      workspace: acme.workspace.file,
      workspaceName: "Acme",
      bolt: "Check",
      job: true,
      trigger: "hook",
      git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" },
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      finishedAt: new Date(Date.now() - 597_000).toISOString(),
      ok: false,
      steps: [
        { kind: "command" as const, label: "postgres", value: "docker compose up", ok: true, durationMs: 1200, bolt: "Database" },
        { kind: "command" as const, label: "lint", value: "pnpm lint", ok: true, durationMs: 900, log: "/logs/1" },
        { kind: "command" as const, label: "test", value: "pnpm test", ok: false, error: "exited with code 1", durationMs: 2100, log: "/logs/2" },
        { kind: "command" as const, label: "build", value: "pnpm build", ok: false, skipped: true, note: 'not reached — "test" failed', durationMs: 0 },
      ],
    };
    const readLog = vi.fn(async (path: string) => (path === "/logs/2" ? "✓ adds\nFAIL divides by zero" : "lint ok"));
    const app = render(<App services={services({ history: async () => [entry], readLog })} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await tick();
    await tick();
    let frame = app.lastFrame() ?? "";
    expect(frame).toContain("All bolts");
    expect(frame).toContain("Check #7");
    expect(frame).toContain("failed at test · “fix cart total” · a1b2c3d");
    expect(frame).toContain(" main ");

    // / narrows the runs as you type; nothing matching says so.
    for (const key of ["/", "z", "z"]) {
      app.stdin.write(key);
      await tick();
    }
    expect(app.lastFrame()).toContain("No run matches “zz”");
    app.stdin.write("\u001B");
    await tick();
    for (const key of ["/", "c", "a", "r", "t", "\r"]) {
      app.stdin.write(key);
      await tick();
    }
    expect(app.lastFrame()).toContain("Check #7");

    // Open it: summary, pipeline with the dependency as one box, and the failed step's log.
    app.stdin.write("\r");
    await tick();
    await tick();
    frame = app.lastFrame() ?? "";
    expect(frame).toContain("Check #7");
    expect(frame).toContain("Triggered");
    expect(frame).toContain("from a git hook");
    expect(frame).toContain("Failed");
    expect(frame).toContain("Database");
    expect(frame).toContain("1 step");
    expect(readLog).toHaveBeenCalledWith("/logs/2");
    expect(frame).toMatch(/2 FAIL divides by zero/);
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
    expect(setUp).toHaveBeenCalledWith(suggestion, ["Work on Shop"]);
    expect(app.lastFrame()).toContain("Trust infra?");
  });

  it("adds a step through a form, never showing JSON", async () => {
    const addStep = vi.fn(async () => undefined);
    const editing = { ...services().editing, addStep };
    const app = await open(services({ editing }));
    app.stdin.write("e");
    await tick();
    expect(app.lastFrame()).toContain("⚡ Work on api");
    app.stdin.write("a");
    await tick();
    // Grouped, as an action list is: what to start, what to wait for, what to open.
    expect(app.lastFrame()).toMatch(/START[\s\S]*Run a command[\s\S]*WAIT[\s\S]*OPEN/);
    app.stdin.write("1"); // pick "Run a command"
    await tick();
    expect(app.lastFrame()).toContain("Command");
    for (const char of "pnpm test") app.stdin.write(char);
    await tick();
    app.stdin.write("\r"); // to Name
    app.stdin.write("\r"); // to In folder
    app.stdin.write("\r"); // to If it stops
    await tick();
    // What it will do, said before it is saved.
    expect(app.lastFrame()).toContain("It will: run pnpm test");
    app.stdin.write("\r"); // to the button
    app.stdin.write("\r"); // Add step
    await tick();
    await tick();
    expect(addStep).toHaveBeenCalledWith(acme.workspace.file, "Work on api", { run: "pnpm test" }, 0);
  });

  it("picks the bolt to run first from a list — this workspace's and others' — instead of typing it", async () => {
    const addStep = vi.fn(async () => undefined);
    const app = await open(services({ editing: { ...services().editing, addStep } }));
    app.stdin.write("e");
    await tick();
    app.stdin.write("a");
    await tick();
    app.stdin.write("3"); // "Run another bolt first"
    await tick();
    expect(app.lastFrame()).toContain("infra › Database");
    // → moves to the next bolt; the last one in the list is another workspace's.
    for (let at = 0; at < 6; at += 1) app.stdin.write("\u001B[D");
    await tick();
    app.stdin.write("\r");
    app.stdin.write("\r");
    await tick();
    await tick();
    expect(addStep).toHaveBeenCalled();
    const step = (addStep.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(typeof step["bolt"]).toBe("string");
  });

  it("says what is wrong with a field, in words", async () => {
    const app = await open(services());
    app.stdin.write("e");
    await tick();
    app.stdin.write("a");
    await tick();
    app.stdin.write("4"); // "Wait until something is ready"
    await tick();
    for (const char of "soon") app.stdin.write(char);
    app.stdin.write("\r"); // to the button
    app.stdin.write("\r"); // Add step
    await tick();
    expect(app.lastFrame()).toContain("Not something Wisp can wait for");
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
    app.stdin.write("\r"); // to the button
    app.stdin.write("\r"); // Create bolt
    await tick();
    await tick();
    expect(addBolt).toHaveBeenCalledWith(acme.workspace.file, "Run the tests", { job: true });
    // Straight on to its first step.
    expect(app.lastFrame()).toContain("The first step of ⚡ Run the tests");
  });

  it("shows containers next to commands, with how they are doing", async () => {
    const container = { file: "/dev/shop/compose.yaml", project: "shop", service: "postgres", name: "shop-postgres-1", image: "postgres:16", state: "running", health: "healthy", status: "Up 3 minutes (healthy)", ports: ["5432"], exitCode: 0 };
    const app = await open(
      services({
        containers: async () => ({ containers: [container] }),
        containerStats: async () => new Map([["shop-postgres-1", { cpu: "0.4%", memory: "48MiB" }]]),
        containerLogs: async () => "database system is ready to accept connections",
      }),
    );
    // Containers are only watched for compose files a workspace uses.
    const withCompose = read("/dev/shop/.wisp.json", { name: "Shop", bolts: [{ label: "Services", targets: [{ compose: "compose.yaml" }] }] });
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
    // Under the bolt whose compose step starts it, in its workspace.
    expect(frame).toMatch(/SHOP[\s\S]*Services[\s\S]*● postgres +healthy/);
    expect(frame).toContain("on localhost:5432");
    expect(frame).toContain("ready to accept connections");
  });

  it("groups what runs under the bolt that started it, and finds things with /", async () => {
    const server = { kind: "background", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:x", pid: 1, startedAt: new Date().toISOString(), alive: true, log: "/l" };
    const api = { ...server, id: "a1", label: "api", command: "pnpm api", bolt: "Work on web", historyId: "h3" };
    const web = { ...server, id: "w1", label: "web", command: "pnpm web", bolt: "Work on web", historyId: "h5" };
    const lone = { ...server, id: "l1", label: "notes", command: "mdbook serve" };
    const past = (id: string, number: number) => ({ id, number, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Work on web", ok: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] });
    const app = await open(services({ runs: async () => [api, web, lone] as never, tail: async () => "", history: async () => [past("h5", 5), past("h3", 3)] as never }));
    await tick();
    app.stdin.write("p");
    await tick();
    await tick();
    let frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/ACME[\s\S]*Work on web[\s\S]*● up[\s\S]*api[\s\S]*web[\s\S]*Not from a bolt[\s\S]*notes/);

    for (const key of ["/", "m", "d", "b"]) {
      app.stdin.write(key);
      await tick();
    }
    frame = app.lastFrame() ?? "";
    expect(frame).toContain("/ mdb");
    expect(frame).toContain("notes");
    expect(frame).not.toContain("Work on web");
    app.stdin.write("\u001B");
    await tick();
    await tick();
    expect(app.lastFrame()).toContain("Work on web");
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
    expect(app.lastFrame()).toContain(`r retry from ${plan[1]!.target.label}`);
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
    expect(frame).toContain("Starting l");
    expect(frame).toContain("Creating an optimized production build");
  });
});

describe("running and history", () => {
  it("are two screens: p for what's running, h for what ran", async () => {
    const app = await open(services());
    app.stdin.write("p");
    await tick();
    expect(app.lastFrame()).toContain("Nothing is running");
    expect(app.lastFrame()).not.toContain("Nothing has run yet");
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
    const long = read("/dev/notes/.wisp.json", { name: "Notes", bolts: [{ label: "Notion", targets: [{ url: `https://app.notion.com/p/${"x".repeat(300)}` }] }] });
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
    expect(describeHistoryStep(step("command", "Payments Service dev", "pnpm dev"), false)).toBe("start Payments Service dev");
    expect(describeHistoryStep(step("command", "test", "pnpm test"), true)).toBe("run test");
  });
});

import { createHash } from "node:crypto";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { VERSION } from "../cli/version.js";
import type { HistoryEntry } from "../core/history.js";
import { interpret } from "../core/project.js";
import type { SwitchResult, TrustState, WorkspaceRead } from "../core/types.js";
import { App } from "./App.js";
import { glyphs } from "./glyphs.js";
import { score, search, windowed, type Library, type Services } from "./model.js";
import { terminalMouse } from "./mouse.js";

const unicode = glyphs({ LANG: "en_US.UTF-8" }, "darwin");

function read(file: string, main: Record<string, unknown>, trust: TrustState = "trusted", personal = false): WorkspaceRead {
  return interpret({ main }, { file, personal, trust, os: "darwin" });
}

const acme = read("/dev/acme/.wisp.json", {
  name: "Acme",
  pipelines: [
    { label: "Work on api", steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] },
    { label: "Work on web", steps: [{ folder: "apps/web" }] },
  ],
});
const infra = read("/dev/infra/.wisp.json", { name: "infra", pipelines: [{ label: "Database", steps: [{ run: "postgres" }] }] }, "untrusted");
const morning = read("/home/.config/wisp/workspaces/Morning.json", { name: "Morning", pipelines: [{ label: "Start the day", steps: [{ url: "mail.google.com" }] }] }, "trusted", true);

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
    questions: async () => [],
    inputs: async () => [],
    suggestSetup: async () => undefined,
    declineSetup: async () => undefined,
    setUp: async () => "",
    watch: () => () => undefined,
    settings: {
      get: async () => ({}),
      set: async (change) => change,
      choices: () => ({ editors: [{ label: "Visual Studio Code", value: "Visual Studio Code" }], terminals: ["Terminal", "Ghostty", "tmux"] }),
      mouse: async () => true,
      setMouse: async (on) => on,
      notify: async () => ({ when: "failures", webhooks: [] }),
      setNotify: async (change) => ({ when: "failures", webhooks: [], ...change }),
    },
    editing: {
      bolt: async (_file, bolt) => ({ label: bolt, steps: [] }),
      addPipeline: async () => undefined,
      renamePipeline: async () => undefined,
      setPipelineNotes: async () => undefined,
      setSlug: async () => undefined,
      setWorkspaceDetails: async () => undefined,
      removePipeline: async () => undefined,
      movePipeline: async () => undefined,
      setKeepGoing: async () => undefined,
      setConfirm: async () => undefined,
      setInput: async () => undefined,
      removeInput: async () => undefined,
      addStep: async () => undefined,
      replaceStep: async () => undefined,
      removeStep: async () => undefined,
      moveStep: async (_file, _bolt, index, by) => index + by,
      setAfter: async () => undefined,
      createPersonalWorkspace: async () => "",
      removePersonalWorkspace: async () => undefined,
      deleteProjectFile: async () => undefined,
    },
    down: async () => ({ stopped: [] }),
    restart: async (run) => ({ ok: true, run }),
    history: async () => [],
    forgetRuns: async () => undefined,
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
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });
const ARROW_DOWN = "\u001B[B";
const ARROW_LEFT = "\u001B[D";
const ARROW_RIGHT = "\u001B[C";

async function open(api: Services) {
  const app = render(<App services={api} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
  await tick();
  await eventually(() => expect(app.lastFrame() ?? "").not.toContain("reading your workspaces"));
  return app;
}

describe("the TUI", () => {
  it("given the workspaces already read, draws them in its first frame, with no loading screen", () => {
    const library: Library = { reads: [morning, infra, acme], here: acme.workspace.file, unreadable: [] };
    const app = render(<App services={services({}, library)} glyphs={unicode} size={{ columns: 100, rows: 24 }} initial={library} />);
    const frame = app.frames[0] ?? "";
    expect(frame).not.toContain("reading your workspaces");
    expect(frame).toContain("❯ Work on api");
    app.unmount();
  });

  it("starts on the project you are in, with its pipelines ready to run", async () => {
    const { lastFrame } = await open(services());
    await eventually(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Workspaces");
      expect(frame.indexOf("Acme")).toBeLessThan(frame.indexOf("infra"));
      expect(frame).toContain("❯ Work on api");
      expect(frame).toContain("pnpm dev");
    });
  });

  it("tells two workspaces with the same name apart, and says to rename one", async () => {
    const twin = read("/work/acme/.wisp.json", { name: "Acme", pipelines: [{ label: "Dev", steps: [{ url: "localhost:3000" }] }] });
    const app = await open(services({}, { reads: [acme, twin], here: acme.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toContain("/work/acme"));
    await eventually(() => expect(app.lastFrame()).toContain("another workspace is called Acme too"));
  });

  it("puts a dot before a run's workspace only when something comes before it", async () => {
    const plain: HistoryEntry = { id: "cccccccccccc", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Dev", number: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] };
    const committed: HistoryEntry = { ...plain, id: "dddddddddddd", bolt: "Verify", git: { branch: "main", commit: "630d9e5", subject: "feat: login" } };
    const app = await open(services({ history: async () => [committed, plain] }));
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("feat: login  · A"));
    await eventually(() => expect(app.lastFrame()).toMatch(/Dev #1 +Acme/));
  });

  it("shows the pipelines in one box and the selected one in a box below, with the command that runs it", async () => {
    const app = await open(services());
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      const list = frame.indexOf("❯ Work on api");
      const details = frame.indexOf("⚡ Work on api");
      expect(list).toBeGreaterThan(-1);
      expect(details).toBeGreaterThan(frame.indexOf("Work on web"));
      expect(frame.slice(list, details)).toContain("╰");
      expect(frame).toMatch(/When you run it, (it will|these \d+ run at the same time):/);
      expect(frame).toContain("never run yet");
      expect(frame).toContain("from a terminal: wisp api");
    });
    await tick();
    app.stdin.write("j");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("⚡ Work on web"));
    await eventually(() => expect(app.lastFrame()).toContain("from a terminal: wisp web"));
  });

  it("keeps one box on a short terminal", async () => {
    const app = render(<App services={services()} glyphs={unicode} size={{ columns: 100, rows: 16 }} />);
    await tick();
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("❯ Work on api");
      expect(frame).toContain("pnpm dev");
      expect(frame).not.toContain("from a terminal");
    });
  });

  it("fits the keys and the version on an 80-column terminal", async () => {
    const app = render(<App services={services()} glyphs={unicode} size={{ columns: 80, rows: 24 }} />);
    await tick();
    const footer = (app.lastFrame() ?? "").split("\n").at(-1) ?? "";
    await eventually(() => expect(footer).toContain("? keys · q quit"));
    await eventually(() => expect(footer).toContain(`v${VERSION}`));
  });

  it("shows the keys of the tab you are on with ?, and goes back there", async () => {
    const app = await open(services());
    app.stdin.write("2");
    await tick();
    app.stdin.write("?");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Keys on Running"));
    await eventually(() => expect(app.lastFrame()).toContain("show the ones that stopped too"));
    await tick();
    app.stdin.write(" ");
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toContain("Keys on Running"));
    expect((app.lastFrame() ?? "").split("\n").at(-1)).toContain("? keys · esc");
  });

  it("puts History's keys along the bottom, like the other tabs, and keeps your run across ?", async () => {
    const run = (id: string, number: number): HistoryEntry => ({ id, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", number, startedAt: new Date(Date.now() - number * 60_000).toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] });
    const app = await open(services({ history: async () => [run("bbbbbbbbbbbb", 2), run("aaaaaaaaaaaa", 1)] }));
    app.stdin.write("h");
    await tick();
    await tick();
    await eventually(() => {
      const lines = (app.lastFrame() ?? "").split("\n");
      expect(lines.at(-1)).toContain("⏎ open · ← pipelines");
      expect(lines.slice(0, -1).join("\n")).not.toContain("⏎ open · ← pipelines");
    });
    await tick();
    app.stdin.write("j");
    await tick();
    app.stdin.write("?");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Keys on History"));
    await tick();
    app.stdin.write("x");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ ✓ Check #1/));
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    expect((app.lastFrame() ?? "").split("\n").at(-1)).toContain("↑↓ steps");
  });

  it("shows a renamed workspace's runs in History under the name it has now", async () => {
    const run = (id: string, workspace: string, workspaceName: string, bolt: string): HistoryEntry => ({ id, workspace, workspaceName, bolt, number: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] });
    const app = await open(services({ history: async () => [run("aaaaaaaaaaaa", acme.workspace.file, "Acme Old", "Check"), run("bbbbbbbbbbbb", acme.workspace.file, "Acme", "Lint"), run("cccccccccccc", "/dev/gone/.wisp.json", "Gone", "Deploy")] }));
    app.stdin.write("h");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("ACME"));
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("Acme Old");
      expect(frame).not.toContain("ACME OLD");
      expect(frame.match(/ACME/g)).toHaveLength(1);
      expect(frame).toContain("GONE");
    });
  });

  it("cuts a long pipeline name in History short, never into its count", async () => {
    const entry: HistoryEntry = { id: "", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Work on the whole Flower Testbed", number: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] };
    const app = await open(services({ history: async () => Array.from({ length: 14 }, (_, at) => ({ ...entry, id: `${at}`.padStart(12, "a"), number: at + 1 })) }));
    app.stdin.write("h");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Work on the[^│]*…\s+14 │/));
  });

  it("shows the version at the bottom right", async () => {
    const { lastFrame } = await open(services());
    expect((lastFrame() ?? "").split("\n").at(-1)).toContain(`v${VERSION}`);
  });

  it("shows a run still going in History, and D deletes a finished run or a pipeline's runs after asking", async () => {
    const done: HistoryEntry = { id: "aaaaaaaaaaaa", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", number: 1, startedAt: new Date(Date.now() - 90_000).toISOString(), finishedAt: new Date(Date.now() - 80_000).toISOString(), ok: true, steps: [] };
    const going: HistoryEntry = { ...done, id: "bbbbbbbbbbbb", number: 2, ok: false, running: true, pid: 1, total: 3, startedAt: new Date().toISOString(), steps: [{ kind: "command", label: "lint", value: "pnpm lint", ok: true, durationMs: 1000 }] };
    const forgetRuns = vi.fn(async () => undefined);
    const app = await open(services({ history: async () => [going, done], forgetRuns }));
    app.stdin.write("h");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("running, step 2 of 3"));

    await tick();

    app.stdin.write("D");
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toContain("Delete run"));

    await tick();

    app.stdin.write("j");
    await tick();
    app.stdin.write("D");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Delete run #1 of Check?"));
    await eventually(() => expect(app.lastFrame()).toContain("running, step 2 of 3"));
    await tick();
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(forgetRuns).toHaveBeenCalledWith(["aaaaaaaaaaaa"]));

    await tick();

    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("D");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Clear all 1 run?"));
  });

  it("edits a workspace's name, icon and notes with e on the workspace list", async () => {
    const setWorkspaceDetails = vi.fn(async () => undefined);
    const app = await open(services({ editing: { ...services().editing, setWorkspaceDetails } }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toContain('Workspace "Acme"'));
    await eventually(() => expect(app.lastFrame()).toContain("which your team shares"));
    await tick();
    for (const key of " Labs") app.stdin.write(key);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setWorkspaceDetails).toHaveBeenCalledWith(acme.workspace.file, { name: "Acme Labs", icon: "", notes: "" }));
    await eventually(() => expect(app.lastFrame()).toContain('Renamed "Acme" to "Acme Labs"'));
  });

  it("asks about deleting a pipeline on its row, with the rest of the list still there", async () => {
    const removePipeline = vi.fn(async () => undefined);
    const app = await open(services({ editing: { ...services().editing, removePipeline } }));
    app.stdin.write("D");
    await tick();
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain('Delete "Work on api"?');
      expect(frame).toContain("Work on web");
      expect(frame).toContain("Workspaces");
      expect(frame).toContain("what it started keeps running");
      expect(frame.indexOf('Delete "Work on api"?')).toBeLessThan(frame.indexOf("Work on web"));
    });
    await tick();
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(removePipeline).toHaveBeenCalledWith(acme.workspace.file, "Work on api"));
  });

  it("asks about removing a step on its row in the editor, and esc keeps it", async () => {
    const removeStep = vi.fn(async () => undefined);
    const bolt = async () => ({ label: "Work on api", steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] });
    const app = await open(services({ editing: { ...services().editing, bolt, removeStep } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*apps\/api/));
    await tick();
    app.stdin.write("D");
    await eventually(() => expect(app.lastFrame()).toContain("Remove this step?"));
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("⚡ Work on api");
      expect(frame).toContain("pnpm dev");
    });
    await tick();
    app.stdin.write("\u001B");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toContain("Remove this step?"));
    await eventually(() => expect(removeStep).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("D");
    await eventually(() => expect(app.lastFrame()).toContain("Remove this step?"));
    await tick();
    app.stdin.write("y");
    await eventually(() => expect(removeStep).toHaveBeenCalledWith(acme.workspace.file, "Work on api", 0));
  });

  it("opens a run that is going on the step it is on, with its output so far and the steps still to come", async () => {
    const step = (label: string) => ({ kind: "command" as const, label, value: `pnpm ${label}`, ok: false, durationMs: 0, finishes: true });
    const going: HistoryEntry = {
      id: "cccccccccccc", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", number: 3, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false,
      steps: [{ ...step("lint"), ok: true, durationMs: 1200 }],
      running: true, pid: 1, total: 3,
      pending: [{ ...step("test"), bolt: "Tests", running: true, log: "/logs/2.log" }, step("build")],
    };
    const readLog = vi.fn(async (path: string) => (path === "/logs/2.log" ? "compiling the tests" : ""));
    const app = await open(services({ history: async () => [going], readLog }));
    app.stdin.write("h");
    await tick();
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Running, step 2 of 3");
      expect(frame).toMatch(/❯ ▾ ● run test\s+running/);
      expect(frame).toContain("compiling the tests");
      expect(frame).toMatch(/· run build\s+waiting/);
      expect(frame).toMatch(/● Tests/);
    });
  });

  it("lists projects before personal workspaces, and flags one waiting for trust", async () => {
    const frame = (await open(services())).lastFrame() ?? "";
    expect(frame.indexOf("infra")).toBeLessThan(frame.indexOf("Morning"));
    await eventually(() => expect(frame).toContain("infra !"));
    // Grouped, and said in words: no unexplained marks. Read from the list alone — the
    // left column — since the panel beside it names the workspace too.
    const list = frame.split("\n").map((line) => line.slice(0, 28)).join("\n");
    expect(list.indexOf("THIS FOLDER")).toBeLessThan(list.indexOf("Acme"));
    expect(list.indexOf("Acme")).toBeLessThan(list.indexOf("PROJECTS"));
    expect(list.indexOf("PROJECTS")).toBeLessThan(list.indexOf("infra"));
    expect(list.indexOf("YOURS")).toBeLessThan(list.indexOf("Morning"));
  });

  it("moves between pipelines and runs the selected one, showing each step", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write(ARROW_DOWN);
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("❯ Work on web"));

    await tick();

    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.objectContaining({ dryRun: false })));
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Acme › Work on web");
      expect(frame).toContain("✓ open the step 0 folder");
      expect(frame).toContain("All done.");
    });

    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Pipelines"));
  });

  it("handles keys that arrive faster than it redraws", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    // No pause between them: each key must see what the one before it did.
    app.stdin.write(ARROW_DOWN);
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.anything()));
    await tick();

    app.stdin.write("k");
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(run).toHaveBeenLastCalledWith(acme, "Work on api", expect.anything()));
  });

  it("asks on the pipeline's row before running a pipeline that asks first: y runs it, esc runs nothing", async () => {
    const run = vi.fn(services().run);
    const questions = vi.fn(async (_read: WorkspaceRead, bolt: string) => (bolt === "Work on web" ? ["Deploy the web?"] : []));
    const app = await open(services({ run, questions }));
    app.stdin.write(ARROW_DOWN);
    await eventually(() => expect(app.lastFrame()).toContain("❯ Work on web"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Deploy the web?"));
    await eventually(() => expect(app.lastFrame()).toContain("Cancel"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("\u001B");
    await eventually(() => expect(app.lastFrame()).not.toContain("Deploy the web?"));
    await eventually(() => expect(run).not.toHaveBeenCalled());

    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Deploy the web?"));
    await tick();
    app.stdin.write("y");
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.objectContaining({ dryRun: false })));
    await eventually(() => expect(app.lastFrame()).toContain("Acme › Work on web"));
  });

  it("asks for a pipeline's inputs in a form, then its question with the values in it, then runs with them", async () => {
    const run = vi.fn(services().run);
    const inputs = vi.fn(async (_read: WorkspaceRead, bolt: string) =>
      bolt === "Work on web" ? [{ name: "env", ask: "Deploy where?", choices: ["staging", "production"] }, { name: "tag", ask: "Which tag?", default: "latest" }] : [],
    );
    const questions = vi.fn(async (_read: WorkspaceRead, _bolt: string, values?: Record<string, string>) => (values?.["env"] ? [`Deploy to ${values["env"]}?`] : []));
    const app = await open(services({ run, inputs, questions }));
    app.stdin.write(ARROW_DOWN);
    await eventually(() => expect(app.lastFrame()).toContain("❯ Work on web"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain('Run "Work on web" in Acme'));
    await eventually(() => expect(app.lastFrame()).toContain("Deploy where?"));
    await eventually(() => expect(app.lastFrame()).toMatch(/Which tag\?[^\n]*\n[^\n]*› +latest/));
    await eventually(() => expect(app.lastFrame()).not.toContain("*"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(app.lastFrame()).toContain("Deploy to production?"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("y");
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.objectContaining({ inputs: { env: "production", tag: "latest" } })));
  });

  it("says under the field when a value isn't one word, and runs nothing", async () => {
    const run = vi.fn(services().run);
    const inputs = vi.fn(async (_read: WorkspaceRead, bolt: string) => (bolt === "Work on web" ? [{ name: "tag", ask: "Which tag?" }] : []));
    const app = await open(services({ run, inputs }));
    app.stdin.write(ARROW_DOWN);
    await eventually(() => expect(app.lastFrame()).toContain("❯ Work on web"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Which tag?"));
    await tick();
    for (const char of "v1; reboot") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toContain("› v1; reboot"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(app.lastFrame()).toContain("takes plain words"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
  });

  it("names a pipeline's inputs in its details", async () => {
    const deploy = read("/dev/acme/.wisp.json", { name: "Acme", pipelines: [{ label: "Deploy", inputs: { variant: { ask: "Which?" }, port: { default: "443" } }, confirm: "Deploy {{variant}}?", steps: [{ url: "https://localhost:{{port}}" }] }] });
    const app = await open(services({}, { reads: [deploy], here: deploy.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toMatch(/inputs: variant, port +│\n│ +│.*asks first: Deploy \{\{variant\}\}\? · never run yet/));
  });

  it("gives a pipeline's notes two lines, and ends a longer one with …", async () => {
    const long = "docker compose up --wait for a variant, project dir is the repo root where the .env lives. Stop it with wisp down deploy and the same variant. Opens the site when it is up.";
    const deploy = read("/dev/acme/.wisp.json", { name: "Acme", pipelines: [{ label: "Deploy", notes: long, steps: [{ url: "localhost:3000" }] }] });
    const app = await open(services({}, { reads: [deploy], here: deploy.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toContain("⚡ Deploy"));
    const frame = app.lastFrame() ?? "";
    const at = frame.split("\n").findIndex((line) => line.includes("⚡ Deploy"));
    const [first, second, third] = frame.split("\n").slice(at + 1, at + 4);
    expect(first).toContain("docker compose up --wait");
    expect(second).toMatch(/\S+.*…/);
    expect(third).not.toMatch(/[a-z]/);
  });

  it("says in a pipeline's details that it asks first", async () => {
    const asking = read("/dev/acme/.wisp.json", { name: "Acme", pipelines: [{ label: "Ship", confirm: "Ship it?", steps: [{ url: "localhost:3000" }] }] });
    const app = await open(services({}, { reads: [asking], here: asking.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toContain("asks first: Ship it? · never run yet"));
  });

  it("checks a pipeline with c: a dry run in its box, nothing runs", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write("c");
    await tick();
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on api", expect.objectContaining({ dryRun: true })));
    await eventually(() => expect(app.lastFrame()).toContain("Ready to run. That's what it would do; nothing ran."));
    await eventually(() => expect(app.lastFrame()).toContain("checking"));
  });

  it("switches workspace from the list", async () => {
    const app = await open(services());
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Database"));
    await eventually(() => expect(app.lastFrame()).toContain("not trusted yet — t"));
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
    await eventually(() => expect(app.lastFrame()).toContain("❯ infra › Database"));
    await tick();
    app.stdin.write("\r");
    await tick();
    // infra isn't trusted and Database runs a command: it asks rather than run half of it.
    await eventually(() => expect(app.lastFrame()).toContain("Trust infra?"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();

    app.stdin.write("/");
    await tick();
    for (const char of "web") {
      app.stdin.write(char);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toContain("❯ Acme › Work on web"));
    await tick();
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(run).toHaveBeenCalledWith(acme, "Work on web", expect.anything()));
  });

  it("does nothing else with the ⏎ that cancels a trust dialog — it does not run the pipeline behind it", async () => {
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
    await eventually(() => expect(app.lastFrame()).toContain("Trust infra?"));
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await tick();
    await eventually(() => expect(trust).not.toHaveBeenCalled());
    await eventually(() => expect(run).not.toHaveBeenCalled());
    await eventually(() => expect(app.lastFrame()).not.toContain("Trust infra?"));
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
    await eventually(() => expect(app.lastFrame()).toContain("Trust infra?"));
    await eventually(() => expect(app.lastFrame()).toContain("postgres"));

    await tick();

    app.stdin.write("x");
    await tick();
    await eventually(() => expect(trust).not.toHaveBeenCalled());

    // Buttons: it starts on Cancel, so ⏎ alone allows nothing; ← then ⏎ trusts.
    app.stdin.write("t");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Trust this file[\s\S]*Cancel/));
    await tick();
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(trust).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("t");
    await tick();
    app.stdin.write("\u001B[D");
    await tick();
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(trust).toHaveBeenCalledWith(infra.workspace.file, infra.hash));
  });

  it("scrolls a long log on a run's page, and stays where you scrolled to", async () => {
    const entry = {
      id: "c1e2a3",
      number: 1,
      workspace: acme.workspace.file,
      workspaceName: "Acme",
      bolt: "Cleanup",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 58_000).toISOString(),
      ok: true,
      steps: [{ kind: "command" as const, label: "Cleanup", value: "mo clean", ok: true, durationMs: 1500, log: "/logs/clean" }],
    };
    const text = Array.from({ length: 80 }, (_, at) => `cleaned item ${at + 1}`).join("\n");
    const app = render(<App services={services({ history: async () => [entry], readLog: async () => text })} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
    await tick();
    for (const key of ["h", "\r"]) {
      app.stdin.write(key);
      await tick();
      await tick();
    }
    // Open its log, if it didn't open by itself.
    if ((app.lastFrame() ?? "").includes("▸ ✓ start Cleanup")) app.stdin.write("\r");
    await tick();
    await tick();
    const shown = () => [...(app.lastFrame() ?? "").matchAll(/cleaned item (\d+)/g)].map((match) => Number(match[1]));
    expect(shown()[0]).toBe(1);

    app.stdin.write("d");
    await tick();
    await tick();
    const paged = shown()[0] ?? 0;
    await eventually(() => expect(paged).toBeGreaterThan(5));

    // ↓ past the only step reads on a line at a time; u goes back up to the top.
    app.stdin.write("\u001B[B");
    await tick();
    expect(shown()[0]).toBe(paged + 1);
    for (const key of ["u", "u", "u"]) {
      app.stdin.write(key);
      await tick();
    }
    expect(shown()[0]).toBe(1);
  });

  it("cancelling the delete-workspace dialog leaves the dashboard as it was: no run, focus unmoved", async () => {
    const run = vi.fn(services().run);
    const deleteProjectFile = vi.fn(async () => undefined);
    const base = services({ run });
    const app = await open(services({ run, editing: { ...base.editing, deleteProjectFile } }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    for (const key of ["D", ARROW_RIGHT, "\r", "D", ARROW_RIGHT, ARROW_LEFT, ARROW_RIGHT, "\r"]) {
      app.stdin.write(key);
      await tick();
    }
    await tick();
    await eventually(() => expect(run).not.toHaveBeenCalled());
    await eventually(() => expect(deleteProjectFile).not.toHaveBeenCalled());
    // Still on the workspaces: D asks about the workspace again, not about a bolt.
    app.stdin.write("D");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Delete its .wisp.json?"));
  });

  it("D on a project deletes its .wisp.json for good, after saying which file", async () => {
    const deleteProjectFile = vi.fn(async () => undefined);
    const removePersonalWorkspace = vi.fn(async () => undefined);
    const base = services();
    const app = await open(services({ editing: { ...base.editing, deleteProjectFile, removePersonalWorkspace } }));
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("D");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Delete its .wisp.json?"));
    await eventually(() => expect(app.lastFrame()).toContain(`Deletes ${acme.workspace.file} for good`));
    await eventually(() => expect(app.lastFrame()).toContain("infra"));
    await eventually(() => expect(app.lastFrame()).toContain("Work on api"));
    await tick();
    app.stdin.write(ARROW_LEFT);
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(deleteProjectFile).toHaveBeenCalledWith(acme.workspace.file));
    await eventually(() => expect(removePersonalWorkspace).not.toHaveBeenCalled());
  });

  it("offers + add a pipeline in an empty workspace, and ⏎ opens the form instead of running", async () => {
    const empty = read("/home/.config/wisp/workspaces/Notes.json", { name: "Notes", pipelines: [] }, "trusted", true);
    const run = vi.fn(services().run);
    const app = await open(services({ run }, { reads: [empty], here: empty.workspace.file, unreadable: [] }));
    app.stdin.write(ARROW_RIGHT);
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("+ add a pipeline"));
    await tick();
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("A new pipeline in Notes"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
  });

  it("asks before running a pipeline that would start only half, and runs it once trusted", async () => {
    const shop = (trust: TrustState) =>
      read("/dev/shop/.wisp.json", {
        name: "Shop",
        pipelines: [
          { label: "Work on web", steps: [{ pipeline: "Database", label: "db" }, { url: "http://localhost:3000", after: "db" }] },
          { label: "Database", steps: [{ run: "postgres" }] },
          { label: "Docs", steps: [{ url: "https://docs.shop.test" }] },
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
    await eventually(() => expect(app.lastFrame()).toContain("Trust Shop?"));
    await eventually(() => expect(app.lastFrame()).toContain('"Work on web" needs some of these'));
    await eventually(() => expect(app.lastFrame()).toMatch(/Trust and run[\s\S]*Cancel/));
    await eventually(() => expect(ran).toEqual([]));

    // Cancel runs nothing at all, rather than the half that was allowed.
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(ran).toEqual([]));
    await eventually(() => expect(app.lastFrame()).toContain("didn't run"));

    // A bolt with nothing waiting for trust runs straight away.
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(ran).toEqual(["Docs:untrusted"]));
    await tick();
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
    await eventually(() => expect(ran).toEqual(["Docs:untrusted", "Work on web:trusted"]));
  });

  it("shows the selected pipeline whole in its box: its order, the pipelines it runs opened up, what each runs", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      pipelines: [
        { label: "Work on web", steps: [{ pipeline: "Database", label: "db" }, { run: "pnpm dev", label: "web", cwd: "apps/web", restart: "on-failure", after: "db" }, { wait: "localhost:3000", label: "up", after: "web" }, { url: "http://localhost:3000", after: "up" }] },
        { label: "Database", steps: [{ compose: "compose.yaml", services: ["db"] }] },
      ],
    });
    const app = render(<App services={services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 100, rows: 30 }} />);
    await eventually(() => expect(app.lastFrame()).toContain("order  Database ──▶ Work on web"));
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).toMatch(/ 1\. ⚡ ?Database[\s\S]* {4}1\. start Docker services: db[\s\S]* 2\. start web +after db[\s\S]*pnpm dev · in apps\/web · restarted if it crashes[\s\S]* 3\. wait until port 3000 is open +after web[\s\S]* 4\. open/));
    await eventually(() => expect(app.lastFrame()).not.toContain("v view"));
  });

  it("draws a pipeline's steps as a graph above them, side by side where they run together, and v hides it", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      pipelines: [{ label: "Check", steps: [{ run: "pnpm install", label: "install", finishes: true }, { run: "pnpm lint", label: "lint", finishes: true, after: "install" }, { run: "pnpm test", label: "test", finishes: true, after: "install" }, { run: "pnpm build", label: "build", finishes: true, after: ["lint", "test"] }] }],
    });
    const app = render(<App services={services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 120, rows: 40 }} />);
    await eventually(() => expect(app.lastFrame()).toMatch(/│ · install │ ──▶ │ · lint │ ──▶ │ · build │/));
    expect(app.lastFrame()).toMatch(/╭────────╮[^\n]*\n[^\n]*│ · test │/);
    expect(app.lastFrame()).not.toContain("after install");
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).not.toContain("│ · install │"));
    expect(app.lastFrame()).toMatch(/2\. run lint +after install/);
  });

  it("draws no graph for steps that all run at once, and says so above them", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      pipelines: [{ label: "Check", steps: [{ run: "docker info", label: "docker", finishes: true }, { run: "./variants.sh", label: "variants", finishes: true }, { run: "./tools.sh", label: "tools", finishes: true }] }],
    });
    const app = render(<App services={services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 120, rows: 40 }} />);
    await eventually(() => expect(app.lastFrame()).toContain("When you run it, these 3 run at the same time:"));
    expect(app.lastFrame()).not.toContain("│ · docker │");
    expect(app.lastFrame()).toMatch(/1\. run docker[\s\S]*1\. run variants[\s\S]*1\. run tools/);
  });

  it("keeps a big pipeline's graph to part of the box: one line a step, then +N more, and its commands still show", async () => {
    const many = Array.from({ length: 12 }, (_, at) => ({ run: `./check-${at + 1}.sh`, label: `check ${at + 1}`, finishes: true, after: "setup" }));
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      pipelines: [{ label: "Audit", steps: [{ run: "./setup.sh", label: "setup", finishes: true }, ...many, { run: "./report.sh", label: "report", finishes: true, after: many.map((step) => step.label) }] }],
    });
    const app = render(<App services={services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 120, rows: 40 }} />);
    await eventually(() => expect(app.lastFrame()).toMatch(/· setup ──▶ · check 1 +──▶ · report/));
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("╭─────────╮");
    expect(frame).toMatch(/│ +\+4 more +│/);
    expect(frame).not.toContain("check 12");
    expect(frame).toMatch(/1\. run setup/);
    expect(frame).toContain("./setup.sh");
  });

  it("keeps a step that isn't allowed yet where the file has it, numbered by what it waits for", async () => {
    const shop = read(
      "/dev/shop/.wisp.json",
      {
        name: "Shop",
        pipelines: [
          { label: "Work on web", steps: [{ pipeline: "Database", label: "db" }, { run: "pnpm dev", label: "web", after: "db" }, { wait: "localhost:3000", label: "up", after: "web" }, { url: "http://localhost:3000", after: "up" }] },
          { label: "Database", steps: [{ url: "http://db.test" }, { compose: "docker-compose.yml" }] },
        ],
      },
      "untrusted",
    );
    const app = render(<App services={services({}, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 100, rows: 30 }} />);
    await eventually(() => expect(app.lastFrame()).toMatch(/When you run it, (it will|these \d+ run at the same time):/));
    await eventually(() => expect(app.lastFrame()).toMatch(/start Docker services from docker-com.* +not trusted yet — t │/));
    await eventually(() => expect(app.lastFrame()).not.toContain("Docker services: Docker services"));
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).toMatch(/ 1\. ⚡ ?Database[\s\S]* {4}1\. open[\s\S]* 2\. start web +after db +not trusted yet[\s\S]*pnpm dev[\s\S]* 3\. wait until port 3000 is open +after web[\s\S]* 4\. open http:\/\/localhost:3000 +after up/));
  });

  it("shows a pipeline's problems on its row and in its box, and the file's in the header, without a check to run", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      nmae: "typo",
      pipelines: [
        { label: "dev", steps: [{ pipeline: "Services" }, { folder: "web" }] },
        { label: "Docs", steps: [{ url: "https://docs.shop.test" }] },
      ],
    });
    const check = async () => ({ ...shop, diagnostics: [...shop.diagnostics, { level: "error" as const, at: "pipelines[0].steps[1].folder", message: "no such folder: /dev/shop/web", pipeline: "dev" }] });
    const app = render(<App services={services({ check }, { reads: [shop], here: shop.workspace.file, unreadable: [] })} glyphs={unicode} size={{ columns: 110, rows: 30 }} />);
    await eventually(() => expect(app.lastFrame()).toContain("no such folder: /dev/shop/web"));
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toMatch(/1\. ⚡ ?Services +✗ no pipeline by that name/);
      expect(frame).toMatch(/❯ dev +✗ 2 problems/);
      expect(frame).not.toMatch(/Docs +✗/);
      expect(frame).toContain('✗ "dev" runs a pipeline called "Services", which this file does not declare');
      expect(frame).toContain('Pick one of this file\'s pipelines, or add one called "Services"');
      expect(frame).toMatch(/! "nmae"/);
      expect(frame).not.toContain("c to check");
    });
  });

  it("scrolls a long pipeline's steps with u and d", async () => {
    const long = read("/dev/long/.wisp.json", { name: "Long", pipelines: [{ label: "Morning", steps: Array.from({ length: 30 }, (_, at) => ({ url: `https://site${at + 1}.example.com`, label: `site ${at + 1}` })) }] });
    const app = await open(services({}, { reads: [long], here: long.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toMatch(/\d+ more below · u d scroll/));
    await eventually(() => expect(app.lastFrame()).toContain(" 1. open site 1"));
    await tick();
    app.stdin.write("d");
    await eventually(() => expect(app.lastFrame()).toMatch(/5 above · \d+ more below · u d scroll/));
    await eventually(() => expect(app.lastFrame()).not.toContain(" 1. open site 1"));
    await tick();
    app.stdin.write("u");
    await eventually(() => expect(app.lastFrame()).toContain(" 1. open site 1"));
  });

  it("has three tabs along the top, 1–3, and keeps a log of what happened under Running", async () => {
    const app = await open(services({ history: async () => [] }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/1 Pipelines +2 Running +3 History/));
    await tick();
    app.stdin.write("3");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Nothing has run yet"));
    await tick();
    app.stdin.write("2");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Nothing is running"));
    await tick();
    app.stdin.write("1");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Workspaces"));
    // A run started here shows up in the activity log.
    app.stdin.write("\r");
    await tick();
    await tick();
    app.stdin.write("2");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/ACTIVITY[\s\S]*\d\d:\d\d Work on api finished/));
  });

  it("changes your own settings by category, with s: the values on the right, saved together", async () => {
    const set = vi.fn(async (change: Record<string, string>) => change);
    const app = await open(services({ settings: { get: async () => ({}), set, choices: () => ({ editors: [{ label: "Visual Studio Code", value: "Visual Studio Code" }], terminals: ["Ghostty", "tmux"] }), mouse: async () => true, setMouse: async (on) => on, notify: async () => ({ when: "failures", webhooks: [] }), setNotify: async (change) => ({ when: "failures", webhooks: [], ...change }) } }));
    await tick();
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toContain("mouse on"));
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toMatch(/❯ Opening/);
      expect(frame).toContain("in the background");
      expect(frame).toContain("when a run fails");
      expect(frame).toContain("● the system default");
    });
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("● Visual Studio Code"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(set).toHaveBeenCalledWith({ folder: "Visual Studio Code", file: "" }));
    await eventually(() => expect(app.lastFrame()).not.toContain("[ Save ]"));
    await eventually(() => expect(app.lastFrame()).toMatch(/ {2}Visual Studio Code · /));

    await tick();

    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("App for folders"));
    await tick();
    app.stdin.write(ARROW_DOWN);
    await tick();
    for (const char of "Sublime Text") app.stdin.write(char);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(set).toHaveBeenCalledWith({ folder: "Sublime Text", file: "" }));
  });

  it("turns the mouse off from the Dashboard category in settings", async () => {
    const setMouse = vi.fn(async (on: boolean) => on);
    const enable = vi.fn();
    const mouse = { subscribe: () => () => undefined, enable };
    const api = services();
    const app = render(<App services={{ ...api, settings: { ...api.settings, setMouse } }} mouse={mouse} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
    await tick();
    await tick();
    await eventually(() => expect(enable).toHaveBeenLastCalledWith(true));
    await tick();
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toContain("mouse on"));
    for (const key of ["j", "j", "j"]) app.stdin.write(key);
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Dashboard/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("● off"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setMouse).toHaveBeenCalledWith(false));
    await eventually(() => expect(app.lastFrame()).toContain("mouse off"));
    await eventually(() => expect(enable).toHaveBeenLastCalledWith(false));
  });

  it("chooses when Wisp tells you about a run, and refuses a webhook that isn't https, from settings", async () => {
    const setNotify = vi.fn(async (change: { when?: "failures" | "changes" | "all" | "off"; webhooks?: { url: string; workspaces?: string[] }[] }) => ({ when: change.when ?? "changes", webhooks: change.webhooks ?? [] }));
    const api = services();
    const app = await open({ ...api, settings: { ...api.settings, setNotify } });
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toContain("when a run fails"));
    await tick();
    app.stdin.write("j");
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Notifications/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Tell me +when a run fails/));
    await eventually(() => expect(app.lastFrame()).toContain("+  add a webhook"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("● when a pipeline starts failing or works again"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setNotify).toHaveBeenCalledWith({ when: "changes" }));
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Tell me +when a pipeline starts failing/));

    await tick();
    app.stdin.write("a");
    await eventually(() => expect(app.lastFrame()).toContain("Add webhooks"));
    await tick();
    for (const char of "ntfy.sh/x") app.stdin.write(char);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(app.lastFrame()).toContain("a web address, starting with https://"));
    await eventually(() => expect(setNotify).toHaveBeenCalledTimes(1));
  });

  it("removes a webhook from the list, adds several in one form, and changes which workspaces one is for, from settings", async () => {
    const setNotify = vi.fn(async (change: { when?: "failures" | "changes" | "all" | "off"; webhooks?: { url: string; workspaces?: string[] }[] }) => ({ when: change.when ?? "failures", webhooks: change.webhooks ?? [] }));
    const api = services();
    const old = "https://ntfy.sh/old-and-secret";
    const deliveries = async () => ({ [createHash("sha256").update(old).digest("hex").slice(0, 16)]: { at: new Date().toISOString(), ok: false, problem: "404 Not Found" } });
    const app = await open({ ...api, settings: { ...api.settings, notify: async () => ({ when: "failures", webhooks: [{ url: old }] }), setNotify, deliveries } });
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toContain("when a run fails"));
    await tick();
    app.stdin.write("j");
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Notifications/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ +1 +https:\/\/ntfy\.sh\/…cret +every workspace/));
    expect(app.lastFrame()).toContain("✗ last one failed: 404 Not Found");
    expect(app.lastFrame()).not.toContain("old-and-secret");
    await tick();
    app.stdin.write("D");
    await eventually(() => expect(app.lastFrame()).toContain("Remove this webhook?"));
    await tick();
    app.stdin.write("y");
    await eventually(() => expect(setNotify).toHaveBeenCalledWith({ webhooks: [] }));
    await eventually(() => expect(app.lastFrame()).toContain("+  add a webhook"));
    expect(app.lastFrame()).toContain("Removed https://ntfy.sh/…cret");

    await tick();
    app.stdin.write("a");
    await eventually(() => expect(app.lastFrame()).toContain("Add webhooks"));
    await tick();
    for (const char of "https://hooks.slack.com/x") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toContain("Address 2"));
    app.stdin.write(ARROW_DOWN);
    await tick();
    for (const char of "https://discord.com/api/webhooks/1/y") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toContain("Address 3"));
    app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_DOWN);
    await eventually(() => expect(app.lastFrame()).toContain("none or all ticked: every workspace"));
    app.stdin.write(ARROW_RIGHT);
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write(" ");
    await tick();
    app.stdin.write("\u0013");
    const both = [
      { url: "https://hooks.slack.com/x", workspaces: [infra.workspace.file] },
      { url: "https://discord.com/api/webhooks/1/y", workspaces: [infra.workspace.file] },
    ];
    await eventually(() => expect(setNotify).toHaveBeenCalledWith({ webhooks: both }));
    await eventually(() => expect(app.lastFrame()).toMatch(/2 +https:\/\/discord\.com\/api\/…\/1\/y +infra/));

    await tick();
    app.stdin.write("k");
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write(" ");
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setNotify).toHaveBeenLastCalledWith({ webhooks: [both[0], { url: both[1]?.url }] }));
  });

  it("says all workspaces when a webhook names every one, and saves ticking them all as every workspace", async () => {
    const setNotify = vi.fn(async (change: { webhooks?: { url: string; workspaces?: string[] }[] }) => ({ when: "failures" as const, webhooks: change.webhooks ?? [] }));
    const api = services();
    const files = [morning, infra, acme].map((entry) => entry.workspace.file);
    const app = await open({ ...api, settings: { ...api.settings, notify: async () => ({ when: "failures", webhooks: [{ url: "https://ntfy.sh/all-of-them", workspaces: files }, { url: "https://ntfy.sh/just-infra-x", workspaces: [infra.workspace.file] }] }), setNotify } });
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toContain("when a run fails"));
    await tick();
    app.stdin.write("j");
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Notifications/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/1 +https:\/\/ntfy\.sh\/…them +all workspaces/));
    expect(app.lastFrame()).toMatch(/2 +https:\/\/ntfy\.sh\/…ra-x +infra/);
    await tick();
    app.stdin.write("j");
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setNotify).toHaveBeenCalledWith({ webhooks: [{ url: "https://ntfy.sh/all-of-them" }, { url: "https://ntfy.sh/just-infra-x", workspaces: [infra.workspace.file] }] }));
  });

  it("sets up only the suggested pipelines left ticked", async () => {
    const suggestion = {
      dir: "/dev/shop",
      name: "Shop",
      found: ["package.json pnpm dev"],
      bolts: [
        { label: "Services", steps: ["start Docker services: postgres"] },
        { label: "Work on Shop", steps: ["start Shop dev"] },
        { label: "Check", steps: ["run test"] },
      ],
      contents: "{}",
    };
    const setUp = vi.fn(async () => infra.workspace.file);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp }, { reads: [infra], unreadable: [] }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/\[✓\] ⚡ Services[\s\S]*\[✓\] ⚡ Work on Shop[\s\S]*\[✓\] ⚡ Check/));
    await tick();
    app.stdin.write(" "); // untick Services
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Set up 2 pipelines"));
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(setUp).toHaveBeenCalledWith(suggestion, ["Work on Shop", "Check"]));
  });

  it("stops offering setup in a folder after d, don't ask again", async () => {
    const suggestion = { dir: "/dev/shop", name: "Shop", found: [], bolts: [{ label: "Services", steps: ["start Docker services: postgres"] }], contents: "{}" };
    const setUp = vi.fn(async () => infra.workspace.file);
    const declineSetup = vi.fn(async () => undefined);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp, declineSetup }, { reads: [infra], unreadable: [] }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Set up this pipeline"));
    await eventually(() => expect(app.lastFrame()).toContain("N don't ask again"));
    await eventually(() => expect(app.lastFrame()).toContain("[ Not now ]"));
    await eventually(() => expect(app.lastFrame()).toContain("[ Don't ask again ]"));
    await tick();
    app.stdin.write("N");
    await tick();
    await tick();
    await eventually(() => expect(declineSetup).toHaveBeenCalledWith("/dev/shop"));
    await eventually(() => expect(setUp).not.toHaveBeenCalled());
    await eventually(() => expect(app.lastFrame()).toContain("Won't ask here again"));
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

describe("commands that finish, down and history in the TUI", () => {
  it("runs a pipeline in its own box, under the list, and esc hides what it did", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("All done."));
    await eventually(() => expect(app.lastFrame()).toContain("❯ Work on api"));
    await eventually(() => expect(app.lastFrame()).toContain("Work on web"));
    await eventually(() => expect(app.lastFrame()).toContain("⏎ done"));
    await eventually(() => expect(app.lastFrame()).not.toContain("When you run it"));
    await tick();
    app.stdin.write("\u001B");
    await eventually(() => expect(app.lastFrame()).toMatch(/When you run it, (it will|these \d+ run at the same time):/));
    await eventually(() => expect(app.lastFrame()).not.toContain("All done."));
  });

  it("closes a finished run on ⏎, back to the pipeline, and runs it again only on the next ⏎", async () => {
    const run = vi.fn(services().run);
    const app = await open(services({ run }));
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("All done."));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/When you run it, (it will|these \d+ run at the same time):/));
    await eventually(() => expect(run).toHaveBeenCalledTimes(1));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(run).toHaveBeenCalledTimes(2));
  });

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
    await eventually(() => expect(app.lastFrame()).toContain("divides by zero"));
    await eventually(() => expect(app.lastFrame()).toMatch(/│ ✓ adds numbers[^\n]*\n[^\n]*│ ✗ divides by zero/));
    finish();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("exited with code 1"));
  });

  it("asks, when the pipeline needed others, whether to stop those too", async () => {
    const shop = read("/dev/shop/.wisp.json", {
      name: "Shop",
      pipelines: [
        { label: "Work on web", steps: [{ pipeline: "Database", label: "db" }, { run: "pnpm dev", label: "web", after: "db" }] },
        { label: "Database", steps: [{ run: "postgres", label: "db" }] },
      ],
    });
    const down = vi.fn(async () => ({ stopped: [] as never[] }));
    const app = await open(services({ down }, { reads: [shop], here: shop.workspace.file, unreadable: [] }));
    await tick();
    app.stdin.write("x");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("It needed Database"));
    // esc backs out: nothing stopped.
    app.stdin.write("\u001B");
    await tick();
    await tick();
    await eventually(() => expect(down).not.toHaveBeenCalled());
    await tick();
    app.stdin.write("x");
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(down).toHaveBeenCalledWith(shop, shop.workspace.bolts[0], { deps: true }));
  });

  it("takes the selected pipeline down with x", async () => {
    const down = vi.fn(async () => ({ stopped: [{ id: "ab12", label: "pnpm dev" }] as never[] }));
    const app = await open(services({ down }));
    app.stdin.write("x");
    await tick();
    await eventually(() => expect(down).toHaveBeenCalledWith(acme, acme.workspace.bolts[0], { deps: false }));
    await eventually(() => expect(app.lastFrame()).toContain("Work on api: stopped 1"));
  });

  it("marks a pipeline that is up", async () => {
    const runs = [{ id: "ab12", kind: "window", label: "pnpm dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:pnpm dev", pid: 1, startedAt: new Date().toISOString(), alive: true }];
    const app = await open(services({ runs: async () => runs as never }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Work on api\s+● running/));
  });

  it("lines up what follows each run's number, whatever its width", async () => {
    const run = (number: number, ok: boolean) => ({ id: `r${number}`, number, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok, steps: ok ? [] : [{ kind: "command" as const, label: "test", value: "pnpm test", ok: false, durationMs: 1 }] });
    const app = render(<App services={services({ history: async () => [run(12, true), run(9, true), run(1, false)] })} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("Check #12"));
    const lines = (app.lastFrame() ?? "").split("\n");
    const where = (number: string, text: string) => {
      const line = lines.find((entry) => entry.includes(`Check ${number} `)) ?? "";
      return line.indexOf(text);
    };
    expect(where("#12", "a1b2c3d")).toBeGreaterThan(0);
    expect(where("#9", "a1b2c3d")).toBe(where("#12", "a1b2c3d"));
    expect(where("#1", "at test")).toBe(where("#12", "a1b2c3d"));
  });

  it("says in the list where a run came from only when it wasn't you", async () => {
    const entry = { id: "aa", number: 3, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", trigger: "tui", git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] };
    const app = render(<App services={services({ history: async () => [entry] })} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("Check #3"));
    await eventually(() => expect(app.lastFrame()).toContain("a1b2c3d fix cart total"));
    await eventually(() => expect(app.lastFrame()).not.toContain("the dashboard"));
  });

  it("shows past runs like a CI: pipelines to filter by, numbered runs, and a run's summary, pipeline and logs", async () => {
    const entry = {
      id: "3f2a1b",
      number: 7,
      workspace: acme.workspace.file,
      workspaceName: "Acme",
      bolt: "Check",
      trigger: "hook",
      inputs: { env: "staging" },
      git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" },
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      finishedAt: new Date(Date.now() - 597_000).toISOString(),
      ok: false,
      steps: [
        { kind: "command" as const, label: "postgres", value: "docker compose up", ok: true, durationMs: 1200, bolt: "Database" },
        { kind: "command" as const, label: "lint", value: "pnpm lint", ok: true, durationMs: 900, log: "/logs/1", finishes: true },
        { kind: "command" as const, label: "test", value: "pnpm test", ok: false, error: "exited with code 1", durationMs: 2100, log: "/logs/2", finishes: true },
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
    await eventually(() => expect(frame).toContain("All pipelines"));
    await eventually(() => expect(frame).toContain("Check #7"));
    await eventually(() => expect(frame).toMatch(/✗ Check #7 +at test +a1b2c3d fix cart total +· git hook/));
    await eventually(() => expect(frame).toMatch(/⎇ main +3\.0s/));

    // / narrows the runs as you type; nothing matching says so.
    for (const key of ["/", "z", "z"]) {
      app.stdin.write(key);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toContain("No run matches “zz”"));
    await tick();
    app.stdin.write("\u001B");
    await tick();
    for (const key of ["/", "c", "a", "r", "t", "\r"]) {
      app.stdin.write(key);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toContain("Check #7"));

    // Open it: summary, pipeline with the dependency as one box, and the failed step's log.
    app.stdin.write("\r");
    await tick();
    await tick();
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toContain("Check #7"));
    await eventually(() => expect(frame).toContain("Triggered"));
    await eventually(() => expect(frame).toContain("from a git hook"));
    await eventually(() => expect(frame).toContain("env=staging"));
    await eventually(() => expect(frame).toContain("Failed"));
    await eventually(() => expect(frame).toContain("Database"));
    await eventually(() => expect(frame).toContain("1 step"));
    await eventually(() => expect(readLog).toHaveBeenCalledWith("/logs/2"));
    await eventually(() => expect(frame).toMatch(/2 FAIL divides by zero/));

    // The tab keys work here too: 3 is the list of runs again, 1 the bolts.
    app.stdin.write("3");
    await eventually(() => expect(app.lastFrame()).not.toContain("Triggered"));
    await eventually(() => expect(app.lastFrame()).toContain("Check #7"));
    await eventually(() => {
      if (!(app.lastFrame() ?? "").includes("Triggered")) app.stdin.write("\r");
      expect(app.lastFrame()).toContain("Triggered");
    });
    await eventually(() => {
      if (!(app.lastFrame() ?? "").includes("Workspaces")) app.stdin.write("1");
      expect(app.lastFrame()).toContain("Workspaces");
    });
  });

  it("hides and shows a run's graph with v", async () => {
    const step = (label: string, stage: number) => ({ kind: "command" as const, label, value: label, ok: true, durationMs: 500, finishes: true, stage });
    const entry: HistoryEntry = { id: "5a6b7c8d9e0f", number: 2, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [step("install", 1), step("lint", 2), step("test", 2), step("build", 3)] };
    const app = render(<App services={services({ history: async () => [entry] })} glyphs={unicode} size={{ columns: 130, rows: 34 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("Check #2"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/│ ✓ install 500ms │ ──▶ │ ✓ lint 500ms │/));
    await eventually(() => expect(app.lastFrame()).toContain("v hide graph"));
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).not.toContain("│ ✓ install 500ms │"));
    expect(app.lastFrame()).toContain("v show graph");
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).toContain("│ ✓ install 500ms │"));
  });

  it("says on a run's page where its notification went, and that it didn't arrive", async () => {
    const entry: HistoryEntry = { id: "4e5f6a7b8c9d", number: 3, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Backup", startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(), ok: false, steps: [{ kind: "command", label: "dump", value: "pg_dump", ok: false, error: "exited with code 1", durationMs: 500 }], notified: [{ url: "https://hooks.slack.com/services/…x7Qa", ok: true }, { url: "https://discord.com/api/…Zk3p", ok: false, problem: "404 Not Found" }] };
    const app = render(<App services={services({ history: async () => [entry] })} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("Backup #3"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Notified"));
    await eventually(() => expect(app.lastFrame()).toContain("1 of 2 failed: https://discord.com/api/…Zk3p 404 Not Found"));
  });

  it("warns along the top when a webhook is failing, and s opens its settings", async () => {
    const api = services();
    const app = await open({ ...api, settings: { ...api.settings, notify: async () => ({ when: "failures", webhooks: [{ url: "https://ntfy.sh/old-and-secret" }] }), failingWebhooks: async () => 1 } });
    await eventually(() => expect(app.lastFrame()).toContain("a webhook is failing: s"));
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Notifications/));
    await eventually(() => expect(app.lastFrame()).toContain("https://ntfy.sh/…cret"));
  });

  it("says nothing along the top while every webhook works", async () => {
    const api = services();
    const app = await open({ ...api, settings: { ...api.settings, failingWebhooks: async () => 0 } });
    await tick();
    expect(app.lastFrame()).not.toContain("failing");
    app.stdin.write("s");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Opening/));
  });

  it("retries the failed part of a past run from history", async () => {
    const entry = { id: "aa", workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Work on api", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, steps: [], inputs: { env: "staging" } };
    const planRetry = vi.fn(async () => []);
    const retry = vi.fn(async (read: WorkspaceRead) => ({ workspace: read.workspace, targets: [], dryRun: false, ok: true }) as SwitchResult);
    const app = await open(services({ history: async () => [entry], planRetry: planRetry as never, retry: retry as never }));
    app.stdin.write("h");
    await tick();
    await tick();
    app.stdin.write("r");
    await tick();
    await tick();
    await eventually(() => expect(planRetry).toHaveBeenCalledWith(acme, entry));
    await eventually(() => expect(retry).toHaveBeenCalledWith(acme, [], "Work on api", expect.objectContaining({ inputs: { env: "staging" } })));
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
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("web dev");
      expect(frame).toContain("● running");
      expect(frame).toContain("- Local: http://localhost:3000");
      expect(frame).toContain("compiling 100%");
      expect(frame).not.toContain("compiling 40%");
    });
  });

  it("restart the selected command with r, and go full screen with f", async () => {
    const restart = vi.fn(async () => ({ ok: true, run: { ...server, id: "cd34" } }));
    const app = await open(services({ runs: async () => [server] as never, tail: async () => "hello", restart: restart as never }));
    await tick();
    app.stdin.write("p");
    await tick();
    app.stdin.write("r");
    await tick();
    await eventually(() => expect(restart).toHaveBeenCalledWith(expect.objectContaining({ id: "ab12" })));
    await tick();
    app.stdin.write("f");
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toContain("Running  History"));
  });

  it("read the log with ↑↓ once full screen, stopping at its first line, and go to the next command with ←→", async () => {
    const worker = { ...server, id: "cd34", label: "worker", command: "pnpm worker", asset: "command:worker", log: "/logs/worker" };
    const lines = (name: string) => Array.from({ length: 40 }, (_, at) => `${name} line ${at + 1}`).join("\n");
    const app = await open(services({ runs: async () => [server, worker] as never, tail: async (log) => lines(log === "/logs/web" ? "web" : "worker") }));
    await tick();
    app.stdin.write("p");
    await tick();
    app.stdin.write("f");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("web line 40"));
    for (const key of ["k", "k", "k"]) {
      app.stdin.write(key);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toContain("↑ 3 lines back"));
    await eventually(() => expect(app.lastFrame()).not.toContain("web line 40"));
    // Paging far past the top stops there: one line down is one line down, not twenty.
    for (const key of ["u", "u", "u", "u", "u"]) {
      app.stdin.write(key);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toMatch(/web line 1\s+│/));
    await tick();
    app.stdin.write("j");
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toMatch(/web line 1\s+│/));
    // → goes to the next command, past the bolt rows, back at its newest line.
    app.stdin.write("\u001B[C");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("worker line 40"));
    await tick();
    app.stdin.write("\u001B[D");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("web line 40"));
  });

  it("have tabs beside the list, [ and ] switch them, and the tab stays while moving between rows", async () => {
    const crashed = { ...server, id: "ef56", alive: false, exitCode: 1, startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const other = { ...server, id: "gh78", label: "worker", command: "pnpm worker", asset: "command:worker" };
    const app = await open(services({ runs: async () => [server, crashed, other] as never, tail: async () => "ready on :3000" }));
    await tick();
    app.stdin.write("p");
    await tick();
    await tick();
    let frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toContain("Logs │ Info │ Runs"));
    await eventually(() => expect(frame).toContain("ready on :3000"));

    await tick();

    app.stdin.write("]");
    await tick();
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toMatch(/Command +pnpm dev/));
    await eventually(() => expect(frame).toMatch(/State +running, PID 1/));
    await eventually(() => expect(frame).toContain("wisp logs ab12 -f"));
    await eventually(() => expect(frame).not.toContain("ready on :3000"));

    await tick();

    app.stdin.write("]");
    await tick();
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toMatch(/ab12/));
    await eventually(() => expect(frame).toMatch(/failed \(exit 1\) +ef56/));
    await eventually(() => expect(frame).not.toContain("gh78"));

    // Back to Info, then to the next command: still on Info, now about that one.
    app.stdin.write("[");
    await tick();
    app.stdin.write("j");
    await tick();
    await tick();
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toMatch(/Command +pnpm worker/));

    await tick();

    app.stdin.write("[");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("ready on :3000"));
  });
});

describe("filtering logs", () => {
  it("keeps only the matching lines of a running command's log, with / when the log is full screen", async () => {
    const server = { id: "ab12", kind: "background", label: "web", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:web", pid: 1, startedAt: new Date().toISOString(), alive: true, log: "/logs/web" };
    const log = ["ready on :3000", "GET /cart 200", "ERROR cart total is NaN", "GET /cart 500", "error: retrying the cart"].join("\n");
    const tail = vi.fn(async () => log);
    const app = await open(services({ runs: async () => [server] as never, tail }));
    await tick();
    app.stdin.write("p");
    await tick();
    app.stdin.write("f");
    await tick();
    for (const key of ["/", "e", "r", "r"]) {
      app.stdin.write(key);
      await tick();
    }
    await tick();
    let frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toContain("/ err"));
    await eventually(() => expect(frame).toContain("2 of 5 lines"));
    await eventually(() => expect(frame).toMatch(/3 ERROR cart total is NaN/));
    await eventually(() => expect(frame).toMatch(/5 error: retrying the cart/));
    await eventually(() => expect(frame).not.toContain("GET /cart 200"));
    // Filtering reads more of the log than the last screens.
    await eventually(() => expect(tail).toHaveBeenLastCalledWith("/logs/web", 20_000, 4 * 1024 * 1024));

    // Kept while you look around; esc clears it.
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("esc clears"));
    await tick();
    app.stdin.write("\u001B");
    await tick();
    await tick();
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toContain("GET /cart 200"));
    await eventually(() => expect(frame).not.toContain("/ err"));
  });

  it("filters every step's log of a past run, and says where the matches are", async () => {
    const entry = {
      id: "c7", number: 7, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", ok: false,
      startedAt: new Date(Date.now() - 600_000).toISOString(), finishedAt: new Date(Date.now() - 597_000).toISOString(),
      steps: [
        { kind: "command" as const, label: "lint", value: "pnpm lint", ok: true, durationMs: 900, log: "/logs/1", finishes: true },
        { kind: "command" as const, label: "test", value: "pnpm test", ok: false, error: "exited with code 1", durationMs: 2100, log: "/logs/2", finishes: true },
      ],
    };
    const readLog = vi.fn(async (path: string) => (path === "/logs/2" ? "✓ adds\n✓ subtracts\nFAIL divides by zero\nFAIL rounds" : "lint ok"));
    const app = render(<App services={services({ history: async () => [entry] as never, readLog })} glyphs={unicode} size={{ columns: 120, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await tick();
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    for (const key of ["/", "f", "a", "i", "l"]) {
      app.stdin.write(key);
      await tick();
    }
    await tick();
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("2 matches in 1 step");
      expect(frame).toMatch(/run test .*2 matches/);
      expect(frame).toMatch(/run lint .*no match/);
      expect(frame).toMatch(/3 FAIL divides by zero/);
      expect(frame).toMatch(/4 FAIL rounds/);
      expect(frame).not.toContain("subtracts");
      // Every step's log is read for it, not only the open one's.
      expect(readLog).toHaveBeenCalledWith("/logs/1");
    });

    app.stdin.write("\r");
    await tick();
    app.stdin.write("\u001B");
    await tick();
    await eventually(() => expect(app.lastFrame()).not.toContain("matches in"));
    await eventually(() => expect(app.lastFrame()).toContain("subtracts"));
    // A second esc goes back to the runs, as before.
    app.stdin.write("\u001B");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("All pipelines"));
  });
});

describe("doing everything without JSON", () => {
  it("offers to set up a folder that has no file yet, and asks about trust right after", async () => {
    const suggestion = { dir: "/dev/shop", name: "Shop", found: ["package.json pnpm dev", "compose.yaml (postgres)"], bolts: [{ label: "Work on Shop", steps: ["start Docker services: postgres", "start Shop dev"] }], contents: "{}" };
    const setUp = vi.fn(async () => infra.workspace.file);
    const app = await open(services({ suggestSetup: async () => suggestion, setUp }, { reads: [infra], unreadable: [] }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Set up Shop?"));
    await eventually(() => expect(app.lastFrame()).toContain("compose.yaml (postgres)"));
    await eventually(() => expect(app.lastFrame()).toContain("start Docker services: postgres, then start Shop dev"));
    await tick();
    app.stdin.write("\r");
    await tick();
    await tick();
    await eventually(() => expect(setUp).toHaveBeenCalledWith(suggestion, ["Work on Shop"]));
    await eventually(() => expect(app.lastFrame()).toContain("Trust infra?"));
  });

  it("adds a step through a form, never showing JSON", async () => {
    const addStep = vi.fn(async () => undefined);
    const editing = { ...services().editing, addStep };
    const app = await open(services({ editing }));
    app.stdin.write("e");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("⚡ Work on api"));
    await tick();
    app.stdin.write("a");
    await tick();
    // Grouped, as an action list is: what to start, what to wait for, what to open.
    await eventually(() => expect(app.lastFrame()).toMatch(/START[\s\S]*Run a command[\s\S]*WAIT[\s\S]*OPEN/));
    await tick();
    app.stdin.write("1"); // pick "Run a command"
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Command"));
    for (const char of "pnpm test") app.stdin.write(char);
    await tick();
    // A test finishes: Wisp guesses so, and asks nothing about restarting it.
    await eventually(() => expect(app.lastFrame()).toContain("● finishes"));
    await eventually(() => expect(app.lastFrame()).not.toContain("Restart"));
    await eventually(() => expect(app.lastFrame()).toContain("Timeout"));
    await tick();
    app.stdin.write("\r"); // to It
    app.stdin.write("\r"); // to Name
    app.stdin.write("\r"); // to In folder
    app.stdin.write("\r"); // to Timeout
    await tick();
    for (const char of "10m") app.stdin.write(char);
    await tick();
    // What it will do, said before it is saved.
    await eventually(() => expect(app.lastFrame()).toContain("It will: run pnpm test"));
    await tick();
    app.stdin.write("\r"); // to the button
    app.stdin.write("\r"); // Add step
    await tick();
    await tick();
    await eventually(() => expect(addStep).toHaveBeenCalledWith(acme.workspace.file, "Work on api", { run: "pnpm test", finishes: true, timeout: "10m" }, 0));
  });

  it("adds a pipeline as a step, picked from this workspace's own, with what it depends on", async () => {
    const addStep = vi.fn(async () => undefined);
    const setAfter = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ folder: "apps/api" }] });
    const app = await open(services({ editing: { ...services().editing, bolt, addStep, setAfter } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*apps\/api/));
    await tick();
    app.stdin.write("a");
    await eventually(() => expect(app.lastFrame()).toContain("Run a pipeline"));
    await tick();
    app.stdin.write("3");
    await eventually(() => expect(app.lastFrame()).toContain("● Work on web"));
    await eventually(() => expect(app.lastFrame()).not.toMatch(/[○●] Work on api/));
    await eventually(() => expect(app.lastFrame()).not.toContain("Database"));
    await eventually(() => expect(app.lastFrame()).toContain("←→ to"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(addStep).toHaveBeenCalledWith(acme.workspace.file, "Work on api", { pipeline: "Work on web" }, 1));
    await eventually(() => expect(setAfter).toHaveBeenCalledWith(acme.workspace.file, "Work on api", 1, [0]));
  });

  it("ticks every step at once from the all row, and none again", async () => {
    const setAfter = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ folder: "apps/api" }, { run: "pnpm lint", label: "lint" }, { run: "pnpm build" }] });
    const app = await open(services({ editing: { ...services().editing, bolt, setAfter } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*apps\/api/));
    await tick();
    app.stdin.write("j");
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*3 .*pnpm build/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save step ]"));
    await eventually(() => expect(app.lastFrame()).toContain("↓ 1 more"));
    await tick();
    for (let down = 0; down < 5; down += 1) app.stdin.write("\u001B[B");
    await eventually(() => expect(app.lastFrame()).toContain("←→ move · space ticks"));
    await eventually(() => expect(app.lastFrame()).toContain("□ all"));
    await eventually(() => expect(app.lastFrame()).toMatch(/↑ \d more/));
    await tick();
    app.stdin.write(" ");
    await eventually(() => expect(app.lastFrame()).toContain("■ all"));
    await eventually(() => expect(app.lastFrame()).toContain("■ 1 · open the apps/api folder"));
    await eventually(() => expect(app.lastFrame()).toContain("■ 2 · run lint — pnpm lint"));
    await tick();
    app.stdin.write(" ");
    await eventually(() => expect(app.lastFrame()).toContain("□ 2 · run lint — pnpm lint"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write(" ");
    await eventually(() => expect(app.lastFrame()).toContain("□ all  1 of 2"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setAfter).toHaveBeenCalledWith(acme.workspace.file, "Work on api", 2, [0]));
  });

  it("shows a pipeline's notes, and changes them on its Notes row without renaming it", async () => {
    const setPipelineNotes = vi.fn(async () => undefined);
    const renamePipeline = vi.fn(async () => undefined);
    const noted = read("/dev/acme/.wisp.json", { name: "Acme", pipelines: [{ label: "Work on api", notes: "The API and its database", steps: [{ folder: "apps/api" }] }] });
    const bolt = async () => ({ label: "Work on api", notes: "The API and its database", steps: [] });
    const app = await open(services({ editing: { ...services().editing, bolt, setPipelineNotes, renamePipeline } }, { reads: [noted], here: noted.workspace.file, unreadable: [] }));
    await eventually(() => expect(app.lastFrame()).toContain("The API and its database"));
    await tick();
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toContain("+  add the first step"));
    await tick();
    for (let up = 0; up < 4; up += 1) app.stdin.write("\u001B[A");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Notes +The API and its database/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    for (const char of " too") app.stdin.write(char);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setPipelineNotes).toHaveBeenCalled());
    await eventually(() => expect(renamePipeline).not.toHaveBeenCalled());
    await eventually(() => expect(setPipelineNotes).toHaveBeenCalledWith(noted.workspace.file, "Work on api", "The API and its database too"));
  });

  it("renames a pipeline, gives it a slug and makes it keep going after a failure, from the rows above its steps", async () => {
    const renamePipeline = vi.fn(async () => undefined);
    const setKeepGoing = vi.fn(async () => undefined);
    const setSlug = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] });
    const app = await open(services({ editing: { ...services().editing, bolt, renamePipeline, setKeepGoing, setSlug } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*apps\/api/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ \+  add an input/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Ask first +no/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ On failure +stop/));
    await eventually(() => expect(app.lastFrame()).toContain("keep going"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write("\u001B[C");
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setKeepGoing).toHaveBeenCalledWith(acme.workspace.file, "Work on api", true));
    await eventually(() => expect(app.lastFrame()).not.toContain("[ Save ]"));
    await tick();
    app.stdin.write("k");
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Slug +work-on-api/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    for (const char of "api") app.stdin.write(char);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setSlug).toHaveBeenCalledWith(acme.workspace.file, "Work on api", "api"));
    await eventually(() => expect(app.lastFrame()).not.toContain("[ Save ]"));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Name +Work on api/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    for (const char of " v2") app.stdin.write(char);
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(renamePipeline).toHaveBeenCalledWith(acme.workspace.file, "Work on api", "Work on api v2"));
  });

  it("shows what each step waits for, and sets it from the step's form, more than one if need be", async () => {
    const setAfter = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({
      label,
      steps: [
        { run: "pnpm install", label: "install", finishes: true },
        { run: "pnpm lint", label: "lint", after: "install", finishes: true },
        { run: "pnpm test", after: ["install"], finishes: true },
      ],
    });
    const app = render(<App services={services({ editing: { ...services().editing, bolt, setAfter } })} glyphs={unicode} size={{ columns: 150, rows: 30 }} />);
    await eventually(() => expect(app.lastFrame() ?? "").toContain("Work on api"));
    await tick();
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/2 .*run lint — pnpm lint +after install/));
    await eventually(() => expect(app.lastFrame()).toMatch(/3 .*run pnpm test +after install/));
    await tick();
    app.stdin.write("j");
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*3 .*pnpm test/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Depends on"));
    await eventually(() => expect(app.lastFrame()).toContain("■ 1 · run install"));
    await eventually(() => expect(app.lastFrame()).toContain("□ 2 · run lint"));
    await tick();
    for (let at = 0; at < 5; at += 1) app.stdin.write(ARROW_DOWN);
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await tick();
    app.stdin.write(" ");
    await eventually(() => expect(app.lastFrame()).toContain("■ 2 · run lint"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setAfter).toHaveBeenCalledWith(acme.workspace.file, "Work on api", 2, [0, 1]));
  });

  it("adds an input from its row, and removes one after asking", async () => {
    const setInput = vi.fn(async () => undefined);
    const removeInput = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({ label, inputs: { tag: { ask: "Which tag?" } }, steps: [{ run: "./deploy.sh {{tag}}", finishes: true }] });
    const app = await open(services({ editing: { ...services().editing, bolt, setInput, removeInput } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/│ Inputs .*\n│ +tag  Which tag\?/));
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*deploy\.sh/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ \+  add another input/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Add input ]"));
    await tick();
    for (const char of "env") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toContain("› env"));
    await tick();
    app.stdin.write("\r");
    await tick();
    for (const char of "Deploy where?") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toMatch(/┃ › Deploy where\?/));
    await tick();
    app.stdin.write("\r");
    await tick();
    for (const char of "staging, production") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toMatch(/┃ › staging, production/));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setInput).toHaveBeenCalledWith(acme.workspace.file, "Work on api", undefined, "env", { ask: "Deploy where?", choices: ["staging", "production"] }));

    await eventually(() => expect(app.lastFrame()).not.toContain("[ Add input ]"));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ tag  Which tag\?/));
    await tick();
    app.stdin.write("D");
    await eventually(() => expect(app.lastFrame()).toContain("Remove this input?"));
    await tick();
    app.stdin.write("y");
    await eventually(() => expect(removeInput).toHaveBeenCalledWith(acme.workspace.file, "Work on api", "tag"));
  });

  it("sets the question a pipeline asks before it runs, from the row above its steps", async () => {
    const setConfirm = vi.fn(async () => undefined);
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ run: "./deploy.sh", finishes: true }] });
    const app = await open(services({ editing: { ...services().editing, bolt, setConfirm } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*deploy\.sh/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ \+  add an input/));
    await tick();
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Ask first +no/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await eventually(() => expect(app.lastFrame()).not.toContain("Question"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("● yes"));
    await eventually(() => expect(app.lastFrame()).toContain('Run "Work on api"?'));
    await tick();
    app.stdin.write("\r");
    await tick();
    for (const char of "Deploy to production?") app.stdin.write(char);
    await eventually(() => expect(app.lastFrame()).toContain("› Deploy to production?"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setConfirm).toHaveBeenCalledWith(acme.workspace.file, "Work on api", "Deploy to production?"));
  });

  it("asks the standard question when yes has no question of its own, and turns it off with no", async () => {
    const setConfirm = vi.fn(async () => undefined);
    let confirm: string | boolean | undefined;
    const bolt = async (_file: string, label: string) => ({ label, ...(confirm === undefined ? {} : { confirm }), steps: [{ run: "./deploy.sh", finishes: true }] });
    const app = await open(services({ editing: { ...services().editing, bolt, setConfirm } }));
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*1 .*deploy\.sh/));
    await tick();
    app.stdin.write("k");
    app.stdin.write("k");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Ask first +no/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(app.lastFrame()).toContain("● yes"));
    confirm = true;
    app.stdin.write("\u0013");
    await eventually(() => expect(setConfirm).toHaveBeenLastCalledWith(acme.workspace.file, "Work on api", true));
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ Ask first +yes/));

    await tick();

    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("● yes"));
    await tick();
    app.stdin.write(ARROW_LEFT);
    await eventually(() => expect(app.lastFrame()).toContain("● no"));
    await tick();
    app.stdin.write("\u0013");
    await eventually(() => expect(setConfirm).toHaveBeenLastCalledWith(acme.workspace.file, "Work on api", false));
  });

  it("edits on one screen at a time on a narrow terminal, and esc goes back to the list", async () => {
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] });
    const app = render(<App services={services({ editing: { ...services().editing, bolt } })} glyphs={unicode} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await eventually(() => expect(app.lastFrame() ?? "").not.toContain("reading your workspaces"));
    await tick();
    app.stdin.write("e");
    await eventually(() => expect(app.lastFrame()).toContain("+  add a step"));
    await eventually(() => expect(app.lastFrame()).not.toContain("Step 1 · "));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Step 1 · "));
    await eventually(() => expect(app.lastFrame()).not.toContain("+  add a step"));
    await tick();
    app.stdin.write("\u001B");
    await eventually(() => expect(app.lastFrame()).toContain("+  add a step"));
  });

  it("says what is wrong with a field, in words", async () => {
    const app = await open(services());
    app.stdin.write("e");
    await tick();
    app.stdin.write("a");
    await tick();
    app.stdin.write("4");
    await tick();
    for (const char of "soon") app.stdin.write(char);
    app.stdin.write("\u0013"); // Add step
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Not something Wisp can wait for"));
  });

  it("creates a new pipeline from a form and opens it to add steps", async () => {
    const addPipeline = vi.fn(async () => undefined);
    const app = await open(services({ editing: { ...services().editing, addPipeline } }));
    app.stdin.write("a");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("A new pipeline in Acme"));
    for (const char of "Run the tests") app.stdin.write(char);
    app.stdin.write("\r"); // to the button
    app.stdin.write("\r"); // Create bolt
    await tick();
    await tick();
    await eventually(() => expect(addPipeline).toHaveBeenCalledWith(acme.workspace.file, "Run the tests"));
    // Straight on to its first step.
    await eventually(() => expect(app.lastFrame()).toContain("What should happen first when it runs?"));
    await eventually(() => expect(app.lastFrame()).toContain("⚡ Run the tests"));
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
    const withCompose = read("/dev/shop/.wisp.json", { name: "Shop", pipelines: [{ label: "Services", steps: [{ compose: "compose.yaml" }] }] });
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
    await eventually(() => {
      const frame = app2.lastFrame() ?? "";
      // Under the bolt whose compose step starts it, in its workspace.
      expect(frame).toMatch(/SHOP[\s\S]*Services[\s\S]*● postgres +healthy/);
      expect(frame).toContain("on localhost:5432");
      expect(frame).toContain("ready to accept connections");
    });
  });

  it("groups what runs under the pipeline that started it, and finds things with /", async () => {
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
    await eventually(() => expect(frame).toMatch(/ACME[\s\S]*Work on web[\s\S]*● up[\s\S]*api[\s\S]*web[\s\S]*Not from a pipeline[\s\S]*notes/));

    for (const key of ["/", "m", "d", "b"]) {
      app.stdin.write(key);
      await tick();
    }
    frame = app.lastFrame() ?? "";
    await eventually(() => expect(frame).toContain("/ mdb"));
    await eventually(() => expect(frame).toContain("notes"));
    await eventually(() => expect(frame).not.toContain("Work on web"));
    await tick();
    app.stdin.write("\u001B");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Work on web"));
  });

  it("says so the moment something stops by itself", async () => {
    let alive = true;
    const server = { id: "ab12", kind: "background", label: "web dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:x", pid: 1, startedAt: new Date().toISOString(), log: "/l" };
    const app = await open(services({ runs: async () => [{ ...server, alive }] as never }));
    await tick();
    alive = false;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await eventually(() => expect(app.lastFrame()).toContain("! web dev stopped (Acme) — press p to see its last output"));
  });
});

describe("search", () => {
  it("prefers pipelines whose own words match", () => {
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
    await eventually(() => expect(state).toEqual({ value: "npm start", cursor: 7 }));
    state = editAt(state.value, state.cursor, "a", key({ ctrl: true }))!;
    expect(state.cursor).toBe(0);
  });
});

describe("a run in progress", () => {
  const plan = [
    { target: { kind: "command" as const, id: "command:lint", label: "lint", value: "pnpm lint", finishes: true }, workspace: acme.workspace, keepGoing: false, bolt: "Work on api" },
    { target: { kind: "command" as const, id: "command:test", label: "test", value: "pnpm test", finishes: true }, workspace: acme.workspace, keepGoing: false, bolt: "Work on api" },
  ];

  it("keeps its title in place, with the words that change after it, a star before them", async () => {
    const app = await open(
      services({
        run: async (target, _bolt, callbacks) => {
          callbacks.onPlan([plan[0]!.target]);
          callbacks.onStep(plan[0]!.target, { attached: true });
          await new Promise<void>((resolve) => callbacks.signal?.addEventListener("abort", () => resolve()));
          return { workspace: target.workspace, targets: [], dryRun: false, ok: false } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/│ ⚡ ?Acme › Work on api +✦ [A-Z][^…]*…/));
    await tick();
    app.stdin.write("x");
    await tick();
  });

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
    await eventually(() => expect(app.lastFrame()).toContain("Stopped — you stopped it."));
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
    await eventually(() => expect(app.lastFrame()).toContain(`r retry from ${plan[1]!.target.label}`));
    await tick();
    app.stdin.write("r");
    await tick();
    await eventually(() => expect(retry).toHaveBeenCalledWith(acme, [plan[1]], "Work on api", expect.anything()));
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
    await eventually(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("RUNNING NOW");
      expect(frame).toContain("Running l");
      expect(frame).toContain("Creating an optimized production build");
    });
  });
});

describe("running and history", () => {
  it("are two screens: p for what's running, h for what ran", async () => {
    const app = await open(services());
    app.stdin.write("p");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Nothing is running"));
    await eventually(() => expect(app.lastFrame()).not.toContain("Nothing has run yet"));
    await tick();
    app.stdin.write("h");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("History"));
    await eventually(() => expect(app.lastFrame()).toContain("Nothing has run yet"));
    await tick();
    app.stdin.write("p");
    await tick();
    await eventually(() => expect(app.lastFrame()).toContain("Nothing is running"));
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
    const long = read("/dev/notes/.wisp.json", { name: "Notes", pipelines: [{ label: "Notion", steps: [{ url: `https://app.notion.com/p/${"x".repeat(300)}` }] }] });
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
    expect(describeHistoryStep(step("wait", "port 5432"))).toBe("wait until port 5432 is open");
    expect(describeHistoryStep(step("wait", "http://localhost:3000"))).toBe("wait until http://localhost:3000 answers");
    expect(describeHistoryStep(step("link", "http://localhost:3000"))).toBe("open http://localhost:3000");
    expect(describeHistoryStep(step("command", "Payments Service dev", "pnpm dev"))).toBe("start Payments Service dev");
    expect(describeHistoryStep({ ...(step("command", "test", "pnpm test") as object), finishes: true } as never)).toBe("run test");
  });
});

describe("the mouse", () => {
  /** Where a piece of text is drawn: its column and line, for a click on it. */
  const at = (frame: string, text: string, after = 0): { x: number; y: number } => {
    const lines = frame.split("\n");
    for (let y = after; y < lines.length; y += 1) {
      const x = (lines[y] ?? "").indexOf(text);
      if (x >= 0) return { x: x + 1, y };
    }
    throw new Error(`"${text}" is not on the screen`);
  };
  const withMouse = async (api: Services) => {
    const mouse = terminalMouse(() => undefined);
    const app = render(<App services={api} mouse={mouse} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame() ?? "").not.toContain("reading your workspaces"));
    return { app, mouse, frame: () => app.lastFrame() ?? "" };
  };
  const spot = async (frame: () => string, text: string, after = 0) => {
    let found = { x: 0, y: 0 };
    await eventually(() => {
      found = at(frame(), text, after);
    });
    return found;
  };
  const server = { kind: "background", workspace: acme.workspace.file, workspaceName: "Acme", pid: 1, startedAt: new Date().toISOString(), alive: true, log: "/l" };
  const web = { ...server, id: "w1", label: "web dev", command: "pnpm dev", asset: "command:web dev" };
  const worker = { ...server, id: "k1", label: "worker", command: "pnpm worker", asset: "command:worker" };

  it("switches screens from the tabs along the top", async () => {
    const { mouse, frame } = await withMouse(services());
    // The header's own first line: the frame's first line, which has the crystal ball (two columns, two code units).
    const header = frame().split("\n")[0] ?? "";
    expect(mouse.emit({ kind: "click", x: header.indexOf("2 Running") + 1, y: 0 })).toBe(true);
    await tick();
    await eventually(() => expect(frame()).toContain("Nothing is running"));
    await tick();
    mouse.emit({ kind: "click", x: header.indexOf("3 History") + 1, y: 0 });
    await tick();
    await tick();
    await eventually(() => expect(frame()).toContain("Nothing has run yet"));
    await tick();
    mouse.emit({ kind: "click", x: header.indexOf("1 Pipelines") + 1, y: 0 });
    await tick();
    await eventually(() => expect(frame()).toContain("Workspaces"));
    expect(mouse.emit({ kind: "click", x: 2, y: 0 })).toBe(false);
  });

  it("selects a row on Running with a click, and a tab beside it", async () => {
    const { app, mouse, frame } = await withMouse(services({ runs: async () => [web, worker] as never, tail: async () => "ready" }));
    app.stdin.write("p");
    await tick();
    await tick();
    await eventually(() => expect(frame()).toMatch(/❯ +● web dev/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "worker")) });
    await tick();
    await tick();
    await eventually(() => expect(frame()).toMatch(/❯ +● worker/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Info │")) });
    await tick();
    await eventually(() => expect(frame()).toMatch(/Command +pnpm worker/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Runs   [ ]")) });
    await tick();
    await eventually(() => expect(frame()).toContain("wisp logs <id> prints any of them"));
  });

  it("scrolls the logs with the wheel over them, and moves the selection over the list", async () => {
    const lines = Array.from({ length: 80 }, (_, line) => `line ${line + 1}`).join("\n");
    const { app, mouse, frame } = await withMouse(services({ runs: async () => [web, worker] as never, tail: async () => lines }));
    app.stdin.write("p");
    await tick();
    await tick();
    await eventually(() => expect(frame()).toContain("line 80"));
    const log = at(frame(), "line 80");
    expect(mouse.emit({ kind: "wheel", ...log, by: -1 })).toBe(true);
    await tick();
    await eventually(() => expect(frame()).toContain("↑ 3 lines back"));
    await eventually(() => expect(frame()).not.toContain("line 80"));
    await tick();
    mouse.emit({ kind: "wheel", ...log, by: 1 });
    await tick();
    await eventually(() => expect(frame()).toContain("line 80"));
    // Over the list, it is left to become an arrow key, which moves the selection.
    expect(mouse.emit({ kind: "wheel", ...(await spot(frame, "● web dev")), by: 1 })).toBe(false);
  });

  it("selects workspaces and pipelines on the Pipelines tab, and runs nothing", async () => {
    const run = vi.fn(services().run);
    const { mouse, frame } = await withMouse(services({ run }));
    mouse.emit({ kind: "click", ...(await spot(frame, "Work on web")) });
    await tick();
    await eventually(() => expect(frame()).toContain("❯ Work on web"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "When you run it")) });
    await tick();
    await eventually(() => expect(frame()).toContain("❯ Work on web"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "infra", 2)) });
    await tick();
    await eventually(() => expect(frame()).toContain("Database"));
    await eventually(() => expect(frame()).not.toContain("Work on web"));
    // The wheel over the workspace list moves through the workspaces.
    mouse.emit({ kind: "wheel", ...(await spot(frame, "infra !", 2)), by: 1 });
    await tick();
    await eventually(() => expect(frame()).toContain("Start the day"));
    await eventually(() => expect(run).not.toHaveBeenCalled());
  });

  it("fills in a form by clicking: a field to type in, a place in its text, the button, an option", async () => {
    const addPipeline = vi.fn(async () => undefined);
    const api = services();
    const { app, mouse, frame } = await withMouse({ ...api, editing: { ...api.editing, addPipeline } });
    const type = async (text: string) => {
      for (const key of text) {
        app.stdin.write(key);
        await tick();
      }
    };
    app.stdin.write("a");
    await eventually(() => expect(frame()).toContain("[ Create pipeline ]"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Name")) });
    await eventually(() => expect(frame()).toMatch(/┃ Name/));
    await type("Lint");
    await eventually(() => expect(frame()).toContain("› Lint"));
    // On the "L" of "› Lint": the cursor goes there, and typing goes in before it.
    const value = at(frame(), "› Lint");
    mouse.emit({ kind: "click", x: value.x + 1, y: value.y });
    await tick();
    await type("X");
    await eventually(() => expect(frame()).toContain("› XLint"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Create pipeline ]")) });
    await eventually(() => expect(addPipeline).toHaveBeenCalledWith(acme.workspace.file, "XLint"));
    // Straight to its first step: a click on one picks it, and a click on an option chooses it.
    await eventually(() => expect(frame()).toContain("What should happen first when it runs?"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Run a command")) });
    await tick();
    await eventually(() => expect(frame()).toContain("The first step · "));
    await eventually(() => expect(frame()).not.toContain("Timeout"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "finishes")) });
    await tick();
    await eventually(() => expect(frame()).toContain("● finishes"));
    await eventually(() => expect(frame()).not.toContain("Restart"));
    await eventually(() => expect(frame()).toContain("[ Add step ]"));
  });

  it("leaves the editor by its tabs, by click or 1 2 3, but not while a form is open; a new step's form goes back to the choices", async () => {
    const { app, mouse, frame } = await withMouse(services());
    const header = frame().split("\n")[0] ?? "";
    app.stdin.write("e");
    await eventually(() => expect(frame()).toContain("+  add the first step"));
    await tick();
    app.stdin.write("a");
    await eventually(() => expect(frame()).toContain("Run a command"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Cancel ]")) });
    await eventually(() => expect(frame()).not.toContain("[ Cancel ]"));
    await tick();
    app.stdin.write("a");
    await eventually(() => expect(frame()).toContain("Run a command"));
    await tick();
    app.stdin.write("1");
    await eventually(() => expect(frame()).toContain("[ Add step ]"));
    expect(mouse.emit({ kind: "click", x: header.indexOf("2 Running") + 1, y: 0 })).toBe(false);
    app.stdin.write("2");
    await tick();
    await eventually(() => expect(frame()).toContain("[ Add step ]"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Back ]")) });
    await eventually(() => expect(frame()).toContain("[ Cancel ]"));
    await eventually(() => expect(frame()).toContain("Run a command"));
    await tick();
    app.stdin.write("1");
    await eventually(() => expect(frame()).toContain("[ Add step ]"));
    await tick();
    app.stdin.write("\u001B");
    await eventually(() => expect(frame()).toContain("[ Cancel ]"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Cancel ]")) });
    await eventually(() => expect(frame()).not.toContain("[ Cancel ]"));
    await eventually(() => expect(mouse.emit({ kind: "click", x: header.indexOf("3 History") + 1, y: 0 })).toBe(true));
    await eventually(() => expect(frame()).toContain("Nothing has run yet"));

    await eventually(() => {
      if (!frame().includes("Workspaces")) app.stdin.write("1");
      expect(frame()).toContain("Workspaces");
    });
    await tick();
    app.stdin.write("e");
    await eventually(() => expect(frame()).toContain("+  add the first step"));
    await tick();
    app.stdin.write("2");
    await eventually(() => expect(frame()).toContain("Nothing is running"));
  });

  it("leaves a form from its Cancel button, by click or by keys, saving nothing", async () => {
    const addPipeline = vi.fn(async () => undefined);
    const api = services();
    const { app, mouse, frame } = await withMouse({ ...api, editing: { ...api.editing, addPipeline } });
    app.stdin.write("a");
    await eventually(() => expect(frame()).toContain("[ Create pipeline ]"));
    await eventually(() => expect(frame()).toContain("[ Cancel ]"));
    await tick();
    for (const key of "Lint") app.stdin.write(key);
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Cancel ]")) });
    await eventually(() => expect(frame()).not.toContain("[ Create pipeline ]"));

    await eventually(() => {
      if (!frame().includes("[ Create pipeline ]")) app.stdin.write("a");
      expect(frame()).toContain("[ Create pipeline ]");
    });
    await tick();
    app.stdin.write("\t");
    await tick();
    app.stdin.write(ARROW_RIGHT);
    await eventually(() => expect(frame()).toContain("▸ Cancel"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(frame()).not.toContain("Create pipeline"));
    await eventually(() => expect(addPipeline).not.toHaveBeenCalled());
  });

  it("ticks pipelines to set up with a click, and sets them up from the button", async () => {
    const suggestion = {
      dir: "/dev/shop",
      name: "Shop",
      found: ["package.json pnpm dev"],
      bolts: [
        { label: "Services", steps: ["start Docker services: postgres"] },
        { label: "Check", steps: ["run test"] },
      ],
      contents: "{}",
    };
    const setUp = vi.fn(async () => infra.workspace.file);
    const { mouse, frame } = await withMouse(services({ suggestSetup: async () => suggestion, setUp }, { reads: [infra], unreadable: [] }));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Services")) });
    await tick();
    await eventually(() => expect(frame()).toContain("[ ] ⚡ Services"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Set up 1 pipeline")) });
    await tick();
    await tick();
    await eventually(() => expect(setUp).toHaveBeenCalledWith(suggestion, ["Check"]));
  });

  it("opens the notification settings from a click on the webhook warning, from anywhere", async () => {
    const api = services();
    const { app, mouse, frame } = await withMouse({ ...api, settings: { ...api.settings, failingWebhooks: async () => 1 } });
    await eventually(() => expect(frame()).toContain("a webhook is failing: s"));
    const header = frame().split("\n")[0] ?? "";
    const start = header.indexOf("● a webhook");
    const end = header.indexOf("failing: s") + "failing: s".length;
    expect(mouse.emit({ kind: "click", x: end + 1, y: 0 })).toBe(false);
    expect(mouse.emit({ kind: "click", x: start - 1, y: 0 })).toBe(false);
    expect(mouse.emit({ kind: "click", x: end - 1, y: 0 })).toBe(true);
    await eventually(() => expect(frame()).toMatch(/❯ Notifications/));
    await eventually(() => {
      if (!frame().includes("Workspaces")) app.stdin.write("\u001B");
      expect(frame()).toContain("Workspaces");
    });
    app.stdin.write("2");
    await eventually(() => expect(frame()).toContain("Nothing is running"));
    expect(mouse.emit({ kind: "click", x: start, y: 0 })).toBe(true);
    await eventually(() => expect(frame()).toMatch(/❯ Notifications/));
  });

  it("leaves settings by its tabs, by click or 1 2 3, but not while a category is open", async () => {
    const { app, mouse, frame } = await withMouse(services());
    const header = frame().split("\n")[0] ?? "";
    app.stdin.write("s");
    await eventually(() => expect(frame()).toContain("mouse on"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(frame()).toContain("[ Save ]"));
    await tick();
    expect(mouse.emit({ kind: "click", x: header.indexOf("2 Running") + 1, y: 0 })).toBe(false);
    app.stdin.write("2");
    await tick();
    await eventually(() => expect(frame()).toContain("[ Save ]"));
    await tick();
    app.stdin.write("\u001B");
    await eventually(() => expect(frame()).not.toContain("[ Save ]"));
    await eventually(() => expect(mouse.emit({ kind: "click", x: header.indexOf("3 History") + 1, y: 0 })).toBe(true));
    await eventually(() => expect(frame()).toContain("Nothing has run yet"));
    await eventually(() => {
      if (!frame().includes("Workspaces")) app.stdin.write("1");
      expect(frame()).toContain("Workspaces");
    });
    await eventually(() => {
      if (!frame().includes("mouse on")) app.stdin.write("s");
      expect(frame()).toContain("mouse on");
    });
    await tick();
    app.stdin.write("2");
    await eventually(() => expect(frame()).toContain("Nothing is running"));
  });

  it("chooses a settings category with a click, opens it with a second, and saves by click", async () => {
    const setMouse = vi.fn(async (on: boolean) => on);
    const api = services();
    const { app, mouse, frame } = await withMouse({ ...api, settings: { ...api.settings, setMouse } });
    app.stdin.write("s");
    await eventually(() => expect(frame()).toContain("mouse on"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Dashboard")) });
    await eventually(() => expect(frame()).toMatch(/❯ Dashboard/));
    await eventually(() => expect(frame()).not.toContain("[ Save ]"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Dashboard")) });
    await eventually(() => expect(frame()).toContain("[ Save ]"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "○ off")) });
    await eventually(() => expect(frame()).toContain("● off"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "[ Save ]")) });
    await eventually(() => expect(setMouse).toHaveBeenCalledWith(false));
    await eventually(() => expect(frame()).toContain("mouse off"));
    await eventually(() => expect(app.lastFrame()).not.toContain("[ Save ]"));
  });

  it("chooses a step in the pipeline editor with a click, and opens it with a second", async () => {
    const api = services();
    const bolt = async (_file: string, label: string) => ({ label, steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] });
    const { app, mouse, frame } = await withMouse({ ...api, editing: { ...api.editing, bolt } as never });
    app.stdin.write("e");
    await tick();
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "💻 run pnpm dev")) });
    await tick();
    await eventually(() => expect(frame()).toMatch(/❯ .*pnpm dev/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "💻 run pnpm dev")) });
    await tick();
    await eventually(() => expect(frame()).toContain("[ Save step ]"));
    await eventually(() => expect(frame()).toContain("Step 2 · "));
  });

  it("chooses and opens runs in History, shows a step's log with a click, and filters by pipeline", async () => {
    const at10 = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const check = {
      id: "c7", number: 7, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Check", startedAt: at10(10), finishedAt: at10(9), ok: false,
      steps: [
        { kind: "command" as const, label: "postgres", value: "docker compose up", ok: true, durationMs: 1200, bolt: "Database" },
        { kind: "command" as const, label: "lint", value: "pnpm lint", ok: true, durationMs: 900, log: "/logs/1", finishes: true },
        { kind: "command" as const, label: "test", value: "pnpm test", ok: false, error: "exited with code 1", durationMs: 2100, log: "/logs/2", finishes: true },
      ],
    };
    const web = { id: "w3", number: 3, workspace: acme.workspace.file, workspaceName: "Acme", bolt: "Work on web", startedAt: at10(20), finishedAt: at10(20), ok: true, steps: [{ kind: "folder" as const, label: "web", value: "apps/web", ok: true, durationMs: 5 }] };
    const lint = Array.from({ length: 60 }, (_, line) => `lint line ${line + 1}`).join("\n");
    const readLog = vi.fn(async (path: string) => (path === "/logs/2" ? "FAIL divides by zero" : lint));
    const mouse = terminalMouse(() => undefined);
    const app = render(<App services={services({ history: async () => [check, web] as never, readLog })} mouse={mouse} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    const frame = () => app.lastFrame() ?? "";
    await tick();
    app.stdin.write("h");
    await tick();
    await tick();

    // One click chooses a run; a second on the chosen one opens it.
    mouse.emit({ kind: "click", ...(await spot(frame, "Work on web #3")) });
    await tick();
    await eventually(() => expect(frame()).toMatch(/❯ ✓ Work on web #3/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Work on web #3")) });
    await tick();
    await eventually(() => expect(frame()).toContain("Total duration"));
    await tick();
    app.stdin.write("\u001B");
    await tick();

    mouse.emit({ kind: "click", ...(await spot(frame, "Check #7")) });
    await eventually(() => expect(frame()).toMatch(/❯ ✗ Check #7/));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Check #7")) });
    await tick();
    await tick();
    await eventually(() => expect(frame()).toContain("FAIL divides by zero"));
    // Below the summary and the pipeline: a click on a step hides its log, or shows it.
    mouse.emit({ kind: "click", ...(await spot(frame, "run test")) });
    await tick();
    await eventually(() => expect(frame()).not.toContain("FAIL divides by zero"));
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "run lint")) });
    await tick();
    await tick();
    await eventually(() => expect(frame()).toContain("lint line 1"));
    await eventually(() => expect(readLog).toHaveBeenCalledWith("/logs/1"));
    const log = at(frame(), "lint line 2");
    mouse.emit({ kind: "wheel", ...log, by: 1 });
    mouse.emit({ kind: "wheel", ...log, by: 1 });
    await tick();
    await eventually(() => expect(frame()).not.toContain("run postgres"));
    await eventually(() => expect(frame()).toContain("lint line 9"));

    // Back to the runs: the bolts on the left filter them.
    app.stdin.write("\u001B");
    await tick();
    mouse.emit({ kind: "click", ...(await spot(frame, "Work on web   ")) });
    await tick();
    await eventually(() => expect(frame()).toMatch(/Work on web +1 run/));
    await eventually(() => expect(frame()).not.toContain("Check #7"));
  });
});

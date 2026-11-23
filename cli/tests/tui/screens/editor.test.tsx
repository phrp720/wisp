import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../../src/tui/App.js";
import { unicode, read, acme, infra, services, tick, eventually, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT, open } from "../../support/tui-app.js";

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
    await tick();
    app.stdin.write("j");
    await eventually(() => expect(app.lastFrame()).toMatch(/❯ .*3 .*pnpm build/));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("[ Save step ]"));
    await eventually(() => expect(app.lastFrame()).toContain("↓ 1 more"));
    await tick();
    for (let down = 0; down < 5; down += 1) {
      app.stdin.write("\u001B[B");
      await tick();
    }
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
    await eventually(() => expect(app.lastFrame()).toContain("⚡ Work on api"));
    await tick();
    app.stdin.write("a");
    await eventually(() => expect(app.lastFrame()).toContain("Wait until something is ready"));
    await tick();
    app.stdin.write("4");
    await eventually(() => expect(app.lastFrame()).toContain("[ Add step ]"));
    for (const char of "soon") {
      await tick();
      app.stdin.write(char);
    }
    await eventually(() => expect(app.lastFrame()).toContain("soon"));
    await tick();
    app.stdin.write("\u0013");
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
    await eventually(() => expect(app.lastFrame()).toMatch(/ACME[\s\S]*Work on web[\s\S]*● up[\s\S]*api[\s\S]*web[\s\S]*Not from a pipeline[\s\S]*notes/));

    for (const key of ["/", "m", "d", "b"]) {
      app.stdin.write(key);
      await tick();
    }
    await eventually(() => expect(app.lastFrame()).toContain("/ mdb"));
    await eventually(() => expect(app.lastFrame()).toContain("notes"));
    await eventually(() => expect(app.lastFrame()).not.toContain("Work on web"));
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

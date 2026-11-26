import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { HistoryEntry } from "../../../src/core/history.js";
import type { SwitchResult, WorkspaceRead } from "../../../src/core/types.js";
import { App } from "../../../src/tui/App.js";
import { unicode, read, acme, services, tick, eventually, open } from "../../support/tui-app.js";

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
        run: async (target, _pipeline, callbacks) => {
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

  it("draws the run as a graph while it goes: what is done, what runs, what waits", async () => {
    let finish: () => void = () => undefined;
    const app = await open(
      services({
        run: async (target, _pipeline, callbacks) => {
          const step = (label: string) => ({ kind: "command" as const, id: `command:${label}`, label, value: label });
          const [up, session, ready, open] = [step("up"), step("session"), step("ready"), step("open")];
          callbacks.onPlan([up, session, ready, open], [[], [0], [0], [2]]);
          callbacks.onStep(up, { attached: false });
          callbacks.onResult({ ...up, ok: true, durationMs: 1200 });
          callbacks.onStep(session, { attached: false });
          callbacks.onStep(ready, { attached: false });
          callbacks.onResult({ ...ready, ok: false, error: "no answer" });
          await new Promise<void>((resolve) => (finish = resolve));
          return { workspace: target.workspace, targets: [], dryRun: false, ok: false } as SwitchResult;
        },
      }),
    );
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/✓ up 1\.2s[^\n]*─┬─▶[^\n]*● session/));
    expect(app.lastFrame()).toMatch(/╰─▶[^\n]*✗ ready[^\n]*▶[^\n]*· open/);
    finish();
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
    await eventually(() => expect(down).toHaveBeenCalledWith(shop, shop.workspace.pipelines[0], { deps: true }));
  });

  it("takes the selected pipeline down with x", async () => {
    const down = vi.fn(async () => ({ stopped: [{ id: "ab12", label: "pnpm dev" }] as never[] }));
    const app = await open(services({ down }));
    app.stdin.write("x");
    await tick();
    await eventually(() => expect(down).toHaveBeenCalledWith(acme, acme.workspace.pipelines[0], { deps: false }));
    await eventually(() => expect(app.lastFrame()).toContain("Work on api: stopped 1"));
  });

  it("marks a pipeline that is up", async () => {
    const runs = [{ id: "ab12", kind: "window", label: "pnpm dev", command: "pnpm dev", workspace: acme.workspace.file, workspaceName: "Acme", asset: "command:pnpm dev", pid: 1, startedAt: new Date().toISOString(), alive: true }];
    const app = await open(services({ runs: async () => runs as never }));
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Work on api\s+● running/));
  });

  it("lines up what follows each run's number, whatever its width", async () => {
    const run = (number: number, ok: boolean) => ({ id: `r${number}`, number, workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Check", git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok, steps: ok ? [] : [{ kind: "command" as const, label: "test", value: "pnpm test", ok: false, durationMs: 1 }] });
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
    const entry = { id: "aa", number: 3, workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Check", trigger: "tui", git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [] };
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
      pipeline: "Check",
      trigger: "hook",
      inputs: { env: "staging" },
      git: { branch: "main", commit: "a1b2c3d", subject: "fix cart total" },
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      finishedAt: new Date(Date.now() - 597_000).toISOString(),
      ok: false,
      steps: [
        { kind: "command" as const, label: "postgres", value: "docker compose up", ok: true, durationMs: 1200, pipeline: "Database" },
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
    await eventually(() => expect(app.lastFrame()).toContain("All pipelines"));
    await eventually(() => expect(app.lastFrame()).toContain("Check #7"));
    await eventually(() => expect(app.lastFrame()).toMatch(/✗ Check #7 +at test +a1b2c3d fix cart total +· git hook/));
    await eventually(() => expect(app.lastFrame()).toMatch(/⎇ main +3\.0s/));

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
    await eventually(() => expect(app.lastFrame()).toContain("Check #7"));
    await eventually(() => expect(app.lastFrame()).toContain("Triggered"));
    await eventually(() => expect(app.lastFrame()).toContain("from a git hook"));
    await eventually(() => expect(app.lastFrame()).toContain("env=staging"));
    await eventually(() => expect(app.lastFrame()).toContain("Failed"));
    await eventually(() => expect(app.lastFrame()).toContain("Database"));
    await eventually(() => expect(app.lastFrame()).toContain("1 step"));
    await eventually(() => expect(readLog).toHaveBeenCalledWith("/logs/2"));
    await eventually(() => expect(app.lastFrame()).toMatch(/2 FAIL divides by zero/));

    // The tab keys work here too: 3 is the list of runs again, 1 the pipelines.
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
    const entry: HistoryEntry = { id: "5a6b7c8d9e0f", number: 2, workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Check", startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(), ok: true, steps: [step("install", 1), step("lint", 2), step("test", 2), step("build", 3)] };
    const app = render(<App services={services({ history: async () => [entry] })} glyphs={unicode} size={{ columns: 130, rows: 34 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toContain("Check #2"));
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toMatch(/│ ✓ install 500ms │ ─┬─▶ │ ✓ lint 500ms │ ─┬─▶ │ ✓ build 500ms │/));
    await eventually(() => expect(app.lastFrame()).toContain("v hide graph"));
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).not.toContain("│ ✓ install 500ms │"));
    await eventually(() => expect(app.lastFrame()).toContain("v show graph"));
    await tick();
    app.stdin.write("v");
    await eventually(() => expect(app.lastFrame()).toContain("│ ✓ install 500ms │"));
  });

  it("shows a cancelled run in grey, as cancelled, never as failed", async () => {
    const entry: HistoryEntry = {
      id: "6c7d8e9f0a1b",
      number: 4,
      workspace: acme.workspace.file,
      workspaceName: "Acme",
      pipeline: "Deploy",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      cancelled: true,
      steps: [
        { kind: "command", label: "build", value: "pnpm build", ok: true, durationMs: 800, finishes: true },
        { kind: "command", label: "ship", value: "./ship.sh", ok: false, cancelled: true, error: "you stopped the run", durationMs: 300, finishes: true },
        { kind: "link", label: "site", value: "https://acme.test", ok: false, skipped: true, note: "not reached — the run was cancelled", durationMs: 0 },
      ],
    };
    const app = render(<App services={services({ history: async () => [entry] })} glyphs={unicode} size={{ columns: 130, rows: 30 }} />);
    await tick();
    app.stdin.write("h");
    await eventually(() => expect(app.lastFrame()).toMatch(/⊘ Deploy #4 +cancelled/));
    expect(app.lastFrame()).not.toContain("at ship");
    await tick();
    app.stdin.write("\r");
    await eventually(() => expect(app.lastFrame()).toContain("Cancelled"));
    expect(app.lastFrame()).not.toContain("Failed");
    expect(app.lastFrame()).toMatch(/⊘ run ship/);
  });

  it("says on a run's page where its notification went, and that it didn't arrive", async () => {
    const entry: HistoryEntry = { id: "4e5f6a7b8c9d", number: 3, workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Backup", startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(), ok: false, steps: [{ kind: "command", label: "dump", value: "pg_dump", ok: false, error: "exited with code 1", durationMs: 500 }], notified: [{ url: "https://hooks.slack.com/services/…x7Qa", ok: true }, { url: "https://discord.com/api/…Zk3p", ok: false, problem: "404 Not Found" }] };
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
    const app = await open({ ...api, settings: { ...api.settings, notify: async () => ({ when: "failures", screen: true, webhooks: [{ url: "https://ntfy.sh/old-and-secret" }] }), failingWebhooks: async () => 1 } });
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
    const entry = { id: "aa", workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Work on api", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, steps: [], inputs: { env: "staging" } };
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
    // → goes to the next command, past the pipeline rows, back at its newest line.
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
    await eventually(() => expect(app.lastFrame()).toContain("Logs │ Info │ Runs"));
    await eventually(() => expect(app.lastFrame()).toContain("ready on :3000"));

    await tick();

    app.stdin.write("]");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Command +pnpm dev/));
    await eventually(() => expect(app.lastFrame()).toMatch(/State +running, PID 1/));
    await eventually(() => expect(app.lastFrame()).toContain("wisp logs ab12 -f"));
    await eventually(() => expect(app.lastFrame()).not.toContain("ready on :3000"));

    await tick();

    app.stdin.write("]");
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/ab12/));
    await eventually(() => expect(app.lastFrame()).toMatch(/failed \(exit 1\) +ef56/));
    await eventually(() => expect(app.lastFrame()).not.toContain("gh78"));

    // Back to Info, then to the next command: still on Info, now about that one.
    app.stdin.write("[");
    await tick();
    app.stdin.write("j");
    await tick();
    await tick();
    await eventually(() => expect(app.lastFrame()).toMatch(/Command +pnpm worker/));

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
    await eventually(() => expect(app.lastFrame()).toContain("/ err"));
    await eventually(() => expect(app.lastFrame()).toContain("2 of 5 lines"));
    await eventually(() => expect(app.lastFrame()).toMatch(/3 ERROR cart total is NaN/));
    await eventually(() => expect(app.lastFrame()).toMatch(/5 error: retrying the cart/));
    await eventually(() => expect(app.lastFrame()).not.toContain("GET /cart 200"));
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
    await eventually(() => expect(app.lastFrame()).toContain("GET /cart 200"));
    await eventually(() => expect(app.lastFrame()).not.toContain("/ err"));
  });

  it("filters every step's log of a past run, and says where the matches are", async () => {
    const entry = {
      id: "c7", number: 7, workspace: acme.workspace.file, workspaceName: "Acme", pipeline: "Check", ok: false,
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

describe("a run in progress", () => {
  const plan = [
    { target: { kind: "command" as const, id: "command:lint", label: "lint", value: "pnpm lint", finishes: true }, workspace: acme.workspace, keepGoing: false, pipeline: "Work on api" },
    { target: { kind: "command" as const, id: "command:test", label: "test", value: "pnpm test", finishes: true }, workspace: acme.workspace, keepGoing: false, pipeline: "Work on api" },
  ];

  it("keeps its title in place, with the words that change after it, a star before them", async () => {
    const app = await open(
      services({
        run: async (target, _pipeline, callbacks) => {
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
        run: async (target, _pipeline, callbacks) => {
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
    await eventually(() => expect(signal).toBeDefined());
    await tick();
    app.stdin.write("x");
    await eventually(() => expect(signal?.aborted).toBe(true));
    await eventually(() => expect(app.lastFrame()).toContain("Stopped — you stopped it."));
  });

  it("retries only the failed steps with r", async () => {
    const retry = vi.fn(async (read: WorkspaceRead) => ({ workspace: read.workspace, targets: [], dryRun: false, ok: true }) as SwitchResult);
    const app = await open(
      services({
        retry: retry as never,
        run: async (target, _pipeline, callbacks) => {
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
        run: async (target, _pipeline, callbacks) => {
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

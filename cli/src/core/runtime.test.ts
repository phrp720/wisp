import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetProject, knownProjects, recordProject, setOpenWithDefaults, getOpenWithDefaults } from "./config.js";
import { detectEnvironment } from "./environment.js";
import { listRuns, matchRun, startRun, stopRun, type RunStatus } from "./processes.js";
import { loginShell, posixQuote, shellInvocation, windowsQuote } from "./shell.js";
import { sameUrl } from "./url.js";
import { matchWorkspace } from "./workspaces.js";
import type { Workspace } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-runtime-")));
  process.env["WISP_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("detectEnvironment", () => {
  it("counts SSH as no display, even on a Mac", () => {
    expect(detectEnvironment({ SSH_CONNECTION: "1 2 3 4" }, "darwin").gui).toBe(false);
    expect(detectEnvironment({}, "darwin").gui).toBe(true);
  });

  it("needs X or Wayland on Linux", () => {
    expect(detectEnvironment({}, "linux").gui).toBe(false);
    expect(detectEnvironment({ WAYLAND_DISPLAY: "wayland-0" }, "linux").gui).toBe(true);
  });

  it("notices tmux and zellij, and can be told outright", () => {
    expect(detectEnvironment({ TMUX: "/tmp/tmux-1/default,1,0" }, "linux").multiplexer).toBe("tmux");
    expect(detectEnvironment({ ZELLIJ: "0" }, "linux").multiplexer).toBe("zellij");
    expect(detectEnvironment({ WISP_HEADLESS: "1" }, "darwin").gui).toBe(false);
  });
});

describe("shellInvocation", () => {
  it("runs sh commands in your own login shell, with env and cwd folded in", () => {
    const invocation = shellInvocation({ command: "pnpm dev", cwd: "/a b", env: { PORT: "3000", NAME: "it's" } }, "linux", {
      SHELL: "/bin/zsh",
    });
    expect(invocation).toEqual({
      file: "/bin/zsh",
      args: ["-ilc", "export PORT=3000 && export NAME='it'\\''s' && cd '/a b' && pnpm dev"],
    });
  });

  it("refuses cmd away from Windows", () => {
    expect(() => shellInvocation({ command: "dir", shell: "cmd" }, "darwin")).toThrow(/only exists on Windows/);
  });

  it("falls back to /bin/sh with no $SHELL", () => {
    expect(loginShell({})).toEqual({ file: "/bin/sh", args: ["-lc"] });
    expect(loginShell({ SHELL: "/bin/bash" })).toEqual({ file: "/bin/bash", args: ["-lc"] });
    expect(loginShell({ SHELL: "/opt/homebrew/bin/fish" })).toEqual({ file: "/opt/homebrew/bin/fish", args: ["-ilc"] });
  });

  it("quotes for POSIX and Windows command lines", () => {
    expect(posixQuote("plain/path")).toBe("plain/path");
    expect(posixQuote("it's")).toBe("'it'\\''s'");
    expect(windowsQuote("C:\\a b\\")).toBe('"C:\\a b\\\\"');
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("config", () => {
  it("remembers projects most recent first, and forgets them", async () => {
    await recordProject("/a/.wisp.json", new Date("2026-01-01"));
    await recordProject("/b/.wisp.json", new Date("2026-01-02"));
    await recordProject("/a/.wisp.json", new Date("2026-01-03"));
    expect((await knownProjects()).map((project) => project.path)).toEqual(["/a/.wisp.json", "/b/.wisp.json"]);

    expect(await forgetProject("/a/.wisp.json")).toBe(true);
    expect((await knownProjects()).map((project) => project.path)).toEqual(["/b/.wisp.json"]);
  });

  it("does not lose writes when several runs record at once", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => recordProject(`/p${index}/.wisp.json`)));
    expect(await knownProjects()).toHaveLength(12);
  });

  it("sets and clears open-with choices", async () => {
    await setOpenWithDefaults({ folder: "code", terminal: "tmux" });
    await setOpenWithDefaults({ terminal: "" });
    expect(await getOpenWithDefaults()).toEqual({ folder: "code" });
  });
});

describe("background runs", () => {
  it("are tracked with their output, and can be stopped", async () => {
    const started = await startRun({
      label: "server",
      command: "echo ready; sleep 30",
      workspace: "/w/.wisp.json",
      workspaceName: "w",
      asset: "command:server",
      invocation: { file: "/bin/sh", args: ["-c", "echo ready; sleep 30"] },
      graceMs: 300,
    });
    expect(started.ok).toBe(true);

    const [run] = await listRuns();
    expect(run).toMatchObject({ id: started.run.id, alive: true, label: "server" });
    expect(await readFile(run!.log, "utf8")).toContain("ready");

    expect(stopRun(run!)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await listRuns())[0]!.alive).toBe(false);
  });

  it("report a command that fails straight away, with what it said", async () => {
    const started = await startRun({
      label: "broken",
      command: "nope",
      workspace: "/w/.wisp.json",
      workspaceName: "w",
      asset: "command:broken",
      invocation: { file: "/bin/sh", args: ["-c", "echo missing thing >&2; exit 2"] },
    });
    expect(started).toMatchObject({ ok: false, error: "missing thing" });
  });

  it("are named by id or label, running ones first", () => {
    const runs = [
      { id: "aaaa", label: "dev", alive: false },
      { id: "bbbb", label: "dev", alive: true },
      { id: "cccc", label: "db", alive: true },
    ] as RunStatus[];
    expect(matchRun("dev", runs).match?.id).toBe("bbbb");
    expect(matchRun("cccc", runs).match?.label).toBe("db");
    expect(matchRun("d", runs).candidates).toHaveLength(2);
  });

  it("have long ids, like Docker's, named by any unique start of one", () => {
    const runs = [
      { id: "3f2a1b9c0d4e", label: "web", alive: true },
      { id: "3f9e77aa0123", label: "api", alive: true },
    ] as RunStatus[];
    expect(matchRun("3f2a", runs).match?.label).toBe("web");
    expect(matchRun("3f9", runs).match?.label).toBe("api");
    // Too short to tell apart: not a guess.
    expect(matchRun("3f", runs).match).toBeUndefined();
  });
});

describe("matchWorkspace", () => {
  const named = (name: string) => ({ id: `/${name}`, name }) as Workspace;
  const all = [named("Acme"), named("Acme Infra"), named("Personal")];

  it("prefers an exact name, then a word only one name has", () => {
    expect(matchWorkspace("acme", all).match?.name).toBe("Acme");
    expect(matchWorkspace("infra", all).match?.name).toBe("Acme Infra");
    expect(matchWorkspace("e", all).match).toBeUndefined();
  });
});

describe("sameUrl", () => {
  it("ignores trailing slashes and fragments, but not queries", () => {
    expect(sameUrl("acme.com", "https://acme.com/")).toBe(true);
    expect(sameUrl("https://acme.com/a#x", "https://acme.com/a#y")).toBe(true);
    expect(sameUrl("https://acme.com/?q=1", "https://acme.com/?q=2")).toBe(false);
  });
});

describe("terminal output", () => {
  it("keeps colours, plays out carriage returns, and drops what is not text", async () => {
    const { cleanOutput } = await import("./ansi.js");
    const raw = "^D\b\b\u001B]0;title\u0007\u001B[32mready\u001B[0m\r\nbuilding 10%\rbuilding 60%\rbuilding 100%\n\u001B[2K\u001B[1Adone\u0001";
    expect(cleanOutput(raw)).toBe("\u001B[32mready\u001B[0m\nbuilding 100%\ndone");
  });

  it("are captured under a terminal, so commands keep their colours and exit codes", async () => {
    const started = await startRun({
      label: "colours",
      command: "test",
      workspace: "/w",
      workspaceName: "w",
      asset: "command:colours",
      invocation: { file: "/bin/sh", args: ["-c", 'if [ -t 1 ]; then echo "tty: yes"; else echo "tty: no"; fi; exit 4'] },
      graceMs: 3000,
    });
    expect(started.ok).toBe(false);
    expect(started.error).toBe("tty: yes");
  });

  it("restart a background run the way it was started", async () => {
    const { restartRun } = await import("./processes.js");
    const first = await startRun({
      label: "server",
      command: "sleep 30",
      workspace: "/w",
      workspaceName: "w",
      asset: "command:server",
      invocation: { file: "/bin/sh", args: ["-c", "sleep 30"] },
      graceMs: 200,
    });
    const [running] = await listRuns();
    const second = await restartRun(running!);
    expect(second.ok).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    const alive = (await listRuns()).filter((run) => run.alive);
    expect(alive.map((run) => run.id)).toEqual([second.run.id]);
    stopRun(alive[0]!);
  });
});

describe("what a pane shows", () => {
  it("expands tabs, so a tabbed log line is as wide as it looks", async () => {
    const { cleanOutput, expandTabs } = await import("./ansi.js");
    expect(expandTabs("17:11:06\tINFO\tready")).toBe("17:11:06        INFO    ready");
    // Colour codes take no columns.
    expect(expandTabs("\u001B[32mab\u001B[0m\tc")).toBe("\u001B[32mab\u001B[0m      c");
    expect(cleanOutput("2026-11-17 17:11:06\tINFO\tServer listening on port: 5050\r\n")).not.toContain("\t");
  });

  it("counts a zombie — exited, not yet collected — as stopped", async () => {
    const { parsePsStates } = await import("./processes.js");
    expect(parsePsStates("18189 Z\n25443 Ss\n")).toEqual([
      [18189, "Z"],
      [25443, "Ss"],
    ]);
  });
});

describe("stopping a tree", () => {
  it("reads the process table into parents and groups", async () => {
    const { parseProcessTable } = await import("./processes.js");
    expect(parseProcessTable("  101     1   101\n  102   101   102\n  103   102   102\n")).toEqual([
      { pid: 101, ppid: 1, pgid: 101 },
      { pid: 102, ppid: 101, pgid: 102 },
      { pid: 103, ppid: 102, pgid: 102 },
    ]);
  });

  it("stops a command in a session of its own straight away, children and all", async () => {
    const started = await startRun({
      label: "server",
      command: "sleep 30",
      workspace: "/w",
      workspaceName: "w",
      asset: "command:tree",
      // A shell that starts a child in yet another session, as a dev server's worker might.
      invocation: { file: "/bin/sh", args: ["-c", "sleep 30 & sleep 30"] },
      graceMs: 300,
    });
    const { descendants, isAlive: alive } = await import("./processes.js");
    const tree = descendants(started.run.pid);
    expect(tree.length).toBeGreaterThan(0);
    const [run] = await listRuns();
    stopRun(run!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(started.run.pid)).toBe(false);
    for (const entry of tree) expect(alive(entry.pid)).toBe(false);
  });
});

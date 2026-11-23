import { render } from "ink-testing-library";
import { expect, vi } from "vitest";

import { interpret } from "../../src/core/project/index.js";
import type { SwitchResult, TrustState, WorkspaceRead } from "../../src/core/types.js";
import { App } from "../../src/tui/App.js";
import { glyphs } from "../../src/tui/terminal/glyphs.js";
import { type Library, type Services } from "../../src/tui/model.js";

export const unicode = glyphs({ LANG: "en_US.UTF-8" }, "darwin");

export function read(file: string, main: Record<string, unknown>, trust: TrustState = "trusted", personal = false): WorkspaceRead {
  return interpret({ main }, { file, personal, trust, os: "darwin" });
}

export const acme = read("/dev/acme/.wisp.json", {
  name: "Acme",
  pipelines: [
    { label: "Work on api", steps: [{ folder: "apps/api" }, { run: "pnpm dev" }] },
    { label: "Work on web", steps: [{ folder: "apps/web" }] },
  ],
});
export const infra = read("/dev/infra/.wisp.json", { name: "infra", pipelines: [{ label: "Database", steps: [{ run: "postgres" }] }] }, "untrusted");
export const morning = read("/home/.config/wisp/workspaces/Morning.json", { name: "Morning", pipelines: [{ label: "Start the day", steps: [{ url: "mail.google.com" }] }] }, "trusted", true);

export function services(overrides: Partial<Services> = {}, library: Library = { reads: [morning, infra, acme], here: acme.workspace.file, unreadable: [] }): Services {
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
    retry: async (target, steps, _label, callbacks) => {
      const targets = steps.map((step) => step.target);
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

export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}
export const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });
export const ARROW_DOWN = "\u001B[B";
export const ARROW_LEFT = "\u001B[D";
export const ARROW_RIGHT = "\u001B[C";

export async function open(api: Services) {
  const app = render(<App services={api} glyphs={unicode} size={{ columns: 100, rows: 24 }} />);
  await tick();
  await eventually(() => expect(app.lastFrame() ?? "").not.toContain("reading your workspaces"));
  return app;
}

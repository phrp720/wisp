import { describe, expect, it } from "vitest";

import type { Container } from "../core/docker.js";
import type { HistoryEntry } from "../core/history.js";
import type { RunStatus } from "../core/processes.js";
import { interpret } from "../core/project.js";
import { groupPanes } from "./running.js";
import type { PaneItem } from "./state.js";

const file = "/dev/shop/.wisp.json";
const shop = interpret(
  {
    main: {
      name: "Shop",
      bolts: [
        { label: "Services", targets: [{ compose: "compose.yaml", services: ["postgres"] }] },
        { label: "Work on shop", targets: [{ bolt: "Services" }, { run: "pnpm dev", label: "web" }] },
      ],
    },
  },
  { file, personal: false, trust: "trusted", os: "darwin" },
);

const postgres: Container = {
  file: "/dev/shop/compose.yaml",
  project: "shop",
  service: "postgres",
  name: "shop-postgres-1",
  image: "postgres:17",
  state: "running",
  health: "healthy",
  status: "Up 2 minutes (healthy)",
  ports: ["5432"],
  exitCode: 0,
};
const web = { id: "aaaaaaaaaaaa", kind: "background", label: "web", command: "pnpm dev", workspace: file, workspaceName: "Shop", asset: "command:web", bolt: "Work on shop", pid: 1, startedAt: "2026-11-18T10:00:00Z", log: "/tmp/x.log", alive: true } as RunStatus;

const entry = (bolt: string, steps: HistoryEntry["steps"], startedAt: string): HistoryEntry => ({
  id: bolt + startedAt,
  workspace: file,
  workspaceName: "Shop",
  bolt,
  job: false,
  startedAt,
  finishedAt: startedAt,
  ok: true,
  steps,
});
const workRun = entry(
  "Work on shop",
  [
    { kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000, bolt: "Services" },
    { kind: "command", label: "web", value: "pnpm dev", ok: true, durationMs: 1500 },
  ],
  "2026-11-18T10:00:00Z",
);

const titles = (items: PaneItem[]) =>
  items.map((item) =>
    item.type === "group"
      ? `group ${item.group.title}`
      : item.type === "step"
        ? `${" ".repeat(item.depth ?? 1)}step ${item.step.label}`
        : item.type === "run"
          ? `${" ".repeat(item.depth ?? 1)}run ${item.run.label}`
          : item.type === "container"
            ? `${" ".repeat(item.depth ?? 1)}container ${item.container.service}`
            : item.type,
  );

describe("the Running list", () => {
  it("shows a bolt that another needed inside that run, not as a group of its own", () => {
    const items = groupPanes([], [web], [postgres], [shop], [workRun]);
    expect(titles(items)).toEqual(["group Work on shop", " step Services", "  container postgres", " run web"]);
  });

  it("keeps a needed bolt in its own group once it has been run on its own since", () => {
    const servicesRun = entry("Services", [{ kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000 }], "2026-11-18T11:00:00Z");
    const items = groupPanes([], [web], [postgres], [shop], [servicesRun, workRun]);
    expect(titles(items)).toContain("group Services");
    expect(titles(items)).toContain("group Work on shop");
  });
});

import { describe, expect, it } from "vitest";

import type { Container } from "../../../src/core/system/docker.js";
import type { HistoryEntry } from "../../../src/core/history.js";
import type { RunStatus } from "../../../src/core/system/processes.js";
import { interpret } from "../../../src/core/project/index.js";
import { RESTART_MARK } from "../../../src/core/system/shell.js";
import { containerDetails, filterPanes, groupPanes, waitingWords, maskEnv, nextTab, pastRuns, runDetails, shownTab, tabsOf, when } from "../../../src/tui/screens/panes.js";
import type { PaneItem } from "../../../src/tui/state.js";

const file = "/dev/shop/.wisp.json";
const shop = interpret(
  {
    main: {
      name: "Shop",
      pipelines: [
        { label: "Services", steps: [{ compose: "compose.yaml", services: ["postgres"] }] },
        { label: "Work on shop", steps: [{ pipeline: "Services" }, { run: "pnpm dev", label: "web", restart: "on-failure", env: { PORT: 3000, STRIPE_SECRET: "sk_live_1", DATABASE_URL: "postgres://shop:hunter2@localhost/shop" } }] },
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
const web = { id: "aaaaaaaaaaaa", kind: "background", label: "web", command: "pnpm dev", workspace: file, workspaceName: "Shop", asset: "command:web", pipeline: "Work on shop", pid: 1, startedAt: "2026-11-18T10:00:00Z", log: "/tmp/x.log", alive: true } as RunStatus;

const entry = (pipeline: string, steps: HistoryEntry["steps"], startedAt: string): HistoryEntry => ({
  id: pipeline + startedAt,
  workspace: file,
  workspaceName: "Shop",
  pipeline,
  startedAt,
  finishedAt: startedAt,
  ok: true,
  steps,
});
const workRun = entry(
  "Work on shop",
  [
    { kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000, pipeline: "Services" },
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
  it("shows a pipeline that another needed inside that run, not as a group of its own", () => {
    const items = groupPanes([], [web], [postgres], [shop], [workRun]);
    expect(titles(items)).toEqual(["group Work on shop", " step Services", "  container postgres", " run web"]);
  });

  it("shows the step a run is on and the ones still to come, not an older run's process in their place", () => {
    const going: HistoryEntry = {
      ...entry("Work on shop", [{ kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000, pipeline: "Services" }], "2026-11-18T12:00:00Z"),
      ok: false,
      running: true,
      total: 3,
      pending: [
        { kind: "command", label: "build", value: "pnpm build", ok: false, durationMs: 0, pipeline: "Build", running: true, log: "/logs/2.log" },
        { kind: "command", label: "web", value: "pnpm dev", ok: false, durationMs: 0 },
      ],
    };
    const items = groupPanes([], [web], [postgres], [shop], [going]);
    expect(titles(items)).toEqual(["group Work on shop", " step Services", "  container postgres", " step Build", " step web", " run web"]);
    const states = items.flatMap((item) => (item.type === "step" ? [`${item.step.label} ${item.step.state ?? "done"}`] : []));
    expect(states).toEqual(["Services done", "Build running", "web waiting"]);
    const build = items.find((item) => item.type === "step" && item.step.label === "Build");
    expect(build?.type === "step" && build.step.log).toBe("/logs/2.log");
  });

  it("shows the pipelines a pipeline that runs nothing itself brought up under it", () => {
    const withUp = interpret(
      {
        main: {
          name: "Shop",
          pipelines: [
            { label: "Services", steps: [{ compose: "compose.yaml", services: ["postgres"] }] },
            { label: "Web", steps: [{ run: "pnpm dev", label: "web" }] },
            { label: "Up", steps: [{ pipeline: "Services" }, { pipeline: "Web" }] },
          ],
        },
      },
      { file, personal: false, trust: "trusted", os: "darwin" },
    );
    const upRun = entry(
      "Up",
      [
        { kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000, pipeline: "Services" },
        { kind: "command", label: "web", value: "pnpm dev", ok: true, durationMs: 1500, pipeline: "Web" },
      ],
      "2026-11-18T10:00:00Z",
    );
    const items = groupPanes([], [{ ...web, pipeline: "Web" }], [postgres], [withUp], [upRun]);
    expect(titles(items)).toEqual(["group Up", " step Services", "  container postgres", " step Web", "  run web"]);
  });

  it("keeps a needed pipeline in its own group once it has been run on its own since", () => {
    const servicesRun = entry("Services", [{ kind: "compose", label: "postgres", value: "compose.yaml", ok: true, durationMs: 9000 }], "2026-11-18T11:00:00Z");
    const items = groupPanes([], [web], [postgres], [shop], [servicesRun, workRun]);
    expect(titles(items)).toContain("group Services");
    expect(titles(items)).toContain("group Work on shop");
  });
});

describe("the panel's tabs", () => {
  const run: PaneItem = { type: "run", run: web, group: "g" };
  const container: PaneItem = { type: "container", container: postgres, group: "g" };

  it("are logs, info and past runs for a command; logs and info for a container; none for a pipeline", () => {
    expect(tabsOf(run)).toEqual(["logs", "info", "runs"]);
    expect(tabsOf(container)).toEqual(["logs", "info"]);
    expect(tabsOf({ type: "group", group: { key: "g", workspaceName: "Shop", title: "Services" } })).toEqual([]);
  });

  it("go round with [ and ], and fall back to logs where a row lacks the tab chosen", () => {
    expect(nextTab(run, undefined, 1)).toBe("info");
    expect(nextTab(run, "runs", 1)).toBe("logs");
    expect(nextTab(run, "logs", -1)).toBe("runs");
    expect(shownTab(container, "runs")).toBe("logs");
    expect(nextTab(container, "runs", 1)).toBe("info");
    expect(nextTab({ type: "current" }, "info", 1)).toBeUndefined();
  });

  it("show a command's env from its file, with secrets hidden", () => {
    const rows = runDetails(web, [shop], [], []);
    const values = rows.map((row) => `${row.label}|${row.value}`);
    expect(values).toContain("Command|pnpm dev");
    expect(values).toContain("Env|PORT=3000");
    expect(values).toContain("|STRIPE_SECRET=****");
    expect(values).toContain("|DATABASE_URL=postgres://shop:****@localhost/shop");
    expect(values).toContain("State|running, PID 1");
    expect(values).toContain("Restart|on-failure");
    expect(values).toContain("From a shell|wisp logs aaaaaaaaaaaa -f · wisp stop aaaaaaaaaaaa");
    expect(values.join("\n")).not.toContain("hunter2");
  });

  it("count the restarts a command's output records", () => {
    const rows = runDetails(web, [shop], [], ["listening", `${RESTART_MARK} in 1s`, "listening", `${RESTART_MARK} in 2s`]);
    expect(rows.find((row) => row.label === "Restart")?.value).toBe("on-failure, restarted 2×");
  });

  it("hide what looks like a secret, and nothing else", () => {
    expect(maskEnv("GITHUB_TOKEN", "ghp_1")).toBe("****");
    expect(maskEnv("DB_PASSWORD", "x")).toBe("****");
    expect(maskEnv("AWS_SECRET_ACCESS_KEY", "x")).toBe("****");
    expect(maskEnv("API_KEY", "x")).toBe("****");
    expect(maskEnv("NODE_ENV", "development")).toBe("development");
    expect(maskEnv("KEYBOARD", "us")).toBe("us");
    expect(maskEnv("REDIS_URL", "redis://default:pw@cache:6379")).toBe("redis://default:****@cache:6379");
  });

  it("list the times a command ran, newest first, and only that command's", () => {
    const earlier = { ...web, id: "bbbbbbbbbbbb", alive: false, exitCode: 1, startedAt: "2026-11-18T09:00:00Z" };
    const other = { ...web, id: "cccccccccccc", asset: "command:api", startedAt: "2026-11-18T11:00:00Z" };
    expect(pastRuns(web, [earlier, other, web]).map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("show a container's ports and what it is using", () => {
    const rows = containerDetails(postgres, { cpu: "0.4%", memory: "48MiB / 7.6GiB" });
    const values = rows.map((row) => `${row.label}|${row.value}`);
    expect(values).toContain("Ports|localhost:5432");
    expect(values).toContain("CPU|0.4%");
    expect(values).toContain("Memory|48MiB / 7.6GiB");
    expect(values).toContain("State|healthy, Up 2 minutes (healthy)");
  });

  it("say when with the time today, and the day before today", () => {
    const now = new Date(2026, 10, 18, 15, 0);
    expect(when(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toBe("09:05");
    expect(when(new Date(2026, 10, 17, 23, 30).toISOString(), now)).toBe("Nov 17 23:30");
  });
});

describe("filtering the Running list", () => {
  const items = groupPanes([], [web], [postgres], [shop], [{ ...workRun, number: 4 }]);

  it("keeps the line a nested match sits under, so it is not left hanging", () => {
    expect(titles(filterPanes(items, "postgres"))).toEqual(["group Work on shop", " step Services", "  container postgres"]);
  });

  it("keeps the pipeline's run number when its steps are filtered out", () => {
    const group = filterPanes(items, "web").find((item) => item.type === "group");
    expect(group?.type === "group" && group.group.number).toBe(4);
  });

  it("keeps the run in progress when its pipeline matches, and only then", () => {
    const withCurrent: PaneItem[] = [{ type: "current" }, ...items];
    expect(filterPanes(withCurrent, "deploy", "Deploy").some((item) => item.type === "current")).toBe(true);
    expect(filterPanes(withCurrent, "postgres", "Deploy").some((item) => item.type === "current")).toBe(false);
  });
});

describe("the words beside a run that is starting", () => {
  const unicode = { spark: "✦" } as Parameters<typeof waitingWords>[0];

  it("show whole, with their star, where some fit", () => {
    const shown = waitingWords(unicode, 16, 0);
    expect(shown).toMatch(/^✦ .+…$/);
    expect(shown.length).toBeLessThanOrEqual(16);
  });

  it("give way to the plain status where none would fit whole", () => {
    expect(waitingWords(unicode, 10, 0)).toBe("starting…");
  });
});

import { dirname } from "node:path";

import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { baseLabel, type HistoryEntry } from "../core/history.js";
import { RESTART_MARK } from "../core/shell.js";
import { describe } from "../core/errors.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { containerMood, shortStatus, type Container, type ContainerStats } from "../core/docker.js";
import { boltStatus, collectBoltTargets, composeFiles, retryPlan } from "../core/switch.js";
import type { Bolt, Diagnostic, StepKind, SwitchResult, SwitchTarget, TargetResult, WorkspaceRead } from "../core/types.js";
import { describeWait } from "../core/wait.js";
import { glyphs as defaultGlyphs, type Glyphs } from "./glyphs.js";
import { BoltEditor } from "./editor.js";
import { BoltView, flow } from "./boltview.js";
import { TONE } from "./tones.js";
import { HistoryScreen, SearchLine } from "./history.js";
import { Choice, Confirm, Form } from "./forms.js";
import { describeStep, matchesAll, ordered, search, windowed, type Library, type SearchHit, type Services, type SetupSuggestion } from "./model.js";

type Focus = "workspaces" | "bolts";

interface StepState {
  target: SwitchTarget;
  state: "pending" | "running" | "done";
  result?: TargetResult;
}

type View =
  | { kind: "browse" }
  | { kind: "search"; query: string; index: number }
  | { kind: "run" }
  | { kind: "check"; read?: WorkspaceRead; scroll: number }
  | { kind: "trust"; read: WorkspaceRead }
  | {
      kind: "processes";
      index: number;
      all: boolean;
      /** Lines scrolled back from the end of the pane; 0 follows it as it grows. */
      scroll: number;
      /** The pane fills the screen, without the list. */
      full: boolean;
      /** A run to open on, once it shows up in the list. */
      focus?: string;
      /** Narrows the list to what matches; `typing` while it is being written. */
      query?: string;
      typing?: boolean;
    }
  | { kind: "help" }
  | { kind: "history" }
  | { kind: "editor"; file: string; bolt: string }
  | { kind: "new-bolt"; file: string; workspace: string }
  | { kind: "new-workspace" }
  | { kind: "delete-bolt"; file: string; bolt: string }
  | { kind: "view"; file: string; bolt: string }
  /** Stopping a bolt that needed others: those too, or only it? */
  | { kind: "stop-bolt"; file: string; bolt: string; needs: string[]; sharedWith: string[] }
  | { kind: "setup"; suggestion: SetupSuggestion };

/** Views that read the keyboard themselves: forms, the editor, confirmations. */
const SELF_DRIVEN = new Set(["editor", "new-bolt", "new-workspace", "delete-bolt", "setup", "history", "view", "stop-bolt"]);

/**
 * The run in progress, or the last one. Kept apart from the screen showing it, so that
 * going to the panes in the middle of a build does not lose the build — it shows there too.
 */
interface RunState {
  title: string;
  /** The workspace and bolt, so a retry knows what it is retrying. */
  read: WorkspaceRead;
  bolt: string;
  job: boolean;
  dryRun: boolean;
  steps: StepState[];
  done: boolean;
  error?: string;
  output: string[];
  outputOf?: string;
  /** Run ids it started, so stopping one of them stops the run. */
  started: string[];
  result?: SwitchResult;
  /** Set once it was stopped, rather than finished. */
  stopped?: string;
}

/** One line of the activity log. */
interface Activity {
  at: number;
  text: string;
  tone: "good" | "bad" | "info";
}

/** A notice at the bottom of the screen: what just changed, and whether that is bad news. */
interface Notice {
  text: string;
  tone: "good" | "bad" | "info";
}

/** One row of the panes: a command Specter runs, or a container Docker runs for it. */
type PaneItem =
  | { type: "run"; run: RunStatus; group: string }
  | { type: "container"; container: Container; group: string }
  | { type: "current" }
  | { type: "group"; group: PaneGroup };

/**
 * A bolt in the Running list, with what it started under it — the way Dockge shows a stack
 * with its containers. Commands go under the bolt that started them; containers under the
 * bolt whose compose step starts them; anything else under its workspace.
 */
interface PaneGroup {
  key: string;
  /** The workspace file, to find the bolt again for stopping or restarting it. */
  workspace?: string;
  workspaceName: string;
  bolt?: string;
  title: string;
}

const KIND: Record<StepKind, string> = {
  app: "app",
  command: "run",
  folder: "folder",
  file: "file",
  link: "link",
  wait: "wait",
  bolt: "needs",
  compose: "docker",
};

export interface AppProps {
  services: Services;
  glyphs?: Glyphs;
  /** Fixed size, for tests; otherwise the terminal's, kept up to date on resize. */
  size?: { columns: number; rows: number };
}

export function App({ services, glyphs = defaultGlyphs(), size }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize(size);

  const [library, setLibrary] = useState<Library>();
  const [loadError, setLoadError] = useState<string>();
  // Read by the key handler through their refs, which update the moment they are set: keys
  // can arrive faster than React re-renders, and each must see what the one before did.
  const [wsIndex, setWsIndex, wsRef] = useLatest(0);
  const [boltIndex, setBoltIndex, boltRef] = useLatest(0);
  const [focus, setFocus, focusRef] = useLatest<Focus>("workspaces");
  const [view, setView, viewRef] = useLatest<View>({ kind: "browse" });
  const [message, setMessage, messageRef] = useLatest<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const [log, setLog] = useState("");
  const busy = useRef(false);
  const [active, setActive, activeRef] = useLatest<RunState | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const [containers, setContainers] = useState<Container[]>([]);
  const [dockerError, setDockerError] = useState<string>();
  const [stats, setStats] = useState<Map<string, ContainerStats>>(new Map());
  const [notice, setNotice] = useState<Notice>();
  // Past runs, for the last result beside each bolt and the recent runs under them.
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  // Whether the finished run is the one being looked at in Running, so it does not vanish mid-read.
  const watchingDone = useRef(false);
  // What was true at the last look, to tell what has changed since.
  const seenRuns = useRef<Map<string, boolean> | undefined>(undefined);
  const seenContainers = useRef<Map<string, string> | undefined>(undefined);
  // Stops asked for here are not news, and neither are files saved here.
  const expected = useRef<Set<string>>(new Set());
  const savedAt = useRef(0);

  /** Say what changed, in a line that stays a few seconds. */
  // What Specter did and what happened, newest first — like lazygit's command log: notices
  // flash by, this keeps them. Shown under the Running list.
  const [events, setEvents] = useState<Activity[]>([]);
  const record = useCallback((text: string, tone: Notice["tone"] = "info") => {
    setEvents((entries) => [{ at: Date.now(), text: text.replace(/ — (press|⏎) .*$/, ""), tone }, ...entries].slice(0, 100));
  }, []);
  const notify = useCallback(
    (text: string, tone: Notice["tone"] = "info") => {
      setNotice({ text, tone });
      record(text, tone);
    },
    [record],
  );
  const say = (text: string) => {
    setMessage(text);
    record(text, /failed|error/i.test(text) ? "bad" : "info");
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 9000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Runs started from here: when they start and how they end.
  const loggedRun = useRef<RunState | undefined>(undefined);
  useEffect(() => {
    if (!active || active.dryRun) return;
    if (loggedRun.current?.title !== active.title || loggedRun.current?.read !== active.read) {
      if (!active.done) record(`ran ${active.bolt}`, "info");
    }
    if (active.done && !(loggedRun.current === active || (loggedRun.current?.done && loggedRun.current.title === active.title && loggedRun.current.read === active.read))) {
      const failed = active.steps.find((step) => step.result && !step.result.ok && !step.result.skipped);
      record(active.stopped ? `${active.bolt} stopped — ${active.stopped}` : failed || active.error ? `${active.bolt} failed${failed ? ` at ${failed.target.label}` : ""}` : `${active.bolt} ${active.job ? "passed" : "is up"}`, active.stopped || failed || active.error ? "bad" : "good");
    }
    loggedRun.current = active;
  }, [active, record]);

  const reads = useMemo(() => (library ? ordered(library) : []), [library]);
  const current = reads[Math.min(wsIndex, Math.max(0, reads.length - 1))];
  const bolts = current?.workspace.bolts ?? [];
  const bolt = bolts[Math.min(boltIndex, Math.max(0, bolts.length - 1))];

  const reload = useCallback(
    async (keep?: string) => {
      try {
        const next = await services.load();
        setLibrary(next);
        setLoadError(undefined);
        const list = ordered(next);
        const file = keep ?? list[0]?.workspace.file;
        const index = Math.max(0, list.findIndex((read) => read.workspace.file === file));
        setWsIndex(index);
        return next;
      } catch (error) {
        setLoadError(describe(error));
        return undefined;
      }
    },
    [services],
  );

  // First load: start on the project you are standing in, with its bolts in focus — the
  // same answer bare `specter` gives on the command line, one keypress from running.
  useEffect(() => {
    void reload().then(async (next) => {
      const first = next ? ordered(next)[0] : undefined;
      if (next?.here && first?.workspace.file === next.here && first.workspace.bolts.length > 0) setFocus("bolts");
      // Opened in a project that has no file yet: offer to set it up, right here.
      if (next && !next.here) {
        const suggestion = await services.suggestSetup().catch(() => undefined);
        if (suggestion && viewRef.current.kind === "browse") setView({ kind: "setup", suggestion });
      }
    });
  }, [reload]);

  // A spinner only while something is running.
  const spinning = active !== undefined && !active.done;
  useEffect(() => {
    if (!spinning) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [spinning]);

  // Runs are watched all the time, cheaply: they are what marks a bolt as up.
  const watching = true;
  const paneItems: PaneItem[] =
    view.kind === "processes"
      ? filterPanes(
          // Running shows what runs. The run in progress sits at the top while it goes; once
          // it is done it is History's — kept here only while you are reading its output.
          groupPanes(active && (!active.done || watchingDone.current) ? [{ type: "current" }] : [], visibleRuns(runs, view.all), containers.filter((container) => view.all || container.state === "running" || container.state === "restarting" || container.exitCode !== 0), reads),
          view.query ?? "",
        )
      : [];
  const processIndex =
    view.kind === "processes"
      ? (() => {
          const focused = view.focus ? paneItems.findIndex((item) => paneKey(item) === view.focus) : -1;
          if (focused >= 0) return focused;
          // Opening the screen lands on the first task, whose output is what you came for.
          if (view.index < 0) return Math.max(0, paneItems.findIndex((item) => item.type !== "group"));
          return Math.max(0, Math.min(view.index, paneItems.length - 1));
        })()
      : 0;
  const selectedItem = view.kind === "processes" ? paneItems[processIndex] : undefined;
  const selectedRun = selectedItem?.type === "run" ? selectedItem.run : undefined;
  const watchingActive = selectedItem?.type === "current";
  watchingDone.current = view.kind === "processes" && watchingActive;
  const selectedContainer = selectedItem?.type === "container" ? selectedItem.container : undefined;
  useEffect(() => {
    if (!selectedContainer) return;
    let alive = true;
    const refresh = async () => {
      const text = await services.containerLogs(selectedContainer.name);
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedContainer?.name, services]);
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    const refresh = async () => {
      const next = await services.runs();
      if (!alive) return;
      setRuns(next);
      // Anything that stopped or started since the last look — unless it was asked for here.
      const before = seenRuns.current;
      if (before) {
        for (const run of next) {
          const was = before.get(run.id);
          if (was === true && !run.alive) {
            if (expected.current.delete(run.id)) continue;
            notify(`${run.label} stopped (${run.workspaceName}) — press p to see its last output`, "bad");
          } else if (was === undefined && run.alive && !expected.current.has(run.id)) {
            notify(`${run.label} started (${run.workspaceName})`, "good");
          }
        }
      }
      seenRuns.current = new Map(next.map((run) => [run.id, run.alive]));
    };
    void refresh();
    const timer = setInterval(refresh, view.kind === "processes" ? 1000 : 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [watching, services, view.kind]);

  // Containers of every compose file a trusted workspace starts: watched like runs, so a
  // database that dies says so, and a bolt knows whether its services are up.
  const files = useMemo(() => [...new Set(reads.flatMap((read) => composeFiles(read.workspace)))], [reads]);
  const panesOpen = view.kind === "processes";
  useEffect(() => {
    if (files.length === 0) {
      setContainers([]);
      return;
    }
    let alive = true;
    const refresh = async () => {
      const { containers: next, error } = await services.containers(files);
      if (!alive) return;
      setContainers(next);
      setDockerError(error);
      const before = seenContainers.current;
      if (before) {
        for (const container of next) {
          const was = before.get(container.name);
          const now = containerMood(container).word;
          if (!was || was === now) continue;
          if (expected.current.delete(container.name)) continue;
          if (now === "unhealthy") notify(`${container.service} is unhealthy — press p to see its logs`, "bad");
          else if (now === "exited" || now === "dead") notify(`${container.service} stopped (${container.status}) — press p to see why`, "bad");
          else if ((now === "healthy" || now === "running") && (was === "unhealthy" || was === "exited" || was === "starting" || was === "restarting")) {
            notify(`${container.service} is ${now === "healthy" ? "healthy" : "running"} again`, "good");
          }
        }
      }
      seenContainers.current = new Map(next.map((container) => [container.name, containerMood(container).word]));
    };
    void refresh();
    const timer = setInterval(refresh, panesOpen ? 1500 : 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [files.join("|"), panesOpen, services, notify]);
  useEffect(() => {
    if (!panesOpen) return;
    const names = containers.filter((container) => container.state === "running").map((container) => container.name);
    if (names.length === 0) return;
    let alive = true;
    const refresh = async () => {
      const next = await services.containerStats(names);
      if (alive) setStats(next);
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panesOpen, containers.map((container) => `${container.name}:${container.state}`).join("|"), services]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await services.history().catch(() => []);
      if (alive) setRecent(next);
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [services, active?.done]);

  // Workspace files edited elsewhere — in an editor, by a `git pull` — are read again.
  const watched = useMemo(() => reads.map((read) => read.workspace.file), [reads]);
  useEffect(() => {
    if (watched.length === 0) return;
    return services.watch(watched, (file) => {
      if (Date.now() - savedAt.current < 2000) return;
      const name = reads.find((read) => read.workspace.file === file)?.workspace.name ?? "A workspace";
      void reload(reads[wsRef.current]?.workspace.file).then(() => notify(`${name}'s file changed — reloaded`, "info"));
    });
  }, [watched.join("|"), services]);

  useEffect(() => {
    if (!selectedRun) {
      if (!selectedContainer) setLog("");
      return;
    }
    let alive = true;
    const refresh = async () => {
      const text = await services.tail(selectedRun.log, 600);
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedRun?.id, selectedRun?.log, services]);

  /**
   * Run steps — a whole bolt, or a retry of part of one — showing each as it goes. The
   * progress is kept in `active`, whichever screen is showing.
   */
  const launch = useCallback(
    async (
      read: WorkspaceRead,
      label: string,
      job: boolean,
      dryRun: boolean,
      start: (callbacks: Parameters<Services["run"]>[2]) => Promise<SwitchResult>,
      title: string,
    ) => {
      if (busy.current) return;
      busy.current = true;
      const controller = new AbortController();
      abort.current = controller;
      setActive({ title, read, bolt: label, job, dryRun, steps: [], done: false, output: [], started: [] });
      setView({ kind: "run" });
      const update = (change: (state: RunState) => RunState) => setActive((prior) => (prior ? change(prior) : prior));

      try {
        const result = await start({
          dryRun,
          signal: controller.signal,
          onPlan: (targets) => update((state) => ({ ...state, steps: targets.map((target) => ({ target, state: "pending" })) })),
          onStep: (target, info) => {
            update((state) => ({ ...state, steps: markFirst(state.steps, target, (step) => ({ ...step, state: "running" })) }));
            // An attached command's output takes the pane; a window's stays in the window.
            if (info.attached) update((state) => ({ ...state, output: [], outputOf: target.label }));
          },
          onOutput: (_target, chunk) =>
            update((state) => {
              // Chunks do not end on line breaks, so join before splitting: the last line
              // stays open until its newline arrives.
              const text = state.output.join("\n") + chunk.replace(/\r/g, "");
              return { ...state, output: text.split("\n").slice(-400) };
            }),
          onResult: (result) =>
            update((state) => ({
              ...state,
              steps: markFirst(state.steps, result, (step) => ({ ...step, state: "done", result }), true),
              started: result.run && !result.note?.startsWith("already running") ? [...state.started, result.run] : state.started,
            })),
        });
        update((state) => ({ ...state, done: true, result }));
      } catch (error) {
        update((state) => ({ ...state, done: true, error: describe(error) }));
      } finally {
        busy.current = false;
        abort.current = undefined;
      }
    },
    [setActive, setView],
  );

  const runBolt = useCallback(
    async (read: WorkspaceRead, label: string, dryRun: boolean) => {
      const job = read.workspace.bolts.find((entry) => entry.label === label)?.job ?? false;
      await launch(read, label, job, dryRun, (callbacks) => services.run(read, label, callbacks), `${read.workspace.name} ${glyphs.arrow} ${label}`);
    },
    [services, glyphs.arrow, launch],
  );

  /** The failed part of the last run, again — not the whole pipeline. */
  const retryFailed = useCallback(async () => {
    const last = activeRef.current;
    if (!last?.result) return;
    const steps = retryPlan(last.result);
    if (steps.length === 0) return setMessage("Nothing failed — there is nothing to retry");
    await launch(
      last.read,
      last.bolt,
      last.job,
      false,
      (callbacks) => services.retry(last.read, steps, last.bolt, last.job, callbacks),
      `${last.read.workspace.name} ${glyphs.arrow} ${last.bolt} — retrying ${steps.length === 1 ? "1 step" : `${steps.length} steps`}`,
    );
  }, [services, glyphs.arrow, launch]);

  /** Stop the run in progress: nothing more starts, and what it has running attached stops. */
  const stopActive = useCallback((why: string) => {
    if (!abort.current) return;
    abort.current.abort();
    setActive((prior) => (prior ? { ...prior, stopped: why } : prior));
  }, [setActive]);

  const openCheck = useCallback(
    async (read: WorkspaceRead) => {
      setView({ kind: "check", scroll: 0 });
      try {
        const checked = await services.check(read.workspace.file);
        setView((prior) => (prior.kind === "check" ? { ...prior, read: checked } : prior));
      } catch (error) {
        setView({ kind: "browse" });
        setMessage(describe(error));
      }
    },
    [services],
  );

  const edit = useCallback(
    async (read: WorkspaceRead) => {
      await services.edit(read.workspace.file);
      savedAt.current = Date.now();
      await reload(read.workspace.file);
      setMessage(`reloaded ${read.workspace.name}`);
    },
    [services, reload],
  );

  // Activity opens on what is running, or — when nothing is — on what ran.
  const history_ = (): View => ({ kind: "history" });
  /**
   * Stop a bolt, and with `deps` the bolts it needed. Asked first when it needed any: stopping
   * Work on web alone leaves the database up, which is right when something else uses it and
   * a surprise when nothing does.
   */
  const stopBolt = (read: WorkspaceRead, target: Bolt, deps: boolean) => {
    setMessage(`Stopping ${target.label}${deps ? " and what it needed" : ""}…`);
    void services
      .down(read, target, { deps })
      .then(async (result) => {
        for (const run of result.stopped) expected.current.add(run.id);
        const torn = result.teardown ? ` · teardown ${result.teardown.ok ? "done" : "failed"}` : "";
        say(`${target.label}${deps ? " and what it needed" : ""}: stopped ${result.stopped.length}${torn}`);
        setRuns(await services.runs());
      })
      .catch((error: unknown) => setMessage(describe(error)));
  };
  const askStop = (read: WorkspaceRead, target: Bolt) => {
    const needs = flow(read, target, reads).filter((name) => name !== target.label);
    if (needs.length === 0) return stopBolt(read, target, false);
    // Other bolts with something up that need the same ones: stopping those would break them.
    const sharedWith = reads.flatMap((other) =>
      other.workspace.bolts
        .filter((candidate) => candidate.label !== target.label && runs.some((run) => run.alive && run.workspace === other.workspace.file && run.bolt === candidate.label))
        .filter((candidate) => flow(other, candidate, reads).some((name) => needs.includes(name) && name !== candidate.label))
        .map((candidate) => candidate.label),
    );
    setView({ kind: "stop-bolt", file: read.workspace.file, bolt: target.label, needs, sharedWith });
  };

  /** 1–4 go straight to a panel, as lazygit's numbers do: workspaces, bolts, running, history. */
  const jump = (input: string): boolean => {
    if (input === "1" || input === "2") {
      setView({ kind: "browse" });
      setFocus(input === "1" ? "workspaces" : "bolts");
      return true;
    }
    if (input === "3") return setView(activity()), true;
    if (input === "4") return setView(history_()), true;
    return false;
  };
  const activity = (focus?: string): View => ({
    kind: "processes",
    index: -1,
    all: false,
    scroll: 0,
    full: false,
    ...(focus ? { focus } : {}),
  });

  useInput((input, key) => {
    const view = viewRef.current;
    if (SELF_DRIVEN.has(view.kind)) return;
    if (notice) setNotice(undefined);
    const focus = focusRef.current;
    const wsIndex = wsRef.current;
    const boltIndex = boltRef.current;
    const current = reads[Math.min(wsIndex, Math.max(0, reads.length - 1))];
    const bolts = current?.workspace.bolts ?? [];
    const bolt = bolts[Math.min(boltIndex, Math.max(0, bolts.length - 1))];
    if (messageRef.current) setMessage(undefined);

    if (view.kind === "search") {
      const hits = search(reads, view.query);
      if (key.escape) return setView({ kind: "browse" });
      if (key.upArrow || (key.ctrl && input === "p")) return setView({ ...view, index: Math.max(0, view.index - 1) });
      if (key.downArrow || (key.ctrl && input === "n")) return setView({ ...view, index: Math.min(hits.length - 1, view.index + 1) });
      if (key.return) {
        const hit = hits[view.index];
        if (!hit) return;
        const read = reads[hit.workspace] as WorkspaceRead;
        setWsIndex(hit.workspace);
        if (hit.bolt) {
          setBoltIndex(Math.max(0, read.workspace.bolts.findIndex((entry) => entry.label === hit.bolt)));
          setFocus("bolts");
          void runBolt(read, hit.bolt, false);
        } else {
          setBoltIndex(0);
          setFocus("bolts");
          setView({ kind: "browse" });
        }
        return;
      }
      if (key.backspace || key.delete) return setView({ ...view, query: view.query.slice(0, -1), index: 0 });
      if (input && !key.ctrl && !key.meta && !key.tab) return setView({ ...view, query: view.query + input, index: 0 });
      return;
    }

    // The trust dialog's buttons take its keys.
    if (view.kind === "trust") return;

    if (view.kind === "help") return setView({ kind: "browse" });

    if (input === "q" && view.kind === "browse") {
      // Nothing left running attached and unseen.
      stopActive("Specter was closed");
      return exit();
    }

    if (view.kind === "run") {
      const run = activeRef.current;
      // Watching is what you want while a bolt is still starting; the run carries on, and
      // is the first pane there.
      if (input === "p") return setView(activity("current"));
      if (input === "h") return setView(history_());
      if (jump(input)) return;
      if (!run || !run.done) {
        if (input === "x") stopActive("you stopped it");
        if (key.escape) return setView({ kind: "browse" });
        return;
      }
      if (input === "r" && run.result && retryPlan(run.result).length > 0) return void retryFailed();
      // A bolt that started servers: ⏎ goes to watch them. Anything else goes back.
      // The bolt's own server, not the database it needed: the last thing it started.
      const started = [...run.steps].reverse().find((step) => step.result?.run && step.result.ok && !step.target.workspace)?.result?.run;
      if (key.return && started) return setView(activity(started));
      if (key.return || key.escape || input === "q" || input === " ") return setView({ kind: "browse" });
      return;
    }

    if (view.kind === "check") {
      if (key.upArrow || input === "k") return setView({ ...view, scroll: Math.max(0, view.scroll - 1) });
      if (key.downArrow || input === "j") return setView({ ...view, scroll: view.scroll + 1 });
      if (input === "t" && view.read && needsTrust(view.read)) return setView({ kind: "trust", read: view.read });
      if (key.escape || key.return || input === "q") return setView({ kind: "browse" });
      return;
    }

    if (view.kind === "processes") {
      // Two screens, one key each: p for what's running, h for what ran.
      // Typing a search: letters go into it; ⏎ or ↓ keeps it and goes back to the list.
      if (view.typing) {
        if (key.escape) return setView({ ...view, query: "", typing: false, index: -1 });
        if (key.return || key.downArrow || key.tab) return setView({ ...view, typing: false });
        if (key.backspace || key.delete) return setView({ ...view, query: (view.query ?? "").slice(0, -1), index: -1 });
        if (input && !key.ctrl && !key.meta) return setView({ ...view, query: `${view.query ?? ""}${input}`, index: -1 });
        return;
      }
      // Fast typing arrives as one chunk: "/md" is "/" and the start of the search.
      if (input.startsWith("/")) {
        const { focus: _drop, ...plain } = view;
        return setView({ ...plain, typing: true, query: `${view.query ?? ""}${input.slice(1)}`, index: -1 });
      }
      if (key.escape && view.query) return setView({ ...view, query: "", index: -1 });
      if (input === "h") return setView(history_());
      if (jump(input)) return;
      const list = paneItems;
      const at = processIndex;
      const { focus: _focus, ...rest } = view;
      const item = list[at];
      // A bolt: stop all of it, restart it, or go into its first task.
      if (item?.type === "group") {
        const read = reads.find((candidate) => candidate.workspace.file === item.group.workspace);
        const boltDef = read?.workspace.bolts.find((entry) => entry.label === item.group.bolt);
        if (key.return) return setView({ ...rest, index: at + 1, scroll: 0 });
        if (input === "x" && read && boltDef) return askStop(read, boltDef);
        if (input === "r" && read && boltDef) {
          const restart = true;
          setMessage(`${restart ? "Restarting" : "Stopping"} ${boltDef.label}…`);
          void services
            .down(read, boltDef)
            .then(async (result) => {
              for (const stopped of result.stopped) expected.current.add(stopped.id);
              setRuns(await services.runs());
              if (restart) {
                if (result.stopped.length > 0) await new Promise((done) => setTimeout(done, 500));
                await runBolt(read, boltDef.label, false);
              } else say(`${boltDef.label}: stopped ${result.stopped.length}`);
            })
            .catch((error: unknown) => setMessage(describe(error)));
          return;
        }
        if (input === "x" || input === "r") return setMessage("These were not started by a bolt — stop them one by one");
      }
      // The run itself: open its steps, stop it, or retry what failed.
      if (item?.type === "current") {
        const run = activeRef.current;
        if (key.return) return setView({ kind: "run" });
        if (input === "x" && run && !run.done) return stopActive("you stopped it");
        if (input === "r" && run?.done && run.result && retryPlan(run.result).length > 0) return void retryFailed();
      }
      // A container: Docker does the starting and stopping.
      if (item?.type === "container" && (input === "r" || input === "x" || input === "s")) {
        const action = input === "r" ? "restart" : input === "x" ? "stop" : "start";
        const name = item.container.service;
        expected.current.add(item.container.name);
        setMessage(`${action === "restart" ? "Restarting" : action === "stop" ? "Stopping" : "Starting"} ${name}…`);
        void services
          .containerAction(item.container.name, action)
          .then(() => say(`${name}: ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`))
          .catch((error: unknown) => setMessage(describe(error)));
        return;
      }
      const page = Math.max(1, bodyHeight - 4);
      if (key.upArrow || input === "k") return setView({ ...rest, index: Math.max(0, at - 1), scroll: 0 });
      if (key.downArrow || input === "j") return setView({ ...rest, index: Math.min(list.length - 1, at + 1), scroll: 0 });
      if (key.pageUp || input === "u") return setView({ ...view, scroll: view.scroll + page });
      if (key.pageDown || input === "d") return setView({ ...view, scroll: Math.max(0, view.scroll - page) });
      if (input === "G" || input === "g") return setView({ ...view, scroll: 0 });
      if (input === "f") return setView({ ...view, full: !view.full });
      if (input === "a") return setView({ ...rest, all: !view.all, index: 0 });
      if (input === "r") {
        const run = item?.type === "run" ? item.run : undefined;
        if (!run) return;
        expected.current.add(run.id);
        setMessage(`restarting ${run.label}…`);
        void services
          .restart(run)
          .then(async (result) => {
            say(result.ok ? `restarted ${run.label}` : `${run.label} failed to start: ${result.error ?? ""}`);
            setRuns(await services.runs());
            expected.current.add(result.run.id);
            setView((prior) => (prior.kind === "processes" ? { ...prior, focus: result.run.id, scroll: 0 } : prior));
          })
          .catch((error: unknown) => setMessage(describe(error)));
        return;
      }
      if (input === "x") {
        const run = item?.type === "run" ? item.run : undefined;
        if (run?.alive) {
          expected.current.add(run.id);
          const owner = activeRef.current;
          if (owner && !owner.done && owner.started.includes(run.id)) {
            // Its run would otherwise carry on and start the next thing, as if nothing happened.
            stopActive(`you stopped ${run.label}`);
            notify(`Stopped ${run.label} — and the run that started it, so nothing else starts`, "info");
          }
          say(services.stop(run) ? `stopped ${run.label}` : `${run.label} had already stopped`);
          void services.runs().then(setRuns);
        }
        return;
      }
      if (key.escape || input === "q" || input === "p") return setView({ kind: "browse" });
      return;
    }

    // Browsing.
    if (input === "?") return setView({ kind: "help" });
    if (input === "N") return setView({ kind: "new-workspace" });
    if (input.startsWith("/")) return setView({ kind: "search", query: input.slice(1), index: 0 });
    if (input === "p") return setView(activity());
    if (input === "h") return setView(history_());
    if (view.kind === "browse" && jump(input)) return;
    if (input === "r") {
      void reload(current?.workspace.file).then(() => setMessage("reloaded"));
      return;
    }

    if (key.tab || key.rightArrow || input === "l") return setFocus(key.tab && focus === "bolts" ? "workspaces" : "bolts");
    if (key.leftArrow || (key.shift && key.tab)) return setFocus("workspaces");

    const up = key.upArrow || input === "k";
    const down = key.downArrow || input === "j";
    if (focus === "workspaces") {
      if (up || down) {
        const next = clamp(wsIndex + (up ? -1 : 1), reads.length);
        setWsIndex(next);
        setBoltIndex(0);
        return;
      }
      if (key.return) return setFocus("bolts");
    } else if (up || down) {
      return setBoltIndex(clamp(boltIndex + (up ? -1 : 1), bolts.length));
    }

    if (!current) return;
    // Editing, without JSON: e opens the bolt editor, a adds a bolt, N a workspace of
    // your own. E hands the file itself to your editor, for those who want it.
    if (input === "E") return void edit(current);
    if (input === "e") {
      if (!bolt) return setView({ kind: "new-bolt", file: current.workspace.file, workspace: current.workspace.name });
      return setView({ kind: "editor", file: current.workspace.file, bolt: bolt.label });
    }
    if (input === "a") return setView({ kind: "new-bolt", file: current.workspace.file, workspace: current.workspace.name });
    if (input === "D" && bolt) return setView({ kind: "delete-bolt", file: current.workspace.file, bolt: bolt.label });
    if (input === "v" && bolt) return setView({ kind: "view", file: current.workspace.file, bolt: bolt.label });
    if ((input === "K" || input === "J") && bolt && focus === "bolts") {
      const by = input === "K" ? -1 : 1;
      savedAt.current = Date.now();
      void services.editing
        .moveBolt(current.workspace.file, bolt.label, by)
        .then(() => reload(current.workspace.file))
        .then(() => setBoltIndex(Math.max(0, Math.min(bolts.length - 1, boltIndex + by))))
        .catch((error: unknown) => setMessage(describe(error)));
      return;
    }
    if (input === "x" && bolt) return askStop(current, bolt);
    if (input === "R" && bolt) {
      const restart = true;
      void services
        .down(current, bolt)
        .then(async (result) => {
          for (const run of result.stopped) expected.current.add(run.id);
          const torn = result.teardown ? ` · teardown ${result.teardown.ok ? "done" : "failed"}` : "";
          say(`${bolt.label}: stopped ${result.stopped.length}${torn}`);
          setRuns(await services.runs());
          if (restart) {
            if (result.stopped.length > 0) await new Promise((done) => setTimeout(done, 500));
            await runBolt(current, bolt.label, false);
          }
        })
        .catch((error: unknown) => setMessage(describe(error)));
      return;
    }
    if (input === "c") return void openCheck(current);
    if (input === "t") {
      if (needsTrust(current)) return setView({ kind: "trust", read: current });
      return setMessage(current.workspace.trusted ? "already trusted" : "nothing here needs trust");
    }
    if ((key.return && focus === "bolts") || input === "n") {
      if (!bolt) return setMessage("no bolts yet — e to edit the file");
      void runBolt(current, bolt.label, input === "n");
    }
  }, { isActive: !SELF_DRIVEN.has(view.kind) });

  const bodyHeight = Math.max(4, rows - 2);
  const hereLabel = library?.here ? tildify(library.here.replace(/[\\/]\.specter\.json$/, "")) : undefined;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header
        services={services}
        glyphs={glyphs}
        columns={columns}
        here={hereLabel}
        running={runs.filter((run) => run.alive).length + containers.filter((container) => container.state === "running").length}
        failing={containers.filter((container) => container.health === "unhealthy" || ((container.state === "exited" || container.state === "dead") && container.exitCode !== 0)).map((container) => `${container.service} ${containerMood(container).word}`)}
      />

      {loadError ? (
        <Box borderStyle={glyphs.border} borderColor="red" height={bodyHeight} paddingX={1}>
          <Text color="red">{loadError}</Text>
        </Box>
      ) : !library ? (
        <Box height={bodyHeight} paddingX={1}>
          <Text dimColor>reading workspaces…</Text>
        </Box>
      ) : view.kind === "setup" ? (
        <SetupPanel
          suggestion={view.suggestion}
          glyphs={glyphs}
          height={bodyHeight}
          onAnswer={async (yes) => {
            if (!yes) {
              setView({ kind: "browse" });
              setMessage("Not now — press a in a workspace to add bolts by hand, or run `specter init` later");
              return;
            }
            try {
              savedAt.current = Date.now();
              const file = await services.setUp(view.suggestion);
              const next = await reload(file);
              const read = next ? ordered(next).find((entry) => entry.workspace.file === file) : undefined;
              setFocus("bolts");
              // Its commands are its own until you say otherwise — straight to that question.
              if (read && needsTrust(read)) setView({ kind: "trust", read });
              else setView({ kind: "browse" });
              notify(`Set up ${view.suggestion.name} — ⏎ runs the selected bolt`, "good");
            } catch (error) {
              setView({ kind: "browse" });
              setMessage(describe(error));
            }
          }}
        />
      ) : view.kind === "editor" ? (
        <BoltEditor
          onSaving={() => (savedAt.current = Date.now())}
          file={view.file}
          bolt={view.bolt}
          others={(reads.find((read) => read.workspace.file === view.file)?.workspace.bolts ?? []).map((entry) => entry.label).filter((label) => label !== view.bolt)}
          editing={services.editing}
          glyphs={glyphs}
          height={bodyHeight}
          onClose={() => setView({ kind: "browse" })}
          onChanged={(label) => {
            savedAt.current = Date.now();
            void reload(view.file).then((next) => {
              const read = next ? ordered(next).find((entry) => entry.workspace.file === view.file) : undefined;
              const at = read?.workspace.bolts.findIndex((entry) => entry.label === label) ?? -1;
              if (at >= 0) setBoltIndex(at);
            });
            if (label !== view.bolt) setView({ ...view, bolt: label });
          }}
          onMessage={setMessage}
        />
      ) : view.kind === "new-bolt" ? (
        <Form
          title={`A new bolt in ${view.workspace}`}
          intro="A bolt is one thing you do — 'Work on the API', 'Run the tests'. You'll add its steps next."
          fields={[
            { key: "label", label: "Name", hint: "what you're doing: Work on the API", required: true },
            {
              key: "kind",
              label: "It…",
              hint: "←/→ to choose. A job is for tests, builds and releases: it stops at the first failure.",
              choices: [
                { value: "start", label: "starts things (servers, apps)" },
                { value: "job", label: "runs to completion (a job)" },
              ],
            },
          ]}
          submitLabel="create it"
          glyphs={glyphs}
          height={bodyHeight}
          onCancel={() => setView({ kind: "browse" })}
          onSubmit={async (values) => {
            const label = values["label"]?.trim() ?? "";
            try {
              savedAt.current = Date.now();
              await services.editing.addBolt(view.file, label, { job: values["kind"] === "job" });
            } catch (error) {
              return { label: describe(error) };
            }
            const next = await reload(view.file);
            const read = next ? ordered(next).find((entry) => entry.workspace.file === view.file) : undefined;
            setBoltIndex(Math.max(0, read?.workspace.bolts.findIndex((entry) => entry.label === label) ?? 0));
            setFocus("bolts");
            setView({ kind: "editor", file: view.file, bolt: label });
            return undefined;
          }}
        />
      ) : view.kind === "new-workspace" ? (
        <Form
          title="A workspace of your own"
          intro="For things that belong to no project: 'Morning', 'On call', 'University'. It lives in Specter's own folder, and its commands run without asking — it's yours."
          fields={[{ key: "name", label: "Name", hint: "Morning", required: true }]}
          submitLabel="create it"
          glyphs={glyphs}
          height={bodyHeight}
          onCancel={() => setView({ kind: "browse" })}
          onSubmit={async (values) => {
            let file: string;
            try {
              file = await services.editing.createPersonalWorkspace(values["name"] ?? "");
            } catch (error) {
              return { name: describe(error) };
            }
            await reload(file);
            setBoltIndex(0);
            setFocus("bolts");
            setView({ kind: "editor", file, bolt: "Start" });
            return undefined;
          }}
        />
      ) : view.kind === "view" && reads.some((candidate) => candidate.workspace.file === view.file) ? (
        <BoltView
          read={reads.find((candidate) => candidate.workspace.file === view.file) as WorkspaceRead}
          bolt={view.bolt}
          reads={reads}
          runs={runs}
          containers={containers}
          history={recent}
          glyphs={glyphs}
          height={bodyHeight}
          onClose={() => setView({ kind: "browse" })}
          onRun={() => {
            const target = reads.find((candidate) => candidate.workspace.file === view.file);
            if (target) void runBolt(target, view.bolt, false);
          }}
          onEdit={() => setView({ kind: "editor", file: view.file, bolt: view.bolt })}
        />
      ) : view.kind === "stop-bolt" ? (
        <Box flexDirection="column" height={bodyHeight} borderStyle={glyphs.border} borderColor={TONE.busy} paddingX={1}>
          <Text bold>{`Stop ${view.bolt}?`}</Text>
          <Text> </Text>
          <Text wrap="wrap">{`It needed ${view.needs.join(" and ")} — ${view.needs.length === 1 ? "that keeps" : "those keep"} running unless you stop ${view.needs.length === 1 ? "it" : "them"} too.`}</Text>
          {view.sharedWith.length > 0 ? (
            <Text color={TONE.busy} wrap="wrap">{`${view.sharedWith.join(" and ")} ${view.sharedWith.length === 1 ? "is" : "are"} up and ${view.sharedWith.length === 1 ? "needs" : "need"} ${view.needs.length === 1 ? "it" : "them"} too — stopping ${view.needs.length === 1 ? "it" : "them"} would break ${view.sharedWith.length === 1 ? "it" : "them"}.`}</Text>
          ) : null}
          <Text> </Text>
          <Choice
            yes={`Also stop ${view.needs.join(", ")}`}
            no={`Only ${view.bolt}`}
            danger={view.sharedWith.length > 0}
            onAnswer={(deps) => {
              const read = reads.find((candidate) => candidate.workspace.file === view.file);
              const target = read?.workspace.bolts.find((entry) => entry.label === view.bolt);
              setView({ kind: "browse" });
              if (read && target) stopBolt(read, target, deps);
            }}
            onCancel={() => setView({ kind: "browse" })}
          />
        </Box>
      ) : view.kind === "delete-bolt" ? (
        <Confirm
          title={`Delete the bolt "${view.bolt}"?`}
          detail="Its steps go with it. Anything it started keeps running — `x` takes a bolt down."
          yes="delete it"
          glyphs={glyphs}
          height={bodyHeight}
          onAnswer={(yes) => {
            setView({ kind: "browse" });
            if (!yes) return;
            savedAt.current = Date.now();
            void services.editing
              .removeBolt(view.file, view.bolt)
              .then(() => reload(view.file))
              .then(() => {
                setBoltIndex(Math.max(0, boltIndex - 1));
                say(`Deleted "${view.bolt}"`);
              })
              .catch((error: unknown) => setMessage(describe(error)));
          }}
        />
      ) : view.kind === "history" ? (
        <HistoryScreen
          services={services}
          glyphs={glyphs}
          height={bodyHeight}
          columns={columns}
          onClose={() => setView({ kind: "browse" })}
          onRunning={() => setView(activity())}
          onJump={(input) => void jump(input)}
          onRetry={(entry) => {
            const read = reads.find((candidate) => candidate.workspace.file === entry.workspace);
            if (!read) return setMessage(`${entry.workspaceName} is not in the list any more`);
            const label = entry.bolt.replace(/ \((retry|down)\)$/, "");
            const job = read.workspace.bolts.find((bolt) => bolt.label === label)?.job ?? entry.job;
            void services
              .planRetry(read, entry)
              .then((steps) =>
                launch(read, label, job, false, (callbacks) => services.retry(read, steps, label, job, callbacks), `${entry.workspaceName} ${glyphs.arrow} ${label} — retrying ${steps.length === 1 ? "1 step" : `${steps.length} steps`}`),
              )
              .catch((error: unknown) => setMessage(describe(error)));
          }}
          onRerun={(entry) => {
            const read = reads.find((candidate) => candidate.workspace.file === entry.workspace);
            if (!read) return setMessage(`${entry.workspaceName} is not in the list any more`);
            void runBolt(read, entry.bolt.replace(/ \((retry|down)\)$/, ""), false);
          }}
        />
      ) : view.kind === "run" ? (
        active ? <RunPanel view={active} glyphs={glyphs} height={bodyHeight} tick={tick} /> : null
      ) : view.kind === "check" ? (
        <CheckPanel view={view} glyphs={glyphs} height={bodyHeight} />
      ) : view.kind === "trust" ? (
        <TrustPanel
          read={view.read}
          glyphs={glyphs}
          height={bodyHeight}
          onAnswer={(yes) => {
            const read = view.read;
            setView({ kind: "browse" });
            if (!yes) return setMessage("not trusted");
            void services
              .trust(read.workspace.file, read.hash)
              .then(() => reload(read.workspace.file))
              .then(() => say(`trusted ${read.workspace.name} — its commands will run`))
              .catch((error: unknown) => setMessage(describe(error)));
          }}
        />
      ) : view.kind === "processes" ? (
        <PanesPanel items={paneItems} activity={events} history={recent} query={view.query ?? ""} typing={Boolean(view.typing)} runs={runs} containers={containers} active={active} tick={tick} stats={stats} dockerError={dockerError} all={view.all} index={processIndex} log={watchingActive ? (active?.output ?? []).join("\n") : log} scroll={view.scroll} full={view.full} glyphs={glyphs} height={bodyHeight} columns={columns} />
      ) : view.kind === "help" ? (
        <HelpPanel glyphs={glyphs} height={bodyHeight} />
      ) : view.kind === "search" ? (
        <SearchPanel hits={search(reads, view.query)} index={view.index} query={view.query} glyphs={glyphs} height={bodyHeight} />
      ) : reads.length === 0 ? (
        <Empty glyphs={glyphs} height={bodyHeight} unreadable={library.unreadable.length} />
      ) : (
        <Box height={bodyHeight}>
          <WorkspaceList reads={reads} index={wsIndex} here={library.here} focused={focus === "workspaces"} glyphs={glyphs} height={bodyHeight} width={Math.min(32, Math.max(18, Math.floor(columns * 0.28)))} />
          {current ? (
            <WorkspacePanel
              read={current}
              boltIndex={boltIndex}
              focused={focus === "bolts"}
              glyphs={glyphs}
              height={bodyHeight}
              runs={runs}
              containers={containers}
              history={recent.filter((entry) => entry.workspace === current.workspace.file)}
            />
          ) : null}
        </Box>
      )}

      <Footer view={view} notice={notice} message={message ?? (library?.unreadable.length ? `${library.unreadable.length} workspace file(s) could not be read — \`specter list\`` : undefined)} />
    </Box>
  );
}

function Header({ services, glyphs, columns, here, running, failing }: { services: Services; glyphs: Glyphs; columns: number; here?: string | undefined; running: number; failing: string[] }) {
  const { environment } = services;
  // Where a command will go, said up front: it is the one thing that differs by place.
  const badges: string[] = [];
  if (!environment.gui) badges.push(environment.ssh ? "over ssh — links are shown, not opened" : "no display — links are shown, not opened");
  return (
    <Box width={columns} height={1} paddingX={1} justifyContent="space-between" overflow="hidden">
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text bold color={TONE.accent}>
            {glyphs.border === "round" ? "🔮 " : ""}specter
          </Text>
          {running > 0 ? <Text color="green">{`  ${glyphs.dot} ${running} running`}</Text> : null}
          {failing.length === 1 ? <Text color="red">{`  ${glyphs.dot} ${failing[0]} — p to see why`}</Text> : failing.length > 1 ? <Text color="red">{`  ${glyphs.dot} ${failing.length} need attention — p`}</Text> : null}
          {badges.length > 0 ? <Text color="yellow">{`  ${badges.join(" · ")}`}</Text> : null}
        </Text>
      </Box>
      {here && columns >= 70 ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{here}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Footer({ view, message, notice }: { view: View; message?: string | undefined; notice?: Notice | undefined }) {
  const keys: Record<View["kind"], string> = {
    browse: "⏎ run · v view · e edit · a add · p running · h history · x stop · / search · ? keys · q quit",
    editor: "",
    "new-bolt": "",
    "new-workspace": "",
    "delete-bolt": "",
    view: "",
    "stop-bolt": "",
    setup: "⏎ set it up · esc not now",
    search: "type to search  ↑↓ choose  ⏎ run  esc back",
    run: "",
    check: "↑↓ scroll  t trust  esc back",
    trust: "←→ choose · ⏎ confirm · esc cancel",
    processes: "↑↓ choose · / search · a show stopped too · r restart · x stop · s start · f full screen · pgup/pgdn scroll · esc back",
    history: "",
    help: "any key to go back",
  };
  return (
    <Box paddingX={1}>
      {notice ? (
        <Text color={notice.tone === "bad" ? "red" : notice.tone === "good" ? "green" : "cyan"} bold={notice.tone === "bad"} wrap="truncate-end">
          {`${notice.tone === "bad" ? "! " : ""}${notice.text}`}
        </Text>
      ) : message ? (
        <Text color="cyan" wrap="truncate-end">{message}</Text>
      ) : (
        <Text dimColor wrap="truncate-end">{keys[view.kind]}</Text>
      )}
    </Box>
  );
}

/**
 * Every workspace, grouped by where it comes from — said in words rather than marks: the
 * project of the folder Specter was opened in, the other projects you have used, and the
 * workspaces of your own.
 */
function WorkspaceList(props: { reads: WorkspaceRead[]; index: number; here?: string | undefined; focused: boolean; glyphs: Glyphs; height: number; width: number }) {
  const { reads, index, here, focused, glyphs, height, width } = props;
  const group = (read: WorkspaceRead) => (read.workspace.file === here ? "This folder" : read.workspace.personal ? "Yours" : "Projects");

  // Headings and workspaces as rows, so a long list scrolls with its headings in place.
  const rows: ({ heading: string } | { read: WorkspaceRead; at: number })[] = [];
  reads.forEach((read, at) => {
    const previous = reads[at - 1];
    if (!previous || group(previous) !== group(read)) rows.push({ heading: group(read) });
    rows.push({ read, at });
  });
  const selectedRow = Math.max(0, rows.findIndex((row) => "at" in row && row.at === index));
  const { items } = windowed(rows, selectedRow, height - 3);

  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text bold dimColor={!focused}>
        <Text dimColor>1 </Text>Workspaces
      </Text>
      {items.map((row) => {
        if ("heading" in row) {
          return (
            <Text key={`h:${row.heading}`} dimColor>
              {row.heading.toUpperCase()}
            </Text>
          );
        }
        const { read, at } = row;
        const selected = at === index;
        const warn = !read.workspace.personal && read.withheld.length > 0 && !read.workspace.trusted;
        return (
          // Only the name is highlighted: inverting coloured pieces separately makes a patchwork.
          // "!" marks a file not allowed to run its commands yet — the panel beside says why.
          <Text key={read.workspace.file} wrap="truncate-end" bold={selected}>
            {selected ? glyphs.pointer : " "}{" "}
            {read.workspace.icon && glyphs.border === "round" ? `${read.workspace.icon} ` : ""}
            <Text color={selected && focused ? undefined : read.workspace.color} inverse={selected && focused}>{read.workspace.name}</Text>
            {warn ? <Text color={TONE.busy} bold>{" !"}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function WorkspacePanel(props: { read: WorkspaceRead; boltIndex: number; focused: boolean; glyphs: Glyphs; height: number; runs: RunStatus[]; containers: Container[]; history: HistoryEntry[] }) {
  const { read, boltIndex, focused, glyphs, height, runs, containers, history } = props;
  const lastRun = (label: string) => history.find((entry) => baseLabel(entry.bolt) === label);
  const { workspace } = read;
  const held = new Map(read.withheld.map((item) => [item.id, item]));
  const bolts = workspace.bolts;
  const selected = bolts[Math.min(boltIndex, Math.max(0, bolts.length - 1))];
  const errors = read.diagnostics.filter((entry) => entry.level === "error").length;

  const steps = selected ? collectBoltTargets(workspace, selected) : [];
  const waiting = selected
    ? selected.steps.flatMap((step) => {
        const id = step.kind === "asset" ? step.id : step.kind === "compose" ? `compose:${step.file}` : undefined;
        return id && held.has(id) ? [held.get(id)!] : [];
      })
    : [];

  // Lines above and between the lists, so the lists take what is left.
  // Room kept at the bottom for the workspace's recent runs, when it has any.
  const recentShown = history.slice(0, Math.max(0, Math.min(4, Math.floor((height - 14) / 2))));
  const fixed = 7 + (recentShown.length > 0 ? recentShown.length + 2 : 0);
  const listRoom = Math.max(2, height - 2 - fixed);
  const boltRoom = Math.max(1, Math.min(bolts.length, Math.ceil(listRoom / 2)));
  const stepRoom = Math.max(1, listRoom - boltRoom);
  const { items: shownBolts, offset } = windowed(bolts, boltIndex, boltRoom);
  const stepLines = [
    ...steps.map((step) => ({ key: `${step.kind}:${step.id}:${step.label}`, label: describeStep(step, false, selected?.job ?? false).replace("›", glyphs.arrow), note: step.workspace ? ` (from ${step.workspace})` : "", waiting: false })),
    ...waiting.map((item) => ({ key: `held:${item.id}`, label: item.kind === "command" ? `start ${item.label}` : `start ${item.label}`, note: "", waiting: true })),
  ];

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">
        {workspace.icon && glyphs.border === "round" ? `${workspace.icon} ` : ""}
        <Text bold color={workspace.color}>{workspace.name}</Text>
        <Text dimColor>{`  ${counts(read)}`}</Text>
      </Text>
      <Text dimColor wrap="truncate-start">{tildify(workspace.file) + (workspace.local ? "  + local" : "")}</Text>
      <Text wrap="truncate-end">
        {needsTrust(read) ? (
          <Text color="yellow">{`${read.trust === "stale" ? "Changed since you allowed it" : "Not allowed to run commands yet"} — press t to review ${read.withheld.length === 1 ? "it" : `the ${read.withheld.length}`}`}</Text>
        ) : workspace.personal ? (
          <Text dimColor>Yours — its commands run without asking</Text>
        ) : read.declaredCommands.length > 0 ? (
          <Text color="green">{`${glyphs.ok} Allowed to run its commands`}</Text>
        ) : (
          <Text dimColor>nothing here runs code</Text>
        )}
        {errors > 0 ? <Text color="red">{`  ${errors} problem${errors === 1 ? "" : "s"} — c to check`}</Text> : null}
      </Text>
      <Text> </Text>
      <Text bold dimColor={!focused}>
        <Text dimColor>2 </Text>
        {`${glyphs.bolt}Bolts`}
      </Text>
      {bolts.length === 0 ? (
        <Text dimColor>No bolts yet — press a to add the first one.</Text>
      ) : (
        shownBolts.map((entry, position) => {
          const at = offset + position;
          const isSelected = at === boltIndex;
          // Every step it has, allowed to run yet or not: the preview below lists them all.
          const count = entry.steps.length;
          const status = boltStatus(workspace, entry, runs, containers);
          const up = status.failing > 0 ? "failing" : status.running > 0 ? (status.running === status.commands ? "up" : "partial") : undefined;
          return (
            <Text key={entry.id} wrap="truncate-end" bold={isSelected}>
              {isSelected ? glyphs.pointer : " "} <Text color={isSelected && focused ? undefined : entry.color} inverse={isSelected && focused}>{entry.label}</Text>
              {entry.job ? <Text color="cyan"> job</Text> : null}
              {up ? (
                <Text color={up === "up" ? "green" : up === "failing" ? "red" : "yellow"}>
                  {` ${glyphs.dot} ${up === "up" ? "running" : up === "failing" ? "something stopped" : `${status.running} of ${status.commands} running`}`}
                </Text>
              ) : null}
              {(() => {
                const last = lastRun(entry.label);
                if (!last || up) return null;
                return last.ok ? (
                  <Text color="green" dimColor>{`  ${glyphs.ok} ${since(last.startedAt)}`}</Text>
                ) : (
                  <Text color="red">{`  ${glyphs.fail} failed ${since(last.startedAt)}`}</Text>
                );
              })()}
              <Text dimColor>{`  ${count} step${count === 1 ? "" : "s"}`}</Text>
            </Text>
          );
        })
      )}
      {selected && stepLines.length === 0 ? (
        <>
          <Text> </Text>
          <Text dimColor>  It has no steps yet — press e to add some.</Text>
        </>
      ) : selected ? (
        <>
          <Text> </Text>
          <Text dimColor>{selected.job ? "  When you run it, it will — and stop at the first failure:" : "  When you run it, it will:"}</Text>
          {windowed(stepLines, 0, stepRoom).items.map((line, at) => (
            <Text key={line.key} wrap="truncate-end">
              <Text dimColor>{`  ${String(at + 1).padStart(2)}. `}</Text>
              {line.waiting ? <Text dimColor>{line.label}</Text> : line.label}
              {line.note ? <Text dimColor>{line.note}</Text> : null}
              {line.waiting ? <Text color="yellow"> (not trusted)</Text> : null}
            </Text>
          ))}
          {stepLines.length > stepRoom ? <Text dimColor>{`  … ${stepLines.length - stepRoom} more`}</Text> : null}
        </>
      ) : null}
      {recentShown.length > 0 ? (
        <>
          <Box flexGrow={1} />
          <Text bold dimColor>Recent runs</Text>
          {recentShown.map((entry) => {
            const failedAt = entry.steps.find((step) => !step.ok && !step.skipped);
            return (
              <Text key={entry.id} wrap="truncate-end">
                {entry.ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>} {entry.bolt}
                <Text dimColor>{` #${entry.number ?? "?"} · ${failedAt ? `failed at ${failedAt.label} · ` : ""}${since(entry.startedAt)} · h for details`}</Text>
              </Text>
            );
          })}
        </>
      ) : null}
    </Box>
  );
}

/** How long ago, as briefly as it reads. */
function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function RunPanel({ view, glyphs, height, tick }: { view: RunState; glyphs: Glyphs; height: number; tick: number }) {
  const retryable = view.done && view.result ? retryPlan(view.result).length : 0;
  const hint = !view.done
    ? "x stop this run · p watch it next to what's running · esc back (it keeps going)"
    : `${retryable > 0 ? `r retry the ${retryable === 1 ? "step" : `${retryable} steps`} that didn't work · ` : ""}${view.steps.some((step) => step.result?.run && step.result.ok) ? "⏎ watch what it started · esc back" : "⏎ back"}`;
  const failed = view.steps.filter((step) => step.result && !step.result.ok && !step.result.skipped).length;
  const links = view.steps.filter((step) => step.result?.kind === "link" && step.result.note?.startsWith("no display"));
  const background = view.steps.filter((step) => step.result?.run).length;
  const output = view.output.length > 0 && view.output[view.output.length - 1] === "" ? view.output.slice(0, -1) : view.output;
  const outputRoom = output.length > 0 ? Math.max(3, Math.floor((height - 6) / 2)) : 0;
  const { items } = windowed(view.steps, Math.max(0, view.steps.findIndex((step) => step.state === "running")), height - 6 - (outputRoom ? outputRoom + 1 : 0));

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={view.done ? (failed > 0 || view.error ? "red" : "green") : TONE.accent} paddingX={1}>
      <Text bold>
        {view.dryRun ? <Text color="yellow">dry run </Text> : view.done ? null : <Text color={TONE.accent}>running </Text>}
        {view.title}
      </Text>
      <Text> </Text>
      {items.map((step, index) => {
        const result = step.result;
        const mark =
          step.state === "pending"
            ? <Text dimColor>{glyphs.pending}</Text>
            : step.state === "running"
              ? <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>
              : result?.skipped
                ? <Text dimColor>{glyphs.skip}</Text>
                : !result?.ok
                  ? <Text color="red">{glyphs.fail}</Text>
                  : <Text color="green">{glyphs.ok}</Text>;
        return (
          <Text key={`${index}:${step.target.id}`} wrap="truncate-end">
            {mark} {step.state === "running" ? <Text bold>{describeStep(step.target, true, view.job)}</Text> : describeStep(step.target, false, view.job)}
            {step.target.workspace ? <Text dimColor>{` (from ${step.target.workspace})`}</Text> : null}
            {result?.error ? <Text color="red">{`  ${result.error}`}</Text> : result?.note ? <Text dimColor>{`  ${result.note}`}</Text> : null}
          </Text>
        );
      })}
      {outputRoom > 0 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="gray" paddingLeft={1}>
          {output.slice(-outputRoom).map((line, index) => (
            <Text key={index} wrap="truncate-end" dimColor>{line || " "}</Text>
          ))}
        </Box>
      ) : null}
      {view.error ? <Text color="red">{`${glyphs.fail} ${view.error}`}</Text> : null}
      {view.done && !view.error && view.steps.length === 0 ? <Text dimColor>nothing ran — its steps wait for trust, or are for another OS</Text> : null}
      {view.done ? (
        <>
          <Text> </Text>
          {links.map((step) => (
            <Text key={`link:${step.target.id}`} color="cyan">{`  ${step.result?.value ?? step.target.value}`}</Text>
          ))}
          <Text>
            {view.stopped ? <Text color="yellow">{`Stopped — ${view.stopped}. `}</Text> : null}
            {failed > 0 ? <Text color="red">{`${failed === 1 ? "A step" : `${failed} steps`} failed — the reason is next to it`}</Text> : view.error || view.stopped ? null : <Text color="green">{view.dryRun ? "That's what it would do. Nothing was changed." : "All done."}</Text>}
            {background > 0 ? <Text>{`  ${background === 1 ? "It's" : `${background} things are`} running now — press ⏎ to watch.`}</Text> : null}
          </Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </Box>
  );
}

function CheckPanel({ view, glyphs, height }: { view: Extract<View, { kind: "check" }>; glyphs: Glyphs; height: number }) {
  if (!view.read) {
    return (
      <Box height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text dimColor>checking…</Text>
      </Box>
    );
  }
  const read = view.read;
  const rank = { error: 0, warning: 1, note: 2 } as const;
  const lines: { key: string; node: ReactNode }[] = [];
  const diagnostics = [...read.diagnostics].sort((left, right) => rank[left.level] - rank[right.level]);

  // Said outright when there is nothing to fix: silence reads as "still checking".
  if (diagnostics.every((entry) => entry.level === "note")) {
    lines.push({ key: "good", node: <Text color="green">{`${glyphs.ok} Nothing wrong with this file.`}</Text> });
  }
  for (const [index, entry] of diagnostics.entries()) {
    lines.push({ key: `d${index}`, node: <DiagnosticLine entry={entry} glyphs={glyphs} /> });
    if (entry.hint) lines.push({ key: `h${index}`, node: <Text dimColor wrap="truncate-end">{`    ${entry.hint}`}</Text> });
  }
  if (read.declaredCommands.length > 0 || read.withheld.length > 0) {
    lines.push({ key: "gap", node: <Text> </Text> });
    lines.push({ key: "runs", node: <Text bold>{`Runs code ${read.workspace.trusted ? "(allowed)" : "(waiting for trust — t)"}`}</Text> });
    for (const command of read.declaredCommands) {
      lines.push({ key: `c${command.id}`, node: <Text wrap="truncate-end"><Text dimColor>{"  run    "}</Text><Text color="cyan">{command.run}</Text>{command.cwd && command.cwd !== dirname(read.workspace.file) ? <Text dimColor>{` in ${tildify(command.cwd).replace(`${tildify(dirname(read.workspace.file))}/`, "")}`}</Text> : null}</Text> });
    }
    for (const item of read.withheld.filter((entry) => entry.kind !== "command")) {
      lines.push({ key: `w${item.id}`, node: <Text wrap="truncate-end"><Text dimColor>{`  ${KIND[item.kind].padEnd(6)} `}</Text><Text color="cyan">{tildify(item.value)}</Text><Text dimColor>{` (${item.reason})`}</Text></Text> });
    }
  }

  const room = height - 4;
  const scroll = Math.min(view.scroll, Math.max(0, lines.length - room));
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>{`Check ${read.workspace.name}`}</Text>
      <Text> </Text>
      {lines.slice(scroll, scroll + room).map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
    </Box>
  );
}

function DiagnosticLine({ entry, glyphs }: { entry: Diagnostic; glyphs: Glyphs }) {
  const mark = entry.level === "error" ? <Text color="red">{glyphs.fail}</Text> : entry.level === "warning" ? <Text color="yellow">!</Text> : <Text dimColor>{glyphs.pending}</Text>;
  return (
    <Text wrap="truncate-end">
      {mark} <Text dimColor>{entry.at}</Text> {entry.level === "note" ? <Text dimColor>{entry.message}</Text> : entry.message}
    </Text>
  );
}

function TrustPanel({ read, glyphs, height, onAnswer }: { read: WorkspaceRead; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold>{`Trust ${read.workspace.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(read.workspace.file) + (read.workspace.local ? "  + local" : "")}</Text>
      {read.trust === "stale" ? <Text color="yellow">this file has changed since you last trusted it</Text> : null}
      <Text> </Text>
      <Text>{`It would be allowed to run ${read.withheld.length} thing${read.withheld.length === 1 ? "" : "s"}:`}</Text>
      {windowed(read.withheld, 0, height - 12).items.map((item) => (
        <Text key={item.id} wrap="truncate-end">
          <Text dimColor>{`  ${KIND[item.kind].padEnd(6)} `}</Text>
          <Text color="cyan">{tildify(item.value)}</Text>
          {item.cwd ? <Text dimColor>{` in ${tildify(item.cwd)}`}</Text> : null}
          {item.reason ? <Text dimColor>{` (${item.reason})`}</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>These run on your machine, as you. Any later edit to the file asks again.</Text>
      <Text> </Text>
      <Choice yes="Trust this file" no="Cancel" danger onAnswer={onAnswer} />
    </Box>
  );
}

/**
 * What Specter is running, each in a pane of its own: the list on the left, each with its
 * last line, and the selected one's live output filling the rest — colours and all.
 */
/**
 * What is running, each in a pane of its own: Specter's commands and Docker's containers
 * together, in a list on the left with how each is doing, and the selected one's live
 * output filling the rest — colours and all.
 */
function PanesPanel(props: {
  items: PaneItem[];
  activity: Activity[];
  history: HistoryEntry[];
  query: string;
  typing: boolean;
  runs: RunStatus[];
  containers: Container[];
  active: RunState | undefined;
  tick: number;
  stats: Map<string, ContainerStats>;
  dockerError?: string | undefined;
  all: boolean;
  index: number;
  log: string;
  scroll: number;
  full: boolean;
  glyphs: Glyphs;
  height: number;
  columns: number;
}) {
  const { items, activity, history, query, typing, active, tick, stats, dockerError, all, index, log, scroll, full, glyphs, height, columns } = props;
  const listWidth = Math.min(42, Math.max(26, Math.floor(columns * 0.32)));
  // The activity log takes the bottom of the list when there is room and something to say.
  const logRoom = activity.length === 0 || height < 16 ? 0 : Math.min(activity.length + 1, 6);
  const item = items[index];
  const lines = cleanOutput(log)
    .split("\n")
    .filter((line, at, every) => line !== "" || at < every.length - 1);
  const room = Math.max(1, height - 3);
  const end = Math.max(room, lines.length - scroll);
  const shown = lines.slice(Math.max(0, end - room), end);

  // Rows for the list: section headings, then two lines per item.
  type Row = { key: string; node: ReactNode };
  const rows: Row[] = [];
  let section = "";
  items.forEach((entry, at) => {
    if (entry.type === "current" || entry.type === "group") {
      const heading = entry.type === "current" ? (active?.done ? "Just finished" : "Running now") : entry.group.workspaceName;
      if (heading !== section) {
        section = heading;
        rows.push({ key: `h:${heading}`, node: <Text bold dimColor>{heading.toUpperCase()}</Text> });
      }
    }
    const selected = at === index;
    if (entry.type === "group") {
      const tally = groupTally(items, entry.group.key);
      const color = tally.bad > 0 ? "red" : tally.up === tally.total ? "green" : tally.up > 0 ? "yellow" : "gray";
      rows.push({
        key: `group:${entry.group.key}`,
        node: (
          <Box flexGrow={1}>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate-end" inverse={selected} bold={Boolean(entry.group.bolt)} dimColor={!entry.group.bolt}>
                {`${selected ? glyphs.pointer : " "} ${entry.group.bolt ? glyphs.bolt : ""}${entry.group.title}`}
              </Text>
            </Box>
            <Text color={color}>{` ${glyphs.dot} ${tally.up === tally.total ? "all up" : `${tally.up} of ${tally.total}`}`}</Text>
          </Box>
        ),
      });
      return;
    }
    if (entry.type === "current") {
      if (!active) return;
      const now = active.steps.find((step) => step.state === "running");
      const failed = active.steps.some((step) => step.result && !step.result.ok && !step.result.skipped);
      const mark = !active.done ? (
        <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>
      ) : failed || active.error || active.stopped ? (
        <Text color="red">{glyphs.fail}</Text>
      ) : (
        <Text color="green">{glyphs.ok}</Text>
      );
      rows.push({
        key: "current",
        node: (
          <Box flexDirection="column">
            <Text wrap="truncate-end" inverse={selected} bold={selected}>
              {mark} {active.bolt}
              <Text dimColor>{` ${active.read.workspace.name}`}</Text>
            </Text>
            <Text wrap="truncate-end" dimColor>{`  ${active.stopped ? `stopped — ${active.stopped}` : now ? describeStep(now.target, true, active.job) : active.done ? (failed ? "a step failed" : "done") : "starting…"}`}</Text>
          </Box>
        ),
      });
      return;
    }
    if (entry.type === "run") {
      const run = entry.run;
      rows.push({
        key: run.id,
        node: (
          <Box flexDirection="column">
            <Text wrap="truncate-end" inverse={selected} bold={selected}>
              {"   "}<Text color={run.alive ? TONE.up : TONE.stopped}>{glyphs.dot}</Text> {run.label}
              <Text dimColor>{startedBy(run, history, entry.type === "run" ? groupBolt(items, entry.group) : undefined).replace(/^ from .* #/, " #")}</Text>
            </Text>
            <Text wrap="truncate-end" dimColor={!(selected && restartsOf(lines).gaveUp)} color={selected && restartsOf(lines).gaveUp ? "red" : undefined}>
              {`     ${run.alive ? [`up ${since(run.startedAt).replace(" ago", "").replace("just now", "<1m")}`, run.kind === "window" ? `in ${run.where ?? "a window"}` : "", selected && restartsOf(lines).count > 0 ? `restarted ${restartsOf(lines).count}×` : ""].filter(Boolean).join(" · ") : selected && restartsOf(lines).gaveUp ? "stopped — gave up restarting" : "stopped"}`}
            </Text>
          </Box>
        ),
      });
    } else {
      const container = entry.container;
      const mood = containerMood(container);
      const usage = stats.get(container.name);
      const color = mood.tone === "good" ? "green" : mood.tone === "busy" ? "yellow" : mood.tone === "bad" ? "red" : "gray";
      const details = [mood.word, container.ports.length > 0 ? container.ports.join(", ") : "", shortStatus(container.status), usage ? `${usage.cpu} ${usage.memory}` : ""].filter(Boolean);
      rows.push({
        key: container.name,
        node: (
          <Box flexDirection="column">
            <Text wrap="truncate-end" inverse={selected} bold={selected}>
              {"   "}<Text color={color}>{glyphs.dot}</Text> {container.service}
              <Text dimColor>{" container"}</Text>
            </Text>
            <Text wrap="truncate-end" color={mood.tone === "bad" ? "red" : undefined} dimColor={mood.tone !== "bad"}>{`     ${details.join(" · ")}`}</Text>
          </Box>
        ),
      });
    }
  });

  const header =
    item?.type === "current" && active ? (
      <Text wrap="truncate-end">
        <Text bold>{active.bolt}</Text>
        <Text dimColor>{`  ${active.outputOf ? `output of ${active.outputOf}  ` : ""}`}</Text>
        {!active.done ? <Text color={TONE.accent}>running — x stops it</Text> : active.stopped ? <Text color="red">stopped</Text> : <Text dimColor>finished — ⏎ for its steps</Text>}
      </Text>
    ) : item?.type === "group" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.group.title}</Text>
        <Text dimColor>{`  ${item.group.workspaceName}`}</Text>
      </Text>
    ) : item?.type === "container" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.container.service}</Text>
        <Text dimColor>{`  ${item.container.image}  `}</Text>
        <Text color={containerMood(item.container).tone === "good" ? "green" : containerMood(item.container).tone === "bad" ? "red" : "yellow"}>{`${glyphs.dot} ${containerMood(item.container).word}`}</Text>
        {item.container.ports.length > 0 ? <Text dimColor>{`  on ${item.container.ports.map((port) => `localhost:${port.split("→")[0]}`).join(", ")}`}</Text> : null}
      </Text>
    ) : item?.type === "run" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.run.label}</Text>
        <Text dimColor>{`${startedBy(item.run, history, undefined, true)}  ${item.run.command}  `}</Text>
        {item.run.alive ? <Text color="green">{`${glyphs.dot} running`}</Text> : <Text color={TONE.stopped}>{`${glyphs.dot} stopped`}</Text>}
        {restartsOf(lines).count > 0 ? <Text color="yellow">{`  restarted ${restartsOf(lines).count}×`}</Text> : null}
      </Text>
    ) : (
      <Text bold>Output</Text>
    );

  return (
    <Box height={height}>
      {full ? null : (
        <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
          <Text bold>
            <Text dimColor>3 </Text>
            {all ? "Running and stopped" : "Running"}
          </Text>
          {typing || query ? <SearchLine query={query} typing={typing} /> : null}
          {items.length === 0 ? <Text dimColor>{query ? `Nothing matches “${query}”. esc clears it.` : all ? "Nothing has run yet." : "Nothing is running. Run a bolt with ⏎, or a shows stopped ones."}</Text> : null}
          {dockerError ? <Text color="yellow" wrap="wrap">{`Docker: ${dockerError}`}</Text> : null}
          {windowed(rows, Math.max(0, rows.findIndex((row) => row.key === (item ? paneKey(item) : ""))), height - (typing || query ? 4 : 3) - logRoom).items.map((row) => (
            <Box key={row.key}>{row.node}</Box>
          ))}
          <Box flexGrow={1} />
          {logRoom > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>ACTIVITY</Text>
              {activity.slice(0, logRoom - 1).map((entry) => (
                <Text key={`${entry.at}:${entry.text}`} wrap="truncate-end">
                  <Text dimColor>{`${clock(entry.at)} `}</Text>
                  <Text color={entry.tone === "bad" ? TONE.failed : entry.tone === "good" ? TONE.up : undefined} dimColor={entry.tone === "info"}>{entry.text}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        borderStyle={glyphs.border}
        borderColor={
          item?.type === "current"
            ? active && !active.done ? TONE.accent : "gray"
            : item?.type === "group"
              ? groupTally(items, item.group.key).bad > 0 ? "red" : TONE.accent
              : item && (item.type === "run" ? item.run.alive : containerMood(item.container).tone === "good") ? "green" : "gray"
        }
        paddingX={1}
      >
        <Text wrap="truncate-end">
          {header}
          {scroll > 0 ? <Text color="yellow">{`  ↑ ${scroll} lines back — G to follow`}</Text> : null}
        </Text>
        {item?.type === "run" && !item.run.log ? <Text dimColor>{`It runs in ${item.run.where ?? "a terminal window"} — its output is there.`}</Text> : null}
        {item?.type === "group" ? (
          <GroupSummary items={items} group={item.group} history={history} stats={stats} glyphs={glyphs} />
        ) : (
          shown.map((line, at) => (
            <Text key={at} wrap="truncate-end">{line || " "}</Text>
          ))
        )}
      </Box>
    </Box>
  );
}

/**
 * The Running list, structured: the run in progress first, then each workspace's bolts
 * with what they started under them.
 */
function groupPanes(head: PaneItem[], runs: RunStatus[], containers: Container[], reads: WorkspaceRead[]): PaneItem[] {
  const groups = new Map<string, { group: PaneGroup; members: PaneItem[] }>();
  const add = (group: PaneGroup, member: PaneItem) => {
    const found = groups.get(group.key) ?? { group, members: [] };
    found.members.push(member);
    groups.set(group.key, found);
  };
  const nameOf = (file: string, fallback: string) => reads.find((read) => read.workspace.file === file)?.workspace.name ?? fallback;

  for (const run of runs) {
    const bolt = run.bolt;
    const key = `${run.workspace}#${bolt ?? ""}`;
    add({ key, workspace: run.workspace, workspaceName: nameOf(run.workspace, run.workspaceName), ...(bolt ? { bolt } : {}), title: bolt ?? "Not from a bolt" }, { type: "run", run, group: key });
  }
  for (const container of containers) {
    // The bolt whose compose step starts this file is the container's owner.
    let owner: { read: WorkspaceRead; bolt: string } | undefined;
    for (const read of reads) {
      for (const bolt of read.workspace.bolts) {
        if (bolt.steps.some((step) => step.kind === "compose" && step.file === container.file)) owner = owner ?? { read, bolt: bolt.label };
      }
    }
    const key = owner ? `${owner.read.workspace.file}#${owner.bolt}` : `compose#${container.project}`;
    add(
      owner
        ? { key, workspace: owner.read.workspace.file, workspaceName: owner.read.workspace.name, bolt: owner.bolt, title: owner.bolt }
        : { key, workspaceName: container.project, title: `${container.project} (docker compose)` },
      { type: "container", container, group: key },
    );
  }

  // Within a workspace, its bolts by name, and what no bolt started last.
  const ordered = [...groups.values()].sort(
    (left, right) =>
      left.group.workspaceName.localeCompare(right.group.workspaceName) ||
      Number(!left.group.bolt) - Number(!right.group.bolt) ||
      left.group.title.localeCompare(right.group.title),
  );
  return [...head, ...ordered.flatMap(({ group, members }) => [{ type: "group" as const, group }, ...members])];
}

/**
 * The Running list narrowed to a search. A bolt that matches keeps all of its tasks; a task
 * that matches keeps its bolt, so you still see where it belongs.
 */
function filterPanes(items: PaneItem[], query: string): PaneItem[] {
  if (!query.trim()) return items;
  const textOf = (item: PaneItem): string[] =>
    item.type === "group"
      ? [item.group.title, item.group.workspaceName]
      : item.type === "run"
        ? [item.run.label, item.run.command, item.run.workspaceName, item.run.alive ? "running" : "stopped"]
        : item.type === "container"
          ? [item.container.service, item.container.name, item.container.image, item.container.project, containerMood(item.container).word, "container"]
          : [];
  const groups = items.filter((item): item is PaneItem & { type: "group" } => item.type === "group");
  const keep = new Set<PaneItem>();
  for (const group of groups) {
    const members = groupMembers(items, group.group.key);
    if (matchesAll(query, ...textOf(group))) {
      keep.add(group);
      for (const member of members) keep.add(member);
      continue;
    }
    const hits = members.filter((member) => matchesAll(query, ...textOf(member), group.group.title, group.group.workspaceName));
    if (hits.length > 0) {
      keep.add(group);
      for (const hit of hits) keep.add(hit);
    }
  }
  return items.filter((item) => keep.has(item));
}

/** The bolt a group in the Running list stands for. */
function groupBolt(items: PaneItem[], key: string): string | undefined {
  const found = items.find((item): item is PaneItem & { type: "group" } => item.type === "group" && item.group.key === key);
  return found?.group.bolt;
}

/**
 * Which run started a task, as History numbers it: " #4" under its own bolt, or
 * " from Work on web #2" when another bolt's run brought it up as a dependency. `long`
 * always names the bolt. Nothing while that run is still going and not in History yet.
 */
function startedBy(run: RunStatus, history: HistoryEntry[], bolt: string | undefined, long = false): string {
  const entry = run.historyId ? history.find((candidate) => candidate.id === run.historyId) : undefined;
  if (!entry?.number) return "";
  const name = entry.bolt.replace(/ \((retry|down)\)$/, "");
  return !long && name === bolt ? ` #${entry.number}` : ` from ${name} #${entry.number}`;
}

/** The tasks under a bolt in the Running list. */
function groupMembers(items: PaneItem[], key: string): (PaneItem & { type: "run" | "container" })[] {
  return items.filter((item): item is PaneItem & { type: "run" | "container" } => (item.type === "run" || item.type === "container") && item.group === key);
}

/** How many of a bolt's tasks are up, and how many are in trouble. */
function groupTally(items: PaneItem[], key: string): { up: number; bad: number; total: number } {
  const members = groupMembers(items, key);
  const up = members.filter((item) => (item.type === "run" ? item.run.alive : item.container.state === "running")).length;
  const bad = members.filter((item) => (item.type === "run" ? false : containerMood(item.container).tone === "bad")).length;
  return { up, bad, total: members.length };
}

/** A bolt selected in the Running list: what it started, at a glance, and what keys do. */
function GroupSummary({ items, group, history, stats, glyphs }: { items: PaneItem[]; group: PaneGroup; history: HistoryEntry[]; stats: Map<string, ContainerStats>; glyphs: Glyphs }) {
  const members = groupMembers(items, group.key);
  return (
    <Box flexDirection="column" marginTop={1}>
      {members.map((member) => {
        if (member.type === "run") {
          const run = member.run;
          return (
            <Text key={run.id} wrap="truncate-end">
              <Text color={run.alive ? TONE.up : TONE.stopped}>{glyphs.dot}</Text> <Text bold>{run.label.padEnd(16)}</Text>
              <Text dimColor>{`${(run.alive ? `up ${since(run.startedAt).replace(" ago", "").replace("just now", "<1m")}` : "stopped").padEnd(10)}  ${(startedBy(run, history, group.bolt, true).trim() || "").padEnd(18)}  ${run.command}`}</Text>
            </Text>
          );
        }
        const container = member.container;
        const mood = containerMood(container);
        const usage = stats.get(container.name);
        return (
          <Text key={container.name} wrap="truncate-end">
            <Text color={mood.tone === "good" ? "green" : mood.tone === "bad" ? "red" : "yellow"}>{glyphs.dot}</Text> <Text bold>{container.service.padEnd(16)}</Text>
            <Text dimColor>{`${mood.word.padEnd(10)}  ${[container.ports.join(", "), usage ? `${usage.cpu} ${usage.memory}` : ""].filter(Boolean).join(" · ")}`}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>
        {group.bolt ? "x stops all of it · r restarts it · ⏎ or ↓ to a task for its output" : "Not started by a bolt — choose one to stop it or see its output."}
      </Text>
    </Box>
  );
}

/** How a pane is found again after the list changes under it. */
function paneKey(item: PaneItem): string {
  if (item.type === "current") return "current";
  if (item.type === "group") return `group:${item.group.key}`;
  return item.type === "run" ? item.run.id : `container:${item.container.name}`;
}

/** How often a command has been brought back, read from the marks its restart loop logs. */
function restartsOf(lines: string[]): { count: number; gaveUp: boolean } {
  let count = 0;
  let gaveUp = false;
  for (const line of lines) {
    if (line.includes(RESTART_MARK)) count += 1;
    if (line.includes("[specter]") && line.includes("gave up after")) gaveUp = true;
  }
  return { count, gaveUp };
}

function restartNote(lines: string[]): string | undefined {
  const { count } = restartsOf(lines);
  return count > 0 ? `restarted ${count}× — ${lastLine(lines) ?? ""}` : undefined;
}

function lastLine(lines: string[]): string | undefined {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]?.replace(/\u001B\[[0-9;]*m/g, "").trim();
    if (line) return line;
  }
  return undefined;
}

function SearchPanel({ hits, index, query, glyphs, height }: { hits: SearchHit[]; index: number; query: string; glyphs: Glyphs; height: number }) {
  const { items, offset } = windowed(hits, index, height - 4);
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1}>
      <Text>
        <Text color={TONE.accent}>/ </Text>
        {query}
        <Text inverse> </Text>
      </Text>
      <Text> </Text>
      {hits.length === 0 ? <Text dimColor>no matches</Text> : null}
      {items.map((hit, position) => {
        const selected = offset + position === index;
        return (
          <Text key={`${hit.workspace}:${hit.bolt ?? ""}`} wrap="truncate-end" inverse={selected}>
            {selected ? glyphs.pointer : " "} {hit.label}
            {hit.bolt ? null : <Text dimColor> workspace</Text>}
          </Text>
        );
      })}
    </Box>
  );
}

/** "I looked at this folder, and here's what I'd set up" — the first thing a new project sees. */
function SetupPanel({ suggestion, glyphs, height, onAnswer }: { suggestion: SetupSuggestion; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
      <Text bold>{`Set up ${suggestion.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(suggestion.dir)}</Text>
      <Text> </Text>
      <Text>I looked at this folder and found:</Text>
      {suggestion.found.map((line) => (
        <Text key={line} wrap="truncate-end">{`  ${glyphs.dot} ${line}`}</Text>
      ))}
      <Text> </Text>
      <Text>So you could run:</Text>
      {suggestion.bolts.map((bolt) => (
        <Box key={bolt.label} flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color={TONE.accent}>{`  ${glyphs.pointer} ${bolt.label}`}</Text>
            {bolt.job ? <Text color="cyan"> — a job: stops at the first failure</Text> : null}
          </Text>
          <Text wrap="truncate-end" dimColor>{`      ${bolt.steps.join(", then ")}`}</Text>
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>It's saved as .specter.json in this folder — you can change all of it afterwards with e.</Text>
      <Choice yes="Set it up" no="Not now" onAnswer={onAnswer} />
    </Box>
  );
}

function HelpPanel({ glyphs, height }: { glyphs: Glyphs; height: number }) {
  // Grouped by what you are doing, so the key you need is where you would look for it.
  const sections: [string, [string, string][]][] = [
    [
      "Run",
      [
        ["⏎", "run the selected bolt"],
        ["n", "dry run — see what it would do, change nothing"],
        ["v", "view the bolt whole — its order, what it needs, what's up"],
        ["x  R", "stop what it started · restart it"],
      ],
    ],
    [
      "Look",
      [
        ["p", "what's running — commands and containers, live"],
        ["h", "history — every run, like a CI"],
        ["/", "search every workspace and bolt"],
        ["c", "check the file for problems"],
      ],
    ],
    [
      "Edit",
      [
        ["e", "edit the selected bolt — its steps, name, kind"],
        ["a  D", "add a bolt · delete the selected one"],
        ["K  J", "move the selected bolt up · down"],
        ["N", "a new workspace of your own"],
        ["E", "open the file itself in your text editor"],
      ],
    ],
    [
      "Move",
      [
        ["↑↓  j k", "move"],
        ["1 2 3 4", "workspaces · bolts · running · history"],
        ["←→  tab", "between workspaces and bolts"],
        ["t", "review and allow what a file would run"],
        ["r  q", "reload · quit"],
      ],
    ],
  ];
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>Keys</Text>
      <Box flexWrap="wrap">
        {sections.map(([title, keys]) => (
          <Box key={title} flexDirection="column" width="50%" marginTop={1} paddingRight={2}>
            <Text color={TONE.accent} bold>{title.toUpperCase()}</Text>
            {keys.map(([combo, meaning]) => (
              <Text key={combo} wrap="truncate-end">
                <Text bold>{combo.padEnd(9)}</Text>
                <Text>{meaning}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>`specter --help` for the command line, `specter spec` for the file format · any key to go back</Text>
    </Box>
  );
}

function Empty({ glyphs, height, unreadable }: { glyphs: Glyphs; height: number; unreadable: number }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>No workspaces yet</Text>
      <Text> </Text>
      <Text>In a project, quit and run <Text color="cyan">specter init</Text> to give it a .specter.json.</Text>
      <Text>Already have some? <Text color="cyan">specter scan ~/dev</Text> finds them.</Text>
      {unreadable > 0 ? <Text color="red">{`${unreadable} workspace file(s) could not be read — specter list`}</Text> : null}
    </Box>
  );
}

/** State whose latest value is readable straight away, through the returned ref. */
function useLatest<T>(initial: T): [T, (next: T | ((prior: T) => T)) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T | ((prior: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (prior: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref];
}

function useTerminalSize(fixed?: { columns: number; rows: number }): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => fixed ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (fixed) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, fixed]);
  return size;
}

function stepLabel(target: SwitchTarget): string {
  if (target.kind === "wait" && target.wait) return describeWait(target.wait);
  if ((target.kind === "folder" || target.kind === "file") && target.label === target.value) return tildify(target.value);
  return target.label;
}

function counts(read: WorkspaceRead): string {
  const { workspace } = read;
  const bolts = workspace.bolts.length;
  return `${bolts} bolt${bolts === 1 ? "" : "s"}`;
}

function needsTrust(read: WorkspaceRead): boolean {
  return !read.workspace.personal && !read.workspace.trusted && read.withheld.length > 0;
}

function visibleRuns(runs: RunStatus[], all: boolean): RunStatus[] {
  const list = all ? runs : runs.filter((run) => run.alive);
  return [...list].sort((left, right) => Number(right.alive) - Number(left.alive));
}

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

/**
 * Update the first step matching a target that is still waiting for this event: the plan
 * may list the same kind of step twice (two waits), so position matters, not just id.
 */
function markFirst(steps: StepState[], target: SwitchTarget, change: (step: StepState) => StepState, finishing = false): StepState[] {
  const index = steps.findIndex(
    (step) =>
      step.target.id === target.id &&
      step.target.kind === target.kind &&
      step.target.workspace === target.workspace &&
      (finishing ? step.state !== "done" : step.state === "pending"),
  );
  if (index === -1) return steps;
  return steps.map((step, at) => (at === index ? change(step) : step));
}

/** A time of day, 24-hour: when something in the activity log happened. */
function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

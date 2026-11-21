import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type Container, containerMood, type ContainerStats } from "../core/docker.js";
import { describe } from "../core/errors.js";
import type { HistoryEntry } from "../core/history.js";
import { checkValue } from "../core/inputs.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { composeFiles, retryPlan } from "../core/switch.js";
import type { Bolt, Diagnostic, SwitchResult, WorkspaceRead } from "../core/types.js";
import { flow } from "./steps.js";
import { Footer, Header, headerTabAt, runningStatus } from "./chrome.js";
import { SetupPanel, TrustPanel } from "./dialogs.js";
import { BoltEditor } from "./editor.js";
import { Choice, Form } from "./forms.js";
import { type Glyphs, glyphs as defaultGlyphs } from "./glyphs.js";
import { HistoryScreen } from "./history.js";
import { boltWindow, Empty, FIRST_BOLT_LINE, SearchPanel, WorkspaceList, workspaceListWidth, WorkspacePanel, workspaceRows } from "./home.js";
import { type Library, ordered, search, type Services } from "./model.js";
import { HelpPanel, RunProgress } from "./panels.js";
import { SettingsScreen } from "./settings.js";
import { type MouseListener, MouseContext, type MouseSource } from "./mouse.js";
import { filterPanes, groupPanes, logWindow, nextTab, nextWithLog, paneKey, PanesPanel, paneSpotAt, shownTab } from "./running.js";
import { type Activity, clamp, type Focus, markFirst, needsTrust, type Notice, type PaneItem, type RunState, SELF_DRIVEN, useLatest, useTerminalSize, type View, visibleRuns, waitingForTrust } from "./state.js";
import { spell } from "./spells.js";
import { TONE } from "./tones.js";

export interface AppProps {
  services: Services;
  glyphs?: Glyphs;
  /** Fixed size, for tests; otherwise the terminal's, kept up to date on resize. */
  size?: { columns: number; rows: number };
  /** Clicks and the wheel. Without it (in tests, or piped), the dashboard is keys only. */
  mouse?: MouseSource;
}

/** Screens the tabs along the top can be clicked from: not one with a form half filled in. */
const TABS_CLICKABLE = new Set<View["kind"]>(["browse", "processes", "history", "help", "search"]);

export function App({ services, glyphs = defaultGlyphs(), size, mouse }: AppProps) {
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
  const [detailScroll, setDetailScroll] = useState(0);
  const detailLimit = useRef(0);
  const [runPinned, setRunPinned] = useState(false);
  useEffect(() => {
    setDetailScroll(0);
    if (activeRef.current?.done) setRunPinned(false);
  }, [wsIndex, boltIndex, activeRef]);
  const abort = useRef<AbortController | undefined>(undefined);
  const [containers, setContainers] = useState<Container[]>([]);
  const [dockerError, setDockerError] = useState<string>();
  const [stats, setStats] = useState<Map<string, ContainerStats>>(new Map());
  const [notice, setNotice] = useState<Notice>();
  // Past runs, for the last result beside each bolt and the recent runs under them.
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [screenHint, setScreenHint] = useState<string>();
  // Whether the finished run is the one being looked at in Running, so it does not vanish mid-read.
  const watchingDone = useRef(false);
  // What was true at the last look, to tell what has changed since.
  const seenRuns = useRef<Map<string, boolean> | undefined>(undefined);
  const seenContainers = useRef<Map<string, string> | undefined>(undefined);
  // Stops asked for here are not news, and neither are files saved here.
  const expected = useRef<Set<string>>(new Set());
  const savedAt = useRef(0);

  /** Say what changed, in a line that stays a few seconds. */
  // What Wisp did and what happened, newest first — like lazygit's command log: notices
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

  // The mouse is on unless turned off in Settings. The terminal is asked for it only once
  // the setting is read, and told to stop when the dashboard closes.
  const [mouseOn, setMouseOn] = useState(false);
  useEffect(() => {
    void services.settings
      .mouse()
      .then(setMouseOn)
      .catch(() => setMouseOn(true));
  }, [services]);
  useEffect(() => {
    mouse?.enable(mouseOn);
  }, [mouse, mouseOn]);
  useEffect(() => () => mouse?.enable(false), [mouse]);

  // Runs started from here: when they start and how they end.
  const loggedRun = useRef<RunState | undefined>(undefined);
  useEffect(() => {
    if (!active || active.dryRun) return;
    if (loggedRun.current?.title !== active.title || loggedRun.current?.read !== active.read) {
      if (!active.done) record(`ran ${active.bolt}`, "info");
    }
    if (active.done && !(loggedRun.current === active || (loggedRun.current?.done && loggedRun.current.title === active.title && loggedRun.current.read === active.read))) {
      const failed = active.steps.find((step) => step.result && !step.result.ok && !step.result.skipped);
      const up = active.steps.some((step) => (step.target.kind === "command" && !step.target.finishes) || step.target.kind === "compose");
      record(active.stopped ? `${active.bolt} stopped — ${active.stopped}` : failed || active.error ? `${active.bolt} failed${failed ? ` at ${failed.target.label}` : ""}` : `${active.bolt} ${up ? "is up" : "finished"}`, active.stopped || failed || active.error ? "bad" : "good");
    }
    loggedRun.current = active;
  }, [active, record]);

  const reads = useMemo(() => (library ? ordered(library) : []), [library]);
  const workspaceNames = useMemo(() => new Map(reads.map((read) => [read.workspace.file, read.workspace.name])), [reads]);
  const current = reads[Math.min(wsIndex, Math.max(0, reads.length - 1))];
  const bolts = current?.workspace.bolts ?? [];
  const bolt = bolts[Math.min(boltIndex, Math.max(0, bolts.length - 1))];
  const [checked, setChecked] = useState<{ read: WorkspaceRead; diagnostics: Diagnostic[] }>();
  const formOpen = useRef(false);
  const setFormOpen = useCallback((busy: boolean) => {
    formOpen.current = busy;
  }, []);
  useEffect(() => {
    if (!current) return;
    let live = true;
    services
      .check(current.workspace.file)
      .then((result) => {
        if (live && result.workspace.file === current.workspace.file) setChecked({ read: current, diagnostics: result.diagnostics });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [current, services]);
  const inBox = active && current && bolt && active.read.workspace.file === current.workspace.file && active.bolt === bolt.label && (!active.done || runPinned) ? active : undefined;

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
  // same answer bare `wisp` gives on the command line, one keypress from running.
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
          groupPanes(active && (!active.done || watchingDone.current) ? [{ type: "current" }] : [], visibleRuns(runs, view.all), containers.filter((container) => view.all || container.state === "running" || container.state === "restarting" || container.exitCode !== 0), reads, recent),
          view.query ?? "",
          active?.bolt,
        )
      : [];
  const processIndex =
    view.kind === "processes"
      ? (() => {
          const focused = view.focus ? paneItems.findIndex((item) => paneKey(item) === view.focus) : -1;
          if (focused >= 0) return focused;
          // Opening the screen lands on the first task, whose output is what you came for.
          if (view.index < 0) {
            const live = paneItems.findIndex((item) => item.type === "current" || item.type === "run" || item.type === "container");
            return Math.max(0, live >= 0 ? live : paneItems.findIndex((item) => item.type !== "group"));
          }
          return Math.max(0, Math.min(view.index, paneItems.length - 1));
        })()
      : 0;
  const selectedItem = view.kind === "processes" ? paneItems[processIndex] : undefined;
  const selectedRun = selectedItem?.type === "run" ? selectedItem.run : undefined;
  const watchingActive = selectedItem?.type === "current";
  // The log the panel beside the list shows: the run in progress's output, or the selected one's.
  const shownLog = watchingActive ? (active?.output ?? []).join("\n") : log;
  watchingDone.current = view.kind === "processes" && watchingActive;
  const selectedContainer = selectedItem?.type === "container" ? selectedItem.container : undefined;
  // Filtering a log reads more of it: the filter should find what scrolled out of the last screens.
  const filteringLog = view.kind === "processes" && Boolean(view.logQuery);
  // A finished step of the pipeline: what it printed in that run, as History keeps it.
  const selectedStepLog = selectedItem?.type === "step" ? selectedItem.step.log : undefined;
  const selectedStepLive = selectedItem?.type === "step" && selectedItem.step.state === "running";
  useEffect(() => {
    if (selectedItem?.type !== "step") return;
    let alive = true;
    const read = () => {
      if (!selectedStepLog) return setLog("");
      void services
        .readLog(selectedStepLog)
        .then((text) => alive && setLog(text))
        .catch(() => alive && setLog(""));
    };
    read();
    const timer = selectedStepLive ? setInterval(read, 1000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [selectedItem?.type, selectedStepLog, selectedStepLive, services]);
  useEffect(() => {
    if (!selectedContainer) return;
    let alive = true;
    const refresh = async () => {
      const text = await services.containerLogs(selectedContainer.name, filteringLog ? 5000 : 1000);
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedContainer?.name, services, filteringLog]);
  const askedAbout = useRef(new Set<string>());
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
            // Finished by itself is news, not trouble; only a failure or a crash is red.
            if (run.exitCode === 0) notify(`${run.label} finished (${run.workspaceName})`, "info");
            else if (run.exitCode !== undefined) notify(`${run.label} failed, exit code ${run.exitCode} (${run.workspaceName}) — press p to see why`, "bad");
            else notify(`${run.label} stopped (${run.workspaceName}) — press p to see its last output`, "bad");
          } else if (was === undefined && run.alive && !expected.current.has(run.id)) {
            notify(`${run.label} started (${run.workspaceName})`, "good");
          }
          // Once per question: a command that went quiet asking something can't be answered
          // in the background, so say so, and how to fix the bolt.
          if (run.alive && run.waiting && !askedAbout.current.has(run.id)) {
            askedAbout.current.add(run.id);
            notify(`${run.label} is waiting for an answer: "${run.waiting}". Give it a flag like --yes, or run commands in a terminal window (s)`, "bad");
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
      if (!selectedContainer && selectedItem?.type !== "step") setLog("");
      return;
    }
    let alive = true;
    const refresh = async () => {
      // Raw lines, not lines shown: a screen-clearing server (Vite) pads each message with a
      // screenful of blank ones, which cleaning drops. The bytes keep it cheap.
      const text = await (filteringLog ? services.tail(selectedRun.log, 20_000, 4 * 1024 * 1024) : services.tail(selectedRun.log, 5000));
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedRun?.id, selectedRun?.log, services, filteringLog]);

  /**
   * Run steps — a whole bolt, or a retry of part of one — showing each as it goes. The
   * progress is kept in `active`, whichever screen is showing.
   */
  const selectBolt = useCallback(
    (read: WorkspaceRead, label: string) => {
      const workspaceAt = reads.findIndex((candidate) => candidate.workspace.file === read.workspace.file);
      if (workspaceAt >= 0) setWsIndex(workspaceAt);
      const boltAt = read.workspace.bolts.findIndex((entry) => entry.label === label);
      if (boltAt >= 0) setBoltIndex(boltAt);
      setFocus("bolts");
    },
    [reads, setWsIndex, setBoltIndex, setFocus],
  );

  const begin = useCallback(
    async (
      read: WorkspaceRead,
      label: string,
      dryRun: boolean,
      start: (callbacks: Parameters<Services["run"]>[2]) => Promise<SwitchResult>,
      title: string,
      inputs: Record<string, string> = {},
    ) => {
      // One run at a time on this screen. Say so, rather than let ⏎ do nothing.
      if (busy.current) {
        const going = activeRef.current;
        setMessage(`${going ? `"${going.bolt}"` : "A run"} is still starting. Run another once it's done`);
        return;
      }
      busy.current = true;
      const controller = new AbortController();
      abort.current = controller;
      setActive({ title, read, bolt: label, dryRun, steps: [], done: false, output: [], started: [] });
      selectBolt(read, label);
      setRunPinned(true);
      setView({ kind: "browse" });
      const update = (change: (state: RunState) => RunState) => setActive((prior) => (prior ? change(prior) : prior));

      try {
        const result = await start({
          dryRun,
          signal: controller.signal,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          onPlan: (targets) => update((state) => ({ ...state, steps: targets.map((target) => ({ target, state: "pending" })) })),
          onStep: (target, info) => {
            update((state) => ({ ...state, steps: markFirst(state.steps, target, (step) => ({ ...step, state: "running" })) }));
            // An attached command's output takes the pane; a window's stays in the window.
            if (info.attached) update((state) => ({ ...state, output: state.steps.some((step) => step.state === "running" && step.target.id !== target.id) ? state.output : [], outputOf: target.label }));
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
    [setActive, setView, selectBolt],
  );

  const pendingRun = useRef<(() => void) | undefined>(undefined);
  const pendingInputs = useRef<((values: Record<string, string>) => void) | undefined>(undefined);
  const launch = useCallback(
    async (
      read: WorkspaceRead,
      label: string,
      dryRun: boolean,
      start: (callbacks: Parameters<Services["run"]>[2]) => Promise<SwitchResult>,
      title: string,
      recorded?: Record<string, string>,
    ) => {
      const showBolt = () => selectBolt(read, label);
      const confirmThen = (values: Record<string, string>, questions: string[]) => {
        if (questions.length === 0) return begin(read, label, dryRun, start, title, values);
        pendingRun.current = () => void begin(read, label, dryRun, start, title, values);
        showBolt();
        setView({ kind: "confirm-run", file: read.workspace.file, bolt: label, question: questions.join(" ") });
      };
      const questionsWith = (values: Record<string, string>) => (dryRun ? Promise.resolve([]) : services.questions(read, label, values).catch(() => []));
      const [specs, questions] = await Promise.all([recorded ? Promise.resolve([]) : services.inputs(read, label).catch(() => []), questionsWith(recorded ?? {})]);
      if (specs.length === 0) return confirmThen(recorded ?? {}, questions);
      const ask = async (values: Record<string, string>) => confirmThen(values, await questionsWith(values));
      if (dryRun) return ask(Object.fromEntries(specs.flatMap((spec) => (spec.default ? [[spec.name, spec.default]] : []))));
      pendingInputs.current = (values) => void ask(values);
      showBolt();
      setView({ kind: "run-inputs", file: read.workspace.file, workspace: read.workspace.name, bolt: label, specs });
    },
    [services, begin, selectBolt, setView],
  );

  const runBolt = useCallback(
    async (read: WorkspaceRead, label: string, dryRun: boolean) => {
      // Not half a run: a bolt with steps waiting for trust asks first. A dry run still goes
      // ahead, since showing what would be skipped is its point.
      if (!dryRun && waitingForTrust(read, label).length > 0) return setView({ kind: "trust", read, then: label });
      await launch(read, label, dryRun, (callbacks) => services.run(read, label, callbacks), `${read.workspace.name} ${glyphs.arrow} ${label}`);
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
      false,
      (callbacks) => services.retry(last.read, steps, last.bolt, callbacks),
      `${last.read.workspace.name} ${glyphs.arrow} ${last.bolt} — retrying ${steps.length === 1 ? "1 step" : `${steps.length} steps`}`,
      last.result.inputs ?? {},
    );
  }, [services, glyphs.arrow, launch]);

  /** Stop the run in progress: nothing more starts, and what it has running attached stops. */
  const stopActive = useCallback((why: string) => {
    if (!abort.current) return;
    abort.current.abort();
    setActive((prior) => (prior ? { ...prior, stopped: why } : prior));
  }, [setActive]);

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
    const needs = flow(read, target).filter((name) => name !== target.label);
    if (needs.length === 0) return stopBolt(read, target, false);
    // Other bolts with something up that need the same ones: stopping those would break them.
    const sharedWith = reads.flatMap((other) =>
      other.workspace.bolts
        .filter((candidate) => candidate.label !== target.label && runs.some((run) => run.alive && run.workspace === other.workspace.file && run.bolt === candidate.label))
        .filter((candidate) => flow(other, candidate).some((name) => needs.includes(name) && name !== candidate.label))
        .map((candidate) => candidate.label),
    );
    setView({ kind: "stop-bolt", file: read.workspace.file, bolt: target.label, needs, sharedWith });
  };

  /** 1–4 go straight to a panel, as lazygit's numbers do: workspaces, bolts, running, history. */
  const jump = (input: string): boolean => {
    if (input === "1") return setView({ kind: "browse" }), true;
    if (input === "2") return setView(activity()), true;
    if (input === "3") return setView(history_()), true;
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

    if (view.kind === "help") return setView(view.back ?? { kind: "browse" });

    if (input === "q" && view.kind === "browse") {
      // Nothing left running attached and unseen.
      stopActive("Wisp was closed");
      return exit();
    }

    if (view.kind === "processes") {
      // Typing the log filter: letters go into it; ⏎ or ↓ keeps it.
      if (view.logTyping) {
        if (key.escape) return setView({ ...view, logQuery: "", logTyping: false, scroll: 0 });
        if (key.return || key.downArrow || key.tab) return setView({ ...view, logTyping: false });
        if (key.backspace || key.delete) return setView({ ...view, logQuery: (view.logQuery ?? "").slice(0, -1), scroll: 0 });
        if (input && !key.ctrl && !key.meta) return setView({ ...view, logQuery: `${view.logQuery ?? ""}${input}`, scroll: 0 });
        return;
      }
      // Two screens, one key each: p for what's running, h for what ran.
      // Typing a search: letters go into it; ⏎ or ↓ keeps it and goes back to the list.
      if (view.typing) {
        if (key.escape) return setView({ ...view, query: "", typing: false, index: -1 });
        if (key.return || key.downArrow || key.tab) return setView({ ...view, typing: false });
        if (key.backspace || key.delete) return setView({ ...view, query: (view.query ?? "").slice(0, -1), index: -1 });
        if (input && !key.ctrl && !key.meta) return setView({ ...view, query: `${view.query ?? ""}${input}`, index: -1 });
        return;
      }
      // Fast typing arrives as one chunk: "/md" is "/" and the start of the search. With the
      // log full screen, / filters the log; beside the list, it filters the list.
      if (input.startsWith("/")) {
        if (view.full) return setView({ ...view, logTyping: true, logQuery: `${view.logQuery ?? ""}${input.slice(1)}`, scroll: 0 });
        const { focus: _drop, ...plain } = view;
        return setView({ ...plain, typing: true, query: `${view.query ?? ""}${input.slice(1)}`, index: -1 });
      }
      // esc clears a filter before it goes back: the one you are looking at first.
      if (key.escape && view.full && view.logQuery) return setView({ ...view, logQuery: "", scroll: 0 });
      if (key.escape && view.query) return setView({ ...view, query: "", index: -1 });
      if (key.escape && view.logQuery) return setView({ ...view, logQuery: "", scroll: 0 });
      if (input === "?") return setView({ kind: "help", back: view });
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
        if (key.return && run) {
          selectBolt(run.read, run.bolt);
          setRunPinned(true);
          return setView({ kind: "browse" });
        }
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
      // [ and ]: the tabs of the panel beside the list (logs, info, past runs), as in lazydocker.
      if (input === "[" || input === "]") {
        const tab = nextTab(item, view.tab, input === "]" ? 1 : -1);
        if (tab) setView({ ...view, tab, scroll: 0 });
        return;
      }
      const page = Math.max(1, bodyHeight - 4);
      // As far back as the log goes: past its first line, scrolling up would only count on.
      const most = logWindow({ item, tab: view.tab, log: shownLog, logQuery: view.logQuery ?? "", logTyping: false, height: bodyHeight }).most;
      if (view.full) {
        // The log full screen: ↑↓ read it, as in a pager; ←→ go to the command before or after.
        if (key.upArrow || input === "k") return setView({ ...view, scroll: Math.min(most, view.scroll + 1) });
        if (key.downArrow || input === "j") return setView({ ...view, scroll: Math.max(0, view.scroll - 1) });
        if (key.leftArrow || key.rightArrow) return setView({ ...rest, index: nextWithLog(list, at, key.rightArrow ? 1 : -1), scroll: 0 });
      }
      if (key.upArrow || input === "k") return setView({ ...rest, index: Math.max(0, at - 1), scroll: 0 });
      if (key.downArrow || input === "j") return setView({ ...rest, index: Math.min(list.length - 1, at + 1), scroll: 0 });
      if (key.pageUp || input === "u") return setView({ ...view, scroll: Math.min(most, view.scroll + page) });
      if (key.pageDown || input === "d") return setView({ ...view, scroll: Math.max(0, view.scroll - page) });
      if (input === "G" || input === "g") return setView({ ...view, scroll: 0 });
      if (input === "f") return setView({ ...view, full: !view.full });
      // o: the old ones too, the runs that stopped.
      if (input === "o") return setView({ ...rest, all: !view.all, index: 0 });
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

    // Browsing. A run in the selected bolt's box takes the keys that act on it.
    if (inBox) {
      if (input === "x" && !inBox.done) return stopActive("you stopped it");
      if (input === "r" && inBox.done && inBox.result && retryPlan(inBox.result).length > 0) return void retryFailed();
      if (input === "p") return setView(activity(inBox.done ? (startedBy(inBox) ?? "current") : "current"));
      if (key.escape && inBox.done) return setRunPinned(false);
      if (key.return && inBox.done && focus === "bolts") return setRunPinned(false);
    }
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
    if (input === "e" && focus === "workspaces") {
      const { file, name, icon, notes, personal, local } = current.workspace;
      return setView({ kind: "edit-workspace", file, name, icon: icon ?? "", notes: notes ?? "", personal, local: Boolean(local) });
    }
    if (input === "e") {
      if (!bolt) return setView({ kind: "new-bolt", file: current.workspace.file, workspace: current.workspace.name });
      return setView({ kind: "editor", file: current.workspace.file, bolt: bolt.label });
    }
    if (input === "a") return setView({ kind: "new-bolt", file: current.workspace.file, workspace: current.workspace.name });
    // D deletes what is selected: a workspace on the left, a bolt on the right.
    if (input === "D" && focus === "workspaces") {
      return setView({ kind: "delete-workspace", file: current.workspace.file, name: current.workspace.name, personal: current.workspace.personal });
    }
    if (input === "D" && bolt) return setView({ kind: "delete-bolt", file: current.workspace.file, bolt: bolt.label });
    if (input === "d" || input === "u") return setDetailScroll((top) => Math.max(0, Math.min(detailLimit.current, top + (input === "d" ? 5 : -5))));
    if (input === "s") return setView({ kind: "settings" });
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
    if (input === "t") {
      if (needsTrust(current)) return setView({ kind: "trust", read: current });
      return setMessage(current.workspace.trusted ? "already trusted" : "nothing here needs trust");
    }
    if ((key.return && focus === "bolts") || input === "c") {
      if (!bolt) {
        if (input === "c") return setMessage("no bolts yet: a adds one");
        return setView({ kind: "new-bolt", file: current.workspace.file, workspace: current.workspace.name });
      }
      void runBolt(current, bolt.label, input === "c");
    }
  }, { isActive: !SELF_DRIVEN.has(view.kind) });

  const bodyHeight = Math.max(4, rows - 2);
  const hereLabel = library?.here ? tildify(library.here.replace(/[\\/]\.wisp\.json$/, "")) : undefined;
  const runningCount = runs.filter((run) => run.alive).length + containers.filter((container) => container.state === "running").length;
  const failing = containers.filter((container) => container.health === "unhealthy" || ((container.state === "exited" || container.state === "dead") && container.exitCode !== 0)).map((container) => `${container.service} ${containerMood(container).word}`);

  /**
   * A click or a wheel turn: what is under it, worked out from the layout each screen is
   * drawn from. Returns whether it did something; a wheel turn it didn't use becomes an
   * arrow key, so lists without their own handling scroll as they always did.
   */
  const onMouse = useRef<MouseListener>(() => false);
  onMouse.current = (event) => {
    const view = viewRef.current;
    if (!library) return false;
    // The tabs along the top.
    if (event.y === 0) {
      if (event.kind !== "click" || !(TABS_CLICKABLE.has(view.kind) || ((view.kind === "editor" || view.kind === "settings") && !formOpen.current))) return false;
      const tab = headerTabAt(event.x, glyphs, runningStatus(glyphs, runningCount, failing)?.text ?? "");
      if (tab === "bolts" && view.kind !== "browse") setView({ kind: "browse" });
      if (tab === "running" && view.kind !== "processes") setView(activity());
      if (tab === "history" && view.kind !== "history") setView(history_());
      return tab !== undefined;
    }
    // From the panels' top border down.
    const y = event.y - 1;
    if (y >= bodyHeight) return false;

    if (view.kind === "processes") {
      const spot = paneSpotAt({ x: event.x, y, items: paneItems, active, index: processIndex, height: bodyHeight, columns, full: view.full, searching: Boolean(view.typing || view.query), activity: events.length, dockerError, glyphs });
      if (!spot) return false;
      if (event.kind === "wheel") {
        // Over the list, the wheel moves the selection (as an arrow key); over the logs, it scrolls them.
        if (spot.area !== "panel" && spot.area !== "tab") return false;
        if (shownTab(paneItems[processIndex], view.tab) === "logs") {
          const most = logWindow({ item: paneItems[processIndex], tab: view.tab, log: shownLog, logQuery: view.logQuery ?? "", logTyping: false, height: bodyHeight }).most;
          setView({ ...view, scroll: Math.max(0, Math.min(most, view.scroll - event.by * 3)) });
        }
        return true;
      }
      if (spot.area === "row") {
        const { focus: _focus, ...rest } = view;
        setView({ ...rest, index: spot.at, scroll: 0, typing: false, logTyping: false });
        return true;
      }
      if (spot.area === "tab") {
        setView({ ...view, tab: spot.tab, scroll: 0 });
        return true;
      }
      return false;
    }

    if (view.kind === "browse" && reads.length > 0) {
      // The workspace list on the left.
      if (event.x < workspaceListWidth(columns)) {
        if (event.kind === "wheel") {
          setWsIndex(clamp(wsRef.current + event.by, reads.length));
          setBoltIndex(0);
          setFocus("workspaces");
          return true;
        }
        const row = workspaceRows(reads, library.here, wsRef.current, bodyHeight)[y - 2];
        if (row && "at" in row) {
          if (row.at !== wsRef.current) setBoltIndex(0);
          setWsIndex(row.at);
          setFocus("workspaces");
        }
        return true;
      }
      // The selected workspace's bolts. A click selects one; ⏎ runs it, as ever.
      const list = reads[Math.min(wsRef.current, reads.length - 1)]?.workspace.bolts ?? [];
      if (list.length === 0) return event.kind === "wheel";
      const { items, offset, split, topHeight } = boltWindow(list, boltRef.current, bodyHeight);
      if (event.kind === "wheel") {
        if (split && y >= topHeight) {
          setDetailScroll((top) => Math.max(0, Math.min(detailLimit.current, top + event.by * 3)));
          return true;
        }
        setFocus("bolts");
        setBoltIndex(clamp(boltRef.current + event.by, list.length));
        return true;
      }
      const at = y - FIRST_BOLT_LINE;
      if (at >= 0 && at < items.length) {
        setFocus("bolts");
        setBoltIndex(offset + at);
      }
      return true;
    }
    return false;
  };
  useLayoutEffect(() => mouse?.subscribe((event) => onMouse.current(event)), [mouse]);

  function deleteWorkspace(asked: Extract<View, { kind: "delete-workspace" }>, yes: boolean) {
    setView({ kind: "browse" });
    if (!yes) return;
    const { file, name, personal } = asked;
    void (personal ? services.editing.removePersonalWorkspace(file) : services.editing.forgetProject(file))
      .then(() => reload())
      .then(() => say(personal ? `Deleted "${name}"` : `Removed "${name}" from your list`))
      .catch((error: unknown) => setMessage(describe(error)));
  }

  function deleteBolt(asked: Extract<View, { kind: "delete-bolt" }>, yes: boolean) {
    setView({ kind: "browse" });
    if (!yes) return;
    savedAt.current = Date.now();
    void services.editing
      .removeBolt(asked.file, asked.bolt)
      .then(() => reload(asked.file))
      .then(() => {
        setBoltIndex(Math.max(0, boltIndex - 1));
        say(`Deleted "${asked.bolt}"`);
      })
      .catch((error: unknown) => setMessage(describe(error)));
  }
  // Screens with state of their own (History) take their clicks themselves, from under the tabs.
  const mouseArea = useMemo(() => (mouse ? { source: mouse, top: 1 } : undefined), [mouse]);

  return (
    <MouseContext.Provider value={mouseArea}>
    <Box flexDirection="column" width={columns} height={rows}>
      <Header
        services={services}
        glyphs={glyphs}
        columns={columns}
        here={hereLabel}
        running={runningCount}
        failing={failing}
        tab={view.kind === "processes" || (view.kind === "help" && view.back?.kind === "processes") ? "running" : view.kind === "history" ? "history" : "bolts"}
      />

      {loadError ? (
        <Box borderStyle={glyphs.border} borderColor="red" height={bodyHeight} paddingX={1}>
          <Text color="red">{loadError}</Text>
        </Box>
      ) : !library ? (
        <Box height={bodyHeight} paddingX={1}>
          <Text>
            <Text color={TONE.accent}>{`${glyphs.spark} ${spell()}… `}</Text>
            <Text dimColor>reading your workspaces</Text>
          </Text>
        </Box>
      ) : view.kind === "setup" ? (
        <SetupPanel
          suggestion={view.suggestion}
          glyphs={glyphs}
          height={bodyHeight}
          onAnswer={async (chosen) => {
            if (chosen === "never") {
              setView({ kind: "browse" });
              await services.declineSetup(view.suggestion.dir).catch(() => undefined);
              setMessage("Won't ask here again. `wisp init` still sets it up whenever you like");
              return;
            }
            if (!chosen) {
              setView({ kind: "browse" });
              setMessage("Not now — press a in a workspace to add bolts by hand, or run `wisp init` later");
              return;
            }
            try {
              savedAt.current = Date.now();
              const file = await services.setUp(view.suggestion, chosen);
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
          workspace={(() => {
            const owner = reads.find((read) => read.workspace.file === view.file)?.workspace;
            return owner ? `${owner.icon && glyphs.border === "round" ? `${owner.icon} ` : ""}${owner.name}` : undefined;
          })()}
          others={(reads.find((read) => read.workspace.file === view.file)?.workspace.bolts ?? []).map((entry) => entry.label).filter((label) => label !== view.bolt)}
          adding={Boolean(view.adding)}
          editing={services.editing}
          glyphs={glyphs}
          height={bodyHeight}
          columns={columns}
          onHint={setScreenHint}
          onJump={(input) => void jump(input)}
          onBusy={setFormOpen}
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
          intro="A bolt is one thing you do — 'Work on the API', 'Run the tests', 'Back up the database'. You'll add its steps next."
          fields={[{ key: "label", label: "Name", hint: "short, since you type it: any whole word of it runs it, like wisp api", placeholder: "Work on the API", required: true }]}
          preview={(values) => (values["label"]?.trim() ? `make ⚡ ${values["label"].trim()}, then ask for its first step` : undefined)}
          submitLabel="Create bolt"
          glyphs={glyphs}
          height={bodyHeight}
          onCancel={() => setView({ kind: "browse" })}
          onSubmit={async (values) => {
            const label = values["label"]?.trim() ?? "";
            try {
              savedAt.current = Date.now();
              await services.editing.addBolt(view.file, label);
            } catch (error) {
              return { label: describe(error) };
            }
            const next = await reload(view.file);
            const read = next ? ordered(next).find((entry) => entry.workspace.file === view.file) : undefined;
            setBoltIndex(Math.max(0, read?.workspace.bolts.findIndex((entry) => entry.label === label) ?? 0));
            setFocus("bolts");
            setView({ kind: "editor", file: view.file, bolt: label, adding: true });
            return undefined;
          }}
        />
      ) : view.kind === "new-workspace" ? (
        <Form
          title="A workspace of your own"
          intro="For things that belong to no project: 'Morning', 'On call', 'University'. It lives in Wisp's own folder, and its commands run without asking — it's yours."
          fields={[{ key: "name", label: "Name", hint: "what it's for", placeholder: "Morning", required: true }]}
          submitLabel="Create workspace"
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
            // Straight to its first bolt: a workspace is only as useful as what it runs.
            setView({ kind: "new-bolt", file, workspace: values["name"]?.trim() ?? "" });
            return undefined;
          }}
        />
      ) : view.kind === "edit-workspace" ? (
        <Form
          title={`Workspace "${view.name}"`}
          intro={
            view.personal
              ? "Yours: kept in Wisp's own folder. Its past runs show the new name."
              : view.local
                ? "Saved where each value is set now: .wisp.local.json for what it overrides, .wisp.json (shared with your team) for the rest."
                : "Saved in .wisp.json, which your team shares: they get the new name on their next pull. Its past runs show it too."
          }
          fields={[
            { key: "name", label: "Name", required: true, placeholder: "Acme" },
            { key: "icon", label: "Icon", hint: "an emoji, or leave it empty", placeholder: "🏢" },
            { key: "notes", label: "Notes", hint: "a line about what it's for", placeholder: "The API, the web app and their database" },
          ]}
          initial={{ name: view.name, icon: view.icon, notes: view.notes }}
          submitLabel="Save"
          glyphs={glyphs}
          height={bodyHeight}
          onCancel={() => setView({ kind: "browse" })}
          onSubmit={async (values) => {
            const name = values["name"]?.trim() ?? "";
            try {
              savedAt.current = Date.now();
              await services.editing.setWorkspaceDetails(view.file, { name, icon: values["icon"] ?? "", notes: values["notes"] ?? "" });
            } catch (error) {
              return { name: describe(error) };
            }
            await reload(view.file);
            setView({ kind: "browse" });
            say(name === view.name ? `Saved "${name}"` : `Renamed "${view.name}" to "${name}"`);
            return undefined;
          }}
        />
      ) : view.kind === "settings" ? (
        <SettingsScreen services={services} glyphs={glyphs} height={bodyHeight} columns={columns} onMouse={setMouseOn} onJump={(input) => void jump(input)} onBusy={setFormOpen} onClose={() => setView({ kind: "browse" })} onSaved={(text) => {
          say(text);
          // Each workspace fixes which app opens its folders and files when it is read, so
          // read them again: the next run uses the new choice, without restarting Wisp.
          void reload(current?.workspace.file);
        }} />
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
      ) : view.kind === "history" ? (
        <HistoryScreen
          names={workspaceNames}
          services={services}
          glyphs={glyphs}
          height={bodyHeight}
          columns={columns}
          onClose={() => setView({ kind: "browse" })}
          onRunning={() => setView(activity())}
          onJump={(input) => void jump(input)}
          onHint={setScreenHint}
          onRetry={(entry) => {
            const read = reads.find((candidate) => candidate.workspace.file === entry.workspace);
            if (!read) return setMessage(`${entry.workspaceName} is not in the list any more`);
            const label = entry.bolt.replace(/ \((retry|down)\)$/, "");
            void services
              .planRetry(read, entry)
              .then((steps) =>
                launch(read, label, false, (callbacks) => services.retry(read, steps, label, callbacks), `${entry.workspaceName} ${glyphs.arrow} ${label} — retrying ${steps.length === 1 ? "1 step" : `${steps.length} steps`}`, entry.inputs ?? {}),
              )
              .catch((error: unknown) => setMessage(describe(error)));
          }}
          onRerun={(entry) => {
            const read = reads.find((candidate) => candidate.workspace.file === entry.workspace);
            if (!read) return setMessage(`${entry.workspaceName} is not in the list any more`);
            void runBolt(read, entry.bolt.replace(/ \((retry|down)\)$/, ""), false);
          }}
        />
      ) : view.kind === "trust" ? (
        <TrustPanel
          read={view.read}
          {...(view.then ? { then: view.then } : {})}
          glyphs={glyphs}
          height={bodyHeight}
          onAnswer={(yes) => {
            const { read, then } = view;
            setView({ kind: "browse" });
            if (!yes) return setMessage(then ? `didn't run "${then}": it waits for trust (t to review)` : "not trusted");
            void services
              .trust(read.workspace.file, read.hash)
              .then(() => reload(read.workspace.file))
              .then(async (next) => {
                say(`trusted ${read.workspace.name} — its commands will run`);
                const fresh = next ? ordered(next).find((entry) => entry.workspace.file === read.workspace.file) : undefined;
                if (then && fresh) await runBolt(fresh, then, false);
              })
              .catch((error: unknown) => setMessage(describe(error)));
          }}
        />
      ) : view.kind === "processes" ? (
        <PanesPanel items={paneItems} activity={events} history={recent} query={view.query ?? ""} typing={Boolean(view.typing)} runs={runs} containers={containers} active={active} tick={tick} stats={stats} dockerError={dockerError} all={view.all} index={processIndex} log={shownLog} scroll={view.scroll} full={view.full} tab={view.tab} reads={reads} logQuery={view.logQuery} logTyping={view.logTyping} glyphs={glyphs} height={bodyHeight} columns={columns} />
      ) : view.kind === "help" ? (
        <HelpPanel glyphs={glyphs} height={bodyHeight} tab={view.back?.kind === "processes" ? "running" : "bolts"} />
      ) : view.kind === "search" ? (
        <SearchPanel hits={search(reads, view.query)} index={view.index} query={view.query} glyphs={glyphs} height={bodyHeight} />
      ) : reads.length === 0 ? (
        <Empty glyphs={glyphs} height={bodyHeight} unreadable={library.unreadable.length} />
      ) : (
        <Box height={bodyHeight}>
          <WorkspaceList
            reads={reads}
            index={wsIndex}
            here={library.here}
            focused={focus === "workspaces"}
            glyphs={glyphs}
            height={bodyHeight}
            width={workspaceListWidth(columns)}
            confirming={
              view.kind === "delete-workspace"
                ? { question: view.personal ? `Delete "${view.name}"?` : `Remove "${view.name}"?`, yes: view.personal ? "Delete" : "Remove", onAnswer: (yes) => deleteWorkspace(view, yes) }
                : undefined
            }
          />
          {current ? (
            <WorkspacePanel
              confirming={
                view.kind === "delete-bolt"
                  ? { question: `Delete "${view.bolt}"?`, yes: "Delete", onAnswer: (yes) => deleteBolt(view, yes) }
                  : view.kind === "confirm-run"
                    ? {
                        question: view.question,
                        yes: "Run",
                        no: "Cancel",
                        onAnswer: (yes) => {
                          const go = pendingRun.current;
                          pendingRun.current = undefined;
                          setView({ kind: "browse" });
                          if (yes) go?.();
                        },
                      }
                    : undefined
              }
              read={current}
              {...(checked && checked.read === current ? { diagnostics: checked.diagnostics } : {})}
              reads={reads}
              instead={
                view.kind === "run-inputs"
                  ? (room: number) => (
                      <Form
                              title={`Run "${view.bolt}" in ${view.workspace}`}
                              intro="It needs these before it runs."
                              fields={view.specs.map((spec) =>
                                spec.choices
                                  ? { key: spec.name, label: spec.ask, choices: spec.choices.map((value) => ({ value, label: value })) }
                                  : spec.default
                                    ? { key: spec.name, label: spec.ask, placeholder: spec.default, hint: `plain words; empty keeps ${spec.default}` }
                                    : { key: spec.name, label: spec.ask, required: true, hint: "plain words, like staging or v1.2.3" },
                              )}
                              initial={Object.fromEntries(view.specs.flatMap((spec) => (spec.choices && spec.default ? [[spec.name, spec.default]] : [])))}
                              submitLabel="Run"
                              glyphs={glyphs}
                              height={room}
                              onCancel={() => {
                                pendingInputs.current = undefined;
                                setView({ kind: "browse" });
                              }}
                              onSubmit={async (values) => {
                                const chosen = Object.fromEntries(view.specs.map((spec) => [spec.name, values[spec.name]?.trim() || spec.default || ""]));
                                const problems = Object.fromEntries(view.specs.flatMap((spec) => {
                                  const problem = checkValue(spec, chosen[spec.name] ?? "");
                                  return problem ? [[spec.name, problem]] : [];
                                }));
                                if (Object.keys(problems).length > 0) return problems;
                                const go = pendingInputs.current;
                                pendingInputs.current = undefined;
                                setView({ kind: "browse" });
                                go?.(chosen);
                                return undefined;
                              }}
                            />
                    )
                  : inBox
                    ? (room: number) => (
                        <Box flexDirection="column" height={room} borderStyle={glyphs.border} borderColor={inBox.done ? (inBox.error || inBox.steps.some((step) => step.result && !step.result.ok && !step.result.skipped) ? "red" : "green") : TONE.accent} paddingX={1} overflow="hidden">
                          <RunProgress view={inBox} glyphs={glyphs} height={Math.max(1, room - 2)} tick={tick} />
                        </Box>
                      )
                    : undefined
              }
              scroll={detailScroll}
              scrollLimit={detailLimit}
              here={current.workspace.file === library.here}
              width={columns - workspaceListWidth(columns) - 4}
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

      <Footer view={view} notice={notice} columns={columns} hint={view.kind === "history" || view.kind === "editor" ? screenHint : undefined} message={message ?? (library?.unreadable.length ? `${library.unreadable.length} workspace file(s) could not be read — \`wisp list\`` : undefined)} />
    </Box>
    </MouseContext.Provider>
  );
}

function startedBy(run: RunState): string | undefined {
  return [...run.steps].reverse().find((step) => step.result?.run && step.result.ok && !step.target.workspace)?.result?.run;
}

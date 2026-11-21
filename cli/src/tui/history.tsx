import { Box, type DOMElement, measureElement, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { allSteps, baseLabel, withWorkspaceNames, type HistoryEntry, type HistoryStep, type StepProgress } from "../core/history.js";
import { ASK_KEYS, AskHere } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { HelpPanel } from "./panels.js";
import { spell } from "./spells.js";
import { since } from "./state.js";
import { TONE } from "./tones.js";
import { matchesAll, shortUrl, windowed, type Services } from "./model.js";
import { FilterLine, filterLog, MatchLine } from "./logfilter.js";
import { useMouse } from "./mouse.js";

export interface HistoryScreenProps {
  services: Services;
  glyphs: Glyphs;
  height: number;
  columns: number;
  onClose: () => void;
  /** Go to what is running instead. */
  onRunning: () => void;
  /** 1 and 2 go to the other tabs; 3 is this one. */
  onJump?: (input: string) => void;
  /** Run the failed part of this run again. */
  onRetry: (entry: HistoryEntry) => void;
  /** Run the whole bolt again. */
  onRerun: (entry: HistoryEntry) => void;
  onHint?: (hint: string) => void;
  names?: ReadonlyMap<string, string>;
}

/** A bolt in the sidebar: the filter, like a workflow in a CI's list. */
export interface BoltFilter {
  key: string;
  workspace?: string;
  workspaceName?: string;
  bolt?: string;
  count: number;
}

/**
 * History, laid out the way a CI lays out its runs: bolts on the left to filter by, the
 * runs of the chosen ones on the right — numbered, with their commit and what started
 * them — and, opening one, its summary, its pipeline drawn as a graph, and its steps with
 * their logs expanding in place.
 */
export function HistoryScreen(props: HistoryScreenProps) {
  const { services, glyphs, height, columns, onClose, onRunning, onRetry, onRerun, onJump, onHint, names } = props;
  const [recorded, setEntries] = useState<HistoryEntry[]>();
  const entries = useMemo(() => recorded && (names ? withWorkspaceNames(recorded, names) : recorded), [recorded, names]);
  const [filterIndex, setFilterIndex] = useState(0);
  const [runIndex, setRunIndex] = useState(0);
  const [focus, setFocus] = useState<"bolts" | "runs">("runs");
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [forget, setForget] = useState<{ ids: string[]; title: string; detail: string; one: boolean }>();
  const [reloads, setReloads] = useState(0);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await services.history();
      if (alive) setEntries(next);
    };
    void load();
    // New runs show up while you look, as on a CI page.
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [services, reloads]);

  const filters = useMemo(() => boltFilters(entries ?? []), [entries]);
  const filter = filters[Math.min(filterIndex, filters.length - 1)];
  const shown = useMemo(
    () =>
      (entries ?? [])
        .filter((entry) => !filter?.bolt || (entry.workspace === filter.workspace && baseLabel(entry.bolt) === filter.bolt))
        .filter((entry) => matchesAll(query, ...searchText(entry))),
    [entries, filter, query],
  );
  const run = shown[Math.min(runIndex, Math.max(0, shown.length - 1))];
  const opened = open ? entries?.find((entry) => entry.id === open) : undefined;

  // Clicks: a bolt on the left filters, a run on the right is chosen, and a click on the
  // chosen run opens it, as ⏎ does. The wheel moves through the list under it.
  useMouse((event) => {
    if (!entries || entries.length === 0 || event.y >= height) return false;
    if (event.x < historySideWidth(columns)) {
      if (event.kind === "wheel") {
        setFocus("bolts");
        setFilterIndex((at) => Math.max(0, Math.min(filters.length - 1, at + event.by)));
        setRunIndex(0);
        return true;
      }
      const line = filterLines(filters, filterIndex, height)[event.y - 2];
      if (line?.kind === "filter") {
        setFocus("bolts");
        if (line.at !== filterIndex) setRunIndex(0);
        setFilterIndex(line.at);
      }
      return true;
    }
    if (event.kind === "wheel") {
      setFocus("runs");
      setRunIndex((at) => Math.max(0, Math.min(shown.length - 1, at + event.by)));
      return true;
    }
    const at = runAt(shown, runIndex, height, event.y);
    if (at === undefined) return true;
    setTyping(false);
    if (focus === "runs" && at === runIndex) setOpen(shown[at]?.id);
    else {
      setFocus("runs");
      setRunIndex(at);
    }
    return true;
  }, !opened && !forget && !help);

  useInput(() => setHelp(false), { isActive: help });

  useInput(
    (input, key) => {
      if (!entries) return;
      // Typing a search: letters go into it; ⏎ or ↓ keeps it and goes back to the runs.
      if (typing) {
        if (key.escape) {
          setQuery("");
          setTyping(false);
          return setRunIndex(0);
        }
        if (key.return || key.downArrow || key.tab) return setTyping(false);
        if (key.backspace || key.delete) {
          setQuery((text) => text.slice(0, -1));
          return setRunIndex(0);
        }
        if (input && !key.ctrl && !key.meta) {
          setQuery((text) => text + input);
          return setRunIndex(0);
        }
        return;
      }
      // Fast typing arrives as one chunk: "/fail" is "/" and the start of the search.
      if (input.startsWith("/")) {
        setFocus("runs");
        setQuery((text) => text + input.slice(1));
        setRunIndex(0);
        return setTyping(true);
      }
      if (key.escape && query) {
        setQuery("");
        return setRunIndex(0);
      }
      if (input === "p") return onRunning();
      if (input === "?") return setHelp(true);
      if (onJump && (input === "1" || input === "2")) return onJump(input);
      if (input === "D") return askToForget();
      if (run && input === "r" && !run.ok && !run.running) return onRetry(run);
      if (run && input === "R") return onRerun(run);
      if (key.escape || input === "q" || input === "h") return onClose();

      if (focus === "bolts") {
        if (key.upArrow || input === "k") {
          setFilterIndex((at) => Math.max(0, at - 1));
          return setRunIndex(0);
        }
        if (key.downArrow || input === "j") {
          setFilterIndex((at) => Math.min(filters.length - 1, at + 1));
          return setRunIndex(0);
        }
        if (key.rightArrow || key.return || key.tab) return setFocus("runs");
        return;
      }
      if (key.leftArrow || (key.shift && key.tab)) return setFocus("bolts");
      if (key.upArrow || input === "k") return setRunIndex((at) => Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setRunIndex((at) => Math.min(shown.length - 1, at + 1));
      if (key.return && run) return setOpen(run.id);
    },
    { isActive: !opened && !forget && !help },
  );

  function askToForget() {
    const finished = (list: HistoryEntry[]) => list.filter((entry) => !entry.running);
    if (focus === "runs") {
      if (!run || run.running) return;
      return setForget({ ids: [run.id], title: `Delete run #${run.number ?? ""} of ${run.bolt}?`, detail: "Its steps and what they printed go with it", one: true });
    }
    const runs = finished((entries ?? []).filter((entry) => !filter?.bolt || (entry.workspace === filter.workspace && baseLabel(entry.bolt) === filter.bolt)));
    if (runs.length === 0) return;
    const count = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
    setForget({
      ids: runs.map((entry) => entry.id),
      title: filter?.bolt ? `Clear the ${count} of ${filter.bolt}?` : `Clear all ${count}?`,
      detail: "Their steps and what they printed go with them; runs still going are kept",
      one: false,
    });
  }

  function answerForget(yes: boolean) {
    const ids = forget?.ids ?? [];
    setForget(undefined);
    if (!yes) return;
    void services.forgetRuns(ids).then(() => {
      setRunIndex(0);
      setReloads((count) => count + 1);
    });
  }

  const listHint = !entries
    ? ""
    : entries.length === 0
      ? "esc back"
      : forget
        ? `${forget.detail} · ${ASK_KEYS}`
        : typing
          ? "type to search · ⏎ keep it · esc clear"
          : [focus === "runs" ? "⏎ open" : "→ runs", "← bolts", "/ search", run && !run.ok && !run.running ? "r retry" : "", "R run again", focus === "runs" ? "D delete" : "D clear", "? keys", "esc"].filter(Boolean).join(" · ");
  useEffect(() => {
    if (help) onHint?.("any key to go back");
    else if (!opened) onHint?.(listHint);
  }, [help, opened, listHint, onHint]);

  if (!entries) {
    return (
      <Box height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text>
          <Text color={TONE.accent}>{`${glyphs.spark} ${spell(3)}… `}</Text>
          <Text dimColor>reading history</Text>
        </Text>
      </Box>
    );
  }

  if (help) return <HelpPanel glyphs={glyphs} height={height} tab="history" />;

  if (opened) {
    return (
      <RunDetail
        entry={opened}
        services={services}
        glyphs={glyphs}
        height={height}
        columns={columns}
        onBack={() => setOpen(undefined)}
        onRetry={() => onRetry(opened)}
        onRerun={() => onRerun(opened)}
        onHelp={() => setHelp(true)}
        {...(onJump ? { onJump } : {})}
        {...(onHint ? { onHint } : {})}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text bold>
          History
        </Text>
        <Text> </Text>
        <Text>Nothing has run yet. Every run of a bolt shows up here — whether it worked, how long each step took, and what it printed — the way a CI shows its runs.</Text>
      </Box>
    );
  }

  const sideWidth = historySideWidth(columns);
  const { items: runRows, offset: runOffset } = runWindow(shown, runIndex, height);

  return (
    <Box height={height}>
      <Box flexDirection="column" width={sideWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={focus === "bolts" ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        <Text bold>
          Bolts
        </Text>
        {filterLines(filters, filterIndex, height).map((line) => {
          if (line.kind === "heading") return <Text key={line.key} dimColor wrap="truncate-end">{clip(line.text, sideWidth - 4)}</Text>;
          const entry = filters[line.at] as BoltFilter;
          const selected = line.at === filterIndex;
          return (
            <Box key={entry.key}>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate-end" inverse={selected && focus === "bolts"} bold={selected}>
                  {selected ? glyphs.pointer : " "} {clip(entry.bolt ?? "All bolts", sideWidth - 8 - String(entry.count).length)}
                </Text>
              </Box>
              <Text dimColor>{`  ${entry.count}`}</Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focus === "runs" ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        <Text>
          <Text bold>{filter?.bolt ?? "All runs"}</Text>
          <Text dimColor>{`  ${shown.length} run${shown.length === 1 ? "" : "s"}`}</Text>
        </Text>
        {forget && !forget.one ? (
          <AskHere question={forget.title} yes="Delete" onAnswer={answerForget} />
        ) : typing || query ? (
          <SearchLine query={query} typing={typing} />
        ) : (
          <Text> </Text>
        )}
        {shown.length === 0 ? <Text dimColor>{`No run matches “${query}”. esc clears it.`}</Text> : null}
        {runRows.map((entry, position, all) => {
          const titleOf = (run: HistoryEntry) => (filter?.bolt ? 0 : run.bolt.length + 1) + `#${run.number ?? ""}`.length;
          const titleWidth = Math.min(32, Math.max(0, ...all.map(titleOf)));
          const at = runOffset + position;
          const selected = at === runIndex && focus === "runs";
          const failedAt = entry.steps.find((step) => !step.ok && !step.skipped);
          const state = entry.running ? `running, step ${Math.min(entry.steps.length + 1, entry.total ?? entry.steps.length + 1)} of ${entry.total ?? "?"}` : entry.interrupted ? "interrupted" : "";
          // A fixed width, so the times line up down the list whatever their length.
          const right = `${(entry.interrupted ? "?" : formatDuration(totalMs(entry)) || "0ms").padStart(7)} · ${since(entry.startedAt).padEnd(8)}`;
          const doomed = forget?.ids.includes(entry.id) ?? false;
          const branch = entry.git ? clip(entry.git.branch, 24) : "";
          const subject = entry.git?.subject ? clip(entry.git.subject, 48) : "";
          return (
            <Box key={entry.id} flexDirection="column">
              <Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text wrap="truncate-end" color={doomed ? "red" : undefined}>
                    <Text bold={selected} color={doomed ? "red" : selected ? TONE.accent : undefined}>
                      {selected ? glyphs.pointer : " "} <Mark ok={entry.ok} running={entry.running} interrupted={entry.interrupted} glyphs={glyphs} /> {filter?.bolt ? "" : `${entry.bolt} `}
                    </Text>
                    <Text dimColor={!filter?.bolt} bold={selected && Boolean(filter?.bolt)} color={selected && filter?.bolt ? TONE.accent : undefined}>{`#${entry.number ?? ""}`}</Text>
                    {" ".repeat(Math.max(0, titleWidth - titleOf(entry)))}
                    {state ? <Text color="cyan">{`  ${state}`}</Text> : null}
                    {failedAt ? <Text color="red">{`  at ${failedAt.label}`}</Text> : null}
                    {entry.git ? <Text color="yellow" dimColor>{`  ${entry.git.commit}`}</Text> : null}
                    {subject ? <Text dimColor>{` ${subject}`}</Text> : null}
                    {entry.trigger === "hook" ? <Text dimColor>{"  · git hook"}</Text> : null}
                    {filter?.bolt ? null : <Text dimColor>{`  · ${entry.workspaceName}`}</Text>}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  {branch ? <Text color="#60a5fa">{`  ${glyphs.border === "round" ? "⎇ " : ""}${branch}`}</Text> : null}
                  <Text dimColor>{`  ${right}`}</Text>
                </Box>
              </Box>
              {doomed && forget?.one ? <AskHere question={forget.title} yes="Delete" onAnswer={answerForget} /> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** How wide the bolts on the left are, the runs taking the rest. */
export function historySideWidth(columns: number): number {
  return Math.min(36, Math.max(22, Math.floor(columns * 0.27)));
}

/**
 * The bolts on the left that fit, line by line: a workspace's name before its first bolt.
 * Drawn from this, and clicks are matched against it.
 */
export function filterLines(filters: BoltFilter[], filterIndex: number, height: number): ({ kind: "heading"; key: string; text: string } | { kind: "filter"; at: number })[] {
  const { items, offset } = windowed(filters, filterIndex, height - 3);
  const lines: ({ kind: "heading"; key: string; text: string } | { kind: "filter"; at: number })[] = [];
  items.forEach((entry, position) => {
    const at = offset + position;
    if (entry.bolt && (at === 0 || filters[at - 1]?.workspace !== entry.workspace)) lines.push({ kind: "heading", key: `h:${entry.key}`, text: (entry.workspaceName ?? "").toUpperCase() });
    lines.push({ kind: "filter", at });
  });
  return lines;
}

/** The runs that fit on the right, two lines each, kept around the chosen one. */
export function runWindow<T>(shown: T[], runIndex: number, height: number): { items: T[]; offset: number } {
  return windowed(shown, runIndex, Math.max(1, height - 4));
}

/** The run at a line of the runs panel, counted from its top border: the title, the search line, then a line a run. */
export function runAt<T>(shown: T[], runIndex: number, height: number, y: number): number | undefined {
  const { items, offset } = runWindow(shown, runIndex, height);
  const position = y - 3;
  return y >= 3 && position < items.length ? offset + position : undefined;
}

/** One run, as a CI's run page: the summary, the pipeline, then each step with its log. */
function RunDetail(props: {
  entry: HistoryEntry;
  services: Services;
  glyphs: Glyphs;
  height: number;
  columns: number;
  onBack: () => void;
  onRetry: () => void;
  onRerun: () => void;
  onHelp: () => void;
  onJump?: (input: string) => void;
  onHint?: (hint: string) => void;
}) {
  const { entry, services, glyphs, height, columns, onBack, onRetry, onRerun, onHelp, onJump, onHint } = props;
  const all = useMemo(() => allSteps(entry), [entry]);
  const runningAt = all.findIndex((step) => step.state === "running");
  const firstFailed = runningAt >= 0 ? runningAt : Math.max(0, entry.steps.findIndex((step) => !step.ok && !step.skipped));
  const [selected, setSelectedState] = useState(firstFailed);
  // Keys can arrive together ("↓⏎" typed fast): each must see the step the one before chose,
  // not the one on screen when they arrived.
  const selectedRef = useRef(firstFailed);
  const setSelected = (next: number | ((prior: number) => number)) => {
    selectedRef.current = typeof next === "function" ? next(selectedRef.current) : next;
    setSelectedState(selectedRef.current);
  };
  // The failed step opens with its log showing, as a CI opens the failing job.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(entry.ok ? [] : [firstFailed]));
  const followed = useRef(runningAt);
  useEffect(() => {
    if (runningAt < 0 || runningAt === followed.current) return;
    const was = followed.current;
    followed.current = runningAt;
    setExpanded((prior) => (prior.has(was) ? new Set([...prior].filter((at) => at !== was)).add(runningAt) : prior));
    if (selectedRef.current === was) setSelected(runningAt);
  }, [runningAt]);
  const [logs, setLogs] = useState<Map<number, string[]>>(new Map());
  const [top, setTop] = useState(0);
  // Whether you scrolled yourself (u, d, or past the ends with ↑↓), so the view stays put.
  const [scrolled, setScrolled] = useState(false);
  // The log filter: every step's log, down to the lines with every word of it. `typing`
  // while it is written; refs too, as keys can arrive faster than a redraw.
  const [query, setQueryState] = useState("");
  const [typing, setTypingState] = useState(false);
  const queryRef = useRef("");
  const typingRef = useRef(false);
  const setQuery = (change: (prior: string) => string) => {
    queryRef.current = change(queryRef.current);
    setQueryState(queryRef.current);
    // A new filter starts at the top of what it found.
    setScrolled(false);
    setTop(0);
  };
  const setTyping = (next: boolean) => {
    typingRef.current = next;
    setTypingState(next);
  };
  const filtering = query !== "";
  const hint = (
    typing
      ? ["type to filter the logs", "⏎ keep it", "esc clear"]
      : ["↑↓ steps", "⏎ its log", "/ filter", "u d scroll", entry.ok || entry.running ? "" : "r retry", "R run again", "? keys", filtering ? "esc clear" : "esc back"]
  )
    .filter(Boolean)
    .join(" · ");
  useEffect(() => onHint?.(hint), [hint, onHint]);

  useEffect(() => {
    // Filtering reads every step's log, not just the open ones.
    for (const at of filtering ? all.keys() : expanded) {
      const step = all[at];
      if (!step?.log || logs.has(at)) continue;
      void services
        .readLog(step.log)
        .then((text) => {
          setLogs((prior) => new Map(prior).set(at, cleanOutput(text).split("\n").filter((line, index, all) => line !== "" || index < all.length - 1)));
        })
        .catch(() => setLogs((prior) => new Map(prior).set(at, GONE)));
    }
  }, [expanded, all, services, logs, filtering]);

  useEffect(() => {
    const step = all[runningAt];
    if (!step?.log || !(expanded.has(runningAt) || filtering)) return;
    void services
      .readLog(step.log)
      .then((text) => setLogs((prior) => new Map(prior).set(runningAt, cleanOutput(text).split("\n").filter((line, index, lines) => line !== "" || index < lines.length - 1))))
      .catch(() => undefined);
  }, [entry, runningAt, expanded, filtering, services, all]);

  // The steps and their open logs, as one list of rows to scroll through. `lines`: how many
  // a row takes when it wraps, so a click below it still finds the right step.
  const rows: { key: string; step?: number; lines?: number; node: ReactNode }[] = [];
  const longest = Math.max(1, ...all.map((step) => step.durationMs));
  // As wide as the longest step, so a step's time sits beside it rather than across the screen.
  const labelWidth = Math.min(Math.max(24, columns - 34), Math.max(16, ...all.map((step) => describeHistoryStep(step).length + 2)));
  let matches = 0;
  let matchingSteps = 0;
  let reading = false;
  all.forEach((step, at) => {
    const isSelected = at === selected;
    const isOpen = expanded.has(at);
    const read = logs.get(at);
    const found = filtering && read && read !== GONE ? filterLog(read, query) : undefined;
    if (filtering && step.log && !read) reading = true;
    if (found && found.length > 0) {
      matches += found.length;
      matchingSteps += 1;
    }
    const bar = step.durationMs > 0 ? "▇".repeat(Math.max(1, Math.round((step.durationMs / longest) * 12))) : "";
    rows.push({
      key: `s${at}`,
      step: at,
      node: (
        <Text wrap="truncate-end">
          <Text color={TONE.accent}>{isSelected ? glyphs.pointer : " "}</Text> {isOpen ? "▾" : "▸"} <Mark ok={step.ok} skipped={step.skipped} running={step.state === "running"} waiting={step.state === "waiting"} glyphs={glyphs} />{" "}
          <Text bold={isSelected} color={isSelected ? TONE.accent : undefined} dimColor={step.state === "waiting" && !isSelected}>{fit(describeHistoryStep(step), labelWidth)}</Text>
          {step.state ? (
            <Text color={step.state === "running" ? "cyan" : undefined} dimColor={step.state === "waiting"}>{`  ${(step.state === "running" ? "running" : "waiting").padEnd(18)}  `}</Text>
          ) : (
            <>
              <Text dimColor>{` ${formatDuration(step.durationMs).padStart(6)}  `}</Text>
              <Text color={step.ok ? TONE.accent : "red"}>{bar.padEnd(12)}</Text>
            </>
          )}
          {"  "}
          {filtering ? (
            found && found.length > 0 ? <Text color="yellow">{`${found.length} match${found.length === 1 ? "" : "es"}`}</Text> : <Text dimColor>{step.log ? (read ? "no match" : "reading…") : "no output"}</Text>
          ) : step.error ? (
            <Text color="red">{step.error}</Text>
          ) : step.note && !step.note.startsWith("logs:") ? (
            <Text dimColor>{step.note}</Text>
          ) : null}
        </Text>
      ),
    });
    // Filtering: under each step, its matching lines, whether it was open or not.
    if (filtering) {
      const width = String(read?.length ?? 0).length;
      for (const match of found ?? []) rows.push({ key: `m${at}:${match.at}`, node: <MatchLine at={match.at} text={match.text} query={query} width={width} indent={8} /> });
      return;
    }
    if (isOpen) {
      const lines = logs.get(at);
      const say = (text: string) => rows.push({ key: `l${at}`, lines: wrappedLines(`        ${text}`, columns - 4), node: <Text dimColor wrap="wrap">{`        ${text}`}</Text> });
      // Every step opens: one without output says why there is none, rather than nothing.
      if (!step.log) say(noOutput(step));
      else if (!lines) say("reading…");
      else if (lines === GONE) say("Its output is no longer kept — it was cleared along with the finished run.");
      else if (lines.length === 0) say("It printed nothing.");
      else {
        const width = String(lines.length).length;
        lines.forEach((line, index) =>
          rows.push({
            key: `l${at}:${index}`,
            node: (
              <Text wrap="truncate-end">
                <Text dimColor>{`        ${String(index + 1).padStart(width)} `}</Text>
                {line || " "}
              </Text>
            ),
          }),
        );
      }
    }
  });

  const graph = pipeline(entry);
  const drawn = graph.flat().length > 1;
  const tallest = Math.max(1, ...graph.map((column) => column.length));
  const graphRows = drawn ? Math.max(1, Math.ceil(graphWidth(graph) / Math.max(20, columns - 6))) * tallest : 0;
  const room = Math.max(3, height - 8 - graphRows * 3 - (filtering || typing ? 1 : 0));
  const selectedRow = Math.max(0, rows.findIndex((row) => row.step === selected));
  // The view follows the selected step, until you scroll yourself: then it stays where you
  // put it (it used to snap straight back to the step, so u and d seemed to do nothing).
  const most = Math.max(0, rows.length - room);
  const first = scrolled
    ? Math.min(most, Math.max(0, top))
    : Math.min(most, Math.max(0, selectedRow < top ? selectedRow : selectedRow >= top + room ? selectedRow - room + 1 : top));
  const visible = rows.slice(first, first + room);

  // Show or hide a step's log.
  const toggle = (at: number) =>
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });

  // How tall the title, summary and pipeline are, measured once drawn: the pipeline wraps
  // to the width, so counting its boxes would only be a guess. The guess is the fallback.
  const head = useRef<DOMElement>(null);
  const headLines = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (head.current) headLines.current = measureElement(head.current).height;
  });

  // A click on a step shows or hides its log, as ⏎ does; the wheel scrolls.
  useMouse((event) => {
    if (event.kind === "wheel") {
      setScrolled(true);
      setTop(Math.min(most, Math.max(0, first + event.by * 3)));
      return true;
    }
    let line = event.y - 1 - (headLines.current ?? 5 + (drawn ? graphRows * 3 : 0));
    if (line < 0) return true;
    for (const row of visible) {
      const lines = row.lines ?? 1;
      if (line < lines) {
        if (row.step === undefined) return true;
        setSelected(row.step);
        setTop(first);
        toggle(row.step);
        return true;
      }
      line -= lines;
    }
    return true;
  });

  useInput((input, key) => {
    // Typing the filter: letters go into it; ⏎ or ↓ keeps it.
    if (typingRef.current) {
      if (key.escape) {
        setQuery(() => "");
        return setTyping(false);
      }
      if (key.return || key.downArrow || key.tab) return setTyping(false);
      if (key.backspace || key.delete) return setQuery((text) => text.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setQuery((text) => text + input);
      return;
    }
    // Fast typing arrives as one chunk: "/err" is "/" and the start of the filter.
    if (input.startsWith("/")) {
      setTyping(true);
      return setQuery((text) => text + input.slice(1));
    }
    if (key.escape && queryRef.current) return setQuery(() => "");
    if (key.escape || key.leftArrow || input === "q" || input === "3") return onBack();
    if (onJump && (input === "1" || input === "2")) return onJump(input);
    if (input === "r" && !entry.ok && !entry.running) return onRetry();
    if (input === "R") return onRerun();
    if (input === "?") return onHelp();
    const scrollTo = (next: number) => {
      setScrolled(true);
      setTop(Math.min(most, Math.max(0, next)));
    };
    if (key.upArrow || input === "k") {
      // Above the first step, ↑ scrolls back up through what was read.
      if (selectedRef.current === 0 && first > 0) return scrollTo(first - 1);
      setScrolled(false);
      setTop(first);
      return setSelected((at) => Math.max(0, at - 1));
    }
    if (key.downArrow || input === "j") {
      // Past the last step, ↓ reads on down its log, a line at a time.
      if (selectedRef.current >= all.length - 1) return scrollTo(first + 1);
      setScrolled(false);
      setTop(first);
      return setSelected((at) => Math.min(all.length - 1, at + 1));
    }
    if (key.pageDown || input === "d") return scrollTo(first + room);
    if (key.pageUp || input === "u") return scrollTo(first - room);
    if (key.return || input === " ") {
      setTop(first);
      toggle(selectedRef.current);
    }
  });

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={entry.ok || entry.running ? "gray" : entry.interrupted ? "yellow" : "red"} paddingX={1} overflow="hidden">
      <Box ref={head} flexDirection="column" flexShrink={0}>
      <Text wrap="truncate-end">
        <Mark ok={entry.ok} running={entry.running} interrupted={entry.interrupted} glyphs={glyphs} /> <Text bold>{entry.bolt}</Text>
        <Text dimColor>{` #${entry.number ?? ""}`}</Text>
        <Text dimColor>{`   ${entry.workspaceName}`}</Text>
      </Text>
      <Summary entry={entry} />
      {drawn ? (
      <Box flexWrap="wrap" marginTop={1}>
        {graph.map((column, at) => (
          <Box key={at} alignItems="flex-start">
            {at > 0 ? <Box marginTop={1}><Text dimColor>{glyphs.border === "round" ? " ──▶ " : " --> "}</Text></Box> : null}
            <Box flexDirection="column">
              {column.map((node, row) => (
                <Box key={row} borderStyle="round" borderColor={node.state === "running" ? "cyan" : node.state === "waiting" || node.skipped ? "gray" : node.ok ? "green" : "red"} paddingX={1}>
                  <Text wrap="truncate-end">
                    <Mark ok={node.ok} skipped={node.skipped} running={node.state === "running"} waiting={node.state === "waiting"} glyphs={glyphs} /> {node.label}
                    {node.detail ? <Text dimColor>{` ${node.detail}`}</Text> : null}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
      ) : (
        <Text> </Text>
      )}
      {filtering || typing ? (
        <FilterLine
          query={query}
          typing={typing}
          found={
            !filtering ? (
              <Text dimColor>type to keep only the log lines with it</Text>
            ) : matches > 0 ? (
              <Text dimColor>{`${matches} match${matches === 1 ? "" : "es"} in ${matchingSteps} step${matchingSteps === 1 ? "" : "s"}${reading ? ", reading the rest…" : ""}`}</Text>
            ) : (
              <Text color={reading ? undefined : "red"} dimColor={reading}>{reading ? "reading the logs…" : "no line matches in any step"}</Text>
            )
          }
        />
      ) : null}
      </Box>
      {visible.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

/** The line under a run's title: how it started, against what, how it ended, how long. */
function Summary({ entry }: { entry: HistoryEntry }) {
  const cells: [string, string, string?][] = [
    ["Triggered", `${triggerWords(entry.trigger) ? `from ${triggerWords(entry.trigger)} ` : ""}${since(entry.startedAt)}`],
    ...(entry.git ? ([["Commit", `${entry.git.branch} @ ${entry.git.commit}${entry.git.subject ? `  “${clip(entry.git.subject, 40)}”` : ""}`]] as [string, string][]) : []),
    ...(entry.inputs ? ([["With", Object.entries(entry.inputs).map(([name, value]) => `${name}=${value}`).join(" ")]] as [string, string][]) : []),
    entry.running
      ? ["Status", `Running, step ${Math.min(entry.steps.length + 1, entry.total ?? entry.steps.length + 1)} of ${entry.total ?? "?"}`, "cyan"]
      : entry.interrupted
        ? ["Status", "Interrupted", "yellow"]
        : ["Status", entry.ok ? "Success" : "Failed", entry.ok ? "green" : "red"],
    ["Total duration", entry.interrupted ? "unknown" : formatDuration(totalMs(entry)) || "0ms"],
  ];
  return (
    <Box marginTop={1}>
      {cells.map(([title, value, color]) => (
        <Box key={title} flexDirection="column" marginRight={4} flexShrink={title === "Commit" ? 1 : 0}>
          <Text dimColor>{title}</Text>
          <Text bold color={color} wrap="truncate-end">
            {value}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export interface GraphNode {
  label: string;
  detail?: string;
  ok: boolean;
  skipped?: boolean;
  state?: StepProgress;
}

/**
 * A run as a pipeline, in columns by when things could start: a box per bolt when the run
 * went through several, a box per step when it ran one. What ran at the same time stacks.
 */
export function pipeline(entry: HistoryEntry): GraphNode[][] {
  const steps = allSteps(entry);
  const stageOf = (step: HistoryStep, at: number) => step.stage ?? at + 1;
  const owners = [...new Set(steps.map((step) => step.bolt ?? baseLabel(entry.bolt)))];
  const nodes: (GraphNode & { key: string; stage: number; steps: number; ms: number; done: number })[] = [];
  steps.forEach((step, at) => {
    const owner = step.bolt ? (step.workspace ? `${step.workspace} › ${step.bolt}` : step.bolt) : baseLabel(entry.bolt);
    const key = owners.length > 1 ? owner : `${at}`;
    let node = nodes.find((candidate) => candidate.key === key);
    if (!node) {
      node = { key, label: owners.length > 1 ? owner : step.label, ok: true, skipped: true, stage: stageOf(step, at), steps: 0, ms: 0, done: 0 };
      nodes.push(node);
    }
    node.stage = Math.min(node.stage, stageOf(step, at));
    node.steps += 1;
    if (step.state === "running") node.state = "running";
    if (step.state) return;
    node.done += 1;
    node.ms += step.durationMs;
    node.ok = node.ok && step.ok;
    node.skipped = Boolean(node.skipped && step.skipped);
  });
  const stages = [...new Set(nodes.map((node) => node.stage))].sort((left, right) => left - right);
  return stages.map((stage) =>
    nodes
      .filter((node) => node.stage === stage)
      .map(({ label, ok, skipped, steps: count, ms, done, state: running }) => {
        const state = running ?? (done < count ? "running" : undefined);
        const waiting = done === 0 && !running;
        const detail = owners.length > 1 ? `${count} step${count === 1 ? "" : "s"}${ms > 0 ? ` ${formatDuration(ms)}` : ""}` : ms > 0 ? formatDuration(ms) : "";
        return {
          label,
          ...(detail ? { detail } : {}),
          ok,
          ...(skipped && !state ? { skipped } : {}),
          ...(waiting ? { state: "waiting" as const } : state ? { state } : {}),
        };
      }),
  );
}

function graphWidth(columns: GraphNode[][]): number {
  return columns.reduce((total, column) => total + Math.max(...column.map((node) => node.label.length + (node.detail?.length ?? 0) + 6)) + 5, 0);
}

/** A past step as the sentence the rest of Wisp would use for it. */
export function describeHistoryStep(step: HistoryStep): string {
  switch (step.kind) {
    case "command":
      return `${step.finishes ? "run" : "start"} ${step.label}`;
    case "compose":
      return `start Docker services: ${step.label}`;
    case "wait":
      return /^\d+(\.\d+)?s$/.test(step.label)
        ? `wait ${step.label}`
        : /^https?:/.test(step.label)
          ? `wait until ${step.label} answers`
          : `wait until ${step.label} is open`;
    case "link":
      return `open ${step.label !== step.value ? step.label : shortUrl(step.value)}`;
    case "folder":
      return `open the ${step.label} folder`;
    default:
      return `open ${step.label}`;
  }
}

/** The sidebar: every bolt that has run, grouped by workspace, after "All bolts". */
function boltFilters(entries: HistoryEntry[]): BoltFilter[] {
  const byKey = new Map<string, BoltFilter>();
  for (const entry of entries) {
    const bolt = baseLabel(entry.bolt);
    const key = `${entry.workspace}#${bolt}`;
    const found = byKey.get(key);
    if (found) found.count += 1;
    else byKey.set(key, { key, workspace: entry.workspace, workspaceName: entry.workspaceName, bolt, count: 1 });
  }
  const bolts = [...byKey.values()].sort((left, right) => (left.workspaceName ?? "").localeCompare(right.workspaceName ?? "") || (left.bolt ?? "").localeCompare(right.bolt ?? ""));
  return [{ key: "all", count: entries.length }, ...bolts];
}

function Mark({ ok, skipped, running, waiting, interrupted, glyphs }: { ok: boolean; skipped?: boolean | undefined; running?: boolean | undefined; waiting?: boolean | undefined; interrupted?: boolean | undefined; glyphs: Glyphs }) {
  if (running) return <Text color="cyan">{glyphs.dot}</Text>;
  if (waiting) return <Text dimColor>{glyphs.pending}</Text>;
  if (skipped) return <Text dimColor>{glyphs.skip}</Text>;
  if (interrupted) return <Text color="yellow">!</Text>;
  return ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>;
}

function totalMs(entry: HistoryEntry): number {
  return Math.max(0, (entry.running ? Date.now() : Date.parse(entry.finishedAt)) - Date.parse(entry.startedAt));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return ms > 0 ? `${ms}ms` : "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function triggerWords(trigger: string | undefined): string {
  return { tui: "the dashboard", cli: "the command line", hook: "a git hook", retry: "a retry" }[trigger ?? ""] ?? "";
}


/** How many lines text takes, wrapped at spaces to a width as the terminal will show it. */
export function wrappedLines(text: string, width: number): number {
  if (width <= 0) return 1;
  let lines = 1;
  let used = 0;
  text.split(" ").forEach((word, at) => {
    const length = word.length;
    if (at === 0) used = length;
    else if (used + 1 + length <= width) used += 1 + length;
    else {
      lines += 1;
      used = length;
    }
    // A word longer than the line is cut across lines.
    while (used > width) {
      lines += 1;
      used -= width;
    }
  });
  return lines;
}

/** Cut to a column's width, saying so when it is cut. */
function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

/** The search box of a list: what is typed, and a cursor while typing. */
export function SearchLine({ query, typing }: { query: string; typing: boolean }) {
  return (
    <Text wrap="truncate-end">
      <Text color={TONE.accent}>/ </Text>
      <Text>{query}</Text>
      {typing ? <Text inverse> </Text> : <Text dimColor>{"  esc clears"}</Text>}
    </Text>
  );
}

/** What a run can be found by: its bolt, where, the commit, how it went and where it failed. */
function searchText(entry: HistoryEntry): (string | undefined)[] {
  const failedAt = entry.steps.find((step) => !step.ok && !step.skipped);
  return [
    entry.bolt,
    `#${entry.number ?? ""}`,
    entry.workspaceName,
    entry.ok ? "passed success ok" : "failed failure",
    failedAt ? failedAt.label : "",
    entry.git?.branch,
    entry.git?.commit,
    entry.git?.subject,
    triggerWords(entry.trigger),
    entry.id,
  ];
}

/** Marks a step's log as gone, which is not the same as empty. */
const GONE: string[] = [];

/** Why a step has no output to show, in words. */
function noOutput(step: HistoryStep): string {
  switch (step.kind) {
    case "command":
      return step.finishes || step.skipped
        ? step.skipped
          ? "It did not run."
          : "It printed nothing."
        : "No output was kept for it — it ran in a window of its own, or before History kept what background commands print. While it runs, Running (p) shows it live.";
    case "wait":
      return step.ok ? `It was ready after ${formatDuration(step.durationMs) || "a moment"}.` : (step.error ?? "It gave up waiting.");
    case "bolt":
      return "Its steps are listed above.";
    case "compose":
      return "Docker started the containers — Running (p) shows their logs.";
    default:
      return step.skipped ? "It did not run." : `It opened ${step.label} — there is nothing to show for that.`;
  }
}

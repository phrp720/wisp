import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { baseLabel, type HistoryEntry, type HistoryStep } from "../core/history.js";
import type { Glyphs } from "./glyphs.js";
import { spell } from "./spells.js";
import { TONE } from "./tones.js";
import { matchesAll, shortUrl, windowed, type Services } from "./model.js";

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
}

/** A bolt in the sidebar: the filter, like a workflow in a CI's list. */
interface BoltFilter {
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
  const { services, glyphs, height, columns, onClose, onRunning, onRetry, onRerun, onJump } = props;
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const [filterIndex, setFilterIndex] = useState(0);
  const [runIndex, setRunIndex] = useState(0);
  const [focus, setFocus] = useState<"bolts" | "runs">("runs");
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);

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
  }, [services]);

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
      if (onJump && (input === "1" || input === "2")) return onJump(input);
      if (run && input === "r" && !run.ok) return onRetry(run);
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
    { isActive: !opened },
  );

  if (!entries) {
    return (
      <Box height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text>
          <Text color={TONE.accent}>{`${spell(3)}… `}</Text>
          <Text dimColor>reading history</Text>
        </Text>
      </Box>
    );
  }

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
        <Box flexGrow={1} />
        <Text dimColor>esc back</Text>
      </Box>
    );
  }

  const sideWidth = Math.min(32, Math.max(22, Math.floor(columns * 0.24)));
  const { items: filterRows, offset: filterOffset } = windowed(filters, filterIndex, height - 3);
  const runRoom = Math.max(1, Math.floor((height - 5) / 2));
  const { items: runRows, offset: runOffset } = windowed(shown, runIndex, runRoom);
  const runWidth = Math.max(30, columns - sideWidth - 6);

  return (
    <Box height={height}>
      <Box flexDirection="column" width={sideWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={focus === "bolts" ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        <Text bold>
          Bolts
        </Text>
        {filterRows.map((entry, position) => {
          const at = filterOffset + position;
          const selected = at === filterIndex;
          const heading = entry.bolt && (at === 0 || filters[at - 1]?.workspace !== entry.workspace);
          return (
            <Box key={entry.key} flexDirection="column">
              {heading ? <Text dimColor>{(entry.workspaceName ?? "").toUpperCase()}</Text> : null}
              <Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text wrap="truncate-end" inverse={selected && focus === "bolts"} bold={selected}>
                    {selected ? glyphs.pointer : " "} {entry.bolt ?? "All bolts"}
                  </Text>
                </Box>
                <Text dimColor>{` ${entry.count}`}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focus === "runs" ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        <Text>
          <Text bold>{filter?.bolt ?? "All runs"}</Text>
          <Text dimColor>{`  ${shown.length} run${shown.length === 1 ? "" : "s"}`}</Text>
        </Text>
        {typing || query ? <SearchLine query={query} typing={typing} /> : <Text> </Text>}
        {shown.length === 0 ? <Text dimColor>{`No run matches “${query}”. esc clears it.`}</Text> : null}
        {runRows.map((entry, position) => {
          const at = runOffset + position;
          const selected = at === runIndex && focus === "runs";
          const failedAt = entry.steps.find((step) => !step.ok && !step.skipped);
          // A fixed width, so the times line up down the list whatever their length.
          const right = `${(formatDuration(totalMs(entry)) || "0ms").padStart(7)} · ${ago(entry.startedAt).padEnd(8)}`;
          const branch = entry.git ? ` ${entry.git.branch} ` : "";
          return (
            <Box key={entry.id} flexDirection="column">
              <Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text wrap="truncate-end" bold={selected} color={selected ? TONE.accent : undefined}>
                    {selected ? glyphs.pointer : " "} <Mark ok={entry.ok} glyphs={glyphs} /> {entry.bolt}
                    <Text dimColor>{` #${entry.number ?? ""}`}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  {branch ? <Text color="#60a5fa" inverse>{branch}</Text> : null}
                  <Text dimColor>{`  ${right}`}</Text>
                </Box>
              </Box>
              <Text wrap="truncate-end" dimColor>
                {`    ${clip(
                  [
                    failedAt ? `failed at ${failedAt.label}` : "",
                    entry.git?.subject ? `“${entry.git.subject}”` : "",
                    entry.git ? entry.git.commit : "",
                    triggerWords(entry.trigger),
                    filter?.bolt ? "" : entry.workspaceName,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  runWidth - 4,
                )}`}
              </Text>
            </Box>
          );
        })}
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate-end">
          {[focus === "runs" ? "⏎ open the run" : "→ its runs", "← bolts", "/ search", run && !run.ok ? "r retry what failed" : "", "R run again", "p running", "esc back"]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Box>
    </Box>
  );
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
}) {
  const { entry, services, glyphs, height, columns, onBack, onRetry, onRerun } = props;
  const firstFailed = Math.max(0, entry.steps.findIndex((step) => !step.ok && !step.skipped));
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
  const [logs, setLogs] = useState<Map<number, string[]>>(new Map());
  const [top, setTop] = useState(0);
  // Whether you scrolled yourself (u, d, or past the ends with ↑↓), so the view stays put.
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    for (const at of expanded) {
      const step = entry.steps[at];
      if (!step?.log || logs.has(at)) continue;
      void services
        .readLog(step.log)
        .then((text) => {
          setLogs((prior) => new Map(prior).set(at, cleanOutput(text).split("\n").filter((line, index, all) => line !== "" || index < all.length - 1)));
        })
        .catch(() => setLogs((prior) => new Map(prior).set(at, GONE)));
    }
  }, [expanded, entry, services, logs]);

  // The steps and their open logs, as one list of rows to scroll through.
  const rows: { key: string; step?: number; node: ReactNode }[] = [];
  const longest = Math.max(1, ...entry.steps.map((step) => step.durationMs));
  // As wide as the longest step, so a step's time sits beside it rather than across the screen.
  const labelWidth = Math.min(Math.max(24, columns - 34), Math.max(16, ...entry.steps.map((step) => describeHistoryStep(step, entry.job).length + 2)));
  entry.steps.forEach((step, at) => {
    const isSelected = at === selected;
    const isOpen = expanded.has(at);
    const bar = step.durationMs > 0 ? "▇".repeat(Math.max(1, Math.round((step.durationMs / longest) * 12))) : "";
    rows.push({
      key: `s${at}`,
      step: at,
      node: (
        <Text wrap="truncate-end">
          <Text color={TONE.accent}>{isSelected ? glyphs.pointer : " "}</Text> {isOpen ? "▾" : "▸"} <Mark ok={step.ok} skipped={step.skipped} glyphs={glyphs} />{" "}
          <Text bold={isSelected} color={isSelected ? TONE.accent : undefined}>{fit(describeHistoryStep(step, entry.job), labelWidth)}</Text>
          <Text dimColor>{` ${formatDuration(step.durationMs).padStart(6)}  `}</Text>
          <Text color={step.ok ? TONE.accent : "red"}>{bar.padEnd(12)}</Text>
          {"  "}
          {step.error ? <Text color="red">{step.error}</Text> : step.note && !step.note.startsWith("logs:") ? <Text dimColor>{step.note}</Text> : null}
        </Text>
      ),
    });
    if (isOpen) {
      const lines = logs.get(at);
      const say = (text: string) => rows.push({ key: `l${at}`, node: <Text dimColor wrap="wrap">{`        ${text}`}</Text> });
      // Every step opens: one without output says why there is none, rather than nothing.
      if (!step.log) say(noOutput(step, entry.job ?? false));
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
  const graphRows = graph.length > 1 ? Math.max(1, Math.ceil(graphWidth(graph) / Math.max(20, columns - 6))) : 0;
  const room = Math.max(3, height - 8 - graphRows * 3);
  const selectedRow = Math.max(0, rows.findIndex((row) => row.step === selected));
  // The view follows the selected step, until you scroll yourself: then it stays where you
  // put it (it used to snap straight back to the step, so u and d seemed to do nothing).
  const most = Math.max(0, rows.length - room);
  const first = scrolled
    ? Math.min(most, Math.max(0, top))
    : Math.min(most, Math.max(0, selectedRow < top ? selectedRow : selectedRow >= top + room ? selectedRow - room + 1 : top));
  const visible = rows.slice(first, first + room);

  useInput((input, key) => {
    if (key.escape || key.leftArrow || input === "q") return onBack();
    if (input === "r" && !entry.ok) return onRetry();
    if (input === "R") return onRerun();
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
      if (selectedRef.current >= entry.steps.length - 1) return scrollTo(first + 1);
      setScrolled(false);
      setTop(first);
      return setSelected((at) => Math.min(entry.steps.length - 1, at + 1));
    }
    if (key.pageDown || input === "d") return scrollTo(first + room);
    if (key.pageUp || input === "u") return scrollTo(first - room);
    if (key.return || input === " ") {
      const at = selectedRef.current;
      setTop(first);
      setExpanded((prior) => {
        const next = new Set(prior);
        if (next.has(at)) next.delete(at);
        else next.add(at);
        return next;
      });
    }
  });

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={entry.ok ? "gray" : "red"} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Mark ok={entry.ok} glyphs={glyphs} /> <Text bold>{entry.bolt}</Text>
        <Text dimColor>{` #${entry.number ?? ""}`}</Text>
        <Text dimColor>{`   ${entry.workspaceName}`}</Text>
      </Text>
      <Summary entry={entry} />
      {graph.length > 1 ? (
      <Box flexWrap="wrap" marginTop={1}>
        {graph.map((node, at) => (
          <Box key={at} alignItems="center">
            {at > 0 ? <Text dimColor>{" ── "}</Text> : null}
            <Box borderStyle="round" borderColor={node.skipped ? "gray" : node.ok ? "green" : "red"} paddingX={1}>
              <Text wrap="truncate-end">
                <Mark ok={node.ok} skipped={node.skipped} glyphs={glyphs} /> {node.label}
                {node.detail ? <Text dimColor>{` ${node.detail}`}</Text> : null}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      ) : (
        <Text> </Text>
      )}
      {visible.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        {["↑↓ steps", "⏎ show or hide its log", "u d scroll", entry.ok ? "" : "r retry what failed", "R run again", "esc back to the runs"].filter(Boolean).join(" · ")}
      </Text>
    </Box>
  );
}

/** The line under a run's title: how it started, against what, how it ended, how long. */
function Summary({ entry }: { entry: HistoryEntry }) {
  const cells: [string, string, string?][] = [
    ["Triggered", `${triggerWords(entry.trigger) ? `from ${triggerWords(entry.trigger)} ` : ""}${ago(entry.startedAt)}`],
    ...(entry.git ? ([["Commit", `${entry.git.branch} @ ${entry.git.commit}${entry.git.subject ? `  “${clip(entry.git.subject, 40)}”` : ""}`]] as [string, string][]) : []),
    ["Status", entry.ok ? "Success" : "Failed", entry.ok ? "green" : "red"],
    ["Total duration", formatDuration(totalMs(entry)) || "0ms"],
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
}

/**
 * A run as a pipeline: one node per step — but a dependency's steps as one node, the way
 * a CI draws a reused workflow as one box with its jobs inside.
 */
export function pipeline(entry: HistoryEntry): GraphNode[] {
  // Like a CI's graph of jobs: one box per bolt the run went through — the ones it needed,
  // then its own — each with its steps counted inside. Steps themselves are the list below.
  const nodes: (GraphNode & { key: string; steps: number; ms: number })[] = [];
  for (const step of entry.steps) {
    const owner = step.bolt ? (step.workspace ? `${step.workspace} › ${step.bolt}` : step.bolt) : baseLabel(entry.bolt);
    let node = nodes.find((candidate) => candidate.key === owner);
    if (!node) {
      node = { key: owner, label: owner, ok: true, skipped: true, steps: 0, ms: 0 };
      nodes.push(node);
    }
    node.steps += 1;
    node.ms += step.durationMs;
    node.ok = node.ok && step.ok;
    node.skipped = Boolean(node.skipped && step.skipped);
  }
  return nodes.map(({ label, ok, skipped, steps, ms }) => ({
    label,
    detail: `${steps} step${steps === 1 ? "" : "s"}${ms > 0 ? ` ${formatDuration(ms)}` : ""}`,
    ok,
    ...(skipped ? { skipped } : {}),
  }));
}

function graphWidth(nodes: GraphNode[]): number {
  return nodes.reduce((total, node) => total + node.label.length + (node.detail?.length ?? 0) + 10, 0);
}

/** A past step as the sentence the rest of Wisp would use for it. */
export function describeHistoryStep(step: HistoryStep, job: boolean): string {
  switch (step.kind) {
    case "command":
      return `${job ? "run" : "start"} ${step.label}`;
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

function Mark({ ok, skipped, glyphs }: { ok: boolean; skipped?: boolean | undefined; glyphs: Glyphs }) {
  if (skipped) return <Text dimColor>{glyphs.skip}</Text>;
  return ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>;
}

function totalMs(entry: HistoryEntry): number {
  return Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return ms > 0 ? `${ms}ms` : "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function triggerWords(trigger: string | undefined): string {
  return { tui: "the dashboard", cli: "the command line", hook: "a git hook", retry: "a retry" }[trigger ?? ""] ?? "";
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
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
function noOutput(step: HistoryStep, job: boolean): string {
  switch (step.kind) {
    case "command":
      return job || step.skipped
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

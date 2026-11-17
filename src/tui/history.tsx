import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import { cleanOutput } from "../core/ansi.js";
import type { HistoryEntry, HistoryStep } from "../core/history.js";
import type { Glyphs } from "./glyphs.js";
import { shortUrl, windowed, type Services } from "./model.js";

type Focus = "runs" | "steps" | "log";

export interface HistoryScreenProps {
  services: Services;
  glyphs: Glyphs;
  height: number;
  columns: number;
  onClose: () => void;
  /** Go to what is running instead. */
  onRunning: () => void;
  /** Run the failed part of this run again. */
  onRetry: (entry: HistoryEntry) => void;
  /** Run the whole bolt again. */
  onRerun: (entry: HistoryEntry) => void;
}

/**
 * Every run, the way a CI shows them: what ran, whether it passed, how long it took, what
 * started it and against which commit — then its steps with their timings, then any step's
 * full log. A failed run opens on the step that failed.
 */
export function HistoryScreen({ services, glyphs, height, columns, onClose, onRunning, onRetry, onRerun }: HistoryScreenProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const [runIndex, setRunIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [focus, setFocus] = useState<Focus>("runs");
  const [log, setLog] = useState<string>();
  const [scroll, setScroll] = useState(0);

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

  const run = entries?.[runIndex];
  const step = run?.steps[stepIndex];

  const select = (at: number) => setRunIndex(at);
  // Opening a run lands on the step that matters: the first that failed.
  useEffect(() => {
    const failed = run?.steps.findIndex((entry) => !entry.ok && !entry.skipped) ?? -1;
    setStepIndex(Math.max(0, failed));
  }, [run?.id]);

  const openLog = async (target: HistoryStep | undefined) => {
    if (!target?.log) return;
    setLog(await services.readLog(target.log));
    setScroll(0);
    setFocus("log");
  };

  const logLines = useMemo(() => (log === undefined ? [] : cleanOutput(log).split("\n").filter((line, at, all) => line !== "" || at < all.length - 1)), [log]);
  const logRoom = Math.max(1, height - 4);

  useInput((input, key) => {
    if (!entries) return;
    if (focus === "log") {
      const most = Math.max(0, logLines.length - logRoom);
      if (key.escape || key.leftArrow || input === "q") return setFocus("steps");
      if (key.upArrow || input === "k") return setScroll((at) => Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setScroll((at) => Math.min(most, at + 1));
      if (key.pageUp || input === "u") return setScroll((at) => Math.max(0, at - logRoom));
      if (key.pageDown || input === "d" || input === " ") return setScroll((at) => Math.min(most, at + logRoom));
      if (input === "g") return setScroll(0);
      if (input === "G") return setScroll(most);
      return;
    }

    if (input === "p") return onRunning();
    if (input === "h" && focus === "runs") return onClose();
    if (run && input === "r" && !run.ok) return onRetry(run);
    if (run && input === "R") return onRerun(run);

    if (focus === "runs") {
      if (key.escape || input === "q") return onClose();
      if (key.upArrow || input === "k") return select(Math.max(0, runIndex - 1));
      if (key.downArrow || input === "j") return select(Math.min(entries.length - 1, runIndex + 1));
      if ((key.return || key.rightArrow || key.tab) && run) return setFocus("steps");
      return;
    }

    // Steps.
    if (key.escape || key.leftArrow || (key.shift && key.tab)) return setFocus("runs");
    if (key.upArrow || input === "k") return setStepIndex((at) => Math.max(0, at - 1));
    if (key.downArrow || input === "j") return setStepIndex((at) => Math.min((run?.steps.length ?? 1) - 1, at + 1));
    if (key.return) return void openLog(step);
  });

  if (!entries) {
    return (
      <Box height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text dimColor>reading history…</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
        <Text bold>History</Text>
        <Text> </Text>
        <Text>Nothing has run yet. Every run of a bolt shows up here: whether it worked, how long each step took, and what it printed.</Text>
        <Box flexGrow={1} />
        <Text dimColor>esc back</Text>
      </Box>
    );
  }

  if (focus === "log" && run && step) {
    const shown = logLines.slice(scroll, scroll + logRoom);
    const width = String(logLines.length).length;
    return (
      <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={step.ok ? "gray" : "red"} paddingX={1}>
        <Text wrap="truncate-end">
          <Mark step={step} glyphs={glyphs} /> <Text bold>{step.label}</Text>
          <Text dimColor>{`  ${run.bolt} · ${run.workspaceName} · ${formatDuration(step.durationMs)}${logLines.length > 0 ? ` · lines ${scroll + 1}–${Math.min(logLines.length, scroll + logRoom)} of ${logLines.length}` : ""}`}</Text>
        </Text>
        {shown.length === 0 ? <Text dimColor>It printed nothing.</Text> : null}
        {shown.map((line, at) => (
          <Text key={at} wrap="truncate-end">
            <Text dimColor>{`${String(scroll + at + 1).padStart(width)} `}</Text>
            {line || " "}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text dimColor>↑↓ scroll · pgup/pgdn a page · g/G start/end · esc back to the steps</Text>
      </Box>
    );
  }

  // The list of runs, by day.
  const listWidth = Math.min(46, Math.max(30, Math.floor(columns * 0.38)));
  type Row = { key: string; heading?: string; at?: number };
  const rows: Row[] = [];
  let day = "";
  entries.forEach((entry, at) => {
    const label = dayLabel(entry.startedAt);
    if (label !== day) {
      day = label;
      rows.push({ key: `d:${label}`, heading: label });
    }
    rows.push({ key: entry.id, at });
  });
  const selectedRow = Math.max(0, rows.findIndex((row) => row.at === runIndex));
  const visibleRows = windowed(rows, selectedRow, Math.floor((height - 3) / 2) + 2).items;

  const longest = Math.max(1, ...(run?.steps.map((entry) => entry.durationMs) ?? [1]));
  // The step's sentence gets what the panel can spare after the time and its bar.
  const labelWidth = Math.max(24, Math.min(56, columns - listWidth - 34));
  const stepsRoom = Math.max(1, height - 7);
  const { items: shownSteps, offset } = windowed(run?.steps ?? [], stepIndex, stepsRoom);

  return (
    <Box height={height}>
      <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={focus === "runs" ? "#a78bfa" : "gray"} paddingX={1} overflow="hidden">
        <Text bold>History</Text>
        {visibleRows.map((row) => {
          if (row.heading) {
            return (
              <Text key={row.key} dimColor>
                {row.heading.toUpperCase()}
              </Text>
            );
          }
          const entry = entries[row.at as number] as HistoryEntry;
          const selected = row.at === runIndex;
          const failedAt = entry.steps.find((item) => !item.ok && !item.skipped);
          return (
            <Box key={row.key} flexDirection="column">
              <Text wrap="truncate-end" inverse={selected && focus === "runs"} bold={selected}>
                {entry.ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>} {entry.bolt}
                <Text dimColor>{`  ${formatDuration(totalMs(entry))} · ${ago(entry.startedAt)}`}</Text>
              </Text>
              <Text wrap="truncate-end" dimColor>
                {`  ${[failedAt ? `failed at ${failedAt.label}` : "", entry.workspaceName, triggerWords(entry.trigger), entry.git ? `${entry.git.branch} @ ${entry.git.commit}` : ""].filter(Boolean).join(" · ")}`}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focus === "steps" ? "#a78bfa" : run?.ok ? "gray" : "red"} paddingX={1} overflow="hidden">
        {run ? (
          <>
            <Text wrap="truncate-end">
              <Mark step={{ ok: run.ok }} glyphs={glyphs} /> <Text bold>{run.bolt}</Text>
              <Text>{` · ${run.ok ? "passed" : "failed"} in ${formatDuration(totalMs(run))}`}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {[triggerWords(run.trigger) ? `from ${triggerWords(run.trigger)}` : "", run.git ? `${run.git.branch} @ ${run.git.commit}` : "", ago(run.startedAt), new Date(run.startedAt).toLocaleString()].filter(Boolean).join(" · ")}
            </Text>
            <Text> </Text>
            {shownSteps.map((entry, position) => {
              const at = offset + position;
              const selected = focus === "steps" && at === stepIndex;
              // Bars in their own fixed column, drawn plain — never inverted, which turns
              // a bar into a block — with a gap before whatever is said after them.
              const bar = entry.durationMs > 0 ? "▇".repeat(Math.max(1, Math.round((entry.durationMs / longest) * 12))) : "";
              const said = describeHistoryStep(entry, run.job);
              const note = entry.error ?? (entry.note && !entry.note.startsWith("logs:") ? entry.note : undefined);
              return (
                <Text key={at} wrap="truncate-end">
                  <Text color="#a78bfa">{selected ? glyphs.pointer : " "}</Text> <Mark step={entry} glyphs={glyphs} />{" "}
                  <Text bold={selected} color={selected ? "#a78bfa" : undefined}>{fit(said, labelWidth)}</Text>
                  <Text dimColor>{` ${formatDuration(entry.durationMs).padStart(6)}  `}</Text>
                  <Text color={entry.ok ? "#a78bfa" : "red"}>{bar.padEnd(12)}</Text>
                  {"  "}
                  {note ? <Text color={entry.error ? "red" : undefined} dimColor={!entry.error}>{note}</Text> : null}
                  {entry.log ? <Text dimColor>{`${note ? "  " : ""}⏎ log`}</Text> : null}
                </Text>
              );
            })}
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate-end">
              {[
                focus === "runs" ? "→ its steps" : "⏎ open a step's log · ← the runs",
                run.ok ? "" : "r retry what failed",
                "R run it all again",
                "p running",
                "esc back",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

/** A past step as the sentence the rest of Specter would use for it. */
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

/** Cut to a column's width, saying so when it is cut. */
function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function Mark({ step, glyphs }: { step: { ok: boolean; skipped?: boolean }; glyphs: Glyphs }) {
  if (step.skipped) return <Text dimColor>{glyphs.skip}</Text>;
  return step.ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>;
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
  return { tui: "the TUI", cli: "the command line", hook: "a git hook", retry: "a retry" }[trigger ?? ""] ?? "";
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

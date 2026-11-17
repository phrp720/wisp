/** The Running screen: what bolts started, grouped under them, with live output and an activity log. */

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { type Container, containerMood, type ContainerStats, shortStatus } from "../core/docker.js";
import type { HistoryEntry } from "../core/history.js";
import type { RunStatus } from "../core/processes.js";
import { RESTART_MARK } from "../core/shell.js";
import type { WorkspaceRead } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { SearchLine } from "./history.js";
import { describeStep, matchesAll, windowed } from "./model.js";
import { type Activity, clock, type PaneGroup, type PaneItem, type RunState, since } from "./state.js";
import { TONE } from "./tones.js";

/**
 * What Specter is running, each in a pane of its own: the list on the left, each with its
 * last line, and the selected one's live output filling the rest — colours and all.
 */
/**
 * What is running, each in a pane of its own: Specter's commands and Docker's containers
 * together, in a list on the left with how each is doing, and the selected one's live
 * output filling the rest — colours and all.
 */
export function PanesPanel(props: {
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
export function groupPanes(head: PaneItem[], runs: RunStatus[], containers: Container[], reads: WorkspaceRead[]): PaneItem[] {
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
export function filterPanes(items: PaneItem[], query: string): PaneItem[] {
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
export function groupBolt(items: PaneItem[], key: string): string | undefined {
  const found = items.find((item): item is PaneItem & { type: "group" } => item.type === "group" && item.group.key === key);
  return found?.group.bolt;
}

/**
 * Which run started a task, as History numbers it: " #4" under its own bolt, or
 * " from Work on web #2" when another bolt's run brought it up as a dependency. `long`
 * always names the bolt. Nothing while that run is still going and not in History yet.
 */
export function startedBy(run: RunStatus, history: HistoryEntry[], bolt: string | undefined, long = false): string {
  const entry = run.historyId ? history.find((candidate) => candidate.id === run.historyId) : undefined;
  if (!entry?.number) return "";
  const name = entry.bolt.replace(/ \((retry|down)\)$/, "");
  return !long && name === bolt ? ` #${entry.number}` : ` from ${name} #${entry.number}`;
}

/** The tasks under a bolt in the Running list. */
export function groupMembers(items: PaneItem[], key: string): (PaneItem & { type: "run" | "container" })[] {
  return items.filter((item): item is PaneItem & { type: "run" | "container" } => (item.type === "run" || item.type === "container") && item.group === key);
}

/** How many of a bolt's tasks are up, and how many are in trouble. */
export function groupTally(items: PaneItem[], key: string): { up: number; bad: number; total: number } {
  const members = groupMembers(items, key);
  const up = members.filter((item) => (item.type === "run" ? item.run.alive : item.container.state === "running")).length;
  const bad = members.filter((item) => (item.type === "run" ? false : containerMood(item.container).tone === "bad")).length;
  return { up, bad, total: members.length };
}

/** A bolt selected in the Running list: what it started, at a glance, and what keys do. */
export function GroupSummary({ items, group, history, stats, glyphs }: { items: PaneItem[]; group: PaneGroup; history: HistoryEntry[]; stats: Map<string, ContainerStats>; glyphs: Glyphs }) {
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
export function paneKey(item: PaneItem): string {
  if (item.type === "current") return "current";
  if (item.type === "group") return `group:${item.group.key}`;
  return item.type === "run" ? item.run.id : `container:${item.container.name}`;
}

/** How often a command has been brought back, read from the marks its restart loop logs. */
export function restartsOf(lines: string[]): { count: number; gaveUp: boolean } {
  let count = 0;
  let gaveUp = false;
  for (const line of lines) {
    if (line.includes(RESTART_MARK)) count += 1;
    if (line.includes("[specter]") && line.includes("gave up after")) gaveUp = true;
  }
  return { count, gaveUp };
}

export function restartNote(lines: string[]): string | undefined {
  const { count } = restartsOf(lines);
  return count > 0 ? `restarted ${count}× — ${lastLine(lines) ?? ""}` : undefined;
}

export function lastLine(lines: string[]): string | undefined {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]?.replace(/\u001B\[[0-9;]*m/g, "").trim();
    if (line) return line;
  }
  return undefined;
}

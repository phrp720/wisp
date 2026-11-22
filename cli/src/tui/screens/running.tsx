import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { type Container, containerMood, type ContainerStats } from "../../core/system/docker.js";
import { baseLabel, type HistoryEntry } from "../../core/history.js";
import { KEEP_FINISHED, type RunStatus } from "../../core/system/processes.js";
import type { WorkspaceRead } from "../../core/types.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { describeHistoryStep, SearchLine } from "./history.js";
import { FilterLine, MatchLine } from "../components/logfilter.js";
import { describeStep } from "../model.js";
import { type Activity, clock, type PaneGroup, type PaneItem, type PaneTab, type RunState, since } from "../state.js";
import { TONE } from "../terminal/tones.js";
import { type Detail, TAB_TITLE, clip, containerDetails, endedAs, groupMembers, groupTally, logWindow, paneList, paneListWidth, pastRuns, restartsOf, runDetails, shortStep, shownTab, startedBy, tabSeparator, tabsOf, waitingWords, when } from "./panes.js";

/**
 * What Wisp is running, each in a pane of its own: the list on the left, each with its
 * last line, and the selected one's live output filling the rest — colours and all.
 */
/**
 * What is running, each in a pane of its own: Wisp's commands and Docker's containers
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
  /** The tab chosen for the panel; a row without it shows its logs. */
  tab?: PaneTab | undefined;
  /** The workspaces, to find a command's env and restart policy for its Info tab. */
  reads?: WorkspaceRead[];
  /** The log filter: only lines with every word of it show. `logTyping` while it is written. */
  logQuery?: string | undefined;
  logTyping?: boolean | undefined;
  glyphs: Glyphs;
  height: number;
  columns: number;
}) {
  const { items, activity, history, query, typing, runs, active, tick, stats, dockerError, all, index, log, scroll, full, reads = [], logQuery = "", logTyping = false, glyphs, height, columns } = props;
  const listWidth = paneListWidth(columns);
  const item = items[index];
  const tabs = tabsOf(item);
  const tab = shownTab(item, props.tab);
  const { lines, filtering, matched, room, total } = logWindow({ item, tab: props.tab, log, logQuery, logTyping, height });
  const end = Math.max(room, total - scroll);
  // Scrolled back: said where it can't be cut off. The tab bar has room; a long command in the header may not.
  const back = scroll > 0 && tab === "logs" ? <Text color="yellow">{`↑ ${scroll} lines back — G to follow`}</Text> : null;
  const shown = lines.slice(Math.max(0, end - room), end);
  const shownMatches = matched?.slice(Math.max(0, end - room), end);
  const numberWidth = String(lines.length).length;

  // Rows for the list: workspace headings, each bolt, then its pipeline — one line a step,
  // in the order its run went, with how each one is doing on the right.
  const list = paneList({ items, active, index, height, searching: Boolean(typing || query), activity: activity.length });
  const width = listWidth - 4;
  /** One line: the left part truncates; the right part is always shown. */
  const line = (selected: boolean, depth: number, mark: ReactNode, label: ReactNode, right: string, rightColor?: string | undefined) => (
    <Box width={width}>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={TONE.accent}>{selected ? glyphs.pointer : " "}</Text>
          {" ".repeat(depth * 2 + 1)}
          {mark}
          {mark ? " " : ""}
          <Text bold={selected} color={selected ? TONE.accent : undefined}>{label}</Text>
        </Text>
      </Box>
      {right ? <Text color={rightColor} dimColor={!rightColor} wrap="truncate-end">{` ${clip(right, Math.floor(width * 0.45))}`}</Text> : null}
    </Box>
  );
  const nodeOf = (entry: PaneItem, at: number): ReactNode => {
    const selected = at === index;
    if (entry.type === "group") {
      const tally = groupTally(items, entry.group.key);
      const state =
        tally.bad > 0
          ? { text: `${glyphs.dot} ${tally.bad} in trouble`, color: TONE.failed }
          : tally.total === 0
            ? { text: "", color: TONE.stopped }
            : tally.up === tally.total
              ? { text: `${glyphs.dot} up`, color: TONE.up }
              : tally.up > 0
                ? { text: `${glyphs.dot} ${tally.up} of ${tally.total} up`, color: TONE.busy }
                : { text: `${glyphs.dot} stopped`, color: TONE.stopped };
      // The run the pipeline below comes from, as History numbers it.
      const number = entry.group.number;
      return line(
        selected,
        0,
        null,
        <Text>
          {entry.group.bolt ? `${glyphs.bolt}${entry.group.title}` : entry.group.title}
          {number ? <Text dimColor bold={false}>{` #${number}`}</Text> : null}
        </Text>,
        state.text,
        state.color,
      );
    }
    if (entry.type === "current") {
      if (!active) return null;
      const now = active.steps.find((step) => step.state === "running");
      const failed = active.steps.some((step) => step.result && !step.result.ok && !step.result.skipped);
      const mark = !active.done ? (
        <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>
      ) : failed || active.error || active.stopped ? (
        <Text color={TONE.failed}>{glyphs.fail}</Text>
      ) : (
        <Text color={TONE.up}>{glyphs.ok}</Text>
      );
      return line(selected, 0, mark, `${glyphs.bolt}${active.bolt}`, active.stopped ? "stopped" : now ? describeStep(now.target, true) : active.done ? (failed ? "failed" : "done") : waitingWords(glyphs, Math.floor(width * 0.45)), failed || active.stopped ? TONE.failed : undefined);
    }
    if (entry.type === "step") {
      const step = entry.step;
      const label = step.kind === "pipeline" ? `${glyphs.bolt}${step.label}` : shortStep(step);
      if (step.state === "running") return line(selected, entry.depth ?? 1, <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>, label, "running");
      if (step.state === "waiting") return line(selected, entry.depth ?? 1, <Text dimColor>{glyphs.pending}</Text>, label, "waiting", "gray");
      const mark = step.skipped ? <Text dimColor>{glyphs.skip}</Text> : step.ok ? <Text color={TONE.up}>{glyphs.ok}</Text> : <Text color={TONE.failed}>{glyphs.fail}</Text>;
      return line(selected, entry.depth ?? 1, mark, label, step.skipped ? "" : !step.ok ? "failed" : step.durationMs >= 1000 ? `${(step.durationMs / 1000).toFixed(1)}s` : "", !step.ok && !step.skipped ? TONE.failed : undefined);
    }
    if (entry.type === "run") {
      const run = entry.run;
      const restarts = selected ? restartsOf(lines) : { count: 0, gaveUp: false };
      const right = run.alive && run.waiting
        ? "waiting for an answer"
        : run.alive
        ? [`up ${since(run.startedAt).replace(" ago", "").replace("just now", "<1m")}`, restarts.count > 0 ? `${restarts.count}× restarted` : ""].filter(Boolean).join(" · ")
        : restarts.gaveUp
          ? "gave up"
          : endedAs(run);
      const failedRun = restarts.gaveUp || (!run.alive && run.exitCode !== undefined && run.exitCode !== 0);
      return line(selected, entry.depth ?? 1, <Text color={run.waiting ? TONE.busy : run.alive ? TONE.up : failedRun ? TONE.failed : TONE.stopped}>{glyphs.dot}</Text>, run.label, right, run.waiting ? TONE.busy : failedRun ? TONE.failed : undefined);
    }
    const container = entry.container;
    const mood = containerMood(container);
    const color = mood.tone === "good" ? TONE.up : mood.tone === "busy" ? TONE.busy : mood.tone === "bad" ? TONE.failed : TONE.stopped;
    return line(selected, entry.depth ?? 1, <Text color={color}>{glyphs.dot}</Text>, container.service, mood.word, mood.tone === "bad" ? TONE.failed : undefined);
  };

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
        {item.run.command !== item.run.label ? <Text dimColor>{`  ${item.run.command}`}</Text> : null}
        {item.run.alive && item.run.waiting ? <Text color={TONE.busy}>{`  ${glyphs.dot} waiting for an answer: "${item.run.waiting}"`}</Text> : item.run.alive ? <Text color={TONE.up}>{`  ${glyphs.dot} running`}</Text> : <Text color={item.run.exitCode ? TONE.failed : TONE.stopped}>{`  ${glyphs.dot} ${endedAs(item.run)}`}</Text>}
        <Text dimColor>{startedBy(item.run, history, undefined, true).replace(" from ", "  started by ")}</Text>
        {restartsOf(lines).count > 0 ? <Text color={TONE.busy}>{`  restarted ${restartsOf(lines).count}×`}</Text> : null}
      </Text>
    ) : item?.type === "step" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.step.kind === "pipeline" ? item.step.label : describeHistoryStep(item.step)}</Text>
        {item.step.skipped ? <Text dimColor>{"  not reached"}</Text> : item.step.ok ? <Text color={TONE.up}>{`  ${glyphs.ok} done`}</Text> : <Text color={TONE.failed}>{`  ${glyphs.fail} failed`}</Text>}
        <Text dimColor>{`  in ${baseLabel(item.entry.bolt)} #${item.entry.number ?? ""} · ${since(item.entry.startedAt)}`}</Text>
      </Text>
    ) : (
      <Text bold>Output</Text>
    );

  return (
    <Box height={height}>
      {full ? null : (
        <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
          <Text bold>
            {all ? "Running and stopped" : "Running"}
          </Text>
          {typing || query ? <SearchLine query={query} typing={typing} /> : null}
          {items.length === 0 ? <Text dimColor>{query ? `Nothing matches “${query}”. esc clears it.` : all ? "Nothing has run yet." : "Nothing is running right now. Run a pipeline from the Pipelines tab (1), or press \"o\" to show the ones that stopped."}</Text> : null}
          {dockerError ? <Text color="yellow" wrap="wrap">{`Docker: ${dockerError}`}</Text> : null}
          {list.visible.map((row) => (
            <Box key={row.key}>{row.kind === "item" ? nodeOf(items[row.at] as PaneItem, row.at) : row.kind === "heading" ? <Text bold dimColor>{row.text}</Text> : <Text> </Text>}</Box>
          ))}
          <Box flexGrow={1} />
          {list.logRoom > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>ACTIVITY</Text>
              {activity.slice(0, list.logRoom - 1).map((entry) => (
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
              : item?.type === "step"
                ? item.step.ok || item.step.skipped ? "gray" : TONE.failed
                : item && (item.type === "run" ? item.run.alive : containerMood(item.container).tone === "good") ? TONE.up : "gray"
        }
        paddingX={1}
      >
        {tabs.length > 0 ? <TabBar tabs={tabs} tab={tab} glyphs={glyphs} note={back} /> : null}
        <Text wrap="truncate-end">
          {header}
          {back && tabs.length === 0 ? <Text>{"  "}{back}</Text> : null}
        </Text>
        {filtering ? (
          <FilterLine
            query={logQuery}
            typing={logTyping}
            found={matched ? <Text color={matched.length === 0 ? TONE.failed : undefined} dimColor={matched.length > 0}>{matched.length === 0 ? `no line matches, of ${lines.length}` : `${matched.length} of ${lines.length} line${lines.length === 1 ? "" : "s"}`}</Text> : <Text dimColor>type to keep only the lines with it</Text>}
          />
        ) : null}
        {shownMatches ? (
          shownMatches.map((match) => <MatchLine key={match.at} at={match.at} text={match.text} query={logQuery} width={numberWidth} />)
        ) : tab === "info" && item?.type === "run" ? (
          <Details rows={runDetails(item.run, reads, history, lines)} room={room} />
        ) : tab === "info" && item?.type === "container" ? (
          <Details rows={containerDetails(item.container, stats.get(item.container.name))} room={room} />
        ) : tab === "runs" && item?.type === "run" ? (
          <PastRuns run={item.run} runs={runs} history={history} glyphs={glyphs} room={room} />
        ) : item?.type === "run" && !item.run.log ? (
          <Text dimColor>{`It runs in ${item.run.where ?? "a terminal window"} — its output is there.`}</Text>
        ) : item?.type === "group" ? (
          <GroupSummary items={items} group={item.group} history={history} stats={stats} glyphs={glyphs} />
        ) : item?.type === "step" && shown.length === 0 ? (
          <Text dimColor wrap="wrap">
            {item.step.kind === "pipeline"
              ? `${item.step.label} ran first and printed nothing.`
              : item.step.skipped
                ? item.step.note ?? "It was not reached."
                : item.step.error ?? `It printed nothing${item.step.durationMs ? ` and took ${item.step.durationMs >= 1000 ? `${(item.step.durationMs / 1000).toFixed(1)}s` : `${item.step.durationMs}ms`}` : ""}.`}
          </Text>
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
 * A bolt selected in the Running list. The list beside it already says how each step is
 * doing; this says what each of its commands and containers actually is, and what keys do.
 */
export function GroupSummary({ items, group }: { items: PaneItem[]; group: PaneGroup; history: HistoryEntry[]; stats: Map<string, ContainerStats>; glyphs: Glyphs }) {
  const members = groupMembers(items, group.key);
  return (
    <Box flexDirection="column" marginTop={1}>
      {members.map((member) =>
        member.type === "run" ? (
          <Text key={member.run.id} wrap="truncate-end">
            <Text bold>{member.run.label.padEnd(14)}</Text>
            <Text dimColor>{member.run.command}</Text>
            {member.run.cwd && member.run.cwd !== member.run.workspace.replace(/\/[^/]+$/, "") ? <Text dimColor>{`  in ${member.run.cwd.replace(/^.*\//, "")}`}</Text> : null}
          </Text>
        ) : (
          <Text key={member.container.name} wrap="truncate-end">
            <Text bold>{member.container.service.padEnd(14)}</Text>
            <Text dimColor>{`${member.container.image}${member.container.ports.length > 0 ? `  on localhost:${member.container.ports.map((port) => port.split("→")[0]).join(", ")}` : ""}`}</Text>
          </Text>
        ),
      )}
      <Text> </Text>
      <Text dimColor>
        {group.bolt ? `x stops all of ${group.bolt} · r restarts it · ↓ to a step for its output` : "Not started by a pipeline — choose one to stop it or see its output."}
      </Text>
    </Box>
  );
}

function TabBar({ tabs, tab, glyphs, note }: { tabs: PaneTab[]; tab: PaneTab; glyphs: Glyphs; note?: ReactNode }) {
  return (
    <Text wrap="truncate-end">
      {tabs.map((entry, at) => (
        <Text key={entry}>
          {at > 0 ? <Text dimColor>{tabSeparator(glyphs)}</Text> : null}
          {entry === tab ? (
            <Text bold underline color={TONE.accent}>
              {TAB_TITLE[entry]}
            </Text>
          ) : (
            <Text dimColor>{TAB_TITLE[entry]}</Text>
          )}
        </Text>
      ))}
      {note ? <Text>{"   "}{note}</Text> : <Text dimColor>{"   [ ] switch"}</Text>}
    </Text>
  );
}

function Details({ rows, room }: { rows: Detail[]; room: number }) {
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.slice(0, Math.max(1, room - 1)).map((row, at) => (
        <Text key={`${row.label}:${at}`} wrap="truncate-end">
          <Text dimColor>{row.label.padEnd(width)}</Text>
          <Text color={row.color}>{row.value}</Text>
        </Text>
      ))}
    </Box>
  );
}

function PastRuns({ run, runs, history, glyphs, room }: { run: RunStatus; runs: RunStatus[]; history: HistoryEntry[]; glyphs: Glyphs; room: number }) {
  const all = pastRuns(run, runs);
  const list = all.length > 0 ? all : [run];
  // Room for the list, a blank line above it and the note under it.
  const fits = Math.max(1, room - 3);
  return (
    <Box flexDirection="column" marginTop={1}>
      {list.slice(0, fits).map((candidate) => {
        const failed = !candidate.alive && candidate.exitCode !== undefined && candidate.exitCode !== 0;
        const state = candidate.alive ? (candidate.waiting ? "waiting for an answer" : "running") : endedAs(candidate);
        const color = candidate.alive ? (candidate.waiting ? TONE.busy : TONE.up) : failed ? TONE.failed : TONE.stopped;
        const self = candidate.id === run.id;
        return (
          <Text key={candidate.id} wrap="truncate-end">
            <Text color={TONE.accent}>{self ? glyphs.pointer : " "}</Text>
            <Text color={color}>{` ${glyphs.dot} `}</Text>
            <Text bold={self}>{when(candidate.startedAt).padEnd(13)}</Text>
            <Text color={failed ? TONE.failed : undefined} dimColor={!failed}>{state.padEnd(18)}</Text>
            <Text dimColor>{`${candidate.id}${startedBy(candidate, history, undefined, true)}`}</Text>
          </Text>
        );
      })}
      {list.length > fits ? <Text dimColor>{`  and ${list.length - fits} more`}</Text> : null}
      <Text dimColor wrap="truncate-end">{`  wisp logs <id> prints any of them. Wisp keeps the last ${KEEP_FINISHED} that ended.`}</Text>
    </Box>
  );
}

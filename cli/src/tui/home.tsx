/** The main screen: workspaces on the left, the selected one's bolts on the right; and search. */

import { Box, Text } from "ink";
import { Fragment } from "react";

import type { Container } from "../core/docker.js";
import { baseLabel, type HistoryEntry } from "../core/history.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { boltStatus, collectBoltTargets } from "../core/switch.js";
import type { Bolt, WorkspaceRead } from "../core/types.js";
import { slugify } from "../core/workspaces.js";
import { shortest } from "../cli/lib/render.js";
import { AskHere } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { describeStep, type SearchHit, windowed } from "./model.js";
import { counts, needsTrust, since } from "./state.js";
import { TONE } from "./tones.js";

/**
 * Every workspace, grouped by where it comes from — said in words rather than marks: the
 * project of the folder Wisp was opened in, the other projects you have used, and the
 * workspaces of your own.
 */
export interface Asking {
  question: string;
  yes: string;
  onAnswer: (yes: boolean) => void;
}

export function WorkspaceList(props: { reads: WorkspaceRead[]; index: number; here?: string | undefined; focused: boolean; glyphs: Glyphs; height: number; width: number; confirming?: Asking | undefined }) {
  const { reads, index, here, focused, glyphs, height, width, confirming } = props;
  const items = workspaceRows(reads, here, index, height - (confirming ? 3 : 0));

  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text bold dimColor={!focused}>
        Workspaces
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
          <Fragment key={read.workspace.file}>
            <Text wrap="truncate-end" bold={selected}>
              {selected ? glyphs.pointer : " "}{" "}
              {read.workspace.icon && glyphs.border === "round" ? `${read.workspace.icon} ` : ""}
              <Text color={selected && confirming ? "red" : selected && focused ? undefined : read.workspace.color} inverse={selected && (focused || Boolean(confirming))}>{read.workspace.name}</Text>
              {warn ? <Text color={TONE.busy} bold>{" !"}</Text> : null}
            </Text>
            {selected && confirming ? <AskHere stacked question={confirming.question} yes={confirming.yes} onAnswer={confirming.onAnswer} /> : null}
          </Fragment>
        );
      })}
    </Box>
  );
}

/** How wide the workspace list is, the bolts panel taking the rest. */
export function workspaceListWidth(columns: number): number {
  return Math.min(32, Math.max(18, Math.floor(columns * 0.28)));
}

/**
 * The workspace list's lines that fit: headings and workspaces as rows, so a long list
 * scrolls with its headings in place. Drawn from this, and clicks are matched against it.
 */
export function workspaceRows(reads: WorkspaceRead[], here: string | undefined, index: number, height: number): ({ heading: string } | { read: WorkspaceRead; at: number })[] {
  const group = (read: WorkspaceRead) => (read.workspace.file === here ? "This folder" : read.workspace.personal ? "Yours" : "Projects");
  const rows: ({ heading: string } | { read: WorkspaceRead; at: number })[] = [];
  reads.forEach((read, at) => {
    const previous = reads[at - 1];
    if (!previous || group(previous) !== group(read)) rows.push({ heading: group(read) });
    rows.push({ read, at });
  });
  const selectedRow = Math.max(0, rows.findIndex((row) => "at" in row && row.at === index));
  return windowed(rows, selectedRow, height - 3).items;
}

/** The line of the bolts panel its first bolt is on, counted from the panel's top border. */
export const FIRST_BOLT_LINE = 5;

const HEAD = 6;

export function boltWindow<T>(bolts: T[], boltIndex: number, height: number, asking = false): { items: T[]; offset: number; split: boolean; topHeight: number; stepRoom: number } {
  if (height >= 18 && bolts.length > 0) {
    const rows = Math.max(1, Math.min(bolts.length, Math.floor(height / 2) - HEAD));
    return { ...windowed(bolts, boltIndex, rows), split: true, topHeight: HEAD + rows + (asking ? 1 : 0), stepRoom: 0 };
  }
  const listRoom = Math.max(2, height - HEAD - 2);
  const rows = Math.max(1, Math.min(bolts.length, Math.ceil(listRoom / 2)));
  return { ...windowed(bolts, boltIndex, rows), split: false, topHeight: height, stepRoom: Math.max(1, listRoom - rows - (asking ? 1 : 0)) };
}

interface BoltState {
  text: string;
  color: string;
  dim?: boolean;
}

export function WorkspacePanel(props: { read: WorkspaceRead; boltIndex: number; focused: boolean; glyphs: Glyphs; height: number; width?: number; here?: boolean; runs: RunStatus[]; containers: Container[]; history: HistoryEntry[]; confirming?: Asking | undefined }) {
  const { read, boltIndex, focused, glyphs, height, width = 80, here = false, runs, containers, history, confirming } = props;
  const lastRun = (label: string) => history.find((entry) => baseLabel(entry.bolt) === label);
  const { workspace } = read;
  const bolts = workspace.bolts;
  const selected = bolts[Math.min(boltIndex, Math.max(0, bolts.length - 1))];
  const errors = read.diagnostics.filter((entry) => entry.level === "error").length;
  const { items: shownBolts, offset, split, topHeight, stepRoom } = boltWindow(bolts, boltIndex, height, Boolean(confirming));

  const stateOf = (entry: Bolt): BoltState | undefined => {
    const status = boltStatus(workspace, entry, runs, containers);
    if (status.failing > 0) return { text: `${glyphs.dot} something stopped`, color: "red" };
    if (status.running > 0) {
      const all = status.running === status.commands;
      return { text: `${glyphs.dot} ${all ? "running" : `${status.running} of ${status.commands} running`}`, color: all ? "green" : "yellow" };
    }
    const last = lastRun(entry.label);
    if (!last) return undefined;
    if (last.running) return { text: `${glyphs.dot} running, step ${Math.min(last.steps.length + 1, last.total ?? last.steps.length + 1)} of ${last.total ?? "?"}`, color: "cyan" };
    if (last.interrupted) return { text: `! interrupted ${since(last.startedAt)}`, color: "yellow" };
    return last.ok ? { text: `${glyphs.ok} ${since(last.startedAt)}`, color: "green", dim: true } : { text: `${glyphs.fail} failed ${since(last.startedAt)}`, color: "red" };
  };

  const rows = shownBolts.map((entry) => ({ entry, state: stateOf(entry) }));
  const stateWidth = Math.max(0, ...rows.map(({ state }) => state?.text.length ?? 0));
  const stateColumn = stateWidth > 0 ? stateWidth + 3 : 0;
  const longest = Math.max(0, ...rows.map(({ entry }) => entry.label.length + (entry.job ? 4 : 0)));
  const showSteps = 2 + Math.min(longest, 24) + stateColumn + 10 <= width;
  const labelWidth = Math.max(10, Math.min(longest, width - 2 - stateColumn - (showSteps ? 10 : 0)));

  const header = (
    <>
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
    </>
  );

  const list =
    bolts.length === 0 ? (
      <>
        <Text bold={focused}>
          {focused ? glyphs.pointer : " "} <Text color={focused ? undefined : "magenta"} inverse={focused}>+ add a bolt</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>{"  A bolt is one thing you do, like \"Work on the API\": what to start, in order."}</Text>
      </>
    ) : (
      rows.map(({ entry, state }, position) => {
        const isSelected = offset + position === boltIndex;
        const tag = entry.job ? " job" : "";
        const name = clip(entry.label, Math.max(4, labelWidth - tag.length));
        const gap = " ".repeat(Math.max(0, labelWidth - name.length - tag.length));
        const count = entry.steps.length;
        return (
          <Fragment key={entry.id}>
            <Text wrap="truncate-end" bold={isSelected}>
              {isSelected ? glyphs.pointer : " "} <Text color={isSelected && confirming ? "red" : isSelected && focused ? undefined : entry.color} inverse={isSelected && focused}>{name}</Text>
              {tag ? <Text color="cyan">{tag}</Text> : null}
              {gap}
              {stateWidth > 0 ? (
                state ? <Text color={state.color} dimColor={state.dim ?? false}>{`   ${state.text.padEnd(stateWidth)}`}</Text> : <Text>{" ".repeat(stateWidth + 3)}</Text>
              ) : null}
              {showSteps ? <Text dimColor>{`   ${count} step${count === 1 ? "" : "s"}`}</Text> : null}
            </Text>
            {isSelected && confirming ? <AskHere question={confirming.question} yes={confirming.yes} onAnswer={confirming.onAnswer} /> : null}
          </Fragment>
        );
      })
    );

  const details = selected ? (
    <BoltDetails
      read={read}
      bolt={selected}
      state={stateOf(selected)}
      last={lastRun(selected.label)}
      here={here}
      glyphs={glyphs}
      full={split}
      room={split ? Math.max(1, height - topHeight - 2) : stepRoom}
    />
  ) : null;

  if (!split) {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        {header}
        {list}
        {details ? <Text> </Text> : null}
        {details}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      <Box flexDirection="column" height={topHeight} flexShrink={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        {header}
        {list}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle={glyphs.border} borderColor="gray" paddingX={1} overflow="hidden">
        {details}
      </Box>
    </Box>
  );
}

function BoltDetails(props: { read: WorkspaceRead; bolt: Bolt; state: BoltState | undefined; last: HistoryEntry | undefined; here: boolean; glyphs: Glyphs; full: boolean; room: number }) {
  const { read, bolt, state, last, here, glyphs, full, room } = props;
  const { workspace } = read;
  const held = new Map(read.withheld.map((item) => [item.id, item]));
  const waiting = bolt.steps.flatMap((step) => {
    const id = step.kind === "asset" ? step.id : step.kind === "compose" ? `compose:${step.file}` : undefined;
    return id && held.has(id) ? [held.get(id)!] : [];
  });
  const lines = [
    ...collectBoltTargets(workspace, bolt).map((step) => ({ key: `${step.kind}:${step.id}:${step.label}`, label: `${step.kind === "bolt" ? glyphs.bolt : ""}${describeStep(step, false, bolt.job ?? false).replace("›", glyphs.arrow)}`, note: step.workspace ? ` (from ${step.workspace})` : "", waiting: false })),
    ...waiting.map((item) => ({ key: `held:${item.id}`, label: `start ${item.label}`, note: "", waiting: true })),
  ];
  const neededBy = workspace.bolts.filter((other) => other.steps.some((step) => step.kind === "bolt" && !step.workspace && step.bolt.toLowerCase() === bolt.label.toLowerCase())).map((other) => other.label);
  const typed = here ? shortest(bolt, workspace.bolts) : `${slugify(workspace.name)} ${shortest(bolt, workspace.bolts)}`;

  const used = full ? 1 + (bolt.notes ? 1 : 0) + 2 + 3 : bolt.notes ? 1 : 0;
  const space = Math.max(1, room - used);
  const shown = lines.length > space ? Math.max(1, space - 1) : lines.length;

  const facts = [
    last ? (last.running ? `running now, #${last.number ?? ""}` : `last run ${last.interrupted ? "!" : last.ok ? glyphs.ok : glyphs.fail} #${last.number ?? ""} ${since(last.startedAt)}`) : "never run yet",
    neededBy.length > 0 ? `needed by ${neededBy.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {full ? (
        <Text wrap="truncate-end">
          <Text color={TONE.accent}>{glyphs.bolt}</Text>
          <Text bold color={bolt.color}>{bolt.label}</Text>
          {bolt.job ? <Text color="cyan"> job</Text> : null}
          {state ? <Text color={state.color} dimColor={state.dim ?? false}>{`   ${state.text}`}</Text> : null}
        </Text>
      ) : null}
      {bolt.notes ? <Text wrap="truncate-end">{full ? bolt.notes : `  ${bolt.notes}`}</Text> : null}
      {full ? <Text> </Text> : null}
      {lines.length === 0 ? (
        <Text dimColor>{full ? "It has no steps yet — press e to add some." : "  It has no steps yet — press e to add some."}</Text>
      ) : (
        <>
          <Text dimColor>{`${full ? "" : "  "}${bolt.job ? "When you run it, it will — and stop at the first failure:" : "When you run it, it will:"}`}</Text>
          {lines.slice(0, shown).map((line, at) => (
            <Text key={line.key} wrap="truncate-end">
              <Text dimColor>{`${full ? "" : "  "}${String(at + 1).padStart(2)}. `}</Text>
              {line.waiting ? <Text dimColor>{line.label}</Text> : line.label}
              {line.note ? <Text dimColor>{line.note}</Text> : null}
              {line.waiting ? <Text color="yellow"> (not trusted)</Text> : null}
            </Text>
          ))}
          {lines.length > shown ? <Text dimColor>{`${full ? "" : "  "}… ${lines.length - shown} more · v shows it whole`}</Text> : null}
        </>
      )}
      {full ? (
        <>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate-end">{facts}</Text>
          <Text wrap="truncate-end">
            <Text dimColor>from a terminal: </Text>
            <Text color="cyan">{`wisp ${typed}`}</Text>
          </Text>
        </>
      ) : null}
    </>
  );
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function SearchPanel({ hits, index, query, glyphs, height }: { hits: SearchHit[]; index: number; query: string; glyphs: Glyphs; height: number }) {
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

export function Empty({ glyphs, height, unreadable }: { glyphs: Glyphs; height: number; unreadable: number }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>No workspaces yet</Text>
      <Text> </Text>
      <Text>In a project, quit and run <Text color="cyan">wisp init</Text> to give it a .wisp.json.</Text>
      <Text>Already have some? <Text color="cyan">wisp scan ~/dev</Text> finds them.</Text>
      {unreadable > 0 ? <Text color="red">{`${unreadable} workspace file(s) could not be read — wisp list`}</Text> : null}
    </Box>
  );
}

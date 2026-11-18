/** The main screen: workspaces on the left, the selected one's bolts on the right; and search. */

import { Box, Text } from "ink";

import type { Container } from "../core/docker.js";
import { baseLabel, type HistoryEntry } from "../core/history.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { boltStatus, collectBoltTargets } from "../core/switch.js";
import type { WorkspaceRead } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { describeStep, type SearchHit, windowed } from "./model.js";
import { counts, needsTrust, since } from "./state.js";
import { TONE } from "./tones.js";

/**
 * Every workspace, grouped by where it comes from — said in words rather than marks: the
 * project of the folder Wisp was opened in, the other projects you have used, and the
 * workspaces of your own.
 */
export function WorkspaceList(props: { reads: WorkspaceRead[]; index: number; here?: string | undefined; focused: boolean; glyphs: Glyphs; height: number; width: number }) {
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

export function WorkspacePanel(props: { read: WorkspaceRead; boltIndex: number; focused: boolean; glyphs: Glyphs; height: number; runs: RunStatus[]; containers: Container[]; history: HistoryEntry[] }) {
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
  const fixed = 7;
  const listRoom = Math.max(2, height - 2 - fixed);
  const boltRoom = Math.max(1, Math.min(bolts.length, Math.ceil(listRoom / 2)));
  const stepRoom = Math.max(1, listRoom - boltRoom);
  const { items: shownBolts, offset } = windowed(bolts, boltIndex, boltRoom);
  const stepLines = [
    ...steps.map((step) => ({ key: `${step.kind}:${step.id}:${step.label}`, label: `${step.kind === "bolt" ? glyphs.bolt : ""}${describeStep(step, false, selected?.job ?? false).replace("›", glyphs.arrow)}`, note: step.workspace ? ` (from ${step.workspace})` : "", waiting: false })),
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
        {`${glyphs.bolt}Bolts`}
      </Text>
      {bolts.length === 0 ? (
        <>
          <Text bold={focused}>
            {focused ? glyphs.pointer : " "} <Text color={focused ? undefined : "magenta"} inverse={focused}>+ add a bolt</Text>
          </Text>
          <Text> </Text>
          <Text dimColor>{"  A bolt is one thing you do, like \"Work on the API\": what to start, in order."}</Text>
        </>
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
    </Box>
  );
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

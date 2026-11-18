/** Full-width panels: a run as it happens, a file's check, and the list of keys. */

import { dirname } from "node:path";

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { tildify } from "../core/paths.js";
import { retryPlan } from "../core/switch.js";
import type { Diagnostic } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { describeStep, windowed } from "./model.js";
import { KIND, type RunState, type View } from "./state.js";
import { spell } from "./spells.js";
import { TONE } from "./tones.js";

export function RunPanel({ view, glyphs, height, tick }: { view: RunState; glyphs: Glyphs; height: number; tick: number }) {
  const retryable = view.done && view.result ? retryPlan(view.result).length : 0;
  const hint = !view.done
    ? "x stop this run · p watch it next to what's running · esc back (it keeps going)"
    : `${retryable > 0 ? `r retry from ${view.steps.find((step) => step.result && !step.result.ok && !step.result.skipped)?.target.label ?? "where it stopped"} · ` : ""}${view.steps.some((step) => step.result?.run && step.result.ok) ? "⏎ watch what it started · esc back" : "⏎ back"}`;
  const failed = view.steps.filter((step) => step.result && !step.result.ok && !step.result.skipped).length;
  const links = view.steps.filter((step) => step.result?.kind === "link" && step.result.note?.startsWith("no display"));
  const background = view.steps.filter((step) => step.result?.run).length;
  const output = view.output.length > 0 && view.output[view.output.length - 1] === "" ? view.output.slice(0, -1) : view.output;
  const outputRoom = output.length > 0 ? Math.max(3, Math.floor((height - 6) / 2)) : 0;
  const { items } = windowed(view.steps, Math.max(0, view.steps.findIndex((step) => step.state === "running")), height - 6 - (outputRoom ? outputRoom + 1 : 0));

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={view.done ? (failed > 0 || view.error ? "red" : "green") : TONE.accent} paddingX={1}>
      <Text bold>
        {view.dryRun ? <Text color="yellow">dry run </Text> : view.done ? null : <Text color={TONE.accent}>{`${spell()}… `}</Text>}
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
            {result && !result.skipped && result.durationMs !== undefined && step.state !== "running" ? <Text dimColor>{`  ${result.durationMs >= 1000 ? `${(result.durationMs / 1000).toFixed(1)}s` : `${result.durationMs}ms`}`}</Text> : null}
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
            {failed > 0 ? <Text color="red">{`${glyphs.fail} Failed — h shows this run in History`}</Text> : view.error || view.stopped ? null : <Text color="green">{view.dryRun ? "That's what it would do. Nothing was changed." : "All done."}</Text>}
            {background > 0 ? <Text>{`  ${background === 1 ? "It's" : `${background} things are`} running now — press ⏎ to watch.`}</Text> : null}
          </Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </Box>
  );
}

export function CheckPanel({ view, glyphs, height }: { view: Extract<View, { kind: "check" }>; glyphs: Glyphs; height: number }) {
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

export function DiagnosticLine({ entry, glyphs }: { entry: Diagnostic; glyphs: Glyphs }) {
  const mark = entry.level === "error" ? <Text color="red">{glyphs.fail}</Text> : entry.level === "warning" ? <Text color="yellow">!</Text> : <Text dimColor>{glyphs.pending}</Text>;
  return (
    <Text wrap="truncate-end">
      {mark} <Text dimColor>{entry.at}</Text> {entry.level === "note" ? <Text dimColor>{entry.message}</Text> : entry.message}
    </Text>
  );
}

export function HelpPanel({ glyphs, height }: { glyphs: Glyphs; height: number }) {
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
        ["s", "settings: your editor, and where commands run"],
      ],
    ],
    [
      "Move",
      [
        ["↑↓  j k", "move"],
        ["1 2 3", "the tabs: bolts · running · history"],
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
      <Text dimColor>`wisp --help` for the command line · `wisp spec` for the file format</Text>
      <Text dimColor italic>Wisp, as in will-o'-the-wisp: the little light that leads the way.</Text>
    </Box>
  );
}

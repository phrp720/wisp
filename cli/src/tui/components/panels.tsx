/** Full-width panels: a run as it happens, and the list of keys. */

import { Box, Text } from "ink";

import { retryPlan } from "../../core/run/index.js";
import type { Diagnostic } from "../../core/types.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { describeStep, windowed } from "../model.js";
import type { RunState } from "../state.js";
import { spell } from "../terminal/spells.js";
import { TONE } from "../terminal/tones.js";

export function RunProgress({ view, glyphs, height, tick }: { view: RunState; glyphs: Glyphs; height: number; tick: number }) {
  const retryable = view.done && view.result ? retryPlan(view.result).length : 0;
  const background = view.steps.filter((step) => step.result?.run).length;
  const hint = !view.done
    ? "x stop this run · p watch it next to what's running"
    : [
        retryable > 0 ? `r retry from ${view.steps.find((step) => step.result && !step.result.ok && !step.result.skipped)?.target.label ?? "where it stopped"}` : "",
        background > 0 ? "p watch what it started" : "",
        "⏎ done",
      ]
        .filter(Boolean)
        .join(" · ");
  const failed = view.steps.filter((step) => step.result && !step.result.ok && !step.result.skipped && !step.result.cancelled).length;
  const cancelled = view.result?.cancelled === true;
  const links = view.steps.filter((step) => step.result?.kind === "link" && step.result.note?.startsWith("no display"));
  const output = view.output.length > 0 && view.output[view.output.length - 1] === "" ? view.output.slice(0, -1) : view.output;
  const summary = view.done ? 2 + links.length : 0;
  const stepRoom = Math.max(1, height - 3 - summary);
  const outputRoom = output.length > 0 ? Math.max(0, Math.min(output.length, Math.floor((stepRoom - 1) / 2))) : 0;
  const { items } = windowed(view.steps, Math.max(0, view.steps.findIndex((step) => step.state === "running")), Math.max(1, stepRoom - (outputRoom ? outputRoom + 1 : 0)));

  return (
    <>
      {/* The title stays where it is; the words that change go after it, cut first when it is long. */}
      <Text wrap="truncate-end">
        <Text color={TONE.accent}>{glyphs.bolt}</Text>
        <Text bold>
          {view.dryRun ? <Text color="yellow">checking </Text> : null}
          {view.title}
        </Text>
        {view.dryRun || view.done ? null : <Text color={TONE.accent}>{`   ${glyphs.spark} ${spell()}…`}</Text>}
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
                : result?.cancelled
                  ? <Text color="gray">{glyphs.cancel}</Text>
                  : !result?.ok
                  ? <Text color="red">{glyphs.fail}</Text>
                  : <Text color="green">{glyphs.ok}</Text>;
        return (
          <Text key={`${index}:${step.target.id}`} wrap="truncate-end">
            {mark} {step.state === "running" ? <Text bold>{describeStep(step.target, true)}</Text> : describeStep(step.target)}
            {step.target.workspace ? <Text dimColor>{` (from ${step.target.workspace})`}</Text> : null}
            {result && !result.skipped && result.durationMs !== undefined && step.state !== "running" ? <Text dimColor>{`  ${result.durationMs >= 1000 ? `${(result.durationMs / 1000).toFixed(1)}s` : `${result.durationMs}ms`}`}</Text> : null}
            {result?.error ? <Text color={result.cancelled ? "gray" : "red"}>{`  ${result.error}`}</Text> : result?.note ? <Text dimColor>{`  ${result.note}`}</Text> : null}
          </Text>
        );
      })}
      {outputRoom > 0 ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="gray" paddingLeft={1}>
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
          <Text wrap="truncate-end">
            {cancelled ? <Text color="gray">{`${glyphs.cancel} Cancelled. h shows this run in History`}</Text> : view.stopped ? <Text color="yellow">{`Stopped — ${view.stopped}. `}</Text> : null}
            {cancelled ? null : failed > 0 ? (
              <Text color="red">{view.dryRun ? `${glyphs.fail} It would stop there. Nothing ran.` : `${glyphs.fail} Failed — h shows this run in History`}</Text>
            ) : view.error || view.stopped ? null : (
              <Text color="green">{view.dryRun ? `${glyphs.ok} Ready to run. That's what it would do; nothing ran.` : "All done."}</Text>
            )}
            {background > 0 ? <Text>{`  ${background === 1 ? "It's" : `${background} things are`} running now.`}</Text> : null}
          </Text>
        </>
      ) : null}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </>
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

export function HelpPanel({ glyphs, height, tab = "bolts" }: { glyphs: Glyphs; height: number; tab?: "bolts" | "running" | "history" }) {
  const anywhere: [string, [string, string][]] = [
    "Anywhere",
    [
      ["1 2 3", "the tabs: pipelines · running · history"],
      ["mouse", "click to select · wheel to scroll · off in settings"],
      ["?", "these keys"],
    ],
  ];
  const running: [string, [string, string][]][] = [
    [
      "On Running",
      [
        ["↑↓  j k", "choose a pipeline or one of its commands"],
        ["[  ]", "its tabs: logs · info · past runs"],
        ["f", "the log full screen: ↑↓ scroll, ←→ the next command"],
        ["u d  G", "scroll the log · back to the newest"],
        ["/", "filter the list, or the log in full screen"],
        ["x  r", "stop · restart"],
        ["o", "show the ones that stopped too"],
        ["esc  p", "back to the pipelines"],
      ],
    ],
    anywhere,
  ];
  const history: [string, [string, string][]][] = [
    [
      "On History",
      [
        ["←  →", "the pipelines to filter by · their runs"],
        ["⏎", "open a run: its summary, pipeline and logs"],
        ["/", "search the runs; in a run, filter its logs"],
        ["u  d", "in a run: scroll"],
        ["v", "in a run: show or hide its graph"],
        ["r  R", "retry what failed · run it all again"],
        ["D", "delete the run, or the selected pipeline's runs"],
        ["esc  h", "back"],
      ],
    ],
    anywhere,
  ];
  // Grouped by what you are doing, so the key you need is where you would look for it.
  const bolts: [string, [string, string][]][] = [
    [
      "Run",
      [
        ["⏎", "run the selected pipeline, in its box: each step ticks off as it goes"],
        ["c", "check it: what it would do, and what's wrong; nothing runs"],
        ["u  d", "scroll the selected pipeline's steps, when they don't fit"],
        ["v", "show or hide the graph of its steps, above them"],
        ["x  R", "stop the run, or what it started · restart it"],
        ["r  ⏎", "after a run: retry from where it failed · close it, back to the pipeline"],
      ],
    ],
    [
      "Look",
      [
        ["p", "what's running — commands and containers, live"],
        ["h", "history — every run, like a CI"],
        ["/", "search every workspace and pipeline"],
      ],
    ],
    [
      "Edit",
      [
        ["e", "edit the selected pipeline, or the workspace on the left: its name, icon, notes"],
        ["a  D", "add a pipeline · delete the selected pipeline, or workspace on the left"],
        ["K  J", "move the selected pipeline up · down"],
        ["N", "a new personal workspace"],
        ["E", "open the file itself in your text editor"],
        ["s", "settings: what opens files, where commands run, notifications, the mouse"],
      ],
    ],
    [
      "Move",
      [
        ["↑↓  j k", "move"],
        ["1 2 3", "the tabs: pipelines · running · history"],
        ["mouse", "click to select · wheel to scroll · off in settings"],
        ["←→  tab", "between workspaces and pipelines"],
        ["t", "review and allow what a file would run"],
        ["r  q", "reload · quit"],
      ],
    ],
  ];
  const sections = tab === "running" ? running : tab === "history" ? history : bolts;
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>{tab === "running" ? "Keys on Running" : tab === "history" ? "Keys on History" : "Keys"}</Text>
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

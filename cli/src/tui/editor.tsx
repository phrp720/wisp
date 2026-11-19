import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";

import { STEP_FIELDS, STEP_KINDS, buildStep, describeRawStep, stepKindOf, stepValues, type RawBolt, type StepKindName } from "../core/edit.js";
import { tildify } from "../core/paths.js";
import { Confirm, Form, Picker } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { useMouse, useRefs } from "./mouse.js";
import { TONE } from "./tones.js";
import { windowed, type Editing } from "./model.js";

type Mode =
  | { kind: "list" }
  | { kind: "pick"; at: number }
  | { kind: "form"; step: StepKindName; at: number; replace: boolean; initial: Record<string, string> }
  | { kind: "rename" }
  | { kind: "delete"; at: number };

export interface BoltEditorProps {
  file: string;
  bolt: string;
  /** Other bolts of this workspace, for "run another bolt first". */
  others: string[];
  /** Bolts of other workspaces, which can be run first too. */
  elsewhere?: { workspace: string; bolt: string }[];
  /** Open on choosing the first step — the bolt was just made. */
  adding?: boolean;
  editing: Editing;
  glyphs: Glyphs;
  height: number;
  onClose: () => void;
  /** After every saved change, so the rest of the TUI can catch up. */
  onChanged: (label: string) => void;
  onMessage: (text: string) => void;
  /** Just before each save, so the file's own change is not taken for someone else's. */
  onSaving?: () => void;
}

/**
 * A bolt, edited without its JSON: its steps in plain words, in order, and keys to add,
 * change, move and remove them. Every change is saved as it is made.
 */
export function BoltEditor({ file, bolt, others, elsewhere = [], adding = false, editing, glyphs, height, onClose, onChanged, onMessage, onSaving }: BoltEditorProps) {
  const [label, setLabel] = useState(bolt);
  const [raw, setRaw] = useState<RawBolt>();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>(adding ? { kind: "pick", at: 0 } : { kind: "list" });
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (name: string) => {
      try {
        setRaw(await editing.bolt(file, name));
        setError(undefined);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [editing, file],
  );
  useEffect(() => void load(bolt), [load, bolt]);

  const steps = raw?.targets ?? [];
  const rows = steps.length + 1; // the last row is "add a step"

  const change = async (work: () => Promise<void>, next?: number, done?: string) => {
    try {
      onSaving?.();
      await work();
      await load(label);
      if (next !== undefined) setIndex(next);
      onChanged(label);
      if (done) onMessage(done);
    } catch (failure) {
      onMessage(failure instanceof Error ? failure.message : String(failure));
    }
  };

  useInput(
    (input, key) => {
      if (key.escape || input === "q") return onClose();
      if (key.upArrow || input === "k") return setIndex((at) => Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setIndex((at) => Math.min(rows - 1, at + 1));
      if (input === "a" || (key.return && index === steps.length)) return setMode({ kind: "pick", at: Math.min(index + 1, steps.length) });
      if (input === "n") return setMode({ kind: "rename" });
      if (input === "t") {
        const job = !raw?.job;
        return void change(() => editing.setJob(file, label, job), undefined, job ? `"${label}" is now a job: it runs to completion and stops at the first failure` : `"${label}" now starts things and leaves them running`);
      }

      const step = steps[index];
      if (step === undefined) return;
      if (key.return) return open(index);
      if (input === "d" || key.delete) return setMode({ kind: "delete", at: index });
      if (input === "K" || (key.shift && key.upArrow)) return void change(() => editing.moveStep(file, label, index, -1), Math.max(0, index - 1));
      if (input === "J" || (key.shift && key.downArrow)) return void change(() => editing.moveStep(file, label, index, 1), Math.min(steps.length - 1, index + 1));
    },
    { isActive: mode.kind === "list" },
  );

  // ⏎ on a step changes it; on the last row, adds one.
  function open(at: number) {
    const step = steps[at];
    if (step === undefined) return setMode({ kind: "pick", at: Math.min(at, steps.length) });
    const kind = stepKindOf(step);
    if (kind === "shared") return onMessage(`"${step}" is shared by name — change it in the file itself (E)`);
    setMode({ kind: "form", step: kind, at, replace: true, initial: stepValues(step) });
  }

  // A click chooses a step; a click on the chosen one opens it, as ⏎ does.
  const rowNodes = useRefs<number>();
  useMouse(
    (event, at) => {
      if (event.kind !== "click") return false;
      const hit = rowNodes.entries().find(([, node]) => at(node));
      if (!hit) return false;
      if (hit[0] === index) open(hit[0]);
      else setIndex(hit[0]);
      return true;
    },
    mode.kind === "list",
  );

  if (mode.kind === "pick") {
    return (
      <Picker
        title={`${steps.length === 0 ? "The first step" : `Step ${mode.at + 1}`} of ⚡ ${label}`}
        intro={steps.length === 0 ? "What should happen first when it runs?" : `What should happen ${mode.at === steps.length ? "next" : `after "${describeRawStep(steps[mode.at - 1] as RawBolt["targets"][number])}"`}?`}
        options={STEP_KINDS.map((entry) => ({ key: entry.kind, title: entry.title, detail: entry.example, group: entry.group, icon: entry.icon }))}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onPick={(kind) => setMode({ kind: "form", step: kind as StepKindName, at: mode.at, replace: false, initial: {} })}
      />
    );
  }

  if (mode.kind === "form") {
    const kind = STEP_KINDS.find((entry) => entry.kind === mode.step);
    // Running another bolt first: chosen from the bolts there are, not typed — this
    // workspace's, then other workspaces' ("infra › Database").
    const choosable = [...others.map((name) => ({ value: name, label: name })), ...elsewhere.map((entry) => ({ value: `${entry.workspace} › ${entry.bolt}`, label: `${entry.workspace} › ${entry.bolt}` }))];
    const picking = mode.step === "bolt" && choosable.length > 0;
    const fields = picking
      ? [{ key: "bolt", label: "Bolt", hint: "it runs to its end — or until what it starts is up — before the next step", required: true, choices: choosable }]
      : STEP_FIELDS[mode.step];
    const initial = picking && mode.initial["workspace"] ? { bolt: `${mode.initial["workspace"]} › ${mode.initial["bolt"] ?? ""}` } : mode.initial;
    const valuesOf = (values: Record<string, string>) => {
      if (!picking) return values;
      const [where, name] = (values["bolt"] ?? "").includes(" › ") ? (values["bolt"] ?? "").split(" › ") : [undefined, values["bolt"]];
      return { bolt: name ?? "", ...(where ? { workspace: where } : {}) };
    };
    return (
      <Form
        title={`${kind && glyphs.border === "round" ? `${kind.icon} ` : ""}${kind?.title ?? "Step"}`}
        intro={`${mode.replace ? "Changing" : "Adding"} step ${mode.at + 1} of ⚡ ${label}.`}
        fields={fields}
        initial={initial}
        preview={(values) => {
          const { step } = buildStep(mode.step, valuesOf(values));
          return step ? describeRawStep(step) : undefined;
        }}
        submitLabel={mode.replace ? "Save step" : "Add step"}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={async (given) => {
          const values = valuesOf(given);
          const { step, errors } = buildStep(mode.step, values);
          if (!step) return errors;
          await change(
            () => (mode.replace ? editing.replaceStep(file, label, mode.at, step) : editing.addStep(file, label, step, mode.at)),
            mode.at,
            mode.replace ? "Saved." : `Added: ${describeRawStep(step)}`,
          );
          setMode({ kind: "list" });
          return undefined;
        }}
      />
    );
  }

  if (mode.kind === "rename") {
    return (
      <Form
        title={`Name "${label}"`}
        intro="A short name, since you type it: any whole word of it runs it, `wisp api`. Notes say what it does."
        fields={[
          { key: "label", label: "Name", required: true, placeholder: "Deploy" },
          { key: "notes", label: "Notes", placeholder: "Builds the website and deploys it to production" },
        ]}
        initial={{ label, notes: raw?.notes ?? "" }}
        submitLabel="Save"
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={async (values) => {
          const name = values["label"]?.trim() ?? "";
          const notes = values["notes"]?.trim() ?? "";
          try {
            onSaving?.();
            if (name !== label) await editing.renameBolt(file, label, name);
            if (notes !== (raw?.notes ?? "")) await editing.setBoltNotes(file, name, notes);
          } catch (failure) {
            return { label: failure instanceof Error ? failure.message : String(failure) };
          }
          setLabel(name);
          await load(name);
          onChanged(name);
          setMode({ kind: "list" });
          return undefined;
        }}
      />
    );
  }

  if (mode.kind === "delete") {
    const step = steps[mode.at];
    return (
      <Confirm
        title={`Remove this step from "${label}"?`}
        detail={step === undefined ? "" : describeRawStep(step)}
        yes="remove it"
        glyphs={glyphs}
        height={height}
        onAnswer={(yes) => {
          setMode({ kind: "list" });
          if (yes) void change(() => editing.removeStep(file, label, mode.at), Math.max(0, Math.min(mode.at, steps.length - 2)), "Removed.");
        }}
      />
    );
  }

  const room = Math.max(1, height - 9);
  const listRows = [...steps.map((step, at) => ({ at, text: describeRawStep(step), kind: stepKindOf(step) })), { at: steps.length, text: steps.length === 0 ? "add the first step" : "add a step", kind: "add" }];
  const { items } = windowed(listRows, index, room);
  // A bolt to run first already starts with ⚡ in its words.
  const icon = (kind: string) => (glyphs.border !== "round" || kind === "bolt" ? "" : (STEP_KINDS.find((entry) => entry.kind === kind)?.icon ?? "🔗") + " ");
  // Steps as one pipeline, top to bottom — the way Shortcuts and n8n show a flow.
  const joint = (at: number) => (glyphs.border !== "round" ? "|" : steps.length === 1 ? "─" : at === 0 ? "┌" : at === steps.length - 1 ? "└" : "│");

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1}>
      <Box>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            <Text bold color={TONE.accent}>{`${glyphs.bolt}${label}`}</Text>
            <Text dimColor>{`   ${tildify(file)}`}</Text>
          </Text>
        </Box>
        {raw?.job ? <Text color={TONE.job}>a job — stops at the first failure</Text> : <Text dimColor>starts things and leaves them running</Text>}
      </Box>
      {error ? <Text color={TONE.failed}>{error}</Text> : null}
      <Text> </Text>
      {items.map((row) => {
        const active = row.at === index;
        const adding = row.kind === "add";
        return (
          <Box key={row.at} ref={rowNodes.set(row.at)}>
          <Text wrap="truncate-end">
            <Text color={TONE.accent}>{active ? `${glyphs.pointer} ` : "  "}</Text>
            {adding ? (
              <Text color={TONE.accent} bold={active}>{`${steps.length > 0 ? "  " : ""}+  ${row.text}`}</Text>
            ) : (
              <Text>
                <Text dimColor>{`${joint(row.at)} ${String(row.at + 1).padStart(2)}  `}</Text>
                {icon(row.kind)}
                <Text bold={active} color={active ? TONE.accent : undefined}>{row.text}</Text>
              </Text>
            )}
          </Text>
          </Box>
        );
      })}
      {steps.length === 0 ? <Text dimColor>{"\n  No steps yet. A bolt does its steps in order: start a server, wait for it, open it."}</Text> : null}
      <Box flexGrow={1} />
      <Text dimColor>{`⏎ ${index === steps.length ? "add" : "change"} · a add after this one · d remove · K J move · n name and notes · t ${raw?.job ? "make it start things" : "make it a job"} · esc done`}</Text>
    </Box>
  );
}

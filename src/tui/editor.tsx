import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";

import { STEP_FIELDS, STEP_KINDS, buildStep, describeRawStep, stepKindOf, stepValues, type RawBolt, type StepKindName } from "../core/edit.js";
import { tildify } from "../core/paths.js";
import { Confirm, Form, Picker } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
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
export function BoltEditor({ file, bolt, others, editing, glyphs, height, onClose, onChanged, onMessage, onSaving }: BoltEditorProps) {
  const [label, setLabel] = useState(bolt);
  const [raw, setRaw] = useState<RawBolt>();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
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
      if (key.return) {
        const kind = stepKindOf(step);
        if (kind === "shared") return onMessage(`"${step}" is shared by name — change it in the file itself (E)`);
        return setMode({ kind: "form", step: kind, at: index, replace: true, initial: stepValues(step) });
      }
      if (input === "d" || key.delete) return setMode({ kind: "delete", at: index });
      if (input === "K" || (key.shift && key.upArrow)) return void change(() => editing.moveStep(file, label, index, -1), Math.max(0, index - 1));
      if (input === "J" || (key.shift && key.downArrow)) return void change(() => editing.moveStep(file, label, index, 1), Math.min(steps.length - 1, index + 1));
    },
    { isActive: mode.kind === "list" },
  );

  if (mode.kind === "pick") {
    return (
      <Picker
        title={`Add a step to "${label}"`}
        intro="What should happen at this point?"
        options={STEP_KINDS.map((entry) => ({ key: entry.kind, title: entry.title, detail: entry.example }))}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onPick={(kind) => setMode({ kind: "form", step: kind as StepKindName, at: mode.at, replace: false, initial: {} })}
      />
    );
  }

  if (mode.kind === "form") {
    const title = STEP_KINDS.find((entry) => entry.kind === mode.step)?.title ?? "Step";
    const fields = STEP_FIELDS[mode.step].map((field) =>
      field.key === "bolt" && others.length > 0 ? { ...field, hint: `one of: ${others.join(", ")}` } : field,
    );
    return (
      <Form
        title={`${mode.replace ? "Change" : "Add"}: ${title}`}
        intro={`In "${label}", as step ${mode.at + 1}.`}
        fields={fields}
        initial={mode.initial}
        submitLabel={mode.replace ? "save" : "add it"}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={async (values) => {
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
        title={`Rename "${label}"`}
        intro="Name it after the job it does. Any word of it runs it: `specter api`."
        fields={[{ key: "label", label: "Name", required: true }]}
        initial={{ label }}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={async (values) => {
          const name = values["label"]?.trim() ?? "";
          try {
            onSaving?.();
            await editing.renameBolt(file, label, name);
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

  const room = Math.max(1, height - 10);
  const listRows = [...steps.map((step, at) => ({ at, text: describeRawStep(step) })), { at: steps.length, text: "add a step" }];
  const { items } = windowed(listRows, index, room);

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="#a78bfa" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold>{`Edit "${label}"`}</Text>
        <Text dimColor>{`   ${tildify(file)}`}</Text>
      </Text>
      <Text>
        {raw?.job ? (
          <Text color="cyan">A job: runs to completion, and stops at the first step that fails.</Text>
        ) : (
          <Text>Starts things and leaves them running.</Text>
        )}
        <Text dimColor>{raw?.job ? "  t: make it start things instead" : "  t: make it a job (tests, builds, releases)"}</Text>
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text> </Text>
      <Text bold>Steps, in the order they happen</Text>
      {steps.length === 0 ? <Text dimColor>Nothing yet — press a, or ⏎ below, to add the first step.</Text> : null}
      {items.map((row) => {
        const active = row.at === index;
        const adding = row.at === steps.length;
        return (
          <Text key={row.at} wrap="truncate-end" inverse={active} color={adding ? "#a78bfa" : undefined}>
            {active ? glyphs.pointer : " "} {adding ? " + " : `${String(row.at + 1).padStart(2)} `} {row.text}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>↑↓ choose · ⏎ change · a add · d remove · K/J move up/down · n rename · t job or not · esc done</Text>
    </Box>
  );
}

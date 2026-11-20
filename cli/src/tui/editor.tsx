import { Box, type DOMElement, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { STEP_FIELDS, STEP_KINDS, buildStep, describeRawStep, stepKindOf, stepValues, type RawBolt, type StepKindName } from "../core/edit.js";
import { tildify } from "../core/paths.js";
import { ASK_KEYS, AskHere, Form, Picker } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { useMouse, useRefs } from "./mouse.js";
import { TONE } from "./tones.js";
import { windowed, type Editing } from "./model.js";

type Row = { kind: "name" } | { kind: "notes" } | { kind: "kind" } | { kind: "step"; at: number } | { kind: "add" };

const DETAILS = 3;
const SIDE_BY_SIDE = 90;

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
  columns?: number;
  onClose: () => void;
  /** After every saved change, so the rest of the TUI can catch up. */
  onChanged: (label: string) => void;
  onMessage: (text: string) => void;
  /** Just before each save, so the file's own change is not taken for someone else's. */
  onSaving?: () => void;
  onHint?: (hint: string) => void;
}

/**
 * A bolt, edited without its JSON: its steps in plain words, in order, and keys to add,
 * change, move and remove them. Every change is saved as it is made.
 */
export function BoltEditor({ file, bolt, others, elsewhere = [], adding = false, editing, glyphs, height, columns = 100, onClose, onChanged, onMessage, onSaving, onHint }: BoltEditorProps) {
  const [label, setLabel] = useState(bolt);
  const [raw, setRaw] = useState<RawBolt>();
  const [index, setIndexState] = useState(DETAILS);
  const indexRef = useRef(DETAILS);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const [open, setOpen] = useState(adding);
  const [newStep, setNewStep] = useState<{ at: number; kind?: StepKindName } | undefined>(adding ? { at: 0 } : undefined);
  const [deleting, setDeleting] = useState<number>();
  const [session, setSession] = useState(0);
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
  const rows: Row[] = [{ kind: "name" }, { kind: "notes" }, { kind: "kind" }, ...steps.map((_, at): Row => ({ kind: "step", at })), { kind: "add" }];
  const selected = Math.min(index, rows.length - 1);
  const row = rows[selected] as Row;

  const back = () => {
    setOpen(false);
    setNewStep(undefined);
    setSession((count) => count + 1);
  };

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

  const edit = (target: Row) => {
    if (target.kind === "add") {
      setNewStep({ at: steps.length });
      return setOpen(true);
    }
    if (target.kind === "step" && stepKindOf(steps[target.at] as RawBolt["targets"][number]) === "shared") {
      return onMessage(`"${String(steps[target.at])}" is shared by name — change it in the file itself (E)`);
    }
    setOpen(true);
  };

  const addAfter = (from: Row) => {
    const at = from.kind === "step" ? from.at + 1 : steps.length;
    setNewStep({ at });
    setOpen(true);
  };

  useInput(
    (input, key) => {
      const at = Math.min(indexRef.current, rows.length - 1);
      const current = rows[at] as Row;
      if (key.escape || input === "q") return onClose();
      if (input === "K" || (key.shift && key.upArrow)) {
        if (current.kind === "step") void change(() => editing.moveStep(file, label, current.at, -1), DETAILS + Math.max(0, current.at - 1));
        return;
      }
      if (input === "J" || (key.shift && key.downArrow)) {
        if (current.kind === "step") void change(() => editing.moveStep(file, label, current.at, 1), DETAILS + Math.min(steps.length - 1, current.at + 1));
        return;
      }
      if (key.upArrow || input === "k") return setIndex(Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setIndex(Math.min(rows.length - 1, at + 1));
      if (key.return || key.rightArrow) return edit(current);
      if (input === "a") return addAfter(current);
      if (current.kind === "step" && (input === "d" || key.delete)) return setDeleting(current.at);
    },
    { isActive: !open && deleting === undefined },
  );

  const rowNodes = useRefs<number>();
  const rightNode = useRef<DOMElement>(null);
  useMouse(
    (event, at) => {
      if (event.kind !== "click") return false;
      if (at(rightNode.current)) {
        edit(row);
        return true;
      }
      const hit = rowNodes.entries().find(([, node]) => at(node));
      if (!hit) return false;
      if (hit[0] === selected) edit(row);
      else setIndex(hit[0]);
      return true;
    },
    !open && deleting === undefined,
  );

  const hint =
    deleting !== undefined
      ? `Its place in the order closes up · ${ASK_KEYS}`
      : open && newStep && !newStep.kind
        ? "↑↓ choose · ⏎ pick · type to find · esc back"
        : open
          ? "↑↓ fields · ⏎ next · ctrl+s save · esc back"
          : ["↑↓ choose", "⏎ edit", "a add a step", row.kind === "step" ? "d remove · K J move" : "", "esc done"].filter(Boolean).join(" · ");
  useEffect(() => onHint?.(hint), [hint, onHint]);

  const stepForm = (kind: StepKindName, initial: Record<string, string>, at: number, replace: boolean, active: boolean, room: number) => {
    const entry = STEP_KINDS.find((candidate) => candidate.kind === kind);
    const choosable = [...others.map((name) => ({ value: name, label: name })), ...elsewhere.map((other) => ({ value: `${other.workspace} › ${other.bolt}`, label: `${other.workspace} › ${other.bolt}` }))];
    const picking = kind === "bolt" && choosable.length > 0;
    const fields = picking
      ? [{ key: "bolt", label: "Bolt", hint: "it runs to its end — or until what it starts is up — before the next step", required: true, choices: choosable }]
      : STEP_FIELDS[kind];
    const start = picking && initial["workspace"] ? { bolt: `${initial["workspace"]} › ${initial["bolt"] ?? ""}` } : initial;
    const valuesOf = (values: Record<string, string>) => {
      if (!picking) return values;
      const [where, name] = (values["bolt"] ?? "").includes(" › ") ? (values["bolt"] ?? "").split(" › ") : [undefined, values["bolt"]];
      return { bolt: name ?? "", ...(where ? { workspace: where } : {}) };
    };
    return (
      <Form
        key={`step:${at}:${kind}:${session}`}
        title={`${replace ? `Step ${at + 1}` : steps.length === 0 ? "The first step" : `New step ${at + 1}`} · ${entry && glyphs.border === "round" ? `${entry.icon} ` : ""}${entry?.title ?? "Step"}`}
        fields={fields}
        initial={start}
        preview={(values) => {
          const { step } = buildStep(kind, valuesOf(values));
          return step ? describeRawStep(step) : undefined;
        }}
        submitLabel={replace ? "Save step" : "Add step"}
        glyphs={glyphs}
        height={room}
        active={active}
        keys={false}
        onCancel={back}
        onSubmit={async (given) => {
          const values = valuesOf(given);
          const { step, errors } = buildStep(kind, values);
          if (!step) return errors;
          await change(() => (replace ? editing.replaceStep(file, label, at, step) : editing.addStep(file, label, step, at)), DETAILS + at, replace ? "Saved." : `Added: ${describeRawStep(step)}`);
          back();
          return undefined;
        }}
      />
    );
  };

  const right = (active: boolean, room: number) => {
    if (newStep && active) {
      if (newStep.kind) return stepForm(newStep.kind, {}, newStep.at, false, true, room);
      return (
        <Picker
          key={`pick:${session}`}
          title={steps.length === 0 ? "The first step" : `New step ${newStep.at + 1}`}
          intro={steps.length === 0 ? "What should happen first when it runs?" : newStep.at === steps.length ? "What should happen next?" : `What should happen after "${describeRawStep(steps[newStep.at - 1] as RawBolt["targets"][number])}"?`}
          options={STEP_KINDS.map((entry) => ({ key: entry.kind, title: entry.title, detail: entry.example, group: entry.group, icon: entry.icon }))}
          glyphs={glyphs}
          height={room}
          keys={false}
          onCancel={back}
          onPick={(kind) => setNewStep({ at: newStep.at, kind: kind as StepKindName })}
        />
      );
    }
    if (row.kind === "add") {
      return (
        <Picker
          key={`preview:${session}`}
          title={steps.length === 0 ? "The first step" : "Add a step"}
          intro="⏎ to choose what it does"
          options={STEP_KINDS.map((entry) => ({ key: entry.kind, title: entry.title, detail: entry.example, group: entry.group, icon: entry.icon }))}
          glyphs={glyphs}
          height={room}
          active={false}
          keys={false}
          onCancel={back}
          onPick={() => undefined}
        />
      );
    }
    if (row.kind === "name") {
      return (
        <Form
          key={`name:${session}`}
          title="Name"
          intro="What you type to run it, so keep it short: any whole word of it runs it, like `wisp api`."
          fields={[{ key: "label", label: "Name", required: true, placeholder: "Deploy" }]}
          initial={{ label }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const name = values["label"]?.trim() ?? "";
            if (name === label) return void back();
            try {
              onSaving?.();
              await editing.renameBolt(file, label, name);
            } catch (failure) {
              return { label: failure instanceof Error ? failure.message : String(failure) };
            }
            setLabel(name);
            await load(name);
            onChanged(name);
            onMessage(`Renamed to "${name}"`);
            back();
            return undefined;
          }}
        />
      );
    }
    if (row.kind === "notes") {
      return (
        <Form
          key={`notes:${session}`}
          title="Notes"
          intro="A line on what it does, shown beside it in the dashboard, `wisp show` and tab completion."
          fields={[{ key: "notes", label: "Notes", placeholder: "Builds the website and deploys it to production" }]}
          initial={{ notes: raw?.notes ?? "" }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            await change(() => editing.setBoltNotes(file, label, values["notes"] ?? ""), undefined, "Saved.");
            back();
            return undefined;
          }}
        />
      );
    }
    if (row.kind === "kind") {
      return (
        <Form
          key={`kind:${session}`}
          title="Kind"
          intro="What happens when it runs."
          fields={[
            {
              key: "kind",
              label: "Kind",
              hint: "a job is for tests, builds and releases",
              choices: [
                { value: "start", label: "Starter — starts things and leaves them running" },
                { value: "job", label: "Job — runs to the end, stops at the first failure" },
              ],
            },
          ]}
          initial={{ kind: raw?.job ? "job" : "start" }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const job = values["kind"] === "job";
            if (job !== Boolean(raw?.job)) {
              await change(() => editing.setJob(file, label, job), undefined, job ? `"${label}" is now a job: it runs to the end and stops at the first failure` : `"${label}" is now a starter: it starts things and leaves them running`);
            }
            back();
            return undefined;
          }}
        />
      );
    }
    const step = steps[row.at] as RawBolt["targets"][number];
    const kind = stepKindOf(step);
    if (kind === "shared") {
      return (
        <Box flexDirection="column" height={room} borderStyle={glyphs.border} borderColor="gray" paddingX={1}>
          <Text bold>{`Step ${row.at + 1}`}</Text>
          <Text dimColor wrap="wrap">{`"${String(step)}" is declared once in the file and shared by name. Change it in the file itself (E).`}</Text>
        </Box>
      );
    }
    return stepForm(kind, stepValues(step), row.at, true, active, room);
  };

  const sideBySide = columns >= SIDE_BY_SIDE;
  if (!sideBySide && open) return right(true, height);

  const leftWidth = sideBySide ? Math.min(60, Math.max(36, Math.floor(columns * 0.42))) : undefined;
  const room = Math.max(1, height - 10 - (deleting === undefined ? 0 : 1));
  const stepRows = rows.map((entry, at) => ({ entry, at })).slice(DETAILS);
  const { items } = windowed(stepRows, Math.max(0, selected - DETAILS), room);
  const icon = (kind: string) => (glyphs.border !== "round" || kind === "bolt" ? "" : (STEP_KINDS.find((entry) => entry.kind === kind)?.icon ?? "🔗") + " ");
  const joint = (at: number) => (glyphs.border !== "round" ? "|" : steps.length === 1 ? "─" : at === 0 ? "┌" : at === steps.length - 1 ? "└" : "│");
  const pointer = (at: number) => <Text color={TONE.accent}>{at === selected ? `${glyphs.pointer} ` : "  "}</Text>;
  const detail = (at: number, name: string, value: string, empty: string) => (
    <Box ref={rowNodes.set(at)}>
      <Text wrap="truncate-end">
        {pointer(at)}
        <Text bold={at === selected} color={at === selected ? TONE.accent : undefined}>{name.padEnd(7)}</Text>
        {value ? <Text>{value}</Text> : <Text dimColor>{empty}</Text>}
      </Text>
    </Box>
  );

  const left = (
    <Box flexDirection="column" width={leftWidth} flexGrow={sideBySide ? 0 : 1} flexShrink={0} height={height} borderStyle={glyphs.border} borderColor={open ? "gray" : TONE.accent} paddingX={1} overflow="hidden">
      <Text bold color={TONE.accent} wrap="truncate-end">{`${glyphs.bolt}${label}`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(file)}</Text>
      {error ? <Text color={TONE.failed}>{error}</Text> : <Text> </Text>}
      {detail(0, "Name", label, "")}
      {detail(1, "Notes", raw?.notes ?? "", "none yet")}
      {detail(2, "Kind", raw?.job ? "Job" : "Starter", "")}
      <Text> </Text>
      <Text bold>Steps</Text>
      {items.map(({ entry, at }) => {
        const active = at === selected;
        if (entry.kind === "add") {
          return (
            <Box key="add" ref={rowNodes.set(at)}>
              <Text wrap="truncate-end">
                {pointer(at)}
                <Text color={TONE.accent} bold={active}>{`${steps.length > 0 ? "  " : ""}+  ${steps.length === 0 ? "add the first step" : "add a step"}`}</Text>
              </Text>
            </Box>
          );
        }
        if (entry.kind !== "step") return null;
        const step = steps[entry.at] as RawBolt["targets"][number];
        return (
          <Box key={`s${entry.at}`} flexDirection="column">
            <Box ref={rowNodes.set(at)}>
              <Text wrap="truncate-end">
                {pointer(at)}
                <Text dimColor>{`${joint(entry.at)} ${String(entry.at + 1).padStart(2)}  `}</Text>
                {icon(stepKindOf(step))}
                <Text bold={active} color={entry.at === deleting ? "red" : active ? TONE.accent : undefined}>{describeRawStep(step)}</Text>
              </Text>
            </Box>
            {entry.at === deleting ? (
              <AskHere
                question="Remove this step?"
                yes="Remove"
                onAnswer={(yes) => {
                  setDeleting(undefined);
                  if (yes) void change(() => editing.removeStep(file, label, entry.at), DETAILS + Math.max(0, Math.min(entry.at, steps.length - 2)), "Removed.");
                }}
              />
            ) : null}
          </Box>
        );
      })}
    </Box>
  );

  if (!sideBySide) return left;
  return (
    <Box height={height}>
      {left}
      <Box ref={rightNode} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {right(open, height)}
      </Box>
    </Box>
  );
}

import { Box, type DOMElement, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { STEP_FIELDS, STEP_KINDS, afterOf, buildInput, buildStep, describeRawStep, inputValues, stepKindOf, stepValues, type RawPipeline, type RawInput, type StepKindName } from "../../core/edit.js";
import { tildify } from "../../core/paths.js";
import { slugify } from "../../core/workspaces.js";
import { ASK_KEYS, AskHere, Form, Picker } from "../components/forms.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { useMouse, useRefs } from "../terminal/mouse.js";
import { TONE } from "../terminal/tones.js";
import { windowed, type Editing } from "../model.js";

type Row =
  | { kind: "name" }
  | { kind: "slug" }
  | { kind: "notes" }
  | { kind: "failure" }
  | { kind: "confirm" }
  | { kind: "input"; name: string }
  | { kind: "add-input" }
  | { kind: "step"; at: number }
  | { kind: "add" };

const SIDE_BY_SIDE = 90;

export interface PipelineEditorProps {
  file: string;
  bolt: string;
  workspace?: string | undefined;
  /** Other bolts of this workspace, for "run another bolt first". */
  others: string[];
  /** Pipelines of other workspaces, which can be run first too. */
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
  onJump?: (input: string) => void;
  onBusy?: (busy: boolean) => void;
}

/**
 * A bolt, edited without its JSON: its steps in plain words, in order, and keys to add,
 * change, move and remove them. Every change is saved as it is made.
 */
export function PipelineEditor({ file, bolt, workspace, others, adding = false, editing, glyphs, height, columns = 100, onClose, onChanged, onMessage, onSaving, onHint, onJump, onBusy }: PipelineEditorProps) {
  const [label, setLabel] = useState(bolt);
  const [raw, setRaw] = useState<RawPipeline>();
  const [index, setIndexState] = useState(-1);
  const indexRef = useRef(-1);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const [open, setOpen] = useState(adding);
  const [newStep, setNewStep] = useState<{ at: number; kind?: StepKindName } | undefined>(adding ? { at: 0 } : undefined);
  const [deleting, setDeleting] = useState<number>();
  const [dropping, setDropping] = useState<string>();
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

  const steps = raw?.steps ?? [];

  const inputs = Object.entries(raw?.inputs ?? {});
  const asking = raw?.confirm === true ? true : typeof raw?.confirm === "string" && raw.confirm.trim() ? raw.confirm.trim() : false;
  const rows: Row[] = [
    { kind: "name" },
    { kind: "slug" },
    { kind: "notes" },
    { kind: "failure" },
    { kind: "confirm" },
    ...inputs.map(([name]): Row => ({ kind: "input", name })),
    { kind: "add-input" },
    ...steps.map((_, at): Row => ({ kind: "step", at })),
    { kind: "add" },
  ];
  const first = 6 + inputs.length;
  const place = (at: number) => (at < 0 ? first : Math.min(at, rows.length - 1));
  const selected = place(index);
  const row = rows[selected] as Row;

  const back = () => {
    setOpen(false);
    setNewStep(undefined);
    setSession((count) => count + 1);
  };

  const shift = async (work: () => Promise<number>) => {
    try {
      onSaving?.();
      const at = await work();
      await load(label);
      setIndex(first + at);
      onChanged(label);
    } catch (failure) {
      onMessage(failure instanceof Error ? failure.message : String(failure));
    }
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
    if (target.kind === "add-input" || target.kind === "input") return setOpen(true);
    if (target.kind === "add") {
      setNewStep({ at: steps.length });
      return setOpen(true);
    }
    if (target.kind === "step" && !stepKindOf(steps[target.at] as RawPipeline["steps"][number])) {
      return onMessage("Wisp can't edit this step here — change it in the file itself (E)");
    }
    setOpen(true);
  };

  const addAfter = (from: Row) => {
    if (from.kind === "input" || from.kind === "add-input") {
      setIndex(first - 1);
      return setOpen(true);
    }
    const at = from.kind === "step" ? from.at + 1 : steps.length;
    setNewStep({ at });
    setOpen(true);
  };

  useInput(
    (input, key) => {
      const at = place(indexRef.current);
      const current = rows[at] as Row;
      if (key.escape || input === "q") return onClose();
      if (onJump && (input === "1" || input === "2" || input === "3")) return onJump(input);
      if (input === "K" || (key.shift && key.upArrow)) {
        if (current.kind === "step") void shift(() => editing.moveStep(file, label, current.at, -1));
        return;
      }
      if (input === "J" || (key.shift && key.downArrow)) {
        if (current.kind === "step") void shift(() => editing.moveStep(file, label, current.at, 1));
        return;
      }
      if (key.upArrow || input === "k") return setIndex(Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setIndex(Math.min(rows.length - 1, at + 1));
      if (key.return || key.rightArrow) return edit(current);
      if (input === "a") return addAfter(current);
      if (current.kind === "step" && (input === "D" || key.delete)) return setDeleting(current.at);
      if (current.kind === "input" && (input === "D" || key.delete)) return setDropping(current.name);
    },
    { isActive: !open && deleting === undefined && dropping === undefined },
  );
  const busy = open || deleting !== undefined || dropping !== undefined;
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);

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
    !open && deleting === undefined && dropping === undefined,
  );

  const onInputs = row.kind === "input" || row.kind === "add-input";
  const hint =
    deleting !== undefined
      ? `Its place in the order closes up · ${ASK_KEYS}`
      : dropping !== undefined
        ? `Steps that use {{${dropping}}} keep it as written · ${ASK_KEYS}`
        : open && newStep && !newStep.kind
          ? "↑↓ choose · ⏎ pick · type to find · esc back"
          : open
            ? "↑↓ fields · ⏎ next · ctrl+s save · esc back"
            : [
                "↑↓ choose",
                "⏎ edit",
                onInputs ? "a add an input" : "a add a step",
                row.kind === "step" ? "D remove · K J move" : row.kind === "input" ? "D remove" : "",
                "esc done",
              ]
                .filter(Boolean)
                .join(" · ");
  useEffect(() => onHint?.(hint), [hint, onHint]);

  const stepForm = (kind: StepKindName, initial: Record<string, string>, at: number, replace: boolean, active: boolean, room: number) => {
    const entry = STEP_KINDS.find((candidate) => candidate.kind === kind);
    const otherSteps = steps.flatMap((other, position) => (replace && position === at ? [] : [{ value: String(position), label: `${position + 1} · ${describeRawStep(other)}` }]));
    const picking = kind === "pipeline" && others.length > 0;
    const current = replace ? afterOf(steps[at] as RawPipeline["steps"][number]) : [];
    const waitsOn = replace
      ? steps.flatMap((other, position) => (typeof other["label"] === "string" && current.includes(other["label"]) ? [String(position)] : []))
      : at > 0
        ? [String(at - 1)]
        : [];
    const fields = [
      ...(picking ? [{ key: "pipeline", label: "Pipeline", hint: "steps that depend on it wait for all of it", required: true, choices: others.map((name) => ({ value: name, label: name })) }, ...STEP_FIELDS.pipeline.filter((field) => field.key === "label")] : STEP_FIELDS[kind]),
      ...(otherSteps.length > 0 ? [{ key: "__after", label: "Depends on", required: false, multi: true, choices: otherSteps }] : []),
    ];
    const start = { ...initial, __after: waitsOn.join(",") };
    const valuesOf = (values: Record<string, string>) => {
      const { __after: _after, ...rest } = values;
      return rest;
    };
    const picked = (values: Record<string, string>) =>
      (values["__after"] ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number)
        .map((position) => (replace || position < at ? position : position + 1));
    return (
      <Form
        key={`step:${at}:${kind}:${session}`}
        title={`${replace ? `Step ${at + 1}` : steps.length === 0 ? "The first step" : `New step ${at + 1}`} · ${entry && glyphs.border === "round" ? `${entry.icon} ` : ""}${entry?.title ?? "Step"}`}
        {...(inputs.length > 0 && kind !== "wait" ? { intro: `${inputs.map(([name]) => `{{${name}}}`).join(", ")} puts in the value it asks for when it runs.` } : {})}
        fields={fields}
        initial={start}
        preview={(values) => {
          const { step } = buildStep(kind, valuesOf(values));
          return step ? describeRawStep(step) : undefined;
        }}
        submitLabel={replace ? "Save step" : "Add step"}
        cancelLabel={replace ? "Cancel" : "Back"}
        glyphs={glyphs}
        height={room}
        active={active}
        keys={false}
        onCancel={replace ? back : () => setNewStep({ at })}
        onSubmit={async (given) => {
          const values = valuesOf(given);
          const { step, errors } = buildStep(kind, values);
          if (!step) return errors;
          await change(
            async () => {
              await (replace ? editing.replaceStep(file, label, at, step) : editing.addStep(file, label, step, at));
              await editing.setAfter(file, label, at, picked(given));
            },
            first + at,
            replace ? "Saved." : `Added: ${describeRawStep(step)}`,
          );
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
          intro={steps.length === 0 ? "What should happen first when it runs?" : newStep.at === steps.length ? "What should happen next?" : `What should happen after "${describeRawStep(steps[newStep.at - 1] as RawPipeline["steps"][number])}"?`}
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
              await editing.renamePipeline(file, label, name);
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
    if (row.kind === "slug") {
      return (
        <Form
          key={`slug:${session}`}
          title="Slug"
          intro="What scripts, cron lines and git hooks type to run it. Left empty, it's made from the name and changes with it; one of your own stays when the name changes."
          fields={[{ key: "slug", label: "Slug", placeholder: slugify(label), hint: "lowercase letters, digits and hyphens" }]}
          initial={{ slug: raw?.slug ?? "" }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const slug = values["slug"]?.trim() ?? "";
            try {
              onSaving?.();
              await editing.setSlug(file, label, slug);
            } catch (failure) {
              return { slug: failure instanceof Error ? failure.message : String(failure) };
            }
            await load(label);
            onMessage(slug && slug !== slugify(label) ? `It answers to ${slug} now` : `It answers to ${slugify(label)}, from its name`);
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
            await change(() => editing.setPipelineNotes(file, label, values["notes"] ?? ""), undefined, "Saved.");
            back();
            return undefined;
          }}
        />
      );
    }
    if (row.kind === "confirm") {
      return (
        <Form
          key={`confirm:${session}`}
          title="Ask first"
          intro="Wisp asks before it runs this pipeline, for one with consequences: a deploy, a restore. A script has to pass --yes."
          fields={[
            {
              key: "ask",
              label: "Ask first",
              choices: [
                { value: "no", label: "no" },
                { value: "yes", label: "yes" },
              ],
            },
            { key: "question", label: "Question", placeholder: `Run "${label}"?`, hint: "empty asks the one in grey", when: (values) => values["ask"] === "yes" },
          ]}
          initial={{ ask: asking === false ? "no" : "yes", question: typeof asking === "string" ? asking : "" }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const next = values["ask"] === "yes" ? values["question"]?.trim() || true : false;
            if (next !== asking) {
              const said = next === false ? `"${label}" now runs without asking` : next === true ? `"${label}" now asks first` : `"${label}" now asks first: ${next}`;
              await change(() => editing.setConfirm(file, label, next), undefined, said);
            }
            back();
            return undefined;
          }}
        />
      );
    }
    if (row.kind === "input" || row.kind === "add-input") {
      const previous = row.kind === "input" ? row.name : undefined;
      const current = previous ? (raw?.inputs?.[previous] as RawInput) : undefined;
      if (!active && !current) {
        return (
          <Box flexDirection="column" height={room} borderStyle={glyphs.border} borderColor="gray" paddingX={1}>
            <Text bold>Inputs</Text>
            <Text dimColor wrap="wrap">Values it asks for each time it runs, like where to deploy or which backup to restore. Its steps use one as {"{{name}}"}.</Text>
            <Text> </Text>
            <Text dimColor>⏎ to add one</Text>
          </Box>
        );
      }
      return (
        <Form
          key={`input:${previous ?? ""}:${session}`}
          title={previous ? `Input ${previous}` : "A new input"}
          intro="A value it asks for each time it runs. Its steps use it as {{name}}."
          fields={[
            { key: "name", label: "Name", required: true, placeholder: "env", hint: "what its steps write between {{ }}" },
            { key: "ask", label: "Question", placeholder: "Deploy where?" },
            { key: "choices", label: "Choices", placeholder: "staging, production", hint: "commas between them; empty takes any value" },
            { key: "default", label: "Default", placeholder: "staging", hint: "used when none is given, as in a script" },
          ]}
          initial={previous && current ? inputValues(previous, current) : {}}
          preview={(values) => {
            const name = values["name"]?.trim();
            return name ? `${previous && previous !== name ? `renames {{${previous}}} to ` : "steps use it as "}{{${name}}}` : undefined;
          }}
          submitLabel={previous ? "Save" : "Add input"}
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const built = buildInput(values, inputs.map(([name]) => name).filter((name) => name !== previous));
            if ("errors" in built) return built.errors;
            const at = previous ? inputs.findIndex(([name]) => name === previous) : inputs.length;
            await change(() => editing.setInput(file, label, previous, built.name, built.input), 5 + at, previous ? "Saved." : `Added the input ${built.name}`);
            back();
            return undefined;
          }}
        />
      );
    }
    if (row.kind === "failure") {
      return (
        <Form
          key={`failure:${session}`}
          title="If a step fails"
          intro="What the rest of the run does when one of its steps fails."
          fields={[
            {
              key: "keepGoing",
              label: "On failure",
              hint: "stop: nothing after it runs",
              choices: [
                { value: "stop", label: "stop" },
                { value: "continue", label: "keep going" },
              ],
            },
          ]}
          initial={{ keepGoing: raw?.keepGoing ? "continue" : "stop" }}
          submitLabel="Save"
          glyphs={glyphs}
          height={room}
          active={active}
          keys={false}
          onCancel={back}
          onSubmit={async (values) => {
            const keepGoing = values["keepGoing"] === "continue";
            if (keepGoing !== Boolean(raw?.keepGoing)) {
              await change(() => editing.setKeepGoing(file, label, keepGoing), undefined, keepGoing ? `"${label}" now keeps going after a failure` : `"${label}" now stops at the first failure`);
            }
            back();
            return undefined;
          }}
        />
      );
    }
    const step = steps[row.at] as RawPipeline["steps"][number];
    const kind = stepKindOf(step);
    if (!kind) {
      return (
        <Box flexDirection="column" height={room} borderStyle={glyphs.border} borderColor="gray" paddingX={1}>
          <Text bold>{`Step ${row.at + 1}`}</Text>
          <Text dimColor wrap="wrap">Wisp can't edit this step here. Change it in the file itself (E).</Text>
        </Box>
      );
    }
    return stepForm(kind, stepValues(step), row.at, true, active, room);
  };

  const sideBySide = columns >= SIDE_BY_SIDE;
  if (!sideBySide && open) return right(true, height);

  const leftWidth = sideBySide ? Math.min(60, Math.max(36, Math.floor(columns * 0.42))) : undefined;
  const inputDetail = (input: RawInput) =>
    [input.choices && input.choices.length > 0 ? input.choices.join(" · ") : "", input.default !== undefined && input.default !== "" ? `default ${input.default}` : ""].filter(Boolean).join(", ");
  const inputLines = inputs.reduce((total, [, input]) => total + (inputDetail(input) ? 2 : 1), 0);
  const nameWidth = Math.min(16, Math.max(0, ...inputs.map(([name]) => name.length)));
  const room = Math.max(1, height - 14 - inputLines - (deleting === undefined && dropping === undefined ? 0 : 1));
  const stepRows = rows.map((entry, at) => ({ entry, at })).slice(first);
  const { items } = windowed(stepRows, Math.max(0, selected - first), room);
  const icon = (kind: string | undefined) => (glyphs.border !== "round" ? "" : (STEP_KINDS.find((entry) => entry.kind === kind)?.icon ?? "🔗") + " ");
  const pointer = (at: number) => <Text color={TONE.accent}>{at === selected ? `${glyphs.pointer} ` : "  "}</Text>;
  const detail = (at: number, name: string, value: string, empty: string) => (
    <Box ref={rowNodes.set(at)}>
      <Text wrap="truncate-end">
        {pointer(at)}
        <Text bold={at === selected} color={at === selected ? TONE.accent : undefined}>{name.padEnd(11)}</Text>
        {value ? <Text>{value}</Text> : <Text dimColor>{empty}</Text>}
      </Text>
    </Box>
  );

  const left = (
    <Box flexDirection="column" width={leftWidth} flexGrow={sideBySide ? 0 : 1} flexShrink={0} height={height} borderStyle={glyphs.border} borderColor={open ? "gray" : TONE.accent} paddingX={1} overflow="hidden">
      <Text bold color={TONE.accent} wrap="truncate-end">{`${glyphs.bolt}${label}`}</Text>
      <Box>
        {workspace ? (
          <Box flexShrink={0}>
            <Text>{workspace}</Text>
            <Text dimColor>{" · "}</Text>
          </Box>
        ) : null}
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-start">{tildify(file)}</Text>
        </Box>
      </Box>
      {error ? <Text color={TONE.failed}>{error}</Text> : <Text> </Text>}
      {detail(0, "Name", label, "")}
      {detail(1, "Slug", raw?.slug ?? "", slugify(label))}
      {detail(2, "Notes", raw?.notes ?? "", "none yet")}
      {detail(3, "On failure", raw?.keepGoing ? "keep going" : "stop", "")}
      {detail(4, "Ask first", asking === true ? "yes" : asking || "", "no")}
      <Text> </Text>
      <Text bold>Inputs</Text>
      {inputs.map(([name, input], at) => {
        const position = 5 + at;
        const on = position === selected;
        const detailLine = inputDetail(input);
        return (
          <Box key={`input:${name}`} flexDirection="column">
            <Box ref={rowNodes.set(position)} flexDirection="column">
              <Text wrap="truncate-end">
                {pointer(position)}
                <Text bold={on} color={name === dropping ? "red" : on ? TONE.accent : undefined}>{name.padEnd(nameWidth)}</Text>
                {"  "}
                {input.ask ? <Text>{input.ask}</Text> : <Text dimColor>no question: it asks for {name}</Text>}
              </Text>
              {detailLine ? <Text dimColor wrap="truncate-end">{`  ${"".padEnd(nameWidth)}  ${detailLine}`}</Text> : null}
            </Box>
            {name === dropping ? (
              <AskHere
                question="Remove this input?"
                yes="Remove"
                onAnswer={(yes) => {
                  setDropping(undefined);
                  if (yes) void change(() => editing.removeInput(file, label, name), 5 + Math.max(0, Math.min(at, inputs.length - 2)), `Removed the input ${name}`);
                }}
              />
            ) : null}
          </Box>
        );
      })}
      <Box ref={rowNodes.set(first - 1)}>
        <Text wrap="truncate-end">
          {pointer(first - 1)}
          <Text color={TONE.accent} bold={first - 1 === selected}>{`+  ${inputs.length === 0 ? "add an input" : "add another input"}`}</Text>
        </Text>
      </Box>
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
        const step = steps[entry.at] as RawPipeline["steps"][number];
        return (
          <Box key={`s${entry.at}`} flexDirection="column">
            <Box ref={rowNodes.set(at)}>
              <Text wrap="truncate-end">
                {pointer(at)}
                <Text dimColor>{`${String(entry.at + 1).padStart(2)}  `}</Text>
                {icon(stepKindOf(step))}
                <Text bold={active} color={entry.at === deleting ? "red" : active ? TONE.accent : undefined}>{describeRawStep(step)}</Text>
                {afterOf(step).length > 0 ? <Text dimColor>{`  after ${afterOf(step).join(", ")}`}</Text> : null}
              </Text>
            </Box>
            {entry.at === deleting ? (
              <AskHere
                question="Remove this step?"
                yes="Remove"
                onAnswer={(yes) => {
                  setDeleting(undefined);
                  if (yes) void change(() => editing.removeStep(file, label, entry.at), first + Math.max(0, Math.min(entry.at, steps.length - 2)), "Removed.");
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

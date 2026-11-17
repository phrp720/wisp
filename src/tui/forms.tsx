import { Box, Text, useInput, type Key } from "ink";
import { useRef, useState } from "react";

import type { Glyphs } from "./glyphs.js";

/** One field of a form: text by default, or a choice between a few options. */
export interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  /** A choice rather than text: ←/→ or space to change it. */
  choices?: { value: string; label: string }[];
}

export interface FormProps {
  title: string;
  /** A line under the title, saying what the form is for. */
  intro?: string;
  fields: FieldSpec[];
  initial?: Record<string, string>;
  submitLabel?: string;
  glyphs: Glyphs;
  height: number;
  /** Resolves with errors to show per field, or nothing when it worked. */
  onSubmit: (values: Record<string, string>) => Promise<Record<string, string> | undefined>;
  onCancel: () => void;
}

/**
 * A form, for everything that would otherwise mean editing JSON.
 *
 * ↑↓ or tab move between fields, typing edits the one you are on, ⏎ moves on — and on the
 * last field, saves. Problems are said under the field they are about, in words that say
 * what to put there instead.
 */
export function Form({ title, intro, fields, initial = {}, submitLabel = "save", glyphs, height, onSubmit, onCancel }: FormProps) {
  // Kept in refs as well as state: keys arrive faster than React redraws — typing fast, or
  // pasting — and each must build on the one before, not on the last frame drawn.
  const start = () => {
    const values: Record<string, string> = {};
    for (const field of fields) values[field.key] = initial[field.key] ?? field.choices?.[0]?.value ?? "";
    return values;
  };
  const valuesRef = useRef<Record<string, string>>(start());
  const indexRef = useRef(0);
  // Where the cursor is in each text field; it starts at the end of what is there.
  const cursorsRef = useRef<Record<string, number>>(Object.fromEntries(Object.entries(valuesRef.current).map(([key, value]) => [key, value.length])));
  const [cursors, setCursorsState] = useState(cursorsRef.current);
  const setCursor = (key: string, at: number) => {
    cursorsRef.current = { ...cursorsRef.current, [key]: at };
    setCursorsState(cursorsRef.current);
  };
  const [values, setValuesState] = useState(valuesRef.current);
  const [index, setIndexState] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const setValues = (next: Record<string, string>) => {
    valuesRef.current = next;
    setValuesState(next);
  };
  const setIndex = (next: number | ((at: number) => number)) => {
    indexRef.current = typeof next === "function" ? next(indexRef.current) : next;
    setIndexState(indexRef.current);
  };

  const submit = async () => {
    const values = valuesRef.current;
    const field = fields[indexRef.current] as FieldSpec;
    const missing: Record<string, string> = {};
    for (const entry of fields) if (entry.required && !values[entry.key]?.trim()) missing[entry.key] = `${entry.label} is needed`;
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setIndex(fields.findIndex((entry) => missing[entry.key]));
      return;
    }
    setSaving(true);
    const problems = await onSubmit(values).catch((error: unknown) => ({ [field.key]: error instanceof Error ? error.message : String(error) }));
    setSaving(false);
    if (problems && Object.keys(problems).length > 0) {
      setErrors(problems);
      const first = fields.findIndex((entry) => problems[entry.key]);
      if (first >= 0) setIndex(first);
    }
  };

  useInput((input, key) => {
    if (saving) return;
    const values = valuesRef.current;
    const index = indexRef.current;
    const field = fields[index] as FieldSpec;
    if (key.escape) return onCancel();
    if (key.upArrow || (key.shift && key.tab)) return setIndex((at) => Math.max(0, at - 1));
    if (key.downArrow || key.tab) return setIndex((at) => Math.min(fields.length - 1, at + 1));
    if (key.return) {
      if (index < fields.length - 1) return setIndex(index + 1);
      return void submit();
    }
    if (key.ctrl && input === "s") return void submit();

    if (field.choices) {
      const at = field.choices.findIndex((choice) => choice.value === values[field.key]);
      if (key.leftArrow || key.rightArrow || input === " ") {
        const step = key.leftArrow ? -1 : 1;
        const next = field.choices[(at + step + field.choices.length) % field.choices.length];
        if (next) setValues({ ...values, [field.key]: next.value });
      }
      return;
    }

    const value = values[field.key] ?? "";
    const next = editAt(value, Math.min(cursorsRef.current[field.key] ?? value.length, value.length), input, key);
    if (next !== undefined) {
      if (next.value !== value) {
        setValues({ ...values, [field.key]: next.value });
        if (errors[field.key]) setErrors({ ...errors, [field.key]: "" });
      }
      setCursor(field.key, next.cursor);
    }
  });

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="#a78bfa" paddingX={1}>
      <Text bold>{title}</Text>
      {intro ? <Text dimColor wrap="wrap">{intro}</Text> : null}
      <Text> </Text>
      {fields.map((entry, at) => {
        const active = at === index;
        const value = values[entry.key] ?? "";
        return (
          <Box key={entry.key} flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={active ? "#a78bfa" : undefined} bold={active}>{`${active ? glyphs.pointer : " "} ${entry.label.padEnd(14)}`}</Text>
              {entry.choices ? (
                <Text>
                  {entry.choices.map((option) => (
                    <Text key={option.value} inverse={option.value === value && active} bold={option.value === value} dimColor={option.value !== value}>
                      {` ${option.label} `}
                    </Text>
                  ))}
                </Text>
              ) : (
                active ? (
                  <Cursor value={value} at={Math.min(cursors[entry.key] ?? value.length, value.length)} />
                ) : (
                  <Text>{value || <Text dimColor>—</Text>}</Text>
                )
              )}
            </Text>
            {errors[entry.key] ? (
              <Text color="red">{`                 ${errors[entry.key]}`}</Text>
            ) : active && entry.hint ? (
              <Text dimColor>{`                 ${entry.hint}`}</Text>
            ) : null}
          </Box>
        );
      })}
      <Text dimColor>{saving ? "saving…" : `↑↓ fields · ←→ move in the text · ⏎ next · ⏎ on the last field to ${submitLabel} · esc cancel`}</Text>
    </Box>
  );
}

/** A text value with the cursor drawn where it is. */
function Cursor({ value, at }: { value: string; at: number }) {
  return (
    <Text>
      {value.slice(0, at)}
      <Text inverse>{value[at] ?? " "}</Text>
      {value.slice(at + 1)}
    </Text>
  );
}

/**
 * Text and cursor after one keypress — or nothing, when the key is not one for a text
 * field. ←/→ move, Home/End (or Ctrl-A/Ctrl-E) jump to the ends, typing and deleting
 * happen where the cursor is: fixing a typo in the middle of a command should not mean
 * deleting back to it.
 */
export function editAt(value: string, cursor: number, input: string, key: Key): { value: string; cursor: number } | undefined {
  const extra = key as Key & { home?: boolean; end?: boolean };
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  if (extra.home || (key.ctrl && input === "a")) return { value, cursor: 0 };
  if (extra.end || (key.ctrl && input === "e")) return { value, cursor: value.length };
  if (key.backspace || key.delete) {
    if (cursor === 0) return { value, cursor };
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (key.ctrl && input === "u") return { value: value.slice(cursor), cursor: 0 };
  if (key.ctrl && input === "w") {
    const before = value.slice(0, cursor).replace(/\s*\S+\s*$/, "");
    return { value: before + value.slice(cursor), cursor: before.length };
  }
  if (key.ctrl || key.meta || key.tab || key.return || key.escape || key.upArrow || key.downArrow) return undefined;
  if (!input) return undefined;
  // Pasted text arrives as one input; keep it on one line.
  const typed = input.replace(/[\r\n]+/g, " ");
  return { value: value.slice(0, cursor) + typed + value.slice(cursor), cursor: cursor + typed.length };
}

/** Text after one keypress, or nothing when the key is not one that edits text. */
export function editText(value: string, input: string, key: Key): string | undefined {
  if (key.backspace || key.delete) return value.slice(0, -1);
  if (key.ctrl && input === "u") return "";
  if (key.ctrl && input === "w") return value.replace(/\s*\S+\s*$/, "");
  if (key.ctrl || key.meta || key.tab || key.return || key.escape) return undefined;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return undefined;
  // Pasted text arrives as one input; keep it on one line.
  return input ? value + input.replace(/[\r\n]+/g, " ") : undefined;
}

/** A list to choose one thing from, each with a line saying what it is. */
export function Picker(props: {
  title: string;
  intro?: string;
  options: { key: string; title: string; detail?: string }[];
  glyphs: Glyphs;
  height: number;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const { title, intro, options, glyphs, height, onPick, onCancel } = props;
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow || input === "k") return setIndex((at) => Math.max(0, at - 1));
    if (key.downArrow || input === "j") return setIndex((at) => Math.min(options.length - 1, at + 1));
    if (key.return) {
      const option = options[index];
      if (option) onPick(option.key);
      return;
    }
    // A number picks straight away.
    const number = Number.parseInt(input, 10);
    if (number >= 1 && number <= options.length) onPick((options[number - 1] as { key: string }).key);
  });

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="#a78bfa" paddingX={1}>
      <Text bold>{title}</Text>
      {intro ? <Text dimColor>{intro}</Text> : null}
      <Text> </Text>
      {options.map((option, at) => {
        const active = at === index;
        return (
          <Text key={option.key} wrap="truncate-end">
            <Text color={active ? "#a78bfa" : undefined} bold={active} inverse={active}>{` ${at + 1}. ${option.title} `}</Text>
            {option.detail ? <Text dimColor>{`  ${option.detail}`}</Text> : null}
          </Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑↓ choose · ⏎ or its number to pick · esc cancel</Text>
    </Box>
  );
}

/** "Are you sure?", with what would happen said plainly, and only y saying yes. */
export function Confirm(props: { title: string; detail?: string; yes: string; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  const { title, detail, yes, glyphs, height, onAnswer } = props;
  useInput((input) => onAnswer(input === "y" || input === "Y"));
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold>{title}</Text>
      {detail ? <Text dimColor wrap="wrap">{detail}</Text> : null}
      <Text> </Text>
      <Text bold color="yellow">{`y to ${yes} · any other key to keep it`}</Text>
    </Box>
  );
}

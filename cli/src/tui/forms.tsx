import { Box, type DOMElement, Text, useInput, type Key } from "ink";
import { useRef, useState } from "react";

import type { Glyphs } from "./glyphs.js";
import { useMouse, useRefs } from "./mouse.js";
import { TONE } from "./tones.js";

/** One field of a form: text by default, or a choice between a few options. */
export interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  /** Shown in grey while the field is empty: an example of what goes there. */
  placeholder?: string;
  /** A choice rather than text: ←/→ or space to change it. */
  choices?: { value: string; label: string }[];
}

export interface FormProps {
  title: string;
  /** A line under the title, saying what the form is for. */
  intro?: string;
  fields: FieldSpec[];
  initial?: Record<string, string>;
  /** What the button at the bottom says: "Add step", "Create bolt", "Save". */
  submitLabel?: string;
  /** What it will do with the values as they are now — shown as they are typed. */
  preview?: (values: Record<string, string>) => string | undefined;
  glyphs: Glyphs;
  height: number;
  /** Resolves with errors to show per field, or nothing when it worked. */
  onSubmit: (values: Record<string, string>) => Promise<Record<string, string> | undefined>;
  onCancel: () => void;
}

/**
 * A form, for everything that would otherwise mean editing JSON — laid out the way Charm's
 * huh and Raycast lay theirs out: each field a label, an input line and a word of help, a bar
 * beside the one you are on, examples in grey where nothing is typed yet, and a button at the
 * bottom that does the thing. ↑↓ or tab move, ⏎ moves on and, on the button, saves.
 */
export function Form({ title, intro, fields, initial = {}, submitLabel = "Save", preview, glyphs, height, onSubmit, onCancel }: FormProps) {
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
  // The fields, then the button: `fields.length` is the button.
  const setIndex = (next: number | ((at: number) => number)) => {
    indexRef.current = typeof next === "function" ? next(indexRef.current) : next;
    setIndexState(indexRef.current);
  };

  const submit = async () => {
    const values = valuesRef.current;
    const missing: Record<string, string> = {};
    for (const entry of fields) if (entry.required && !values[entry.key]?.trim()) missing[entry.key] = `${entry.label} is needed`;
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setIndex(fields.findIndex((entry) => missing[entry.key]));
      return;
    }
    setSaving(true);
    const last = fields[fields.length - 1] as FieldSpec;
    const problems = await onSubmit(values).catch((error: unknown) => ({ [last.key]: error instanceof Error ? error.message : String(error) }));
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
    if (key.escape) return onCancel();
    if (key.upArrow || (key.shift && key.tab)) return setIndex((at) => Math.max(0, at - 1));
    if (key.downArrow || key.tab) return setIndex((at) => Math.min(fields.length, at + 1));
    if (key.ctrl && input === "s") return void submit();
    if (index === fields.length) {
      if (key.return || input === " ") return void submit();
      return;
    }
    if (key.return) return setIndex(index + 1);
    const field = fields[index] as FieldSpec;

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

  // Clicks: on a field, to type in it (on its text, the cursor goes where you clicked); on
  // an option, to choose it; on the button, to save. The wheel moves between fields, as ↑↓.
  const fieldNodes = useRefs<string>();
  const button = useRef<DOMElement>(null);
  useMouse((event, at) => {
    if (event.kind !== "click" || saving) return false;
    if (at(button.current)) {
      setIndex(fields.length);
      void submit();
      return true;
    }
    for (const [position, field] of fields.entries()) {
      const spot = at(fieldNodes.get(field.key));
      if (!spot) continue;
      setIndex(position);
      const values = valuesRef.current;
      const value = values[field.key] ?? "";
      // Line 0 is the label, line 1 the value, after the bar beside the field (two columns).
      if (spot.y === 1 && field.choices) {
        const chosen = choiceAt(field.choices, spot.x - 2);
        if (chosen) setValues({ ...values, [field.key]: chosen.value });
      } else if (!field.choices) {
        // On the value: where you clicked, after its "› ". Anywhere else: the end.
        setCursor(field.key, spot.y === 1 ? Math.max(0, Math.min(value.length, spot.x - 4)) : value.length);
      }
      return true;
    }
    return false;
  });

  const bar = glyphs.border === "round" ? "┃" : "|";
  const said = preview?.(values);
  const onButton = index === fields.length;
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
      <Text bold color={TONE.accent}>{title}</Text>
      {intro ? <Text dimColor wrap="wrap">{intro}</Text> : null}
      {fields.map((entry, at) => {
        const active = at === index;
        const value = values[entry.key] ?? "";
        const edge = <Text color={TONE.accent}>{active ? `${bar} ` : "  "}</Text>;
        return (
          <Box key={entry.key} ref={fieldNodes.set(entry.key)} flexDirection="column" marginTop={1}>
            <Text>
              {edge}
              <Text bold={active} color={active ? TONE.accent : undefined}>{entry.label}</Text>
              {entry.required ? <Text color={TONE.failed}>{" *"}</Text> : null}
            </Text>
            <Text wrap="wrap">
              {edge}
              {entry.choices ? (
                entry.choices.map((option, number) => {
                  const chosen = option.value === value;
                  return (
                    <Text key={option.value}>
                      {number > 0 ? "   " : ""}
                      <Text color={chosen ? TONE.accent : undefined} dimColor={!chosen}>{`${chosen ? "●" : "○"} ${option.label}`}</Text>
                    </Text>
                  );
                })
              ) : (
                <Text>
                  <Text dimColor>{"› "}</Text>
                  {active ? (
                    value ? <Cursor value={value} at={Math.min(cursors[entry.key] ?? value.length, value.length)} /> : <Text><Text inverse> </Text><Text dimColor>{entry.placeholder ?? ""}</Text></Text>
                  ) : (
                    value || <Text dimColor>{entry.placeholder ?? (entry.required ? "" : "optional")}</Text>
                  )}
                </Text>
              )}
            </Text>
            {errors[entry.key] ? (
              <Text color={TONE.failed}>{`${active ? bar : " "} ${errors[entry.key]}`}</Text>
            ) : active && entry.hint ? (
              <Text>
                {edge}
                <Text dimColor>{entry.choices ? `${entry.hint} — ←→ to change` : entry.hint}</Text>
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {said ? (
        <Text wrap="truncate-end">
          <Text dimColor>It will: </Text>
          <Text>{said}</Text>
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Box ref={button}>
          <Text color={onButton ? "black" : TONE.accent} backgroundColor={onButton ? TONE.accent : undefined} bold>
            {saving ? " saving… " : onButton ? ` ▸ ${submitLabel} ` : ` [ ${submitLabel} ] `}
          </Text>
        </Box>
        <Text dimColor>{"   ↑↓ fields · ⏎ next · ctrl+s or ⏎ on the button to save · esc cancel"}</Text>
      </Box>
    </Box>
  );
}

/** The option of a choice field at a column of its line: "● label", three spaces apart. */
export function choiceAt<T extends { label: string }>(choices: T[], column: number): T | undefined {
  let at = 0;
  for (const [number, choice] of choices.entries()) {
    if (number > 0) at += 3;
    const width = 2 + choice.label.length;
    if (column >= at && column < at + width) return choice;
    at += width;
  }
  return undefined;
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

/**
 * A list to choose one thing from — like the action list of Shortcuts or n8n: grouped under
 * headings, each with an icon and examples, and typing narrows it down.
 */
export function Picker(props: {
  title: string;
  intro?: string;
  options: { key: string; title: string; detail?: string; group?: string; icon?: string }[];
  glyphs: Glyphs;
  height: number;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const { title, intro, options, glyphs, height, onPick, onCancel } = props;
  const [index, setIndexState] = useState(0);
  const [query, setQueryState] = useState("");
  const indexRef = useRef(0);
  const queryRef = useRef("");
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const setQuery = (next: string) => {
    queryRef.current = next;
    setQueryState(next);
    setIndex(0);
  };
  // A step whose name matches beats one whose description does: "open a web" means "Open a
  // website", not "Wait until something is ready", whose example says "a website answers".
  const matching = (text: string) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const all = (haystack: string) => words.every((word) => haystack.toLowerCase().includes(word));
    const byName = options.filter((option) => all(option.title));
    if (byName.length > 0) return byName;
    return options.filter((option) => all(`${option.title} ${option.detail ?? ""} ${option.group ?? ""}`));
  };
  const shown = matching(query);

  useInput((input, key) => {
    const list = matching(queryRef.current);
    if (key.escape) return queryRef.current ? setQuery("") : onCancel();
    if (key.upArrow) return setIndex(Math.max(0, indexRef.current - 1));
    if (key.downArrow || key.tab) return setIndex(Math.min(list.length - 1, indexRef.current + 1));
    if (key.return) {
      const option = list[indexRef.current];
      if (option) onPick(option.key);
      return;
    }
    if (key.backspace || key.delete) return setQuery(queryRef.current.slice(0, -1));
    // With nothing typed, a number picks straight away; otherwise typing narrows the list.
    const number = Number.parseInt(input, 10);
    if (!queryRef.current && number >= 1 && number <= list.length) return onPick((list[number - 1] as { key: string }).key);
    if (input && !key.ctrl && !key.meta && /^[\w\s.-]+$/.test(input)) setQuery(queryRef.current + input);
  });

  // A click on an option picks it, as ⏎ does.
  const optionNodes = useRefs<string>();
  useMouse((event, at) => {
    if (event.kind !== "click") return false;
    const hit = optionNodes.entries().find(([, node]) => at(node));
    if (hit) onPick(hit[0]);
    return Boolean(hit);
  });

  let group: string | undefined;
  // Titles padded to one width, so the examples beside them line up in a column.
  const widest = Math.max(0, ...shown.map((option) => option.title.length));
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
      <Text bold color={TONE.accent}>{title}</Text>
      {intro ? <Text dimColor>{intro}</Text> : null}
      <Text>
        <Text color={TONE.accent}>{"/ "}</Text>
        {query ? <Text>{query}</Text> : <Text dimColor>type to find one</Text>}
      </Text>
      {shown.length === 0 ? <Text dimColor>{`Nothing matches “${query}” — esc clears it.`}</Text> : null}
      {shown.map((option, at) => {
        const active = at === index;
        const heading = option.group && option.group !== group ? option.group : undefined;
        group = option.group;
        return (
          <Box key={option.key} flexDirection="column">
            {heading ? <Text bold dimColor>{`\n${heading.toUpperCase()}`}</Text> : null}
            <Box ref={optionNodes.set(option.key)}>
            <Text wrap="truncate-end">
              <Text color={TONE.accent}>{active ? `${glyphs.pointer} ` : "  "}</Text>
              {option.icon && glyphs.border === "round" ? `${option.icon} ` : ""}
              <Text bold={active} color={active ? TONE.accent : undefined}>{option.title.padEnd(widest)}</Text>
              {option.detail ? <Text dimColor>{`   ${option.detail}`}</Text> : null}
            </Text>
            </Box>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>↑↓ choose · ⏎ pick · type to find · esc cancel</Text>
    </Box>
  );
}

/** "Are you sure?", with what would happen said plainly, and only y saying yes. */
export function Confirm(props: { title: string; detail?: string; yes: string; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  const { title, detail, yes, glyphs, height, onAnswer } = props;
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold>{title}</Text>
      {detail ? <Text dimColor wrap="wrap">{detail}</Text> : null}
      <Text> </Text>
      <Choice yes={`Yes, ${yes}`} no="No, keep it" danger onAnswer={onAnswer} />
    </Box>
  );
}

/**
 * Two buttons side by side, as a dialog has: ←→ or tab moves between them, ⏎ presses the
 * one picked, esc is always "no". y and n still work, for those who know them. A choice that
 * deletes or allows something starts on "no", so a stray ⏎ does nothing harmful.
 */
export function Choice(props: { yes: string; no: string; danger?: boolean; onAnswer: (yes: boolean) => void; onCancel?: () => void }) {
  const { yes, no, danger = false, onAnswer, onCancel } = props;
  const [onYes, setOnYes] = useState(!danger);
  const picked = useRef(onYes);
  const pick = (yes: boolean) => {
    picked.current = yes;
    setOnYes(yes);
  };
  const answered = useRef(false);
  // The key that answers is the dialog's alone. Every screen hears each key; answering at
  // once would close the dialog before the screen behind it hears the same ⏎, and it would
  // act on it too — run the bolt under the dialog. So the answer lands after the key is done.
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    setTimeout(() => onAnswer(yes), 0);
  };
  useInput((input, key) => {
    if (answered.current) return;
    // Arrows go where they point: ← to the left button (yes), → to the right one (no). Only
    // tab flips, so → on "No" stays on "No" instead of jumping to "Yes, delete it".
    if (key.leftArrow || input === "h") return pick(true);
    if (key.rightArrow || input === "l") return pick(false);
    if (key.tab) return pick(!picked.current);
    if (key.return || input === " ") return answer(picked.current);
    if (input === "y" || input === "Y") return answer(true);
    // Where both buttons do something, esc is neither: it backs out.
    if (key.escape && onCancel) {
      answered.current = true;
      return void setTimeout(onCancel, 0);
    }
    if (key.escape || input === "n" || input === "N" || input === "q") return answer(false);
  });
  const button = (label: string, focused: boolean, color: string) => (
    <Text color={focused ? "black" : color} backgroundColor={focused ? color : undefined} bold={focused}>
      {focused ? `▸ ${label} ` : `  ${label} `}
    </Text>
  );
  return (
    <Box flexDirection="column">
      <Box>
        {button(yes, onYes, danger ? "red" : TONE.accent)}
        <Text>{"   "}</Text>
        {button(no, !onYes, "gray")}
      </Box>
      <Text dimColor>←→ choose · ⏎ confirm · esc cancel</Text>
    </Box>
  );
}

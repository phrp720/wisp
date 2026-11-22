import { Box, type DOMElement, Text, useInput, type Key } from "ink";
import { useRef, useState } from "react";

import type { Glyphs } from "../terminal/glyphs.js";
import { useMouse, useRefs } from "../terminal/mouse.js";
import { TONE } from "../terminal/tones.js";

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
  multi?: boolean;
  when?: (values: Record<string, string>) => boolean;
  guess?: (values: Record<string, string>) => string | undefined;
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
  cancelLabel?: string;
  active?: boolean;
  keys?: boolean;
}

/**
 * A form, for everything that would otherwise mean editing JSON — laid out the way Charm's
 * huh and Raycast lay theirs out: each field a label, an input line and a word of help, a bar
 * beside the one you are on, examples in grey where nothing is typed yet, and a button at the
 * bottom that does the thing. ↑↓ or tab move, ⏎ moves on and, on the button, saves.
 */
export function Form({ title, intro, fields, initial = {}, submitLabel = "Save", cancelLabel = "Cancel", preview, glyphs, height, onSubmit, onCancel, active: editing = true, keys = true }: FormProps) {
  // Kept in refs as well as state: keys arrive faster than React redraws — typing fast, or
  // pasting — and each must build on the one before, not on the last frame drawn.
  const touched = useRef(new Set(Object.keys(initial)));
  const guessed = (values: Record<string, string>) => {
    let next = values;
    for (const field of fields) {
      if (!field.guess || touched.current.has(field.key)) continue;
      const guess = field.guess(next);
      if (guess !== undefined && next[field.key] !== guess) next = { ...next, [field.key]: guess };
    }
    return next;
  };
  const visible = (values: Record<string, string>) => fields.filter((field) => !field.when || field.when(values));
  const start = () => {
    const values: Record<string, string> = {};
    for (const field of fields) values[field.key] = initial[field.key] ?? (field.multi ? "" : (field.choices?.[0]?.value ?? ""));
    return guessed(values);
  };
  const valuesRef = useRef<Record<string, string>>(start());
  const pickRef = useRef<Record<string, number>>({});
  const [picks, setPicks] = useState<Record<string, number>>({});
  const setPick = (key: string, at: number) => {
    pickRef.current = { ...pickRef.current, [key]: at };
    setPicks(pickRef.current);
  };
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
    const shown = visible(values);
    const missing: Record<string, string> = {};
    for (const entry of shown) if (entry.required && !values[entry.key]?.trim()) missing[entry.key] = `${entry.label} is needed`;
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setIndex(shown.findIndex((entry) => missing[entry.key]));
      return;
    }
    setSaving(true);
    const last = shown[shown.length - 1] as FieldSpec;
    const problems = await onSubmit(values).catch((error: unknown) => ({ [last.key]: error instanceof Error ? error.message : String(error) }));
    setSaving(false);
    if (problems && Object.keys(problems).length > 0) {
      setErrors(problems);
      const first = shown.findIndex((entry) => problems[entry.key]);
      if (first >= 0) setIndex(first);
    }
  };
  const change = (field: FieldSpec, next: Record<string, string>) => {
    touched.current.add(field.key);
    const settled = guessed(next);
    setValues(settled);
    setIndex((at) => Math.min(at, visible(settled).length));
  };

  useInput((input, key) => {
    if (saving) return;
    const values = valuesRef.current;
    const index = indexRef.current;
    const shown = visible(values);
    if (key.escape) return onCancel();
    if (key.upArrow || (key.shift && key.tab)) return setIndex((at) => Math.max(0, at - 1));
    if (key.downArrow || key.tab) return setIndex((at) => Math.min(shown.length + 1, at + 1));
    if (key.ctrl && input === "s") return void submit();
    if (index >= shown.length) {
      if (key.leftArrow) return setIndex(shown.length);
      if (key.rightArrow) return setIndex(shown.length + 1);
      if (key.return || input === " ") return index > shown.length ? onCancel() : void submit();
      return;
    }
    if (key.return) return setIndex(index + 1);
    const field = shown[index] as FieldSpec;

    if (field.choices && field.multi) {
      const at = pickRef.current[field.key] ?? 0;
      const rows = withAll(field.choices);
      if (key.leftArrow || key.rightArrow) return setPick(field.key, (at + (key.leftArrow ? -1 : 1) + rows.length) % rows.length);
      const row = rows[at];
      if (input === " " && row) change(field, { ...values, [field.key]: row.all ? everyOrNone(values[field.key] ?? "", field.choices) : toggled(values[field.key] ?? "", row.value) });
      return;
    }
    if (field.choices) {
      const at = field.choices.findIndex((choice) => choice.value === values[field.key]);
      if (key.leftArrow || key.rightArrow || input === " ") {
        const step = key.leftArrow ? -1 : 1;
        const next = field.choices[(at + step + field.choices.length) % field.choices.length];
        if (next) change(field, { ...values, [field.key]: next.value });
      }
      return;
    }

    const value = values[field.key] ?? "";
    const next = editAt(value, Math.min(cursorsRef.current[field.key] ?? value.length, value.length), input, key);
    if (next !== undefined) {
      if (next.value !== value) {
        change(field, { ...values, [field.key]: next.value });
        if (errors[field.key]) setErrors({ ...errors, [field.key]: "" });
      }
      setCursor(field.key, next.cursor);
    }
  }, { isActive: editing });

  // Clicks: on a field, to type in it (on its text, the cursor goes where you clicked); on
  // an option, to choose it; on the button, to save. The wheel moves between fields, as ↑↓.
  const fieldNodes = useRefs<string>();
  const button = useRef<DOMElement>(null);
  const cancel = useRef<DOMElement>(null);
  useMouse((event, at) => {
    if (event.kind !== "click" || saving) return false;
    const shown = visible(valuesRef.current);
    if (at(button.current)) {
      setIndex(shown.length);
      void submit();
      return true;
    }
    if (at(cancel.current)) {
      onCancel();
      return true;
    }
    for (const [position, field] of shown.entries()) {
      const spot = at(fieldNodes.get(field.key));
      if (!spot) continue;
      setIndex(position);
      const values = valuesRef.current;
      const value = values[field.key] ?? "";
      // Line 0 is the label, then the value (one line), or the options (one a line).
      if (field.choices && field.multi) {
        const row = withAll(field.choices)[spot.y - 1];
        if (row) {
          setPick(field.key, spot.y - 1);
          change(field, { ...values, [field.key]: row.all ? everyOrNone(value, field.choices) : toggled(value, row.value) });
        }
      } else if (field.choices) {
        const chosen = field.choices[spot.y - 1];
        if (chosen) change(field, { ...values, [field.key]: chosen.value });
      } else {
        // On the value: where you clicked, after its "› ". Anywhere else: the end.
        setCursor(field.key, spot.y === 1 ? Math.max(0, Math.min(value.length, spot.x - 4)) : value.length);
      }
      return true;
    }
    return false;
  }, editing);

  const bar = glyphs.border === "round" ? "┃" : "|";
  const said = preview?.(values);
  const shown = visible(values);
  const onButton = index === shown.length;
  const onCancelButton = index > shown.length;
  const needed = 3 + (intro ? 1 : 0) + shown.reduce((sum, entry) => sum + 2 + (entry.choices ? (entry.multi ? withAll(entry.choices).length : entry.choices.length) : 1) + 1, 0) + (said ? 1 : 0) + (editing ? 2 : 0);
  const compact = needed > height;
  const sizes = shown.map((entry, at) => 1 + (entry.choices ? (entry.multi ? withAll(entry.choices).length : entry.choices.length) : 1) + (errors[entry.key] || (editing && at === index && (entry.hint || entry.choices)) ? 2 : 0));
  const room = height - 3 - (intro ? 2 : 0) - (said ? 1 : 0) - (editing ? 2 : 0);
  const focus = Math.min(index, shown.length - 1);
  let from = 0;
  while (from < focus && sizes.slice(from, focus + 1).reduce((sum, size) => sum + size, 0) > room) from += 1;
  let to = focus + 1;
  while (to < shown.length && sizes.slice(from, to + 1).reduce((sum, size) => sum + size, 0) <= room) to += 1;
  const above = compact ? from : 0;
  const below = compact ? shown.length - Math.max(to, focus + 1) : 0;
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={editing ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text bold color={editing ? TONE.accent : undefined}>{title}</Text>
        {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
      </Text>
      {intro ? <Text dimColor wrap="wrap">{intro}</Text> : null}
      {shown.map((entry, at) => {
        if (at < above || at >= shown.length - below) return null;
        const active = editing && at === index;
        const value = values[entry.key] ?? "";
        const edge = <Text color={TONE.accent}>{active ? `${bar} ` : "  "}</Text>;
        return (
          <Box key={entry.key} ref={fieldNodes.set(entry.key)} flexDirection="column" flexShrink={0} marginTop={compact ? 0 : 1}>
            <Text>
              {edge}
              <Text bold={active} color={active ? TONE.accent : undefined}>{entry.label}</Text>
              {entry.required ? <Text color={TONE.failed}>{" *"}</Text> : null}
            </Text>
            {entry.choices && entry.multi ? (
              withAll(entry.choices).map((option, at) => {
                const all = option.all;
                const tickedCount = (entry.choices ?? []).filter((choice) => value.split(",").includes(choice.value)).length;
                const ticked = all ? tickedCount === (entry.choices ?? []).length : value.split(",").includes(option.value);
                const some = all && tickedCount > 0 && !ticked;
                const here = active && at === (picks[entry.key] ?? 0);
                const box = ticked ? (glyphs.border === "round" ? "■" : "[x]") : glyphs.border === "round" ? "□" : "[ ]";
                return (
                  <Text key={all ? "__all" : option.value} wrap="truncate-end">
                    {edge}
                    <Text color={here ? TONE.accent : undefined} bold={here} dimColor={!ticked && !here}>{`${box} ${option.label}`}</Text>
                    {some ? <Text dimColor>{`  ${tickedCount} of ${(entry.choices ?? []).length}`}</Text> : null}
                  </Text>
                );
              })
            ) : entry.choices ? (
              entry.choices.map((option) => {
                const chosen = option.value === value;
                return (
                  <Text key={option.value} wrap="truncate-end">
                    {edge}
                    <Text color={chosen ? TONE.accent : undefined} dimColor={!chosen}>{`${chosen ? "●" : "○"} ${option.label}`}</Text>
                  </Text>
                );
              })
            ) : (
              <Text wrap="wrap">
                {edge}
                <Text>
                  <Text dimColor>{"› "}</Text>
                  {active ? (
                    value ? <Cursor value={value} at={Math.min(cursors[entry.key] ?? value.length, value.length)} /> : <Text><Text inverse> </Text><Text dimColor>{entry.placeholder ?? ""}</Text></Text>
                  ) : (
                    value || <Text dimColor>{entry.placeholder ?? (entry.required ? "" : "optional")}</Text>
                  )}
                </Text>
              </Text>
            )}
            {errors[entry.key] ? (
              <Text color={TONE.failed}>{`${active ? bar : " "} ${errors[entry.key]}`}</Text>
            ) : active && (entry.hint || entry.choices) ? (
              <Text>
                {edge}
                <Text dimColor>{[entry.hint, entry.multi ? "←→ move · space ticks" : entry.choices ? "←→ to change" : ""].filter(Boolean).join(" — ")}</Text>
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
      {editing ? (
        <Box marginTop={1}>
          <Box ref={button}>
            <Text color={onButton ? "black" : TONE.accent} backgroundColor={onButton ? TONE.accent : undefined} bold>
              {saving ? " saving… " : onButton ? ` ▸ ${submitLabel} ` : ` [ ${submitLabel} ] `}
            </Text>
          </Box>
          {saving ? null : (
            <Box ref={cancel} marginLeft={1}>
              <Text color={onCancelButton ? "black" : undefined} backgroundColor={onCancelButton ? "gray" : undefined} dimColor={!onCancelButton}>
                {onCancelButton ? ` ▸ ${cancelLabel} ` : ` [ ${cancelLabel} ] `}
              </Text>
            </Box>
          )}
          {below > 0 ? <Text dimColor>{`   ↓ ${below} more`}</Text> : null}
          {keys ? <Text dimColor>{`   ↑↓ fields · ⏎ next · ctrl+s ${submitLabel.toLowerCase()} · esc ${cancelLabel.toLowerCase()}`}</Text> : null}
        </Box>
      ) : null}
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
  active?: boolean;
  keys?: boolean;
}) {
  const { title, intro, options, glyphs, height, onPick, onCancel, active: choosing = true, keys = true } = props;
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
  }, { isActive: choosing });

  // A click on an option picks it, as ⏎ does.
  const optionNodes = useRefs<string>();
  const cancelNode = useRef<DOMElement>(null);
  useMouse((event, at) => {
    if (event.kind !== "click") return false;
    if (at(cancelNode.current)) return onCancel(), true;
    const hit = optionNodes.entries().find(([, node]) => at(node));
    if (hit) onPick(hit[0]);
    return Boolean(hit);
  }, choosing);

  let group: string | undefined;
  // Titles padded to one width, so the examples beside them line up in a column.
  const widest = Math.max(0, ...shown.map((option) => option.title.length));
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={choosing ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text bold color={choosing ? TONE.accent : undefined}>{title}</Text>
      {intro ? <Text dimColor>{intro}</Text> : null}
      {choosing ? (
        <Text>
          <Text color={TONE.accent}>{"/ "}</Text>
          {query ? <Text>{query}</Text> : <Text dimColor>type to find one</Text>}
        </Text>
      ) : null}
      {shown.length === 0 ? <Text dimColor>{`Nothing matches “${query}” — esc clears it.`}</Text> : null}
      {shown.map((option, at) => {
        const active = choosing && at === index;
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
      {choosing || keys ? <Box flexGrow={1} /> : null}
      {choosing ? (
        <Box ref={cancelNode}>
          <Text dimColor>{" [ Cancel ] "}</Text>
        </Box>
      ) : null}
      {keys ? <Text dimColor>↑↓ choose · ⏎ pick · type to find · esc cancel</Text> : null}
    </Box>
  );
}

function useChoice(danger: boolean, onAnswer: (yes: boolean) => void, onCancel?: () => void): boolean {
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
  return onYes;
}

function choiceButton(label: string, focused: boolean, color: string) {
  return (
    <Text color={focused ? "black" : color} backgroundColor={focused ? color : undefined} bold={focused}>
      {focused ? `▸ ${label} ` : `  ${label} `}
    </Text>
  );
}

export const CONFIRM_KEYS = "←→ choose · ⏎ confirm · esc cancel";

export const ASK_KEYS = "⏎ confirm · esc cancel";

export function AskHere(props: { question: string; yes: string; no?: string; stacked?: boolean; onAnswer: (yes: boolean) => void }) {
  const { question, yes, no = "Keep", stacked = false, onAnswer } = props;
  const onYes = useChoice(true, onAnswer);
  const buttons = (
    <>
      {choiceButton(yes, onYes, "red")}
      <Text> </Text>
      {choiceButton(no, !onYes, "gray")}
    </>
  );
  if (stacked) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="red" bold wrap="wrap">{question}</Text>
        <Text wrap="truncate-end">{buttons}</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text color="red" bold>{question}</Text>
        <Text>{"  "}</Text>
        {buttons}
      </Text>
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
  const onYes = useChoice(danger, onAnswer, onCancel);
  return (
    <Box flexDirection="column">
      <Box>
        {choiceButton(yes, onYes, danger ? "red" : TONE.accent)}
        <Text>{"   "}</Text>
        {choiceButton(no, !onYes, "gray")}
      </Box>
      <Text dimColor>{CONFIRM_KEYS}</Text>
    </Box>
  );
}

function toggled(value: string, option: string): string {
  const ticked = value.split(",").filter(Boolean);
  return (ticked.includes(option) ? ticked.filter((entry) => entry !== option) : [...ticked, option]).join(",");
}

function everyOrNone(value: string, choices: { value: string }[]): string {
  const ticked = value.split(",").filter(Boolean);
  return choices.every((choice) => ticked.includes(choice.value)) ? "" : choices.map((choice) => choice.value).join(",");
}

function withAll(choices: { value: string; label: string }[]): { value: string; label: string; all: boolean }[] {
  const rows = choices.map((choice) => ({ ...choice, all: false }));
  return choices.length > 1 ? [{ value: "", label: "all", all: true }, ...rows] : rows;
}

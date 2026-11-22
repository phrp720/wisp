/** Your own settings on this machine, by category: what opens folders and files, where commands run, when Wisp tells you about a run, and the mouse. */

import { Box, type DOMElement, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { webhookProblem } from "../core/notify.js";
import { type FieldSpec, Form } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { useMouse, useRefs } from "./mouse.js";
import type { NotifyChoice, OpenWith, Services } from "./model.js";
import { TONE } from "./tones.js";

type Category = "opening" | "running" | "notifications" | "dashboard";

const CATEGORIES: { key: Category; label: string; intro: string }[] = [
  { key: "opening", label: "Opening", intro: "What opens a pipeline's folder and file steps. From a terminal: wisp open-with." },
  { key: "running", label: "Running", intro: "Where a pipeline's commands go while they keep running, like a dev server. Commands that finish always run where you can see them. From a terminal: wisp open-with terminal." },
  { key: "notifications", label: "Notifications", intro: "About a run you might have missed: one nobody watched (cron, a script), or one that took over 30 seconds. From a terminal: wisp notify." },
  { key: "dashboard", label: "Dashboard", intro: "How this screen behaves." },
];

const WHEN = { failures: "when a run fails", all: "when any run ends", off: "never" } as const;
const DEFAULT = "__default";
const OTHER = "__other";

export function SettingsScreen({ services, glyphs, height, columns = 100, onClose, onSaved, onMouse, onJump, onBusy }: { services: Services; glyphs: Glyphs; height: number; columns?: number; onClose: () => void; onSaved: (text: string) => void; onMouse?: (on: boolean) => void; onJump?: (input: string) => void; onBusy?: (busy: boolean) => void }) {
  const [current, setCurrent] = useState<OpenWith>();
  const [mouse, setMouse] = useState<boolean>();
  const [notify, setNotify] = useState<NotifyChoice>();
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false);
  const setEditing = (next: boolean) => {
    editingRef.current = next;
    setEditingState(next);
  };
  const [session, setSession] = useState(0);
  const choices = useRef(services.settings.choices()).current;

  useEffect(() => {
    onBusy?.(editing);
  }, [editing, onBusy]);

  useEffect(() => {
    void services.settings.get().then(setCurrent);
    void services.settings.mouse().then(setMouse);
    void services.settings.notify().then(setNotify);
  }, [services]);

  const leave = () => {
    setEditing(false);
    setSession((count) => count + 1);
  };

  const rowNodes = useRefs<number>();
  const right = useRef<DOMElement>(null);
  useMouse(
    (event, at) => {
      if (event.kind !== "click") return false;
      const hit = rowNodes.entries().find(([, node]) => at(node));
      if (hit) {
        if (hit[0] === indexRef.current) setEditing(true);
        else setIndex(hit[0]);
        return true;
      }
      if (at(right.current)) {
        setEditing(true);
        return true;
      }
      return false;
    },
    !editing,
  );

  useInput(
    (input, key) => {
      if (key.escape || input === "q" || input === "s") return onClose();
      if (onJump && (input === "1" || input === "2" || input === "3")) return onJump(input);
      if (key.upArrow || input === "k") return setIndex(Math.max(0, indexRef.current - 1));
      if (key.downArrow || input === "j") return setIndex(Math.min(CATEGORIES.length - 1, indexRef.current + 1));
      if (key.return || key.rightArrow || input === " ") return setEditing(true);
    },
    { isActive: !editing },
  );

  const loaded = current !== undefined && mouse !== undefined && notify !== undefined;
  const category = CATEGORIES[index] as (typeof CATEGORIES)[number];
  const narrow = columns < 80;
  const leftWidth = Math.min(34, Math.max(24, Math.floor(columns * 0.3)));

  const summary = (key: Category): string => {
    if (!loaded) return "…";
    if (key === "opening") return current.folder === current.file ? describe("folder", current.folder) : `${describe("folder", current.folder)} · ${describe("file", current.file)}`;
    if (key === "running") return current.terminal ? describe("terminal", current.terminal) : "in the background";
    if (key === "notifications") return `${WHEN[notify.when]}${notify.webhook ? " · webhook" : ""}`;
    return `mouse ${mouse ? "on" : "off"}`;
  };

  const form = () => {
    if (!loaded) return <Text dimColor>…</Text>;
    const { fields, initial, save } = categoryForm(category.key, { current, mouse, notify, editors: choices.editors, terminals: choices.terminals });
    return (
      <Form
        key={`${category.key}:${session}`}
        title={category.label}
        intro={category.intro}
        fields={fields}
        initial={initial}
        submitLabel="Save"
        cancelLabel="Back"
        glyphs={glyphs}
        height={height}
        active={editing}
        keys={editing}
        onCancel={leave}
        onSubmit={async (values) => {
          const outcome = await save(values, services);
          if (outcome.errors) return outcome.errors;
          if (outcome.current) setCurrent(outcome.current);
          if (outcome.notify) setNotify(outcome.notify);
          if (outcome.mouse !== undefined) {
            setMouse(outcome.mouse);
            onMouse?.(outcome.mouse);
          }
          onSaved(outcome.said ?? "Saved");
          leave();
          return undefined;
        }}
      />
    );
  };

  const list = (
    <Box flexDirection="column" width={narrow ? undefined : leftWidth} flexGrow={narrow ? 1 : 0} flexShrink={0} height={height} borderStyle={glyphs.border} borderColor={editing ? "gray" : TONE.accent} paddingX={1}>
      <Text bold color={editing ? undefined : TONE.accent}>Settings</Text>
      <Text dimColor wrap="truncate-end">On this machine only.</Text>
      <Text> </Text>
      {CATEGORIES.map((entry, at) => {
        const selected = at === index;
        return (
          <Box key={entry.key} ref={rowNodes.set(at)} flexDirection="column" flexShrink={0} marginBottom={1}>
            <Text wrap="truncate-end">
              <Text color={TONE.accent}>{selected ? `${glyphs.pointer} ` : "  "}</Text>
              <Text bold={selected} color={selected && !editing ? TONE.accent : undefined}>{entry.label}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">{`  ${summary(entry.key)}`}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {editing ? null : <Text dimColor wrap="truncate-end">⏎ edit · esc back</Text>}
    </Box>
  );

  if (narrow) return editing ? <Box ref={right} flexDirection="column" flexGrow={1}>{form()}</Box> : list;
  return (
    <Box height={height}>
      {list}
      <Box ref={right} flexDirection="column" flexGrow={1} minWidth={0}>
        {form()}
      </Box>
    </Box>
  );
}

interface Saved {
  errors?: Record<string, string>;
  current?: OpenWith;
  notify?: NotifyChoice;
  mouse?: boolean;
  said?: string;
}

function categoryForm(
  category: Category,
  state: { current: OpenWith; mouse: boolean; notify: NotifyChoice; editors: { value: string; label: string }[]; terminals: string[] },
): { fields: FieldSpec[]; initial: Record<string, string>; save: (values: Record<string, string>, services: Services) => Promise<Saved> } {
  const { current, mouse, notify, editors, terminals } = state;

  if (category === "opening") {
    const apps = [{ value: DEFAULT, label: "the system default" }, ...editors, { value: OTHER, label: "another app…" }];
    const known = (value: string | undefined) => (!value ? DEFAULT : editors.some((editor) => editor.value === value) ? value : OTHER);
    const other = (key: "folder" | "file") => ({
      key: `${key}App`,
      label: key === "folder" ? "App for folders" : "App for files",
      hint: "its name on macOS, or a command on Linux and Windows",
      placeholder: "Visual Studio Code",
      required: true,
      when: (values: Record<string, string>) => values[key] === OTHER,
    });
    return {
      fields: [
        { key: "folder", label: "Folders open in", hint: "a pipeline's folder steps, like apps/api", choices: apps },
        other("folder"),
        { key: "file", label: "Files open in", hint: "a pipeline's file steps, like docs/runbook.md", choices: apps },
        other("file"),
      ],
      initial: {
        folder: known(current.folder),
        folderApp: known(current.folder) === OTHER ? (current.folder ?? "") : "",
        file: known(current.file),
        fileApp: known(current.file) === OTHER ? (current.file ?? "") : "",
      },
      save: async (values, services) => {
        const pick = (key: "folder" | "file") => (values[key] === DEFAULT ? "" : values[key] === OTHER ? (values[`${key}App`] ?? "").trim() : (values[key] ?? ""));
        const next = await services.settings.set({ folder: pick("folder"), file: pick("file") });
        return { current: next, said: `Folders open in ${describe("folder", next.folder)}, files in ${describe("file", next.file)}` };
      },
    };
  }

  if (category === "running") {
    const options = [
      { value: DEFAULT, label: "in the background, watched in Wisp" },
      ...terminals.filter((name) => name !== "tmux" && name !== "zellij").map((name) => ({ value: name, label: `in a ${name} window` })),
      ...terminals.filter((name) => name === "tmux" || name === "zellij").map((name) => ({ value: name, label: `in a ${name} session` })),
    ];
    if (current.terminal && !options.some((option) => option.value === current.terminal)) options.push({ value: current.terminal, label: describe("terminal", current.terminal) });
    return {
      fields: [{ key: "terminal", label: "Commands run", hint: "a tmux session suits a server over SSH: tmux attach -t wisp", choices: options }],
      initial: { terminal: current.terminal || DEFAULT },
      save: async (values, services) => {
        const next = await services.settings.set({ terminal: values["terminal"] === DEFAULT ? "" : (values["terminal"] ?? "") });
        return { current: next, said: `Commands run ${describe("terminal", next.terminal)}` };
      },
    };
  }

  if (category === "notifications") {
    return {
      fields: [
        { key: "when", label: "Tell me", hint: "on this screen, and at the webhook if there is one", choices: (Object.keys(WHEN) as (keyof typeof WHEN)[]).map((value) => ({ value, label: WHEN[value] })) },
        { key: "webhook", label: "Webhook", hint: "for a server: Slack, Discord and ntfy get a message, any other address JSON. Empty for none", placeholder: "https://ntfy.sh/my-server" },
      ],
      initial: { when: notify.when, webhook: notify.webhook ?? "" },
      save: async (values, services) => {
        const url = values["webhook"]?.trim() ?? "";
        const refused = url ? webhookProblem(url) : undefined;
        if (refused) return { errors: { webhook: refused } };
        const next = await services.settings.setNotify({ when: values["when"] as NotifyChoice["when"], webhook: url });
        return { notify: next, said: `Tell me ${WHEN[next.when]}${next.webhook ? `, and at ${next.webhook}` : ""}` };
      },
    };
  }

  return {
    fields: [
      {
        key: "mouse",
        label: "Mouse",
        hint: "on: click rows and tabs, scroll with the wheel. Off: select text without holding Shift",
        choices: [
          { value: "on", label: "on" },
          { value: "off", label: "off" },
        ],
      },
    ],
    initial: { mouse: mouse ? "on" : "off" },
    save: async (values, services) => {
      const next = await services.settings.setMouse(values["mouse"] === "on");
      return { mouse: next, said: `Mouse: ${next ? "on" : "off"}` };
    },
  };
}

function describe(key: "folder" | "file" | "terminal", value: string | undefined): string {
  if (value) return key === "terminal" ? (value === "tmux" || value === "zellij" ? `in a ${value} session` : `in a ${value} window`) : value;
  return key === "terminal" ? "in the background, watched in Wisp" : "the system default";
}

/**
 * Terminal output, made safe to show inside another program's layout.
 *
 * A command run under a terminal writes what a terminal understands: colours, but also
 * carriage returns that redraw a progress bar, cursor moves, window titles, the `^D` a
 * shim echoes. Colours are kept — they are half of what makes a log readable — and the
 * rest is played out the way a terminal would, so a progress bar ends as its last frame
 * rather than as forty lines of them.
 */
export function cleanOutput(text: string): string {
  const withoutShim = text.replace(/^(\^D)?\u0004?[\b]{0,2}/, "");
  const lines = withoutShim
    .replace(/\r\n/g, "\n")
    // OSC: titles and hyperlinks. Their payload is not text to show.
    .replace(/\u001B\][^\u0007\u001B]*(\u0007|\u001B\\)/g, "")
    // The screen cleared: marked, before the clears go with the other cursor codes.
    .replace(SCREEN_CLEARED, CLEARED)
    // CSI: keep colours (`m`), drop cursor moves, clears and modes.
    .replace(/\u001B\[[0-9;?]*([A-Za-z])/g, (sequence: string, final: string) => (final === "m" ? sequence : ""))
    // Character sets and keypad modes.
    .replace(/\u001B[()][0-9A-Za-z]|\u001B[=>]/g, "")
    .split("\n");

  // A log keeps what came before a clear: a viewer has no screen to wipe, and you want it
  // back. What it drops is the padding: Vite, for one, prints a screenful of blank lines
  // before each clear to push the old screen up, which in a log is the last screen of it
  // looking empty, the latest message alone at its bottom.
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw.includes(CLEARED)) {
      out.push(playLine(raw));
      continue;
    }
    while (out.length > 0 && stripAnsi(out[out.length - 1] as string).trim() === "") out.pop();
    const line = playLine(raw.replaceAll(CLEARED, ""));
    if (stripAnsi(line).trim() !== "") out.push(line);
  }
  return out.join("\n");
}

/**
 * The ways a program clears the screen: the cursor sent home and everything below erased
 * (`ESC[H ESC[J`, Vite's `ESC[1;1H ESC[0J`), the screen or scrollback erased (`ESC[2J`,
 * `ESC[3J`), or the terminal reset (`ESC c`).
 */
const SCREEN_CLEARED = /\u001B\[(?:[01]?(?:;[01]?)?)?H\u001B\[[0-2]?J|\u001B\[[23]J|\u001Bc/g;
/** Where the screen was cleared, while a log is played out. A private-use character, never in real output. */
const CLEARED = "\uE000";

/** One line as it would end up on screen: `\r` returns to its start, `\b` steps back. */
function playLine(line: string): string {
  let text = line;
  if (text.includes("\r")) {
    const parts = text.split("\r").filter((part, index, all) => part !== "" || index === all.length - 1);
    text = parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
  }
  if (text.includes("\b")) {
    let out = "";
    for (const char of text) out = char === "\b" ? out.slice(0, -1) : out + char;
    text = out;
  }
  // Anything else below a space, bar tab and escape, is not for showing.
  return expandTabs(text.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, ""));
}

/**
 * Tabs as the spaces a terminal would draw, to the next multiple of eight.
 *
 * A layout counts a tab as one column; a terminal draws it as up to eight. Left in, every
 * tabbed log line is wider than the layout thinks, wraps, and takes the borders with it.
 * Colour codes take no columns, so they are stepped over when counting.
 */
export function expandTabs(text: string, width = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "\u001B") {
      const sequence = /^\u001B\[[0-9;?]*[A-Za-z]/.exec(text.slice(at));
      if (sequence) {
        out += sequence[0];
        at += sequence[0].length - 1;
        continue;
      }
    }
    if (char === "\t") {
      const spaces = width - (column % width);
      out += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    out += char;
    column += 1;
  }
  return out;
}

/** Text with its colours taken out, for measuring and searching. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

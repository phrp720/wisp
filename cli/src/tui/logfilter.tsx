/**
 * Filtering a log down to the lines that matter, as `grep --color` would: every word of the
 * filter must be on the line, in any order and any case (the same rule as every other
 * filter in Wisp), and the words are lit where they are.
 */

import { Text } from "ink";
import type { ReactNode } from "react";

import { TONE } from "./tones.js";

/** A log line without its colours: what is matched, and what is shown once filtered. */
export function plain(line: string): string {
  return line.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
}

function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The lines with every word of the filter on them, each with its place in the log (from 0). */
export function filterLog(lines: string[], query: string): { at: number; text: string }[] {
  const words = wordsOf(query);
  const found: { at: number; text: string }[] = [];
  lines.forEach((line, at) => {
    const text = plain(line);
    const lower = text.toLowerCase();
    if (words.every((word) => lower.includes(word))) found.push({ at, text });
  });
  return found;
}

/** Where the filter's words are on a line: the line in pieces, the matching ones marked. */
export function pieces(text: string, query: string): { text: string; hit: boolean }[] {
  const words = wordsOf(query);
  const lower = text.toLowerCase();
  const lit = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let from = lower.indexOf(word); from >= 0; from = lower.indexOf(word, from + 1)) lit.fill(true, from, from + word.length);
  }
  const out: { text: string; hit: boolean }[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const last = out[out.length - 1];
    if (last && last.hit === lit[at]) last.text += text[at];
    else out.push({ text: text[at] as string, hit: lit[at] as boolean });
  }
  return out;
}

/** A matching line, its place in the log first, the filter's words lit. */
export function MatchLine({ at, text, query, width, indent = 0 }: { at: number; text: string; query: string; width: number; indent?: number }) {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{`${" ".repeat(indent)}${String(at + 1).padStart(width)} `}</Text>
      {pieces(text || " ", query).map((piece, index) =>
        piece.hit ? (
          <Text key={index} color="black" backgroundColor="yellow">
            {piece.text}
          </Text>
        ) : (
          <Text key={index}>{piece.text}</Text>
        ),
      )}
    </Text>
  );
}

/** The filter as it is typed, and what it found: "/ error   12 of 600 lines". */
export function FilterLine({ query, typing, found }: { query: string; typing: boolean; found: ReactNode }) {
  return (
    <Text wrap="truncate-end">
      <Text color={TONE.accent}>/ </Text>
      <Text>{query}</Text>
      {typing ? <Text inverse> </Text> : null}
      <Text dimColor>{`   `}</Text>
      {found}
      {typing ? null : <Text dimColor>{"   esc clears"}</Text>}
    </Text>
  );
}

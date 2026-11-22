# The dashboard

`wisp` opens a dashboard of all your projects in your terminal: run a pipeline, watch what it
started, look back at past runs, and make pipelines through forms. It works the same at your
desk, over SSH and in tmux.

<Recording name="dashboard" alt="Wisp's dashboard: running a pipeline in its box, its server's live output on the Running tab, then the History tab" />

## Three tabs

- **`1` Pipelines:** your workspaces on the left, their pipelines on the right, and under them the
  selected pipeline: its steps, what's up, how its last run went, and the command that runs it
  from a terminal. `⏎` runs it right there, each step ticking off. `c` checks it: what it
  would do, with nothing run. A pipeline with a problem says so on its row (`✗ 1 problem`), and
  its box says what's wrong and how to fix it.
- **`2` Running:** what each pipeline started, with live output, health and ports.
  [More](./running#the-running-tab).
- **`3` History:** every run like a CI run, with its branch, commit and each step's output.
  [More](./runs#history).

A pipeline that [asks for values](./file#inputs) shows a short form first, and one that
[asks first](./file#asking-first) asks on its row.

## No JSON needed

`a` adds a pipeline and `e` edits one. The editor shows the pipeline on the left (its name, notes,
what a failure does, whether it asks first, its inputs and its steps) and the form for the
selected row on the right.

New steps are picked from a list (run a command, start Docker services, run a pipeline, wait,
open something) and each has a **Depends on** list of the other steps to tick. `a` adds a
step after the selected one, already depending on it. `D` removes it, `K` `J` move it.
`E` opens the file itself if you'd rather.

<Recording name="editor" alt="Making a pipeline in the dashboard: name it, then add a command, a wait and a website through short forms, then run it" />

## The mouse

Click a tab, a workspace, a pipeline, a row or a button. The wheel scrolls what's under it. A
click only selects: `⏎` runs a pipeline, so a stray click never starts anything, and allowing
commands or confirming a delete stays on the keyboard. Forms have `[ Cancel ]` (or
`[ Back ]`) beside the button that saves.

Over SSH it works too, since your terminal sends the clicks. In tmux it needs
`set -g mouse on`. While Wisp has the mouse, selecting text takes Shift (Option in iTerm2);
turn the mouse off in [Settings](./settings) to select freely.

## Keys

Lowercase keys are everyday and safe. A capital is the heavier form of the same letter, and
`D` deletes, always after asking. `?` shows the keys of the screen you're on.

| | |
|---|---|
| `1` `2` `3` | Pipelines · Running · History |
| `↑↓` `j k` · `←→` `tab` | move · between workspaces and pipelines |
| `⏎` · `c` | run the selected pipeline · check it without running anything |
| `x` · `R` | stop the run, or what the pipeline started · restart it |
| `r` · `⏎` | after a run: retry from the failed step · close it |
| `a` · `e` · `D` | add · edit · delete a pipeline (on a workspace: `e` renames it, `D` removes it) |
| `K` · `J` | move a pipeline up · down |
| `N` · `E` | a personal workspace · open the file in your editor |
| `/` | search every workspace and pipeline; in a log or an open run, filter its lines |
| `[` · `]` · `f` | on Running: the selected command's tabs · its log full screen |
| `u` · `d` · `G` | scroll output up · down · back to the newest |
| `t` | allow a file's commands ([trust](./trust)) |
| `s` · `r` · `q` | [settings](./settings) · reload the files · quit |

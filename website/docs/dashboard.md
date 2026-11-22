# The dashboard

`wisp` opens a dashboard of all your workspaces, right in your terminal: run a pipeline,
watch what it started, look back at past runs, and make pipelines through forms. It works the
same at your desk, over SSH and in tmux.

<Recording name="dashboard" alt="Wisp's dashboard: running a pipeline in its box, its server's live output on the Running tab, then the History tab" />

## Three tabs

| Tab | |
|---|---|
| **`1` Pipelines** | your workspaces on the left, their pipelines on the right, the selected one's steps below |
| **`2` Running** | what each pipeline started, with live output, health and ports. [More](./whats-running#the-running-tab) |
| **`3` History** | every run, with its commit and each step's output. [More](./history) |

## Running one

Select a pipeline and press `⏎`: it runs right there, each step ticking off in its box, while
the list stays where it is.

- `x` stops it, and `r` retries from a failed step.
- `⏎` again closes the result, so a second `⏎` runs it again.
- `c` checks it instead: what it would do, with nothing run.

A pipeline that [asks for values](./inputs) shows a short form first, and one that
[asks first](./asking-first) asks on its row. A pipeline with a problem says so on its row
(`✗ 1 problem`), and its box says what's wrong and how to fix it.

## No JSON needed

`a` adds a pipeline and `e` edits one. The editor shows the pipeline on the left (its name,
notes, what a failure does, whether it asks first, its inputs and its steps) and the form for
the selected row on the right.

New steps are picked from the same list as on the [Steps](./steps) page: Start, Wait, Open.
Each step has a **Depends on** list of the other steps to tick. `a` adds a step below the
selected one, already depending on it; `D` removes it; `K` `J` move it. `E` opens the file in
your editor if you'd rather.

<Recording name="editor" alt="Making a pipeline in the dashboard: name it, then add a command, a wait and a website through short forms, then run it" />

## The mouse

Click a tab, a workspace, a pipeline, a row or a button, and the wheel scrolls what's under
it. A click only selects: `⏎` runs, so a stray click never starts anything, and allowing
commands or confirming a delete stays on the keyboard. Forms have `[ Cancel ]` (or
`[ Back ]`) beside the button that saves.

Over SSH it works too. In tmux, it needs `set -g mouse on`. While Wisp has the mouse,
selecting text takes Shift (Option in iTerm2); turn the mouse off in [Settings](./settings) to
select freely.

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

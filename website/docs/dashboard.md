# The dashboard

`wisp` opens a dashboard of all your projects, right in your terminal: run a bolt, watch what
it started, look back at past runs. It works the same at your desk, over SSH and in tmux.

![Wisp's dashboard: running a bolt, its server's live output on the Running tab, then the History tab](/demo/dashboard.gif)

## Three tabs

- **`1` Bolts:** your projects (and your own workspaces) on the left, their bolts on the
  right, and under them the selected bolt, whole: its steps with what each runs and whether
  it's up, the bolts it runs opened up in place, how its last run went, what runs it, and
  the command that runs it from a terminal. `⏎` runs it right there: each step ticks off in
  that box, with the output of the one running, while the list stays where it is. `x` stops
  the run, `r` retries from a failed step, and `⏎` (or `esc`) closes the result, so a second
  `⏎` runs it again.
  One that [asks for values](./file#inputs) shows a short form first, and one that
  [asks first](./file#asking-first) asks on its row.
  A bolt with a problem says so on its row (`✗ 1 problem`), and its box says what's wrong
  and how to fix it: a step naming a bolt that isn't there, a folder that's gone. A problem
  with the file itself is in the header. `c` checks the bolt without running anything.
- **`2` Running:** what each bolt started, as a pipeline, with live output, health and
  ports, and a log of what crashed and came back. Beside the list, each command has tabs
  for its logs, its details and its past runs, as in lazydocker.
- **`3` History:** every run like a CI run, with its branch, commit, and each step's output,
  including the ones still going. `D` deletes a run, or a bolt's runs.

## The mouse

Click a tab along the top, a workspace, a bolt, a row on Running or a tab beside it. In
History, click a run to choose it and again to open it, then click a step to show or hide
its log. The wheel scrolls the list under it, or the output when it is over a log. A click
selects; `⏎` still runs a bolt, so a stray click never starts anything.

Forms take clicks too: a field to type in it (on its text, the cursor goes where you
click), an option to choose it, the button to save, and `[ Cancel ]` beside it to leave
without saving (on a new step, `[ Back ]`, to the list of kinds; `esc` does the same). So do the lists you pick from, the setup checklist and Settings. In the
editor, the tabs along the top take you elsewhere whenever no form is open; with one open,
save or cancel it first. Allowing a project's commands and confirming a delete stay
on the keyboard, so a stray click can never do either.

It works over SSH too, since your own terminal sends the clicks. In tmux it needs
`set -g mouse on` in your `.tmux.conf`.

While Wisp has the mouse, selecting text takes Shift (Option in iTerm2), as in any
terminal app that uses the mouse. Rather select freely? Turn it off in [Settings](./settings) (`s`).

## No JSON needed

`a` adds a bolt and `e` edits one. The editor has two sides: on the left, the bolt (its
name, notes, what a failure does, whether it asks first and its inputs, then its steps), and on the right, the form for whatever is selected there. `⏎` edits it, `ctrl+s` saves, `esc` goes back. New steps are picked from a list
(Start, Wait, Open; another bolt is under Start) and filled in the same way, each with a
**Depends on** list of the other steps to tick (none ticked: it starts right away; **all**
ticks or clears them all). `a` adds one after the selected
step, already depending on it; `D` removes it and `K` `J` move it. On a narrow terminal it shows one side at a time. `E` opens
the file itself if you'd rather.

![Making a bolt in the dashboard: name it, then add a command, a wait and a website through short forms, then run it](/demo/editor.gif)

## Keys

| | |
|---|---|
| `⏎` · `c` | run the selected bolt, in its box · check it: what it would do, and what's wrong, with nothing run |
| `u` · `d` | scroll the selected bolt's steps, when they don't fit |
| `x` · `R` | stop the run while it goes, or what it started (asks about the bolts it needed) · restart it |
| `r` · `⏎` | after a run: retry from the step that failed · close it, back to the bolt |
| `e` · `a` · `D` | edit · add · delete a bolt (on the left: `e` renames a workspace and sets its icon and notes, `D` deletes it) |
| `←` `⏎` or `y` · `esc` | deleting asks on the row itself: delete it · keep it |
| `K` · `J` | move a bolt up · down |
| `N` · `E` | a workspace of your own · open the file itself in your editor |
| `1` `2` `3` | bolts · running · history (`p` and `h` work too) |
| `↑↓` `j k` · `←→` `tab` | move · between workspaces and bolts |
| `/` | filter: the list you're on; in a log full screen (`f`) or an open run in History, the log's lines |
| `o` | on Running: show the ones that stopped too |
| `[` · `]` | on Running: the selected command's tabs: logs, info, past runs |
| `u` · `d` · `G` | scroll output up · down · back to the newest |
| `f` | on Running: the log full screen, where `↑↓` scroll it and `←→` go to the command before or after |
| `t` | allow a file's commands |
| `s` | settings: your editor, and where commands run |
| `D` | on History: delete the selected run, or the selected bolt's runs |
| `r` · `?` · `q` | reload the files · the keys of the tab you're on · quit |

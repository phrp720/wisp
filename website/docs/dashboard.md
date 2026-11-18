# The dashboard

`wisp` opens a dashboard of all your projects, right in your terminal: run a bolt, watch what
it started, look back at past runs. It works the same at your desk, over SSH and in tmux.

![Wisp's dashboard: running a bolt, its server's live output on the Running tab, then the History tab](/demo/dashboard.gif)

## Three tabs

- **`1` Bolts:** your projects (and your own workspaces) on the left, their bolts on the
  right. `⏎` runs one and shows each step.
- **`2` Running:** what each bolt started, as a pipeline, with live output, health and
  ports, and a log of what crashed and came back.
- **`3` History:** every run like a CI run, with its branch, commit, and each step's output.

## No JSON needed

`a` adds a bolt and `e` edits one: steps are picked from a list (Start, Wait, Open) and
filled in through short forms. `E` opens the file itself if you'd rather.

![Making a bolt in the dashboard: name it, then add a command, a wait and a website through short forms, then run it](/demo/editor.gif)

## Keys

| | |
|---|---|
| `⏎` · `n` | run the selected bolt · dry run it |
| `v` | view a bolt whole: its steps, what it needs, what's up |
| `x` · `R` | stop what it started (asks about the bolts it needed) · restart it |
| `e` · `a` · `D` | edit · add · delete a bolt (`D` on the left deletes a workspace) |
| `K` · `J` | move a bolt up · down |
| `N` · `E` | a workspace of your own · open the file itself in your editor |
| `1` `2` `3` | bolts · running · history (`p` and `h` work too) |
| `↑↓` `j k` · `←→` `tab` | move · between workspaces and bolts |
| `/` | search, on any tab |
| `o` | on Running: show the ones that stopped too |
| `u` · `d` · `G` | scroll output up · down · back to the newest |
| `t` · `c` | allow a file's commands · check it for problems |
| `s` | settings: your editor, and where commands run |
| `r` · `?` · `q` | reload the files · every key · quit |

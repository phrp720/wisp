# The TUI

`wisp` opens a full-screen view of all your projects, like htop. It works the same at your
desk, over SSH and inside tmux.

```
 🔮 wisp   1 Bolts   2 Running ● 2   3 History                     ~/dev/acme
╭──────────────────────────╮╭─────────────────────────────────────────────────────╮
│ Workspaces               ││ 🏢 Acme  3 bolts                                    │
│ THIS FOLDER              ││ ~/dev/acme/.wisp.json                               │
│ ❯ 🏢 Acme                ││ ✓ Allowed to run its commands                       │
│ PROJECTS                 ││                                                     │
│   🧱 infra               ││ ⚡ Bolts                                            │
│ YOURS                    ││ ❯ Work on api ● running  5 steps                    │
│   ☀️ Morning             ││   Work on web  ✓ 3m ago  2 steps                    │
│                          ││   Check job  ✗ failed 1h ago  3 steps               │
╰──────────────────────────╯╰─────────────────────────────────────────────────────╯
 ⏎ run · v view · e edit · a add · x stop · / search · 1 2 3 tabs · s settings · ? keys
```

## Three tabs

- **`1` Bolts:** your workspaces and their bolts. `⏎` runs one and shows each step.
- **`2` Running:** what each bolt started, as a pipeline, with live output, health and
  ports, and a log of what crashed and came back.
- **`3` History:** every run like a CI run, with its branch, commit, and each step's output.

## No JSON needed

`a` adds a bolt and `e` edits one: steps are picked from a list (Start, Wait, Open) and
filled in through short forms. `E` opens the file itself if you'd rather.

## Keys

| | |
|---|---|
| `⏎` · `n` | run the selected bolt · dry run it |
| `v` | view a bolt whole: its steps, what it needs, what's up |
| `x` · `R` | stop what it started (asks about the bolts it needed) · restart it |
| `e` · `a` · `D` | edit · add · delete a bolt |
| `1` `2` `3` | bolts · running · history |
| `/` | search, on any tab |
| `o` | on Running: show the ones that stopped too |
| `u` · `d` · `G` | scroll output up · down · back to the newest |
| `t` · `c` | allow a file's commands · check it for problems |
| `s` | settings: your editor, and where commands run |
| `?` · `q` | every key · quit |

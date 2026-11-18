# The TUI

`wisp` on its own opens a full-screen view of everything you have, like htop but for your
projects. It works the same at your desk, over SSH and inside tmux.

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
│                          ││                                                     │
│                          ││   When you run it, it will:                         │
│                          ││    1. ⚡ infra › Database first                     │
│                          ││    2. start api server                              │
│                          ││    3. wait until http://localhost:3000 answers      │
╰──────────────────────────╯╰─────────────────────────────────────────────────────╯
 ⏎ run · v view · e edit · a add · x stop · / search · 1 2 3 tabs · ? keys
```

## Three tabs

Along the top, one key each:

- **`1` Bolts.** Your workspaces on the left, the selected one's bolts on the right. `⏎`
  runs a bolt and shows each step as it happens. `v` shows it whole and read-only: every
  step in order, the bolts it needs opened up beneath it, what each runs and where, and
  what is up right now.
- **`2` Running** (or `p`). What your bolts started, each bolt as a pipeline: what it waited
  for, what it opened, and what is running, with its live output on the right. Commands and
  Docker containers sit side by side, with health and ports. An activity log underneath keeps
  what happened: what you ran and stopped, what crashed, what came back.
- **`3` History** (or `h`). Every run, like a CI: numbered per bolt, with the branch and
  commit it ran on. Open one for its summary and each step's time and output.

`/` searches wherever you are. `?` lists every key.

## Edit without JSON

- `a` adds a bolt. Name it, choose whether it starts things or is a job, and you go
  straight to its first step.
- Steps are chosen from a list grouped like an action library: **Start** (a command, Docker
  services, another bolt first), **Wait** (a website, a port, some seconds), **Open** (a
  website, folder, file or app). Type to find one.
- Each step is a short form, with examples in grey and a line saying what it will do.
- `e` edits a bolt: `⏎` changes a step, `a` adds one after it, `K` and `J` move it, `d`
  removes it, `t` makes it a job.
- `D` deletes a bolt, `N` makes a workspace of your own, and `E` opens the file itself in
  your editor, if you'd rather.

## Stopping things

`x` takes a bolt down. When it needed other bolts (a database, say), Wisp asks whether to
stop those too, and warns you if another running bolt still uses them. `R` restarts a bolt.
On Running, `x` and `r` work on one task or a whole bolt.

Questions are two buttons: `←→` picks, `⏎` confirms, `esc` backs out. Anything that deletes
or allows something starts on "no".

## Keys

| Key | |
|---|---|
| `⏎` | run the selected bolt |
| `n` | dry run: see what it would do, change nothing |
| `v` | view the bolt whole |
| `x` · `R` | stop what it started · restart it |
| `1` `2` `3` | the tabs: bolts · running · history |
| `/` | search |
| `c` | check the file for problems |
| `t` | review and allow what a file would run |
| `e` · `a` · `D` | edit · add · delete a bolt |
| `u` · `d` · `G` | on Running and History: scroll output up · down · back to the newest |
| `?` · `q` | every key · quit |

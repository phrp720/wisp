# What's running

Wisp keeps track of every command it starts. So it knows which bolts are **up**, never
starts a second copy of a server that's already running, and can take a bolt down again,
child processes included. Nothing is left behind running without you knowing.

## Where commands run

In the background, on your machine as if you'd typed them. Each shows up in the dashboard's
Running tab with its live, coloured output. No extra windows. They keep running when you
close Wisp, and they're there again when you reopen it.

From the command line:

```bash
wisp ps              # what's running: status, uptime, restarts
wisp logs api -f     # follow one
wisp stop api        # stop one
```

Prefer a window per command, or a tmux session? Choose it in [Settings](./settings) (`s`), or
ask for it once with `--window`.

## In the Running tab

The panel beside the list has tabs for the command you've selected. `[` and `]` switch
between them, and the tab you pick stays as you move down the list:

- **Logs:** its live output. `f` shows it full screen: `↑↓` scroll it, `←→` go to the
  command before or after, and `/` filters it. Only the lines with every word you type stay,
  the words highlighted, with each line's number. The filter stays as you move to another
  command, so you can look for the same error in each.

  A dev server that clears the screen for each message (Vite does) shows every message
  here, one after another, without the screenful of blank lines it pads each clear with.
- **Info:** what it runs and in which folder, its `env` (values that look like secrets are
  hidden), its restart policy, its PID, and the `wisp logs` and `wisp stop` lines to reach
  it from a shell.
- **Runs:** the times it ran before, newest first, and how each ended. Handy when something
  keeps crashing.

A container has **Logs** and **Info**, with its image, ports, CPU and memory.

## Commands that ask something

A bolt is meant to run without you, so a command that stops to ask (*"Use port 3001
instead? (Y/n)"*, *"Password:"*) can't be answered in the background. Wisp notices: the
command shows as **waiting for an answer** on Running and in `wisp ps`, with the question.

Then fix the step, one of three ways:

| When | Do this |
|---|---|
| It has a flag to skip the question | add it to `run`: `--yes`, `-y`, `CI=1`, `--non-interactive`. Best: it never asks again |
| It needs a secret, like a token | put it in `env`, in your own `.wisp.local.json` (kept out of git), not typed each time |
| It needs you each time: a login, a 2FA code, sudo | run commands in a terminal window (Settings, `s`, or `--window`), where you can type |

## Docker containers

A bolt's `compose` services show up in the Running tab beside its commands: each container
with its health, its ports, and its logs on the right (`]` for its CPU and memory). `wisp down`
stops them.

## Up and down

```bash
wisp down api          # stop what "api" started
wisp down api --deps   # and the database it needed
wisp restart api
```

In the dashboard, `x` on a bolt asks whether to stop the bolts it needed too, and warns you if
another running bolt still uses them.

## When something crashes

Wisp says so at the bottom of the screen, and the Running tab turns red with what needs you.
A command with `"restart": "on-failure"` comes back by itself, with a growing pause between
tries; the Running list shows how many times it was restarted.

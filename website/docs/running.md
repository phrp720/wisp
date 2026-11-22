# What's running

Wisp keeps track of every command it starts. So it knows which pipelines are **up**, never starts
a second copy of a server that's already running, and can take a pipeline down again, child
processes included. Nothing keeps running without you knowing.

## Where commands run

In the background, as if you'd typed them, with their output kept. They keep running when
you close Wisp or disconnect, and they're there again when you come back.

```bash
wisp ps              # what's running: status, uptime, restarts
wisp logs api -f     # follow one
wisp stop api        # stop one, and everything it started
```

Rather have a terminal window per command, or a tmux session? Choose it in
[Settings](./settings), or ask for it once with `--window`.

## The Running tab

In the dashboard (`2`), each pipeline that's up shows what it started, with health and ports.
Beside the list, the selected command has three tabs (`[` and `]` switch):

- **Logs:** its live output. `f` shows it full screen and `/` filters it: only the lines with
  every word you typed stay, with their line numbers.
- **Info:** what it runs, in which folder, its `env` (values that look like secrets are
  hidden), its restart policy and PID, and the `wisp logs` and `wisp stop` lines to reach it
  from a shell.
- **Runs:** the times it ran before, and how each ended. Handy when something keeps crashing.

A pipeline's Docker containers show up beside its commands, with their health, ports, logs, CPU
and memory.

## Up and down

```bash
wisp down api          # stop what "api" started, then run its down steps
wisp down api --deps   # and the pipelines it ran, like the database
wisp restart api
```

In the dashboard, `x` on a pipeline asks whether to stop the pipelines it ran too, and warns you if
another running pipeline still uses them.

## When something crashes

The Running tab turns red with what needs you, and Wisp says so at the bottom of the screen.
A command with `"restart": "on-failure"` comes back by itself, waiting a little longer after
each try, and the list shows how many times it restarted. That keeps working after Wisp is
closed.

## Commands that ask something

A command that stops to ask (*"Use port 3001 instead? (Y/n)"*, *"Password:"*) can't be
answered in the background. Wisp notices and shows it as **waiting for an answer**, with the
question. Then fix the step:

| When | Do this |
|---|---|
| It has a flag to skip the question | add it to `run`: `--yes`, `-y`, `CI=1`, `--non-interactive` |
| It needs a secret, like a token | let the step [fetch it](./use-cases#use-a-secret), or put it in `env` in your own `.wisp.local.json` |
| It needs you each time: a login, a 2FA code, sudo | run commands in a terminal window (Settings, or `--window`), where you can type |

# What's running

Wisp keeps track of every command it starts. So it knows which pipelines are up, never
starts a second copy of a server that's already running, and can stop a pipeline again,
child processes included.

```bash
wisp ps              # what's running: status, uptime, restarts
wisp logs api -f     # follow one
wisp stop api        # stop one, and everything it started
```

Commands that keep running go in the background, with their output kept. They keep running
when you close Wisp or disconnect, and they're there again when you come back. Rather have a
terminal window per command, or a tmux session? Choose it in [Settings](./settings).

## The Running tab

In the dashboard (`2`), each pipeline that's up shows what it started, with health and
ports. Beside the list, the selected command has three tabs (`[` and `]` switch them):

- **Logs:** its live output. `f` shows it full screen and `/` filters it to the lines with
  every word you type.
- **Info:** what it runs, in which folder, its `env` (values that look like secrets are
  hidden), its restart policy and PID, and the `wisp logs` and `wisp stop` lines to reach it
  from a shell.
- **Runs:** the times it ran before, and how each ended. Handy when something keeps crashing.

[Docker](./docker) containers show up beside the commands, with health, ports, logs, CPU and
memory.

<Recording name="dashboard" alt="Wisp's dashboard: running a pipeline in its box, its server's live output on the Running tab, then the History tab" />

## When something crashes

The Running tab turns red with what needs you, and Wisp says so at the bottom of the screen.
A command with [`restart`](./commands#when-it-crashes) comes back by itself, and the list
shows how many times it did.

## Commands that ask something

A command that stops to ask, like *"Use port 3001 instead? (Y/n)"* or *"Password:"*, can't be
answered in the background. Wisp notices, and shows it as **waiting for an answer**, with the
question. Then fix the step:

| When | Do this |
|---|---|
| It has a flag to skip the question | add it to `run`: `--yes`, `-y`, `CI=1`, `--non-interactive` |
| It needs a secret, like a token | let the step [fetch it](./secrets) |
| It needs you each time: a login, a 2FA code, sudo | run commands in a terminal window ([Settings](./settings), or `--window`), where you can type |

## Disk space

Wisp keeps the last 50 runs of each pipeline, and 500 in all. A log over 10 MB keeps its last 5 MB, even while its server
runs, and everything together stays under 500 MB, the oldest going first.
`wisp ps --clear` forgets finished commands straight away.

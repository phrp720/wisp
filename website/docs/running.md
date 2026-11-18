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

Prefer a window per command? Ask for one with `--window`, or make it the default:

```bash
wisp open-with terminal ghostty
wisp open-with terminal tmux     # on a server you SSH into: a wisp session to attach to
```

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

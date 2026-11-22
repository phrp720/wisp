# Runs and history

## Keeps running, or finishes?

Each command says which it is. That decides whether Wisp **waits for it**.

| | Keeps running (the default) | Finishes (`"finishes": true`) |
|---|---|---|
| **For** | dev servers, databases, watchers, tunnels | tests, lint, builds, backups, deploys |
| **Wisp** | starts it in the background, checks it didn't fail at once, moves on | waits for it, with its output on screen |
| **Afterwards** | it keeps running: [watch it](./running), stop it with `wisp down` | ✓ or ✗, with its output kept in History |
| **Run again** | left alone if it's already up | runs again, every time |

One pipeline can mix both: build the UI, then serve it, while the API starts beside it.

```json
{
  "label": "Dev",
  "steps": [
    { "compose": "compose.yaml", "label": "db" },
    { "run": "npm run dev", "cwd": "api", "label": "api", "after": "db" },
    { "run": "npm run build", "cwd": "ui", "label": "build", "finishes": true },
    { "run": "npm run start", "cwd": "ui", "label": "ui", "after": "build" },
    { "url": "http://localhost:3000", "after": ["ui", "api"] }
  ]
}
```

In the dashboard, a command's form asks **It: keeps running / finishes**, and guesses from
what you type: `npm run build` finishes, `npm run dev` keeps running.

## When a step fails

The run stops there: steps already going finish, and nothing new starts. The tests fail,
nothing deploys:

```json
{
  "label": "Release",
  "steps": [
    { "pipeline": "Verify", "label": "verify" },
    { "run": "pnpm build", "label": "build", "after": "verify", "finishes": true },
    { "run": "./deploy.sh", "after": "build", "finishes": true }
  ]
}
```

To carry on anyway, give the pipeline `"keepGoing": true`: a failure is reported and the rest
still runs. In the dashboard, it's the pipeline's **On failure** row.

## When a step hangs

A test stuck on the network, a backup waiting on a lock: give a command that should finish a
`"timeout"`.

```json
{ "run": "pnpm test", "finishes": true, "timeout": "10m" }
```

Past it, Wisp stops the command and everything it started, and the step fails like any
other: the run stops, and you're [told](./settings#notifications). Without one, Wisp waits as
long as it takes.

## History

Every run is kept, the way a CI keeps them: numbered per pipeline, with the branch and commit it
ran on, what started it, the [values it was given](./file#inputs), and each step's time and
output. A run shows up as soon as it starts and fills in as it goes.

<Recording name="jobs" alt="A Check pipeline fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only the test, and it passes" />

```bash
wisp history                 # this project's runs; --all for every project
wisp history <id>            # one run, step by step
wisp history <id> --log 3    # what step 3 printed
wisp history verify --clear  # delete a pipeline's runs (runs still going are kept)
```

In the dashboard, it's the History tab (`3`): pipelines on the left, their runs on the right,
and each run's page with every step's output. `/` filters all of a run's output at once:
type `FAIL` or `error` to go straight to what broke. `D` deletes a run, or a pipeline's runs.

Wisp keeps the last 200 runs and deletes older ones as new ones come in.

## Retry only what failed

`wisp verify --retry` (or `r` in the dashboard) runs the failed step and what comes after it,
not the steps that already passed, with the same input values.

## From git hooks and cron

Run your checks before every push. A failure stops the push:

```bash
wisp hook pre-push verify
```

Its commands should finish: one that keeps running can't stop a push, and Wisp says so.

Or on a schedule, with the cron you already have:

```
0 3 * * * wisp use ~/dev/acme/.wisp.json Backup
```

A run nobody watched that fails shows a notification, or posts to your
[webhook](./settings#notifications).

# Runs and history

## Keeps running, or finishes?

Each command says which it is. That decides whether Wisp **waits for it**.

| | Keeps running (the default) | Finishes (`"finishes": true`) |
|---|---|---|
| **For** | dev servers, databases, watchers | tests, lint, builds, backups, deploys |
| **Wisp** | starts it in the background, checks it didn't fail at once, then moves on | waits for it, with its output on screen |
| **Afterwards** | it keeps running: watch it on Running, stop it with `x` or `wisp down` | it's over, ✓ or ✗, with its output kept in History |
| **Already running** | left alone, not started twice | runs again, every time |

One bolt can mix both. This one starts the database and the API, builds the UI, then
serves it:

```json
{
  "label": "Dev",
  "targets": [
    { "compose": "compose.yaml" },
    { "run": "npm run dev", "cwd": "api" },
    { "wait": "localhost:5050" },
    { "run": "npm run build", "cwd": "ui", "finishes": true },
    { "run": "npm run start", "cwd": "ui" },
    { "url": "http://localhost:3000" }
  ]
}
```

In the dashboard, a command's form asks **It: keeps running / finishes**, and guesses from
what you type: `npm run build` finishes, `npm run dev` keeps running.

## When a step fails

The run stops there: nothing after it runs. The tests fail, nothing deploys:

```json
{
  "label": "Release",
  "targets": [
    { "bolt": "Check" },
    { "run": "pnpm build", "finishes": true },
    { "run": "./deploy.sh", "finishes": true }
  ]
}
```

A bolt it depends on that fails stops it too. To carry on anyway, give the bolt
`"keepGoing": true`: a failure is reported, and the rest still runs. In the dashboard, press
`e` on the bolt and change its **On failure** row.

## History

Every run is kept, the way a CI keeps them: numbered per bolt, with the branch and commit
it ran on, what started it, the [values it was given](./file#inputs), and each step's time
and output. A run shows up as soon as it
starts and fills in as it goes: the steps done, the one it's on (with its output so far, for
a command that finishes), and the ones still to come. Running shows the same for the bolt.
One whose Wisp was closed or killed before it finished is marked interrupted, with the steps
it never reached. Rename a workspace and its past runs show the new name; one you've
removed keeps the name it had.

![A Check bolt fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only the test, and it passes](/demo/jobs.gif)

From the command line: `wisp history` lists the runs, `wisp history <id>` shows one, and
`wisp history <id> --log 3` prints what step 3 printed. `--clear` deletes runs:
`wisp history <id> --clear` one run, `wisp history check --clear` a bolt's,
`wisp history --clear` this project's, and with `--all` every project's. Runs still going are
kept.

In the dashboard, the History tab (`3`) shows the same: bolts on the left to filter by, the runs on
the right, and each run's page with a summary, the bolts it went through, and every step's
output. On a run's page, `/` filters every step's output at once: each step says how many
lines matched, and the matching lines show under it with their numbers. Type `FAIL` or
`error` to go straight to what broke. `D` deletes the selected run, or, on the bolts on the
left, clears that bolt's runs (all of them on "All bolts"), after asking.

## Retry only what failed

`wisp Check --retry` (or `r` in the dashboard) runs the failed step and everything after it, not
the steps that already passed, with the same input values.

## From git hooks and cron

Run your checks before every push. The push is blocked if they fail:

```bash
wisp hook pre-push check
```

Its commands should finish: one that keeps running can't block a push, and Wisp says so.

Or on a schedule, with the cron you already have:

```
0 3 * * * wisp use ~/dev/acme/.wisp.json Release
```

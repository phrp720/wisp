# Jobs and history

## A job, or a normal bolt?

The difference is whether Wisp **waits for each command to finish**.

| | Normal bolt | Job (`"job": true`) |
|---|---|---|
| **For** | what keeps running: dev servers, databases, watchers | what finishes: tests, lint, builds, deploys, cleanups |
| **Each command** | starts in the background; Wisp checks it didn't fail at once, then moves on | runs attached: Wisp waits for it, with its output on screen |
| **When one fails** | the rest still start (only a failed `wait` stops it) | everything stops there |
| **Afterwards** | it keeps running: watch it on Running, stop it with `x` or `wisp down` | it's over: pass or fail, kept in History |
| **Already running** | left alone, not started twice | runs again, every time |

**The rule:** if the command keeps running, a normal bolt; if it finishes, a job. A cleanup
script as a normal bolt starts in the background and you only hear how it went from the
Activity log; as a job it runs in front of you and ends with ✓ or ✗.

To switch, press `e` on the bolt in the dashboard, then `t`; or add `"job": true`.

## Jobs

A job runs to completion and stops the moment something fails:

```json
{
  "label": "Release",
  "job": true,
  "targets": [{ "bolt": "Database" }, { "bolt": "Check" }, { "run": "pnpm build" }, { "run": "./deploy.sh" }]
}
```

- Commands run one after another, with their output on screen.
- **The first failure stops it.** Tests fail, nothing deploys. A failed job it depends on
  stops it too.
- Bolts it needs that aren't jobs, like the database, start as usual and stay up.

## History

Every run is kept, the way a CI keeps them: numbered per bolt, with the branch and commit
it ran on, what started it, and each step's time and output. A run shows up as soon as it
starts, as running with the step it's on, and fills in as it goes. One whose Wisp was
closed or killed before it finished is marked interrupted.

![A Check job fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only the test, and it passes](/demo/jobs.gif)

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
the steps that already passed.

## From git hooks and cron

Run a job before every push. The push is blocked if it fails:

```bash
wisp hook pre-push check
```

Or on a schedule, with the cron you already have:

```
0 3 * * * wisp use ~/dev/acme/.wisp.json Release
```

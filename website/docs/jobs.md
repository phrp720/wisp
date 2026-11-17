# Jobs and history

Some bolts start things and leave them running. Others should *run to completion* and stop
the moment something fails: tests, builds, releases. Mark those as a **job**:

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
it ran on, what started it, and each step's time and output.

```console
$ wisp history
✗ 3f2a1b  Release #4 job · 2m ago · 41.2s · main @ a1b2c3d
✓ 9c01de  Check #12 job · 1h ago · 12.8s · main @ a1b2c3d

$ wisp history 3f2a1b
failed Release · Acme · 41.2s
   1 ✓ wait   port 5432
   2 ✓ run    lint · pnpm lint 3.1s  [--log 2]
   3 ✗ run    test · pnpm test 9.8s exited with code 1  [--log 3]
   4 – run    pnpm build not reached

$ wisp history 3f2a1b --log 3      # what the tests printed
```

In the TUI, the History tab (`3`) shows the same: bolts on the left to filter by, the runs on
the right, and each run's page with a summary, the bolts it went through, and every step's
output.

## Retry only what failed

`wisp Check --retry` (or `r` in the TUI) runs the failed step and everything after it, not
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

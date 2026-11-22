# History

Every run is kept, the way a CI keeps them: numbered per pipeline, with the branch and commit
it ran on, what started it, the [values it was given](./inputs), and each step's time and
output. A run shows up as soon as it starts, and fills in as it goes.

<Recording name="jobs" alt="A Verify pipeline fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only what failed, and it passes" />

## From the command line

```bash
wisp history                   # this project's runs; --all for every project
wisp history <id>              # one run, step by step
wisp history <id> --log 3      # what step 3 printed
```

## In the dashboard

The History tab (`3`) lists pipelines on the left and their runs on the right. Open a run
for a summary, the pipelines it went through, and every step's output.

`/` filters a run's output, all steps at once: type `FAIL` or `error` to go straight to what
broke. Each step says how many lines matched.

## Retry what failed

```bash
wisp verify --retry
```

Runs the step that failed and what comes after it, not the steps that already passed, with
the same input values. In the dashboard, it's `r` after a run.

## Clearing it

```bash
wisp history <id> --clear       # one run
wisp history verify --clear     # a pipeline's runs
wisp history --clear            # this project's (--all: every project's)
```

`D` does the same in the dashboard, after asking. Runs still going are kept.

::: info How long runs are kept
The last 200, with their output. Older ones are deleted as new ones come in.
:::

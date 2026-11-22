# History

Every run is kept, the way a CI keeps them: numbered per pipeline, with the branch and commit
it ran on, what started it, the [values it was given](./inputs), each step's time and
output, and which webhooks it [notified](./notifications) and whether they got it. A run shows
up as soon as it starts, and fills in as it goes.

<Recording name="jobs" alt="A Verify pipeline fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only what failed, and it passes" />

## From the command line

```bash
wisp history                   # this project's runs; --all for every project
wisp history <id>              # one run, step by step
wisp history <id> --log 3      # what step 3 printed
```

## In the dashboard

The History tab (`3`) lists pipelines on the left and their runs on the right. Open a run
for a summary, its steps drawn as a graph (what waited for what, and what ran side by side),
and every step's output. `v` hides the graph or brings it back, here and on the Pipelines tab,
where the same graph shows what a pipeline will do before you run it. A big one draws a line a
step, and folds a long column into `+N more`.

`/` filters a run's output, all steps at once: type `FAIL` or `error` to go straight to what
broke. Each step says how many lines matched.

## How a run ends

| | |
|---|---|
| `✓` **Success** | every step did what it should |
| `✗` **Failed** | a step broke: a command exited with an error, a wait gave up |
| `⊘` **Cancelled** | you stopped it before it finished. Grey, never red: nothing broke |
| `!` **Interrupted** | Wisp itself stopped before the run did, so how it ended is unknown |

A run is cancelled when you press `x` on it, and also when you stop something it started
while it's still going: a command or a Docker container, with `x` or `r` on the Running tab,
`wisp stop` or `wisp down`. Say the dev server a later step was waiting for, or the database
container behind a wait for its port. As on GitHub, the step that was cut off says why
(`you stopped the run`, `you stopped server`) and the steps after it say they weren't reached.
A command that crashed by itself is still a failure.

A cancelled run doesn't count as a pipeline [starting to fail](./notifications#checks-that-run-every-few-minutes),
and `--retry` picks up from the step that was cut off.

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
The last 50 runs of each pipeline, with their output, and 500 in all. Older ones are deleted
as new ones come in, so a check run every few minutes pushes out only its own.
:::

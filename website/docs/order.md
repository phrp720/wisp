# Order

Steps start together, unless they say what they wait for. A step's `after` names other steps
of the pipeline by their `label`, and it starts once all of them have finished.

<Pipeline name="verify" />

```json
{
  "label": "Verify",
  "steps": [
    { "run": "pnpm lint", "label": "lint", "finishes": true },
    { "run": "pnpm typecheck", "label": "types", "finishes": true },
    { "run": "pnpm test", "label": "test", "finishes": true },
    { "run": "pnpm build", "after": ["lint", "types", "test"], "finishes": true }
  ]
}
```

Lint, types and tests run side by side, and the build waits for all three.

## When a step counts as finished

It depends on the step:

| Step | Finished when |
|---|---|
| A command that [finishes](./commands) | it exits |
| A command that keeps running | it has started and didn't fail at once |
| [Docker services](./docker) | they're healthy |
| A [wait](./steps#wait-until-something-is-ready) | what it waits for answers |
| [Another pipeline](./pipelines-in-pipelines) | all of its steps are |

That's why a server is usually followed by a wait: the API has *started*, and the wait
makes the next step hold on until it *answers*.

```json
{ "run": "pnpm dev", "cwd": "apps/api", "label": "api" },
{ "wait": "http://localhost:3000", "label": "up", "after": "api" },
{ "url": "http://localhost:3000", "after": "up" }
```

## Mistakes Wisp catches

A step waiting for a label no step has, two steps with the same label, or steps that wait for
each other: the pipeline refuses to run, and `wisp check` says why.

## While they run

Steps running at the same time print their output line by line, each line starting with
its step's label. In [History](./history), each step's output stays its own.

::: tip In the dashboard
Each step in the editor has a **Depends on** list to tick. A step you add with `a` already
depends on the one above it.
:::

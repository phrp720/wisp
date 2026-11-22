# Pipelines as steps

A pipeline can run another as one of its steps. Put shared steps, like starting the database,
in a pipeline of their own, and run it from the others:

```json
{
  "pipelines": [
    { "label": "Database", "steps": [{ "compose": "compose.yaml", "services": ["postgres"] }] },
    {
      "label": "Dev",
      "steps": [
        { "pipeline": "Database", "label": "db" },
        { "run": "pnpm dev", "cwd": "apps/api", "after": "db" }
      ]
    }
  ]
}
```

`wisp dev` starts the database, then the API. `wisp database` starts just the database.

## How it behaves

- It's a step like any other: it starts right away, or once what it's `after` is done.
- A step that waits for it waits for **all** of its steps.
- It runs **once per run**, however many steps run it, and what's already running is left
  alone.
- If it fails, the pipeline that ran it fails too.

## Only from the same file

A pipeline runs pipelines of its own file, so each file stands on its own. Renaming a pipeline
renames the steps that run it.

To start another project's pipeline anyway, use a command:

```json
{ "run": "wisp use ~/dev/infra/.wisp.json Database", "finishes": true }
```

::: tip In the dashboard
It's **Run a pipeline** among the steps, with this workspace's pipelines to pick from.
:::

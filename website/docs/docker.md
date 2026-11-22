# Docker

A pipeline can start the services of a compose file, and wait until they're healthy before
the next step:

```json
{ "compose": "compose.yaml", "services": ["postgres", "redis"], "label": "db" }
```

Leave out `services` to start all of them. The path is relative to the `.wisp.json`.

## Waiting for healthy

Wisp runs `docker compose up --wait`, so it moves on once the containers are up and, for those
with a health check, healthy. It gives them two minutes. A step that waits for it, like the
API, never starts against a database that isn't ready:

```json
{ "compose": "compose.yaml", "services": ["postgres"], "label": "db" },
{ "run": "pnpm dev", "cwd": "apps/api", "after": "db" }
```

## When Docker isn't running

Before a compose step, or a command that calls `docker` (like
`{ "run": "docker compose up -d" }`), Wisp checks that Docker answers, giving it 5 seconds. If it
doesn't, the step fails at once with "Docker isn't running: open Docker Desktop, then try
again", and nothing after it runs. Nothing waits for Docker in the background, so opening Docker
Desktop later doesn't set off steps you ran earlier. The check runs once per run.

## Watching them

The [Running tab](./whats-running#the-running-tab) shows each container beside the
pipeline's commands, with its health, ports, logs, CPU and memory.

## Stopping them

`wisp down dev` stops them along with everything else the pipeline started. For teardown
that isn't stopping, like removing volumes, add [down steps](./running-pipelines#down-steps).

::: tip Containers and commands together
Compose runs containers; most projects also have things outside them: a dev server on your
machine, a migration, a page to open. One pipeline does all of it.
:::

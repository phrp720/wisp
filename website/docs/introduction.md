# What is Wisp

Wisp runs **pipelines** on your own machines: your laptop, a teammate's, or a server. A
pipeline is a short list of steps, like *start the database, then the API, open the page*.
You write it once, then run it by name from whatever folder you're in.

```bash
wisp <workspace> <pipeline>
```

<Recording name="cli" alt="wisp acme dev, from the home folder: the database, then the API, with the web app beside them, each step ticking off" />

## What a pipeline looks like

Steps start together, unless they say what they wait for:

<Pipeline name="dev" />

```json
{
  "label": "Dev",
  "steps": [
    { "compose": "compose.yaml", "services": ["postgres"], "label": "db" },
    { "run": "pnpm dev", "cwd": "apps/api", "label": "api", "after": "db" },
    { "run": "pnpm dev", "cwd": "apps/web", "label": "web" },
    { "wait": "http://localhost:3000", "label": "up", "after": "api" },
    { "url": "http://localhost:5173", "after": ["up", "web"] }
  ]
}
```

It lives in a `.wisp.json` next to your code, so the whole team has it. You rarely write it
by hand: `wisp init` drafts pipelines from what the project already has, and the
[dashboard](./dashboard) edits them through forms.

## What Wisp does with it

- **Runs the steps** side by side or in order, and waits for what has to be ready: a port, a
  website, healthy containers.
- **Keeps track of what it started.** A server never starts twice, each keeps its log, and
  `wisp down dev` stops all of it, child processes included.
- **Keeps every run**, like CI keeps them: the commit, each step's output and time. A retry
  runs only what failed.
- **Asks before anything runs** from a project you cloned, and again whenever the file
  changes.

## Where it fits

| | |
|---|---|
| **A project** | the dev stack, the checks before a push, a release |
| **A server** | deploys, updates, backups and cleanups, the same for whoever logs in |
| **Your own machine** | a tunnel to a database, backing up your photos |

[Use cases](./use-cases) has each of these as a pipeline to copy.

## Next

[Getting started](./getting-started): install it and run your first pipeline, in five minutes.

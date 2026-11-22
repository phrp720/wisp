# Running pipelines

```bash
wisp acme dev       # from any folder: the workspace, then the pipeline
wisp dev            # inside the project, the pipeline is enough
wisp pick           # choose from a list
wisp                # the dashboard: ⏎ runs the selected one
```

Each step ticks off as it goes. Servers keep running in the background, and the command
returns once everything is up.

## How Wisp reads a name

- **One word is a pipeline of the project you're in,** and only of that project. When it
  isn't one there, nothing runs, and Wisp says what to type instead, like
  `Elsewhere: wisp shop deploy`.
- **Two words are a workspace and one of its pipelines,** from any folder.
- **A name can be** the full label in quotes (`"Work on api"`), its slug (`work-on-api`), or
  any whole word of it that only one pipeline has (`api`). Never part of a word: `doc`
  doesn't run *Documentation*.
- **When several match,** Wisp lists them and runs nothing.
- **When two workspaces share a name,** like two projects called *Acme*, `wisp acme dev` lists
  both files and runs nothing. Run one by its file, `wisp use ~/work/acme/.wisp.json dev`, or
  give one another name. `wisp list` and the dashboard point out shared names.
- **A pipeline named like a command** (`list`, `check`) runs with `wisp use list`.

`wisp show acme` lists a workspace's pipelines with their slugs, and tab completion fills
them in.

## Choosing from a list

`wisp pick` lists the pipelines with what's running and their notes: type to filter, `⏎`
runs the selected one, `esc` cancels. `wisp pick acme` lists one workspace's.

## Before you run it

```bash
wisp acme deploy --dry-run
```

Shows what it would do, and where each command would run, without changing anything.

## Where the output goes

By default, servers run in the background and commands that finish show their output here.
For one run:

| | |
|---|---|
| `--inline` | everything here, in this terminal |
| `--window` | each command in a terminal window (tmux windows, inside tmux) |
| `--detach` | everything in the background, even if your settings say windows |

To change the default, see [Settings](./settings).

## Stopping

```bash
wisp down dev            # stop what it started, child processes included
wisp down dev --deps     # and the pipelines it ran, like the database
wisp restart dev         # down, then up again
```

In the dashboard, `x` stops a pipeline. It asks whether to stop the pipelines it ran too, and
warns you if another running pipeline still uses them.

## Down steps

For teardown that isn't stopping a process, `down` lists steps to run after Wisp has stopped
what the pipeline started:

```json
{ "label": "Services", "steps": [{ "run": "./start.sh" }], "down": [{ "run": "./stop.sh" }] }
```

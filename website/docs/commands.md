# Commands

A command step runs something in your shell, as if you'd typed it:

```json
{ "run": "pnpm dev", "cwd": "apps/api", "label": "api" }
```

## Keeps running, or finishes?

Every command is one or the other, and that decides whether Wisp **waits for it**.

| | Keeps running (the default) | Finishes (`"finishes": true`) |
|---|---|---|
| **For** | dev servers, databases, watchers, tunnels | tests, lint, builds, backups, deploys |
| **Wisp** | starts it in the background, checks it didn't fail at once, moves on | waits for it, with its output on screen |
| **Afterwards** | still running: [watch it](./whats-running), stop it with `wisp down` | ✓ or ✗, its output kept in [History](./history) |
| **Run again** | left alone if it's already up | runs again, every time |

```json
{ "run": "pnpm test", "label": "test", "finishes": true }
```

::: tip In the dashboard
A command's form asks **It: keeps running / finishes**, and guesses from what you type:
`npm run build` finishes, `npm run dev` keeps running.
:::

## When it fails

The run stops: steps already going finish, and nothing new starts. The tests fail, nothing
deploys. To carry on anyway, give the pipeline `"keepGoing": true`: the failure is
reported, and the rest still runs.

## When it hangs

A test stuck on the network, a backup waiting on a lock: give a command that finishes a
`timeout`.

```json
{ "run": "pnpm test", "finishes": true, "timeout": "10m" }
```

`"30s"`, `"10m"`, `"1h"` or a number of seconds. Past it, Wisp stops the command and
everything it started, and the step fails like any other. Without one, Wisp waits as long
as it takes.

## When it crashes

A server that keeps running can come back by itself:

```json
{ "run": "node server.js", "label": "app", "restart": "on-failure" }
```

`"on-failure"` restarts it after a crash, `"always"` whenever it exits. Wisp waits 1s, 2s,
4s and so on, up to 30s between tries, and gives up after 10 in a row. It keeps working
after Wisp is closed.

## Everything else

| Field | |
|---|---|
| `cwd` | the folder to run it in, relative to the `.wisp.json`; left out, the project's folder |
| `env` | environment variables, on top of yours: `{ "PORT": 3000 }` |
| `shell` | `"sh"`, `"pwsh"` or `"cmd"`; by default your own shell on macOS and Linux, PowerShell on Windows |
| `background` | `true` keeps it in the background even when [Settings](./settings) put commands in terminal windows |

::: info Trust
A project's commands only run once you've [trusted](./trust) its file.
:::

---
name: wisp
description: Run, write and debug Wisp pipelines (.wisp.json): a project's dev stack, checks, deploys and backups, run with the `wisp` CLI. Use when a repository has a .wisp.json or .wisp.local.json, when the user mentions Wisp or `wisp` commands, or asks to start a project's servers, run its checks, read a run's logs or history, or set up a task runner for a project.
---

# Wisp

Before running or editing anything, read the reference. It is built into the CLI and
matches the installed version:

```bash
wisp help agents
```

If `wisp` is not installed, ask the user before installing it (`npm install -g @phrp720/wisp`).

## The loop

1. `wisp show --json`: what this project can run. Commands of a file not yet trusted are
   under `withheld`, not `steps`.
2. Edit `.wisp.json`, then `wisp check --json` until `errors` is 0.
3. `wisp <pipeline> --dry-run --json` to see the plan.
4. `wisp <pipeline> --inline` for checks (read the output directly), or `--detach` for
   servers, then `wisp ps --json`, `wisp logs <name>` and `wisp down <pipeline>`.
5. After a failure: `wisp history <id> --log <n>` prints the failing step's output.

Add `--json` to anything you parse. `"ok": false` comes with exit code 1, and a refusal
is `{"ok": false, "error": {"code": "…", "message": "…", "hint": "…"}}`.

## Never on the user's behalf

- `wisp trust`. On `NOT_TRUSTED`, show the user what `wisp check` lists under "Runs code"
  and ask them to approve it.
- `--yes` on a pipeline that asks first (`CONFIRM_NEEDED`). Ask the user its question, and
  pass `--yes` only once they agree.
- `wisp notify`, `wisp completion --install` and `wisp hook`: these are the user's settings.

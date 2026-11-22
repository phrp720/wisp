# Hooks and cron

Pipelines run the same way when nobody is watching: before a push, every night, when the
machine boots.

## Before every push

```bash
wisp hook pre-push verify
```

Runs *Verify* on every `git push`, and stops the push if it fails. Its commands should
[finish](./commands#keeps-running-or-finishes): one that keeps running can't stop a push, and
Wisp says so.

| | |
|---|---|
| `wisp hook --list` | the hooks Wisp put in this repository |
| `wisp hook pre-push --remove` | take one out |
| `--force` | replace a hook Wisp didn't write |

A pipeline that [asks first](./asking-first) runs without asking from a hook: you started the
push.

## On a schedule

Cron runs a pipeline by its file's path, so it doesn't depend on which folder it starts in:

```
0 3 * * * wisp use /srv/shop/.wisp.json Backup
```

And at boot, to bring an app back up:

```
@reboot wisp use /srv/shop/.wisp.json App
```

Every run is in [History](./history), a step that hangs past its
[timeout](./commands#when-it-hangs) is stopped, and a failure can
[send you a message](./notifications).

## From scripts

Without a terminal, Wisp never stops to ask. Pass what it would ask:

```bash
wisp acme deploy --input env=production --yes
```

| | |
|---|---|
| `--input name=value` | a value the pipeline [asks for](./inputs) |
| `--yes` | yes to [Asking first](./asking-first), and each input's default |
| `--json` | the result as JSON, for the script to read |

It exits `0` when everything ran and `1` when something failed. A file that isn't
[trusted](./trust) runs nothing, and stops with `NOT_TRUSTED`.

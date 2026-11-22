# Notifications

Wisp tells you about a run you might have missed: one nobody watched, like a cron job or a
script, or one that took over 30 seconds. It shows a notification on this machine's screen,
and posts to your webhooks.

```bash
wisp notify                                     # what is set, webhooks numbered
wisp notify changes                             # failures (the default), changes, all, or off
wisp notify add https://ntfy.sh/my-server       # a webhook for every workspace
wisp notify --test                              # send one now to every webhook, to check
wisp notify --reveal                            # the webhooks' whole addresses
```

The same is in the dashboard's [Settings](./settings), under **Notifications**.

## Checks that run every few minutes

`failures` tells you about every failed run, so a check that cron runs every 5 minutes would
tell you every 5 minutes while the site is down. `changes` tells you once when a pipeline
starts failing, and once when it works again:

```json
{
  "label": "Check staging",
  "steps": [
    { "wait": { "url": "https://staging.example.com/health", "status": 200, "timeout": 30 } }
  ]
}
```

```bash
wisp notify changes
wisp notify add https://ntfy.sh/my-staging
# crontab -e
*/5 * * * * wisp use ~/staging/.wisp.json "Check staging"
```

Run it from another machine to check the site from outside, or on the server itself to check
ports nobody else can reach, like `{ "wait": "localhost:5432" }`.

## Webhooks

For a server, where nobody sees the screen. Add as many as you like, each for every workspace
or only for the ones you name:

```bash
wisp notify add https://discord.com/api/webhooks/...                    # every workspace
wisp notify add https://hooks.slack.com/services/... staging production  # only these two
wisp notify add https://hooks.slack.com/services/... billing             # one more for it
wisp notify remove https://hooks.slack.com/services/... staging          # not for staging
wisp notify remove 2                                                    # gone, by its number
```

A workspace is named as in `wisp show`, or by the path to its `.wisp.json`. A run goes to the
webhooks for every workspace and to those for its own. Webhooks are kept in your settings on
this machine, never in `.wisp.json`: the address is usually a secret, and that file is shared.

Each message says which step failed and why, like `at dump: exited with code 1` or
`at site: it answered 502`. Wisp knows these services by their addresses and sends each one
the kind of message it shows best:

| Service | What it shows |
| ------- | ------------- |
| Slack | A card with a red or green bar: the title, then workspace, failed step, host and how long it took, the error, and `wisp history <id>` |
| Discord | An embed with the same fields, coloured, with the host and run in the footer |
| Microsoft Teams | An Adaptive Card. Make the webhook with the Workflows app ("Post to a channel when a webhook request is received") |
| ntfy | A title, the message, and a ✓ or ✗ |

Any other address gets JSON:

```json
{
  "text": "✗ Backup failed on web-1\nat dump: exited with code 1 · Shop · wisp history 8efbda976796",
  "ok": false,
  "pipeline": "Backup",
  "workspace": "Shop",
  "failedStep": "dump",
  "error": "exited with code 1",
  "history": "8efbda976796",
  "host": "web-1",
  "durationMs": 2140
}
```

The address must be `https://`, so the message and any secret in it travel encrypted. Plain
`http://` works only to this machine (`localhost`).

## Keeping the address secret

A webhook's address is its password: anyone who has it can post to your channel. So Wisp
shows it without the secret part, in the dashboard, in `wisp notify` and in `--json`, so it
doesn't end up in a screenshot or an agent's log:

```text
webhooks
  1  https://hooks.slack.com/services/…x7Qa  every workspace
     sent 2h ago
  2  https://discord.com/api/…Zk3p  Shop
     ✗ failed 5m ago: 404 Not Found
```

Remove one by its number. `wisp notify --reveal` shows the whole addresses, when you need to
copy one.

## When a webhook stops working

A deleted channel or a removed webhook fails without a sound: you just stop hearing. So Wisp
remembers how each webhook's last delivery went, and tells you where you'll see it:

- The dashboard says `● a webhook is failing: s` along the top. Click it or press `s` to open
  Settings at Notifications, with the error beside the webhook.
- `wisp notify` shows it under the webhook, like `✗ failed 5m ago: 404 Not Found` above.
- Each run in [History](./history) says where its notification went, and whether it arrived:
  `notified hooks.slack.com/services/…x7Qa ✓` in `wisp history <id>`, and `notified` in its
  `--json`.

`wisp notify --test` checks them all now. Make a new webhook, add it, and remove the old one
by its number.

## When it stays quiet

- A run started with `--json` never notifies: whatever started it reads the result.
- `WISP_NOTIFY=off` turns it off for one command.

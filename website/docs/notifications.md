# Notifications

Wisp tells you about a run you might have missed: one nobody watched, like a cron job or a
script, or one that took over 30 seconds. It shows a notification on this machine's screen,
and posts to a webhook if you set one.

```bash
wisp notify                                     # what is set
wisp notify all                                 # failures (the default), all, or off
wisp notify --webhook https://ntfy.sh/my-server
wisp notify --test                              # send one now, to check
```

The same is in the dashboard's [Settings](./settings), under **Notifications**.

## Webhooks

For a server, where nobody sees the screen. Slack, Discord and ntfy get a message they show as
it is. Any other address gets JSON:

```json
{
  "text": "✗ Backup failed on web-1\nat dump · Shop · wisp history 8efbda976796",
  "ok": false,
  "pipeline": "Backup",
  "workspace": "Shop",
  "failedStep": "dump",
  "history": "8efbda976796",
  "host": "web-1"
}
```

The address must be `https://`, so the message and any secret in it travel encrypted. Plain
`http://` works only to this machine (`localhost`).

## When it stays quiet

- A run started with `--json` never notifies: whatever started it reads the result.
- `WISP_NOTIFY=off` turns it off for one command.

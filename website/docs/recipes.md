# Recipes

Everyday tasks, each as a bolt you can copy. Put it in your project's `.wisp.json`, or in a
[workspace of your own](./file#personal-workspaces).

## Start the dev stack

The database, then the API, then the page once the API answers:

```json
{
  "label": "Dev",
  "targets": [
    { "compose": "compose.yaml", "services": ["postgres"] },
    { "run": "pnpm dev", "cwd": "apps/api" },
    { "wait": "http://localhost:3000" },
    { "url": "http://localhost:3000" }
  ]
}
```

`wisp dev` brings it up and `wisp down dev` stops it. Run it again, and what's already up is
left alone.

## Check before every push

Lint, types and tests at the same time, then the build:

```json
{
  "label": "Verify",
  "targets": [
    { "together": [
      { "run": "pnpm lint", "finishes": true },
      { "run": "pnpm typecheck", "finishes": true },
      { "run": "pnpm test", "finishes": true }
    ] },
    { "run": "pnpm build", "finishes": true }
  ]
}
```

`wisp hook pre-push verify` runs it on every `git push` and stops the push if it fails. After
a fix, `wisp verify --retry` runs only what failed.

## Deploy, asking first

Which environment, then one question before it goes:

```json
{
  "label": "Deploy",
  "inputs": { "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" } },
  "confirm": "Deploy to {{env}}?",
  "targets": [
    { "bolt": "Verify" },
    { "run": "./deploy.sh {{env}}", "finishes": true },
    { "url": "https://{{env}}.acme.com" }
  ]
}
```

`wisp deploy` asks both. In a script: `wisp deploy --input env=production --yes`.

## Use a secret

Wisp keeps no secrets. A step fetches its own from where you keep them, so nothing secret is
written in the file, shown on screen, or kept in history:

```json
{
  "label": "Deploy",
  "targets": [
    { "run": "TOKEN=$(op read op://ops/deploy/token) ./deploy.sh", "finishes": true }
  ]
}
```

That one reads it from 1Password. The same step, for other places:

| Kept in | The step runs |
|---|---|
| macOS Keychain | `TOKEN=$(security find-generic-password -s deploy -w) ./deploy.sh` |
| pass | `TOKEN=$(pass show deploy/token) ./deploy.sh` |
| a `.env` file | `set -a; . ./.env; set +a; ./deploy.sh` |
| 1Password, on Windows | `$env:TOKEN = op read op://ops/deploy/token; ./deploy.ps1` |

Keep a `.env` out of git, and on a server readable only by you: `chmod 600 .env`. One thing
no tool can stop: if your script prints the secret, it lands in the log.

## Back up every night, and hear if it fails

```json
{
  "label": "Backup",
  "targets": [
    { "run": "pg_dump acme > ~/backups/acme-$(date +%F).sql", "finishes": true },
    { "run": "find ~/backups -name 'acme-*' -mtime +14 -delete", "finishes": true }
  ]
}
```

Add it to cron with `crontab -e`:

```
0 3 * * * wisp use ~/dev/acme/.wisp.json Backup
```

If it fails, Wisp tells you: on screen, and on a server through `wisp notify --webhook`, to
Slack, Discord or ntfy. Each run is in `wisp history`.

## Open your morning

In a workspace of your own, say *Me* (`N` in the dashboard):

```json
{
  "label": "Morning",
  "targets": [
    { "url": "mail.google.com" },
    { "url": "calendar.google.com" },
    { "app": "Slack" }
  ]
}
```

`wisp me morning`, from any folder.

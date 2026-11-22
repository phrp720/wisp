# Secrets

Wisp keeps no secrets. A step fetches its own from where you already keep them, so nothing
secret is written in the file, shown on screen or kept in history:

```json
{ "run": "TOKEN=$(op read op://ops/deploy/token) ./deploy.sh", "finishes": true }
```

That one reads it from 1Password. The same step, for other places:

| Kept in | The step runs |
|---|---|
| macOS Keychain | `TOKEN=$(security find-generic-password -s deploy -w) ./deploy.sh` |
| pass | `TOKEN=$(pass show deploy/token) ./deploy.sh` |
| a `.env` file | `set -a; . ./.env; set +a; ./deploy.sh` |
| 1Password, on Windows | `$env:TOKEN = op read op://ops/deploy/token; ./deploy.ps1` |

## Good to know

- Keep a `.env` out of git, and on a server readable only by you: `chmod 600 .env`.
- Don't use [inputs](./inputs) for passwords: their values are shown and kept with the run.
- A value in a step's `env` that looks like a secret is hidden on the
  [Running tab](./whats-running#the-running-tab).

::: warning What no tool can stop
If your script prints the secret, it lands in the log.
:::

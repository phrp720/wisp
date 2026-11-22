# Use cases

What Wisp is for, each with a pipeline to copy. Put it in the project's `.wisp.json`, or in
a [personal workspace](./workspaces#personal-workspaces) when it belongs to no repository.

The names are yours. Wisp has no built-in `dev` or `deploy`: you run a pipeline from any
folder as `wisp <workspace> <pipeline>`, so `wisp acme dev` runs the *Dev* pipeline of the
*Acme* project. Inside the project, `wisp dev` is enough.

[[toc]]

## Bring up a dev stack

A project needs a database, an API and a web app, started in the right order, in the right
folders. Usually that's a section of the README, three terminal tabs, and a server you
forget to stop.

### The database, the API, the web app

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

`wisp dev` in the project, or `wisp acme dev` from anywhere. Run it again and what's already
up is left alone. `wisp down dev` stops all of it, child processes included, and
`wisp logs api -f` follows one.

### Servers that come back

Give a server `"restart": "on-failure"` and Wisp starts it again when it crashes, waiting a
little longer each time. The Running tab shows how often it did.

```json
{ "run": "pnpm worker", "cwd": "apps/api", "label": "worker", "after": "db", "restart": "on-failure" }
```

### Start over with a fresh database

Throw the local data away, then migrate and seed. It asks first.

```json
{
  "label": "Fresh db",
  "confirm": "Delete the local database and start over?",
  "steps": [
    { "run": "docker compose down -v", "label": "drop", "finishes": true },
    { "compose": "compose.yaml", "services": ["postgres"], "label": "db", "after": "drop" },
    { "run": "pnpm prisma migrate deploy", "label": "migrate", "after": "db", "finishes": true },
    { "run": "pnpm prisma db seed", "after": "migrate", "finishes": true }
  ]
}
```

## Check before you push

CI tells you ten minutes after the push. Run the same checks first, side by side, with each
run kept like CI keeps it.

### Lint, types and tests, then the build

<Pipeline name="verify" />

```json
{
  "label": "Verify",
  "steps": [
    { "run": "pnpm lint", "label": "lint", "finishes": true },
    { "run": "pnpm typecheck", "label": "types", "finishes": true },
    { "run": "pnpm test", "label": "test", "finishes": true, "timeout": "10m" },
    { "run": "pnpm build", "after": ["lint", "types", "test"], "finishes": true }
  ]
}
```

`wisp hook pre-push verify` runs it on every `git push`, and a failure stops the push. After
a fix, `wisp verify --retry` runs only what failed. Every run is in History, with its commit
and each step's output.

## Release and deploy

A deploy is the pipeline you least want to get wrong: the checks first, the right
environment, and a log of what happened.

### Deploy, asking first

It asks where, then asks once more before it goes. The checks run first, as a step.

```json
{
  "label": "Deploy",
  "inputs": { "env": { "ask": "Deploy where?", "choices": ["staging", "production"], "default": "staging" } },
  "confirm": "Deploy to {{env}}?",
  "steps": [
    { "pipeline": "Verify", "label": "verify" },
    { "run": "./deploy.sh {{env}}", "label": "deploy", "after": "verify", "finishes": true, "timeout": "15m" },
    { "wait": "https://{{env}}.acme.com/health", "after": "deploy" }
  ]
}
```

`wisp deploy` asks both. From CI or a script: `wisp deploy --input env=production --yes`.

<Recording name="server" alt="wisp shop deploy, from the home folder: it asks where, asks before it goes, then builds and ships" />

### Tag a release once the checks pass

```json
{
  "label": "Release",
  "inputs": { "version": { "ask": "Which version?" } },
  "confirm": "Tag and push v{{version}}?",
  "steps": [
    { "pipeline": "Verify", "label": "verify" },
    { "run": "git tag v{{version}} && git push origin v{{version}}", "after": "verify", "finishes": true }
  ]
}
```

The tag only goes out when every check passed.

### Use a secret

A step fetches its own secret from where you keep it, so nothing secret is written in the
file, shown on screen or kept in history:

```json
{ "run": "TOKEN=$(op read op://ops/deploy/token) ./deploy.sh", "finishes": true }
```

The same for the macOS Keychain, pass or a `.env` file: [Secrets](./secrets).

## Run a server

On a server, how to update or restart the app lives in someone's head or a wiki page.
Write it as pipelines next to the app, and anyone who SSHs in runs it the same way, from
whatever folder they land in. What Wisp starts in the background keeps running after you
disconnect.

### Update the app and restart it

```json
{
  "label": "Update",
  "confirm": true,
  "steps": [
    { "run": "git pull --ff-only", "label": "pull", "finishes": true },
    { "run": "npm ci --omit=dev", "label": "install", "after": "pull", "finishes": true, "timeout": "10m" },
    { "run": "npm run migrate", "label": "migrate", "after": "install", "finishes": true },
    { "run": "sudo systemctl restart shop", "label": "restart", "after": "migrate", "finishes": true },
    { "wait": "http://localhost:8080/health", "after": "restart" }
  ]
}
```

`wisp shop update`. If the pull changes the `.wisp.json` itself, the next run waits for
`wisp trust`: a changed file never runs unread.

### Keep an app running, without writing a service

```json
{
  "label": "App",
  "steps": [
    { "run": "node server.js", "label": "app", "env": { "PORT": 8080 }, "restart": "always" },
    { "wait": "localhost:8080", "after": "app" }
  ]
}
```

`wisp shop app` starts it, `wisp ps` shows its uptime and restarts, `wisp logs app -f`
follows it, `wisp restart shop app` restarts it. To start it when the machine boots, in
`crontab -e`:

```
@reboot wisp use /srv/shop/.wisp.json App
```

## Scheduled jobs

Cron runs it, nobody watches it, and nobody notices when it breaks. Run it through Wisp and
every run is kept, a hung job is stopped, and a failure sends you a message.

### Back up every night

```json
{
  "label": "Backup",
  "steps": [
    { "run": "pg_dump shop > ~/backups/shop-$(date +%F).sql", "label": "dump", "finishes": true, "timeout": "30m" },
    { "run": "find ~/backups -name 'shop-*' -mtime +14 -delete", "after": "dump", "finishes": true }
  ]
}
```

In `crontab -e`, and once, where to send a failure:

```
0 3 * * * wisp use /srv/shop/.wisp.json Backup
```

```bash
wisp notify add https://ntfy.sh/my-server    # or a Slack, Discord or Teams webhook
```

If it fails, or hangs past its 30 minutes, you get a message. `wisp history` has every run,
with its output.

### Clean up disk space every week

Each step runs even if another fails, and the run still says what failed.

```json
{
  "label": "Cleanup",
  "keepGoing": true,
  "steps": [
    { "run": "docker system prune -af --filter until=168h", "finishes": true },
    { "run": "find /var/log/shop -name '*.gz' -mtime +30 -delete", "finishes": true }
  ]
}
```

```
0 4 * * 0 wisp use /srv/shop/.wisp.json Cleanup
```

## Your own machine

Not everything belongs to a repository. Press `N` in the dashboard for a personal
workspace, say *Homelab*. Its pipelines run from any folder, and without asking for trust,
since they're yours.

### A tunnel to the production database

Keeps an SSH tunnel open, and opens it again if it drops.

```json
{
  "label": "Tunnel",
  "notes": "prod's database on localhost:5433",
  "steps": [
    { "run": "ssh -N -L 5433:localhost:5432 deploy@db.acme.com", "label": "tunnel", "restart": "on-failure" },
    { "wait": "localhost:5433", "after": "tunnel" }
  ]
}
```

`wisp homelab tunnel` opens it, ready when the command returns. `wisp down homelab tunnel`
closes it.

### Back up your photos

To the NAS first, then a copy offsite, each allowed two hours:

```json
{
  "label": "Back up photos",
  "steps": [
    { "run": "rsync -a --delete ~/Pictures/ nas:/volume1/photos", "label": "nas", "finishes": true, "timeout": "2h" },
    { "run": "restic backup ~/Pictures", "label": "offsite", "after": "nas", "finishes": true, "timeout": "2h" }
  ]
}
```

`wisp homelab photos`, or every Sunday from cron: `0 2 * * 0 wisp homelab photos`.

### Several projects at once

A pipeline runs pipelines of its own file only, so each project's file stands alone. To start
several projects together, run them as commands:

```json
{
  "label": "Work",
  "steps": [
    { "run": "wisp use ~/dev/acme/.wisp.json Dev", "finishes": true },
    { "run": "wisp use ~/dev/shop/.wisp.json Storefront", "finishes": true },
    { "app": "Slack" }
  ]
}
```

# File reference

Every field a `.wisp.json` can hold. For a gentler introduction, see [The .wisp.json file](./file).
Your editor autocompletes all of this once the file has its `$schema` line.

## The workspace

| Field | |
|---|---|
| `$schema` | `https://raw.githubusercontent.com/phrp720/wisp/main/schema/wisp.schema.json`, for autocomplete and checks as you type |
| `name` | what the project is called; left out, it's the folder's name |
| `icon` | an emoji shown beside the name, like `"🏢"` |
| `color` | a hex colour, like `"#6d4aff"` |
| `notes` | a line about what the project is for |
| `bolts` | the [bolts](#bolts) |
| `links` · `folders` · `files` · `apps` · `commands` | [shared assets](#shared-assets) that bolts name by label |

## Bolts

| Field | |
|---|---|
| `label` | its name, and what you type: its slug or any whole word of it runs it. Keep it short: "Deploy", "Work on api" |
| `notes` | a line on what it does, shown in `wisp show`, `wisp pick`, tab completion and the dashboard |
| `targets` | its [steps](#steps), in order |
| `job` | `true` makes it a [job](./jobs): runs to the end, stops at the first failure, kept in history |
| `down` | steps `wisp down` runs after stopping what it started, like `docker compose stop` |
| `color` | a hex colour |

## Steps

Each step is one of the forms below, or the label of a [shared asset](#shared-assets) as a
plain string: `"Repository"`. Every form takes an optional `label` (what Wisp shows for it)
and `os` (see [Several operating systems](#several-operating-systems)).

### Command

```json
{ "run": "pnpm dev", "label": "api", "cwd": "apps/api", "env": { "PORT": 3000 }, "restart": "on-failure" }
```

| Field | |
|---|---|
| `run` | the command line; pipes and `&&` work. One per OS when they differ |
| `cwd` | the folder to run it in, relative to the file; left out, the project's folder |
| `env` | environment variables, on top of yours |
| `restart` | `"on-failure"` after a crash, `"always"` whenever it exits, `"no"` (the default). Waits 1s, 2s, 4s… up to 30s between tries; gives up after 10 in a row |
| `shell` | `"sh"`, `"pwsh"` or `"cmd"`; the default is your shell on macOS and Linux, PowerShell on Windows |
| `background` | `true` keeps it in the background even when your [settings](./settings) open commands in terminal windows |

Runs only once the file is [trusted](./trust).

### Docker services

```json
{ "compose": "compose.yaml", "services": ["postgres", "redis"] }
```

Starts the services and waits until they're healthy. Leave out `services` for all of them.
`wisp down` stops them.

### Another bolt

```json
{ "bolt": "Database" }
{ "bolt": "Database", "workspace": "infra" }
```

Runs that bolt first, once per run however many bolts need it. `workspace` points at
another project's bolt.

### Wait

```jsonc
{ "wait": 3 }                               // seconds
{ "wait": "5432" }                          // a port on localhost
{ "wait": "db:5432" }                       // a port on another host
{ "wait": "http://localhost:3000" }         // a website that answers
{ "wait": { "url": "http://localhost:3000", "timeout": 120 } }
```

Ports and websites give up after 60 seconds, unless `timeout` says otherwise. The object
form takes `port`, `host`, `url`, `seconds` and `timeout`.

### Link

```json
{ "url": "http://localhost:3000" }
```

On macOS, a tab that's already open is focused instead of opening another. A bare host,
like `staging.acme.com`, is taken as `https://`.

### Folder · File

```json
{ "folder": "apps/api" }
{ "file": "docs/runbook.md" }
```

Paths are relative to the file. Folders open in your file manager or the editor you chose in
[Settings](./settings). A file that runs when opened (`.sh`, `.command`, `.exe`…) waits for
[trust](./trust).

### App

```json
{ "app": "Slack" }
{ "app": { "macos": "Visual Studio Code", "linux": "code", "windows": "code" } }
```

A name, a macOS bundle id (`com.tinyspeck.slackmacgap`), or a command on PATH.

## Shared assets

Declare something once, and any bolt names it by its label:

```json
{
  "links": [{ "label": "Repository", "url": "https://github.com/acme/acme" }],
  "folders": [{ "label": "API", "path": "apps/api" }],
  "files": [{ "label": "Runbook", "path": "docs/runbook.md" }],
  "apps": [{ "label": "Slack", "app": "Slack" }],
  "commands": [{ "label": "api", "run": "pnpm dev", "cwd": "apps/api" }],
  "bolts": [{ "label": "Work on api", "targets": ["API", "api", "Repository"] }]
}
```

Each takes the same fields as its step form above (`path` for folders and files). A plain
string works too: `"links": ["https://github.com/acme/acme"]` is its own label. When a link
and a folder share a label, `"folder:API"` picks the folder.

In your [personal workspaces](./file#personal-workspaces), a shared link, folder or file can
also say `"openWith": "WebStorm"`. A project's file can't: everyone chooses their own editor.

## Several operating systems

```json
{ "run": { "macos": "open -a Docker", "linux": "systemctl --user start docker" } }
{ "folder": "build/win", "os": "windows" }
{ "app": "Xcode", "os": ["macos"] }
```

A value per OS (`macos`, `linux`, `windows`), or `os` to keep a step to some of them. A step
for another OS is skipped quietly.

## Beside the file

- **`.wisp.local.json`** next to it is merged in: your own bolts and assets, kept out of git.
  A bolt with the same label replaces the project's.
- **Personal workspaces** are the same format, in Wisp's `workspaces` folder (`wisp doctor`
  shows where).

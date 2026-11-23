# AGENTS.md

Notes for AI coding agents working on Wisp's own code. To *use* Wisp, run
`wisp help agents` (the same text as [docs/SPEC.md](docs/SPEC.md)).

## Layout

- `cli/`: Wisp itself, published as `@phrp720/wisp`.
  - `src/core`: the file format, trust, discovery, running pipelines, history. No CLI or TUI code.
    `core/project` reads and checks a `.wisp.json`; `core/run` plans and runs pipelines
    (import each through its `index.ts`). `core/system` talks to the machine (processes,
    shells, docker, waits), `core/init` guesses a file for `wisp init`, `core/text` formats.
  - `src/platform`: everything specific to macOS, Linux and Windows.
  - `src/cli`: the `wisp` command. `commands/` has one file per command, `lib/` what they
    share. `src/cli/spec.ts` is the agent reference.
  - `src/tui`: the full-screen TUI (Ink + React). `App.tsx` holds state and keys, `watch.ts`
    what it polls. `screens/` has one file per screen, `components/` the parts screens
    share, `terminal/` mouse, glyphs and colours.
  - `tests/`: every test, at the same path as the code it tests (`src/core/run/plan.ts` is tested
    in `tests/core/run/`). `tests/support/` holds shared setup. `pnpm typecheck` checks the tests
    too; `tsconfig.build.json` builds only `src`.
- `website/`: the landing page and docs (VitePress), served by a Cloudflare Worker.
- `schema/wisp.schema.json`: the file's JSON Schema. Served at https://willowisp.dev/schema.json (the website copies it there on build), the address every `.wisp.json` points to.
- `docs/SPEC.md`: generated from `cli/src/cli/spec.ts`. Never edit it by hand.

## Commands

Run from the repository's root:

```bash
pnpm install
pnpm typecheck
pnpm test          # must pass before you finish
pnpm build
pnpm spec          # after changing cli/src/cli/spec.ts: regenerates docs/SPEC.md (a test compares them)
pnpm website:build # after changing website/
```

## Rules

- Keep `core` free of CLI and TUI code.
- Every command that prints results takes `--json`; never mix prose into JSON on stdout.
  Progress and warnings go to stderr. A failure under `--json` is JSON too.
- Without a terminal, nothing prompts: scripts and agents must never hang.
- Wisp never runs a cloned file's commands until a person approves them with `wisp trust`.
  Don't add a way around that, and don't run `wisp trust` on a person's behalf.
- Docs and website text: no em dashes (—). Use commas, colons, brackets or a new sentence.
- Tests live in `cli/tests/`, mirroring `cli/src/` (`*.test.ts`, `*.test.tsx`). Add one with every behaviour change.

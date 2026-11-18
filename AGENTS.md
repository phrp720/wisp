# AGENTS.md

Notes for AI coding agents working on Wisp's own code. To *use* Wisp, run
`wisp help agents` (the same text as [docs/SPEC.md](docs/SPEC.md)).

## Layout

- `cli/`: Wisp itself, published as `@squaredasher/wisp`.
  - `src/core`: the file format, trust, discovery, running bolts, history. No CLI or TUI code.
  - `src/platform`: everything specific to macOS, Linux and Windows.
  - `src/cli`: the `wisp` command. `src/cli/spec.ts` is the agent reference.
  - `src/tui`: the full-screen TUI (Ink + React). `App.tsx` holds state and keys; each screen
    has its own file (`home`, `running`, `history`, `panels`, `dialogs`, `editor`).
- `website/`: the landing page and docs (VitePress), served by a Cloudflare Worker.
- `schema/wisp.schema.json`: the file's JSON Schema. Its address is in every `.wisp.json`, so it stays here.
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
- Tests live beside the code (`*.test.ts`, `*.test.tsx`). Add one with every behaviour change.

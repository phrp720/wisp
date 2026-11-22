# Contributing to Wisp

Thanks for helping. Every kind of contribution is welcome, and small ones count.

## The most useful things you can do

- **Tell us when `wisp init` misses something.** Open an issue with what the project uses
  (framework, package manager, how you start it) and what Wisp suggested. Detection is the
  first thing new users meet, so these reports matter most.
- **Report a bug.** Include `wisp --version`, your OS and terminal, what you ran, and what
  happened. `wisp doctor` prints the rest; remove anything private from it first.
- **Improve the docs.** If something confused you, it will confuse others. A one-line fix is a
  great pull request.

For bigger changes, open an issue first, so we can agree on the shape before you write it.

## Set up

You need Node 22.12+ and pnpm 10.

```bash
git clone https://github.com/phrp720/wisp && cd wisp
pnpm install
pnpm test          # 200+ tests, a few seconds
pnpm typecheck
pnpm build         # cli/dist
pnpm website:dev   # the site and docs, at http://localhost:5173
```

The repository uses Wisp on itself. With Wisp installed, `wisp trust` this folder, then:

- `wisp "Work on the CLI"`: the tests and the typechecker, watching as you edit
- `wisp "Try my build"`: your working copy as a `wisp-dev` command beside your normal `wisp`,
  rebuilt as you save; stopping the pipeline removes it
- `wisp "Check everything"`: what CI runs, before you push

## Where things are

| Path | What |
|---|---|
| `cli/src/core` | the file format, trust, discovery, running pipelines, history. No CLI or dashboard code |
| `cli/src/platform` | everything specific to macOS, Linux and Windows |
| `cli/src/cli` | the `wisp` command; `spec.ts` is the reference for AI agents |
| `cli/src/tui` | the dashboard (Ink and React) |
| `cli/src/core/ecosystems.ts` | what `wisp init` detects: a good first place to contribute |
| `schema/wisp.schema.json` | the file's JSON Schema |
| `website/` | the landing page and docs (VitePress) |

[AGENTS.md](AGENTS.md) has the same map in more detail.

## Making a change

- **Add a test with every behaviour change.** Tests live beside the code (`*.test.ts`,
  `*.test.tsx`). `pnpm test` must pass.
- **Keep the promises:**
  - nothing from a cloned `.wisp.json` runs until a person allows it with `wisp trust`;
  - without a terminal, nothing waits on a question (scripts and AI agents must never hang);
  - every command that prints results takes `--json`, with nothing but JSON on stdout.
- **Changed `cli/src/cli/spec.ts`?** Run `pnpm spec` to regenerate `docs/SPEC.md`; a test
  compares them.
- **Changed the schema?** Update the [File reference](website/docs/reference.md) too.
- **Writing docs or messages:** short sentences, plain words, no em dashes (use a comma, a
  colon or a new sentence). Examples use made-up projects (Acme, Shop), never real ones.

## Pull requests

Keep them small and focused, and say *why* as well as what. Before you open one:

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm website:build
```

Releases are cut by the maintainers; [RELEASING.md](.github/RELEASING.md) explains how.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

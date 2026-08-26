_English | [한국어](CONTRIBUTING.ko.md)_

# Contributing

Thanks for contributing to ADDE. This document walks through the flow from setting up a development environment to opening a PR.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development setup](#development-setup)
- [Verification (required before committing)](#verification-required-before-committing)
- [Code style](#code-style)
- [Branch / PR flow](#branch--pr-flow)
- [Issues / security](#issues--security)

## Prerequisites

- Node.js >= 22
- [pnpm](https://pnpm.io) (the repo uses pnpm — see the `packageManager` pin)

## Development setup

```bash
pnpm install          # install dependencies
pnpm build            # TypeScript build
pnpm dev <command>    # run locally (tsx, e.g. pnpm dev --version)
```

## Verification (required before committing)

Run every gate with one command — CI runs this exact script, so a green run locally means a green run in CI:

```bash
pnpm gates
```

It chains the individual gates, which you can also run on their own:

```bash
pnpm typecheck        # type checking
pnpm lint             # ESLint
pnpm format:check     # Prettier format check (fix with pnpm format)
pnpm i18n:check       # en/ko catalog parity
pnpm usage:check      # flag declarations vs. usage text
pnpm build            # TypeScript build (must precede tests — spawn tests run dist/)
pnpm test             # vitest
```

A `pre-push` hook runs `pnpm gates` and blocks the push if any gate fails. It activates
automatically on `pnpm install` (which points `core.hooksPath` at `.githooks/`). To push past it
deliberately, use `ADDE_SKIP_HOOKS=1 git push` or `git push --no-verify`.

Coverage measurement (optional):

```bash
pnpm test:coverage    # generate a coverage report (coverage/)
```

## Code style

- Prettier enforces formatting and ESLint enforces linting. Editors follow `.editorconfig`.
- TypeScript strict mode. Match the surrounding code's comment density, naming, and idioms.
- User-facing strings are collected in `src/core/messages.ts` (CLI copy) and `src/shared/notify.ts` (block/exception notices).

## Branch / PR flow

- Start work on a `feature/<topic>` branch.
- PRs target **`develop`** (not a direct PR to `main`).
- Fill in the PR template checklist. When user-facing behavior changes, update `docs/` and `CHANGELOG.md` too.
- Prefix commit messages with the change type: `[feat]` / `[fix]` / `[docs]` / `[refactor]`, etc.

## Issues / security

- Bugs and feature proposals: use the GitHub issue templates.
- **Do not open a public issue for security vulnerabilities** — follow the private reporting path in [SECURITY.md](SECURITY.md).

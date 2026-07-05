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

A PR must pass the gates below (CI runs the same checks):

```bash
pnpm typecheck        # type checking
pnpm lint             # ESLint
pnpm test             # vitest
pnpm format:check     # Prettier format check (fix with pnpm format)
```

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

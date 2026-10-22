# Contributing to AI Fenshen

Thanks for your interest in AI Fenshen. This document covers the basics for running the project locally and submitting changes.

## Prerequisites

- Node.js (version range in `package.json` → `engines`)
- pnpm
- For server work: a Node runtime with `node:sqlite` support

## Local setup

```bash
pnpm install --frozen-lockfile
pnpm dev        # desktop dev preview
pnpm build      # production build
```

Model provider keys are supplied at runtime through environment variables. Never hard-code a key, and never commit `.env` files, user data, or private configuration — pull requests containing secrets will be closed.

## Checks

Run the relevant checks before opening a pull request:

```bash
pnpm run project:verify
pnpm run test:project-state
pnpm run test:release-runtime
```

## Pull requests

1. Branch from `main`; keep each PR focused on one change.
2. Describe what changed and why, and how you verified it.
3. Do not reformat unrelated files, and do not change product behavior beyond the stated scope.
4. UI changes: include before/after screenshots when possible.

## Issues

Use the issue templates. For bugs, include reproduction steps, expected vs. actual behavior, and your environment (OS, Node version). For feature requests, describe the user problem first, then the proposed solution.

## Security

If you find a vulnerability or a leaked credential, do not open a public issue — contact the maintainer privately via the email on the GitHub profile.

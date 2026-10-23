# Security Policy

## Reporting a vulnerability

If you find a security vulnerability, or a credential that appears to have been committed by mistake, **do not open a public issue**. Contact the maintainer privately via the email address on the GitHub profile of `geneadela284-glitch`, with:

- a description of the issue and its impact,
- steps to reproduce, if applicable,
- the affected file(s) or component(s).

You should receive an acknowledgement within a few days. Please give the maintainer a reasonable window to fix the issue before any public disclosure.

## Scope notes

- This repository is a reviewed source snapshot. It intentionally contains **no** API keys, user data, or deployment configuration; model keys are supplied at runtime through environment variables.
- The application is local-first: user data stays on the user's own devices by design.
- Stored provider keys are masked in the UI and redacted from logs and diagnostics.

## Supported versions

Only the latest snapshot on `main` is maintained. Fixes land there first.

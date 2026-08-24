# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript worker. Keep domain rules in `src/domain/`, integrations in
`src/naver/` and `src/sheets/`, orchestration in `src/sync/`, and entry points in `src/cli/`
or `src/scheduler/`. Configuration, locking, and logging have matching modules.

Tests mirror risk and scope: `tests/unit/`, `tests/integration/`, `tests/deployment/`,
`tests/e2e/`, and `tests/visual/`. Reusable mock payloads belong in `tests/fixtures/`.
Operational scripts and systemd units live under `ops/deployment/`; project documentation
lives in `docs/`. Treat `dist/`, `coverage/`, and `test-results/` as build artifacts.

## Build, Test, and Development Commands

- `corepack enable && pnpm install --frozen-lockfile`: install dependencies with Node 22.23.1
  and pnpm 11.10.0.
- `pnpm sync:once`: run one local sync using mock Naver data.
- `pnpm test:unit` or `pnpm vitest run tests/unit/plate.test.ts`: run focused Vitest tests.
- `pnpm test:integration`, `pnpm test:deployment`: verify cross-module and deployment behavior.
- `pnpm test:e2e`, `pnpm test:visual`: run targeted Playwright CLI and snapshot checks.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: run static checks.
- `pnpm test:all`: reproduce the main CI verification; `pnpm build` compiles production code.

## Coding Style & Naming Conventions

Prettier enforces two-space indentation, double quotes, semicolons, trailing commas, and a
100-character width. Use kebab-case filenames, camelCase values, PascalCase types, and descriptive
test names. In strict NodeNext TypeScript, include `.js` in relative imports and prefer
`import type`. ESLint rejects `any`, non-null assertions, and type assertions; validate and narrow
uncertain input instead.

## Agent and Code Discipline

- Write human-facing text with the fewest precise words. Avoid praise, superlatives, and empty
  agreement. State facts directly.
- Extract recurring, meaningful, or specification-defined values into named constants or enums.
  Keep self-explanatory one-offs inline.
- Avoid the Arrow Anti-Pattern. Reduce indentation with early returns and `continue`.
- Keep function names under 30 characters.
- Use enums, not booleans, for function parameters.
- Separate logical blocks with blank lines.
- Always use braces, including one-line `if` statements.
- Encapsulate low-level I/O, parsing, and network mechanics behind drivers or abstractions. Expose
  domain-level APIs.
- Enforce adjacent-layer dependencies. Never bypass an intermediate service or abstraction to
  reach storage, raw network clients, or drivers.
- For bug fixes, write a targeted test first, confirm failure, implement, then confirm success.

## Testing Guidelines

Name Vitest files `*.test.ts` and Playwright files `*.spec.ts`. Add the smallest test that proves
changed behavior; no numeric coverage threshold replaces regression coverage. Automated tests
must use fixtures, temporary lock directories, mocked Google APIs, and never the live Naver API
or production Sheet. Review visual diffs manually and never replace Linux snapshots from macOS.

## Commit & Pull Request Guidelines

Follow the history’s concise English imperative style, such as `Define duplicate view membership
rules`; use a conventional prefix only when it matches nearby maintenance commits. Keep commits
atomic. PRs should explain behavior and operational impact, link the issue when applicable, list
commands run, and include screenshots or snapshot notes for visual changes. The `Verify` job must
pass. Changes under `ops/deployment/`, `.github/workflows/`, or dependency manifests require
owner review and may trigger the documented privileged-maintenance path.

## Security & Configuration

Copy `.env.example` locally, but never commit `.env`, credentials, cookies, or product exports.
Live Naver calls require both `NAVER_API_MODE=live` and `ALLOW_LIVE_NAVER_API=true`.

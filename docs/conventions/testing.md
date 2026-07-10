# Testing Convention

Every implementation task must leave the repo passing:

- Static: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- Unit: `pnpm test:unit`
- Integration: `pnpm test:integration`
- E2E: `pnpm test:e2e`
- Visual: `pnpm test:visual`

Use fixtures for local Naver data. Do not call live Naver Commerce API from local tests.

Google Sheets tests must cover tab creation, legacy-tab migration, Korean header and status round trips, bounded update ranges, service-account credential validation, preservation of operator-owned values, duplicate-group ordering, stale-format cleanup, and formatting requests. Every managed foreground/background pair must meet WCAG AA 4.5:1 contrast, and light/dark visual snapshots must cover the operator table. The Google API is mocked locally; only the fixed-IP live smoke test may verify the real spreadsheet.

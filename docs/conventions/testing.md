# Testing Convention

Every implementation task must leave the repo passing:

- Static: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- Unit: `pnpm test:unit`
- Integration: `pnpm test:integration`
- E2E: `pnpm test:e2e`
- Visual: `pnpm test:visual`

Use fixtures for local Naver data. Do not call live Naver Commerce API from local tests.

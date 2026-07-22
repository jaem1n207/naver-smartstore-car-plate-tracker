# Testing Convention

Every implementation task must leave the repository passing the same contract used by the `Verify` GitHub Actions job.

## Local contract

- Static: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- Unit: `pnpm test:unit`.
- Integration: `pnpm test:integration`.
- Deployment: `pnpm test:deployment`.
- E2E: `pnpm test:e2e`.
- Visual: `pnpm test:visual`.
- Production compile: `pnpm build`.

Run the combined package contract first, then the separate production build and generated-CSS consistency check used by CI.

**[MacBook]**

```bash
# [MacBook]
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:all
pnpm build
git diff --exit-code -- tests/visual/fixtures/sheets-view.css
```

The repository pins Node.js `22.23.1` in `.node-version` and pnpm `11.10.0` in `package.json` and the production workflow. Use those exact versions when reproducing CI.

## Test isolation

Use fixtures for local Naver data. Automated tests must never call the live Naver Commerce API or write the production Google Sheet. The fixed-IP live smoke test is the only path for real Naver and Google verification.

Every process-level test gets its own temporary `SYNC_LOCK_DIR`. Lock tests cover active-owner contention, verified stale-owner recovery, PID reuse, a crash before owner publication, malformed owner state, and token-safe release. Scheduler tests cover graceful `SIGTERM` drain and compiled runtime startup.

## Google Sheets behavior

Google Sheets tests cover tab creation, legacy-tab migration, Korean header and status round trips, bounded update ranges, service-account credential validation, preservation of operator-owned values, duplicate-group ordering, stale-format cleanup, and formatting requests.

Every managed foreground/background pair must meet WCAG AA 4.5:1 contrast. Light and dark visual snapshots cover the operator table. The Google API is mocked locally.

## Visual determinism and baselines

Visual tests use Playwright's bundled Chromium with one worker, locale `ko-KR`, timezone `Asia/Seoul`, viewport `2540x720`, device scale `1`, reduced motion, and sRGB. The fixture loads the local Noto Sans KR variable font and waits for all eight font faces before measuring geometry or taking screenshots.

Snapshots are platform-specific. macOS changes must be reviewed against the Darwin baselines in `tests/visual/sheets-view.spec.ts-snapshots/`. The `ubuntu-24.04` GitHub runner exercises the Linux baseline with the Playwright version locked by `pnpm-lock.yaml`; a missing or changed Linux baseline is a CI failure that must be generated and visually reviewed on the same Linux environment before merge. Never approve expected, actual, or diff images without inspection.

**[MacBook]**

```bash
# [MacBook]
pnpm test:visual
```

Do not use the MacBook to overwrite Linux snapshots. Use the CI artifact or the matching Ubuntu 24.04 environment, inspect the result, and commit only the intended baseline.

## Deployment and workflow tests

`pnpm test:deployment` is a local, non-root suite. It uses temporary directories, temporary Git repositories, command shims, and injected crash points to verify:

- exact forced-command and SHA validation;
- equal, stale, forward, initial, and divergent revision handling;
- swap, disk, and memory preflight;
- shared sync locking and deployment flock contention;
- secretless transient builds and immutable sealing;
- bootstrap rejection when the initial checkout equals or is nested inside the managed `/opt` application root;
- candidate failure restart, A/B/C two-release preservation, and activation rollback;
- invocation-scoped health and restart-count checks;
- crash-consistent recovery at every activation transition;
- escaping links, special files, unsafe metadata, surviving children, and writable-descriptor rejection;
- workflow triggers, four-secret scope, strict SSH, pinned actions, CODEOWNERS, and Node/pnpm pins.

Security-sensitive deployment helpers accept only canonical roots and intentionally reject paths that traverse symlink aliases. On macOS, Node may report the temporary directory beneath `/var/folders/...` while its canonical path is `/private/var/folders/...`. Any deployment fixture that passes a freshly created temporary root into production validation must call `realpath()` immediately after `mkdtemp()` and derive all child paths from that result. Do not weaken production validation or rely on a `TMPDIR` override to make the suite pass.

Run focused rollback and boot-recovery coverage with:

**[MacBook]**

```bash
# [MacBook]
pnpm vitest run tests/deployment/deployer.integration.test.ts -t "rolls back activation without another fetch or build and verifies the rollback invocation"
pnpm vitest run tests/deployment/recovery.test.ts
```

Shell syntax is part of the local contract. CI downloads versioned `actionlint` and `shellcheck` binaries from their official releases, verifies fixed SHA-256 digests, and runs them directly. Those Linux checks remain authoritative when the tools are not installed locally.

**[MacBook]**

```bash
# [MacBook]
bash -n ops/deployment/*.sh ops/deployment/lib/*.sh
python3 -m py_compile ops/deployment/atomic_fs.py
```

## Production smoke boundary

The production deployment health check proves that the new systemd invocation logs `scheduler started` with `mode: live`, the expected cron, and requested `APP_REVISION`, then remains `active/running` for 15 seconds without a restart or PID change. It does not call Naver or Google and does not prove an external synchronization can complete.

Use the [automatic deployment runbook](../operations/automatic-production-deployment.md) for first deployment and reboot verification, then the [fixed-IP live smoke test](../operations/live-smoke-test.md) for real external access.

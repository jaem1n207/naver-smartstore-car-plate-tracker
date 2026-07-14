# Automatic Production Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify every pull request, automatically deploy the newest verified `main` revision to Oracle Cloud, and keep synchronization and rollback safe without relying on the developer's MacBook.

**Architecture:** Runtime code shares one cross-process lock contract between the scheduler, CLI, and root deployer, and drains an active synchronization on `SIGTERM`. A dedicated deployment account invokes a root-owned state machine that builds with a secretless account, seals immutable releases, performs monotonic activation with durable state, and rolls back by switching symlinks. GitHub Actions verifies static, unit, integration, E2E, visual, and deployment suites before sending only `deploy <sha>` through a forced SSH command.

**Tech Stack:** Node.js 22.23.1, TypeScript 6, pnpm 11.10.0, Vitest, Playwright Chromium, Bash, Python 3 standard library, systemd, OpenSSH, GitHub Actions

## Global Constraints

- Use pnpm only. New npm packages must be installed at their latest compatible minor and committed with a caret range plus the updated lockfile.
- Keep Naver and Google credentials only on Oracle. Build and deployment accounts must not read them.
- Never call the live Naver API or write the production Google Sheet from automated tests.
- Normal deployment moves only forward through fetched `origin/main`; equal or stale requests are successful no-ops and divergent history fails closed.
- Runtime, build, deploy, and maintenance accounts remain separate.
- Production executes `node dist/src/scheduler/main.js`, not `tsx`.
- Detailed application journal entries never enter public GitHub Actions logs.
- GitHub Actions and reusable actions use immutable full commit SHAs.
- Static, unit, integration, E2E, visual, deployment, and production build checks must pass before pushing.
- Use TDD for runtime and deployment behavior. Every task pairs implementation with its direct tests.
- Preserve the existing mock-first local development and fixed-IP live-smoke boundaries.

---

### Task 1: Cross-Process Synchronization Lock

**Files:**

- Create: `src/runtime/sync-lock.ts`
- Create: `src/sync/run-locked-sync-job.ts`
- Modify: `src/config/env.ts`
- Modify: `src/cli/sync-once.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Test: `tests/unit/sync-lock.test.ts`
- Test: `tests/integration/locked-sync-job.test.ts`
- Modify: `tests/e2e/mock-sync.cli.spec.ts`

**Interfaces:**

- Produces: `acquireSyncLock(options: SyncLockOptions): Promise<SyncLockLease>`
- Produces: `runLockedSyncJob(dependencies, lockOptions): Promise<SyncJobResult>`
- Produces: `SyncLockHeldError` with stable code `SYNC_LOCK_HELD`
- Consumes: `runSyncJob(SyncJobDependencies)` without changing its pure orchestration contract

- [ ] **Step 1: Write failing lock unit tests**

Cover first acquisition, active-owner contention, dead-owner stale recovery, PID-reuse protection through Linux process start ticks, malformed owner fail-closed behavior, token-mismatch release, and release after callback failure. Use temporary directories and injected `processExists`, `readProcessStartTicks`, `pid`, and `token` dependencies so macOS tests do not require `/proc`.

The owner file contract is exact ASCII:

```text
pid=<positive integer>
start_ticks=<positive integer or unknown>
token=<32 lowercase hexadecimal characters>
```

- [ ] **Step 2: Run the lock tests and verify RED**

Run: `pnpm vitest run tests/unit/sync-lock.test.ts`

Expected: fail because `src/runtime/sync-lock.ts` does not exist.

- [ ] **Step 3: Implement atomic lock acquisition and release**

Define these public types without assertions or `@ts-ignore`:

```ts
export interface SyncLockOptions {
  readonly lockDir: string;
  readonly pid?: number;
  readonly token?: string;
  readonly processExists?: (pid: number) => boolean;
  readonly readProcessStartTicks?: (pid: number) => Promise<string | undefined>;
}

export interface SyncLockLease {
  readonly owner: SyncLockOwner;
  release(): Promise<void>;
}

export class SyncLockHeldError extends Error {
  readonly code = "SYNC_LOCK_HELD";
}
```

Acquire with atomic `mkdir(lockDir)`, write `owner` through an exclusive temporary file and rename, and reclaim only when the recorded process is absent or its Linux start ticks no longer match. Release only when the stored token equals the lease token. Reject unknown files in a stale lock directory instead of recursively deleting them.

- [ ] **Step 4: Add the locked sync facade and configuration**

Add `SYNC_LOCK_DIR` to `EnvSchema` and `AppEnv`, defaulting to `.runtime/sync.lock`. Add `.runtime/` to `.gitignore` and the variable to `.env.example`.

Implement:

```ts
export async function runLockedSyncJob(
  dependencies: SyncJobDependencies,
  lockOptions: SyncLockOptions,
): Promise<SyncJobResult> {
  const lease = await acquireSyncLock(lockOptions);
  try {
    return await runSyncJob(dependencies);
  } finally {
    await lease.release();
  }
}
```

Use the facade in `sync-once.ts` before any Naver or Sheets work. Keep CLI result JSON unchanged except for lock failures.

- [ ] **Step 5: Write and pass integration and CLI tests**

Verify that a held lock prevents API and Sheet calls, a failed sync releases the lock, and two processes cannot sync concurrently. Give every E2E test a unique temporary `SYNC_LOCK_DIR` and cover both `node --import tsx src/cli/sync-once.ts` and compiled `node dist/src/cli/sync-once.js`.

Run:

```bash
pnpm vitest run tests/unit/sync-lock.test.ts tests/integration/locked-sync-job.test.ts
pnpm build
pnpm playwright test tests/e2e/mock-sync.cli.spec.ts
```

Expected: all focused tests pass and no `.runtime` file is tracked.

- [ ] **Step 6: Commit**

Commit message: `Coordinate cross-process synchronization`

---

### Task 2: Graceful Scheduler Lifecycle And Compiled Runtime

**Files:**

- Create: `src/scheduler/scheduler.ts`
- Modify: `src/scheduler/main.ts`
- Modify: `src/config/env.ts`
- Modify: `package.json`
- Test: `tests/unit/scheduler.test.ts`
- Test: `tests/integration/scheduler-shutdown.test.ts`

**Interfaces:**

- Consumes: `runLockedSyncJob` and `SyncLockOptions` from Task 1
- Produces: `createScheduler(options): SchedulerController`
- Produces: `SchedulerController.shutdown(signal): Promise<void>`
- Produces: startup log fields `cron`, `mode`, and `appRevision`

- [ ] **Step 1: Write failing lifecycle tests**

Use a fake scheduled task and deferred sync promise. Assert that shutdown sets draining before stopping cron, rejects a trigger that races after draining, waits for the active promise, records sync failure without skipping lock release, resolves once, and handles repeated signals idempotently.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `pnpm vitest run tests/unit/scheduler.test.ts`

Expected: fail because `createScheduler` is missing.

- [ ] **Step 3: Extract the scheduler controller**

Use this contract:

```ts
export interface SchedulerController {
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

export interface SchedulerOptions {
  readonly schedule: (expression: string, callback: () => Promise<void>) => ScheduledTask;
  readonly runSync: () => Promise<SyncJobResult>;
  readonly cron: string;
  readonly mode: "mock" | "live";
  readonly appRevision: string;
  readonly logger: SchedulerLogger;
}
```

Keep one `activeSync` promise. The callback checks `draining` before acquisition and again immediately before `runSync`. `shutdown` sets `draining`, stops the cron task, awaits `activeSync`, and logs `scheduler stopped`. It must not call `process.exit()`.

- [ ] **Step 4: Wire production main and revision logging**

Add optional `APP_REVISION` with default `local` to `AppEnv`. `main.ts` registers `process.once("SIGTERM")` and `process.once("SIGINT")`, sets `process.exitCode` after `shutdown`, and logs:

```ts
logger.info(
  { cron: env.syncCron, mode: env.naverApiMode, appRevision: env.appRevision },
  "scheduler started",
);
```

Add scripts:

```json
"scheduler:production": "node dist/src/scheduler/main.js",
"sync:once:production": "node dist/src/cli/sync-once.js"
```

- [ ] **Step 5: Add real child-process shutdown coverage**

Spawn the compiled scheduler with mock mode and a delayed test seam, trigger one sync, send `SIGTERM`, and assert the child exits only after the active run releases its lock. Assert the startup JSON contains the exact `APP_REVISION` and no secret values.

Run:

```bash
pnpm vitest run tests/unit/scheduler.test.ts tests/integration/scheduler-shutdown.test.ts
pnpm build
```

Expected: lifecycle and compiled build checks pass.

- [ ] **Step 6: Commit**

Commit message: `Drain scheduler synchronization on shutdown`

---

### Task 3: Durable Deployment Primitives

**Files:**

- Create: `ops/deployment/lib/common.sh`
- Create: `ops/deployment/atomic_fs.py`
- Create: `tests/deployment/common.test.ts`
- Create: `tests/deployment/atomic-fs.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces shell functions: `validate_sha`, `classify_revision`, `read_lock_owner`, `acquire_sync_lock`, `release_sync_lock`, `safe_result`, `validate_candidate_tree`, `verify_invocation`
- Produces Python commands: `write-file`, `replace-symlink`, `clear-file`, each performing file and parent-directory fsync
- Produces: `pnpm test:deployment`

- [ ] **Step 1: Write failing command-level tests**

Spawn Bash and Python with temporary fixtures. Cover exact lowercase 40-hex validation, equal/stale/forward/divergent Git histories, owner parsing, live-owner wait, dead-owner reclaim, unexpected lock entry rejection, allowlisted result keys, malformed journal JSON, old invocation rejection, and restart-count changes.

For Python durability, test atomic content replacement, relative symlink replacement in the same parent, mode enforcement, missing-parent rejection, symlink destination rejection, and pending-state removal.

- [ ] **Step 2: Run deployment tests and verify RED**

Run: `pnpm vitest run tests/deployment/common.test.ts tests/deployment/atomic-fs.test.ts`

Expected: fail because the deployment primitives are absent.

- [ ] **Step 3: Implement the shell contract**

Start every shell source with strict mode and a fixed path:

```bash
set -Eeuo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
```

`classify_revision <git-dir> <deployed-sha> <requested-sha>` prints exactly one of `equal`, `stale`, `forward`, or `divergent`. `safe_result` prints one JSON line containing only `outcome`, `requestedSha`, `previousSha`, `activatedSha`, and `diagnosticId`. Never emit command environments or journal contents.

Implement the Node-compatible lock owner format from Task 1. Shell stale recovery checks `kill -0` and `/proc/<pid>/stat` start ticks, removes only `owner` and an otherwise empty lock directory, and holds its random token through activation or recovery.

- [ ] **Step 4: Implement the durability helper**

Use Python standard-library `os.open` with `O_NOFOLLOW | O_CREAT | O_EXCL`, `os.replace`, `os.symlink`, file `fsync`, and parent-directory `fsync`. Validate every destination against a compiled-in allowed root passed by the root-owned wrapper; do not accept arbitrary absolute destinations from SSH input.

- [ ] **Step 5: Add script validation and package contract**

Add:

```json
"test:deployment": "vitest run tests/deployment --passWithNoTests"
```

Include it in `test:all`. Run:

```bash
bash -n ops/deployment/lib/common.sh
python3 -m py_compile ops/deployment/atomic_fs.py
pnpm test:deployment
```

Expected: all primitive tests pass.

- [ ] **Step 6: Commit**

Commit message: `Add durable deployment primitives`

---

### Task 4: Oracle Release State Machine And Bootstrap

**Files:**

- Create: `ops/deployment/deploy-entrypoint.sh`
- Create: `ops/deployment/deploy.sh`
- Create: `ops/deployment/recover.sh`
- Create: `ops/deployment/build-candidate.sh`
- Create: `ops/deployment/bootstrap.sh`
- Create: `ops/deployment/systemd/car-plate-tracker.service`
- Create: `ops/deployment/systemd/car-plate-tracker-recover.service`
- Create: `tests/deployment/entrypoint.test.ts`
- Create: `tests/deployment/deployer.integration.test.ts`
- Create: `tests/deployment/recovery.test.ts`
- Create: `tests/deployment/isolation-contract.test.ts`

**Interfaces:**

- Consumes: Task 3 shell and durability primitives
- Produces forced command: `deploy <40-lowercase-hex-sha>`
- Produces runtime coordination under `/var/lib/naver-smartstore-car-plate-tracker/runtime` and root-only deployment state under `/var/lib/naver-smartstore-car-plate-tracker/deployment`
- Produces systemd readiness contract using `APP_REVISION`

- [ ] **Step 1: Write failing entrypoint and deployment integration tests**

Use an isolated temporary root and command shims. Test missing, uppercase, short, extra-argument, environment-assignment, and metacharacter commands. Verify the privileged deployer independently validates UID, one SHA argument, safe path, and fixed origin.

Create a real temporary Git repository with A and B commits. Cover initial HEAD-only deploy, A then B, B then A stale no-op, equal no-op, divergence, swap/disk/memory preflight failures, active-sync drain, install failure, build failure, activation failure, successful rollback, failed rollback, and lock contention.

- [ ] **Step 2: Write failing recovery and isolation tests**

Inject failure after pending journal write, previous link write, current link switch, service start, health success, marker write, and pending clear. Verify boot recovery restores the durable deployed SHA whenever activation is pending or marker/current disagree.

Reject an escaping symlink, FIFO, socket, device, unexpected ACL/xattr, daemonized process, inherited writable descriptor, non-empty cgroup, and timed-out transient unit. Permit pnpm relative symlinks only when their final target remains inside the candidate.

- [ ] **Step 3: Implement forced entrypoint and monotonic state machine**

`deploy-entrypoint.sh` accepts only exact `SSH_ORIGINAL_COMMAND`, clears the environment, and invokes the single sudo-approved deployer. `deploy.sh` uses a root-owned `flock`, fetches only the compiled-in GitHub HTTPS origin, validates `${sha}^{commit}` and `origin/main` ancestry, and returns stale/equal as no-op.

When no marker exists, permit only the current fetched `origin/main` head. Require at least 2 GiB active swap, 3 GiB free disk, and 128 MiB `MemAvailable` before stopping the scheduler.

- [ ] **Step 4: Implement isolated candidate build and sealing**

Run `build-candidate.sh` through `systemd-run --wait --collect` as `carplate-build` with `KillMode=control-group`, `RuntimeMaxSec=30min`, `MemoryMax=900M`, `MemorySwapMax=2G`, `TasksMax=128`, `ProtectSystem=strict`, `NoNewPrivileges=true`, and candidate/package-store-only writable paths.

The helper runs:

```bash
pnpm install --frozen-lockfile
pnpm build
node --check dist/src/scheduler/main.js
pnpm prune --prod
```

After the cgroup is empty, validate the candidate, copy without preserving ownership, ACLs, or xattrs into a different temporary release, create `release.env`, normalize to root-owned read-only content, and atomically rename it into `releases/<sha>`.

- [ ] **Step 5: Implement durable activation, health, and recovery**

Write and fsync `activation-state` before switching links. Health verification reads only the new systemd `InvocationID`, requires `scheduler started`, `mode: live`, expected cron, and requested revision, then requires 15 seconds of `active/running` with unchanged `NRestarts` and live `MainPID`.

On failure, switch to `previous` without fetch/install/build and verify its invocation. `recover.sh` runs before every service start and restores `deployed-sha` when pending or mismatched.

- [ ] **Step 6: Implement repeat-safe bootstrap and hardened units**

`bootstrap.sh` creates `carplate`, `carplate-build`, and `carplate-deploy`; gives only `carplate` write access to `/var/lib/naver-smartstore-car-plate-tracker/runtime`; keeps `/var/lib/naver-smartstore-car-plate-tracker/deployment` root-only; migrates the current `.env` to root:carplate `0640`; creates the root-owned authorized-key location; installs scripts; validates sudoers; installs both units; and does not enable the scheduler until a known-good marker exists. The deploy account has `/bin/sh` only so OpenSSH can invoke the forced command; its password is locked and the root-owned SSH restrictions prevent interactive or caller-selected commands.

The runtime unit executes compiled Node, uses `TimeoutStopSec=60min`, orders recovery first, and applies `NoNewPrivileges`, empty capabilities, `PrivateTmp`, `ProtectHome`, `ProtectSystem=strict`, kernel/control-group protection, read-only access to `/etc/naver-smartstore-car-plate-tracker` and the active release, and write access only to `/var/lib/naver-smartstore-car-plate-tracker/runtime`. Do not enable `MemoryDenyWriteExecute` because Node.js JIT requires executable memory.

- [ ] **Step 7: Pass the full deployment suite**

Run:

```bash
bash -n ops/deployment/*.sh ops/deployment/lib/*.sh
python3 -m py_compile ops/deployment/atomic_fs.py
pnpm test:deployment
```

Expected: all command-shim and real-temporary-Git tests pass without root or live systemd.

- [ ] **Step 8: Commit**

Commit message: `Automate immutable Oracle releases`

---

### Task 5: GitHub Verification, Visual Determinism, And Governance

**Files:**

- Create: `.node-version`
- Create: `.github/workflows/deploy-production.yml`
- Create: `.github/dependabot.yml`
- Create: `.github/CODEOWNERS`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `playwright.config.ts`
- Modify: `tests/visual/sheets-view.spec.ts`
- Modify: `tests/visual/fixtures/sheets-view.input.css`
- Create: `tests/visual/fixtures/fonts/`
- Update: `tests/visual/sheets-view.spec.ts-snapshots/*.png`
- Create: `tests/deployment/workflow-contract.test.ts`

**Interfaces:**

- Consumes: all package scripts and deployment command from Tasks 1-4
- Produces required check job `verify`
- Produces deploy request `deploy $GITHUB_SHA`
- Produces deterministic Darwin and Linux Chromium baselines

- [ ] **Step 1: Install only necessary latest-minor packages**

Run with pnpm:

```bash
pnpm add -D @fontsource-variable/noto-sans-kr@latest yaml@latest
```

Verify `package.json` records caret ranges and the lockfile changes contain no unrelated upgrades.

- [ ] **Step 2: Write failing workflow contract tests**

Parse YAML and assert `pull_request` verifies only, `push` deploys only `main`, `workflow_dispatch` rejects non-main, permissions are `contents: read`, deploy alone has `environment: production`, concurrency is `production-deploy` with `cancel-in-progress: false`, only four `OCI_DEPLOY_*` secrets are referenced, and SSH sends only `deploy <event SHA>` with strict host checking.

- [ ] **Step 3: Add the pinned workflow and governance files**

Use the reviewed full SHA pins for checkout, setup-node, pnpm setup, upload-artifact, actionlint, and shellcheck. The `verify` job runs frozen install, Playwright Chromium install, `pnpm test:all`, `pnpm build`, shell syntax/static checks, and generated CSS diff. Upload Playwright artifacts for seven days on failure. The deploy job has a timeout exceeding the 60-minute drain plus 30-minute build and returns only allowlisted server output.

Dependabot monitors `github-actions` weekly. CODEOWNERS assigns `@jaem1n207` to workflows, deployment sources, `package.json`, and `pnpm-lock.yaml`.

- [ ] **Step 4: Make visual tests deterministic**

Remove the local Chrome executable override. Configure Playwright Chromium with one worker, `ko-KR`, `Asia/Seoul`, viewport `2540x720`, device scale 1, reduced motion, and sRGB. Load the local Noto Sans KR variable font and await `document.fonts.ready` before geometry or screenshot assertions.

Regenerate Darwin snapshots with bundled Chromium. Generate Linux snapshots in the pinned Playwright Linux image used by CI. Do not approve a baseline without visually inspecting expected, actual, and diff output.

- [ ] **Step 5: Verify CI and visual contracts**

Run:

```bash
pnpm test:deployment
pnpm test:visual
pnpm test:all
pnpm build
git diff --exit-code -- tests/visual/fixtures/sheets-view.css
```

Run `actionlint` and `shellcheck` locally when installed; the pinned CI checks remain authoritative on Linux.

- [ ] **Step 6: Commit**

Commit message: `Verify and deploy main automatically`

---

### Task 6: Beginner Operations, Security, And Final Verification

**Files:**

- Create: `docs/operations/automatic-production-deployment.md`
- Modify: `docs/operations/oracle-cloud-systemd.md`
- Modify: `docs/conventions/testing.md`
- Modify: `docs/SECURITY.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-14-automatic-production-deployment.md`

**Interfaces:**

- Consumes: exact commands, paths, users, secrets, outcomes, and recovery procedures from Tasks 1-5
- Produces: one ordered server migration and GitHub setup runbook for a frontend developer

- [ ] **Step 1: Write the repeat-safe migration runbook**

Document, in execution order: backup/current-state checks, persistent 2 GiB swap verification, Node 22.23.1 and pnpm 11.10.0, dedicated users, `/opt` release layout, `/etc` secret migration, Google credential permissions, reviewed script installation, deploy-key generation, root-owned authorized key, SSH fingerprint verification, sudoers validation, hardened systemd units, GitHub `production` environment secrets, branch protection, first initialization, `workflow_dispatch`, reboot verification, rollback drill, deploy-key rotation, and diagnostic commands.

Every command must state whether it runs on the MacBook, Oracle shell, or GitHub UI. Never include real IPs, IDs, secrets, spreadsheet IDs, or service-account content.

- [ ] **Step 2: Align existing documentation**

Replace `pnpm scheduler` production guidance with compiled immutable release operation. Explain that scheduler enablement survives MacBook shutdown and VM reboot but external service availability is not guaranteed. Route manual deployment through the locked deployer and manual sync through the shared lock.

Update testing and security docs with Linux visual baselines, deployment suites, account separation, public-log allowlisting, forced-key scope, crash recovery, and credential rotation.

- [ ] **Step 3: Run security and secret scans**

Run repository searches for bcrypt-shaped supplied secrets, private-key headers, real Oracle IPs, the real spreadsheet ID, `StrictHostKeyChecking=no`, unrestricted `sudo`, `pull_request_target`, and journal output in workflow steps. Inspect every match and remove unsafe content.

- [ ] **Step 4: Run complete verification**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:visual
pnpm test:deployment
pnpm build
git diff --check
```

Expected: every static, unit, integration, E2E, visual, deployment, and production build check passes.

- [ ] **Step 5: Perform independent final reviews**

Dispatch a whole-branch code reviewer, security reviewer, documentation reviewer, and CI reviewer. Fix every Critical or Important finding and rerun the covering tests before re-review.

- [ ] **Step 6: Complete the plan ledger and commit**

Mark all task checkboxes complete and commit the plan/docs with message `Document automatic deployment operations`.

- [ ] **Step 7: Push the existing PR branch**

Push `naver-smartstore-car-plate-tracker-mvp`, confirm Draft PR #1 contains all commits, and report the exact one-time Oracle/GitHub steps the user must perform before merging.

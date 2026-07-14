# Duplicate Visibility And Sync Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish every duplicate category in Google Sheets and report current-run versus whole-sheet synchronization counts without ambiguous field names.

**Architecture:** Keep duplicate presentation rules in `operator-view.ts` and let the Google repository translate them into cell formats and group borders. Expand `SyncJobResult` into explicit flat fields, reuse it for CLI and scheduler logs, and map the same values into localized run-log columns.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Playwright, Google Sheets API, Pino, pnpm

## Global Constraints

- Highlight only `차량번호` and `중복 상태`; leave the rest of duplicate rows neutral except existing exception-state cells.
- Use the exact Korean labels and hex colors from the approved design spec.
- Treat duplicate counts as product rows, never as unique vehicle-number group counts.
- Remove old ambiguous result keys rather than preserving aliases.
- Write and run failing regression tests before production changes.
- Do not access the live Naver API from local tests.

---

### Task 1: Duplicate Status Presentation

**Files:**

- Modify: `src/sheets/operator-view.ts`
- Modify: `src/sheets/google-repository.ts`
- Modify: `src/sheets/columns.ts`
- Modify: `tests/unit/operator-view.test.ts`
- Modify: `tests/unit/google-repository.test.ts`
- Modify: `tests/unit/sheets-columns.test.ts`
- Modify: `tests/visual/fixtures/sheets-view.html`
- Modify: `tests/visual/sheets-view.spec.ts-snapshots/sheets-view-darwin.png`
- Modify: `tests/visual/sheets-view.spec.ts-snapshots/sheets-view-dark-darwin.png`

**Interfaces:**

- Produces: `duplicateStatusStyle(status: DuplicateStatus): DuplicateGroupStyle | undefined`
- Produces: three exported status styles with the exact approved colors
- Consumes: sorted `SheetProductRow[]` and `DuplicateGroup` ranges

- [x] **Step 1: Write failing unit tests**

Assert that all three non-unique statuses return different styles, exact colors, and WCAG AA contrast. Assert the exact Korean labels and backward-compatible parsing of existing labels. Assert that Google formatting applies each row's status style to columns 0 and 1 and uses the highest-information status for a mixed group's outer border.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run tests/unit/operator-view.test.ts tests/unit/google-repository.test.ts`

Expected: failures because all duplicate statuses currently return `DUPLICATE_GROUP_STYLE`.

- [x] **Step 3: Implement the approved palette and group borders**

Replace the single duplicate style with status-specific styles and replace the visible labels with the approved labels while continuing to parse legacy Korean labels. Format each row's first two cells from its own `duplicateStatus`. Select the mixed group's border in priority order `duplicated_both`, `duplicated_across_stores`, `duplicated_in_same_store`. Increase the duplicate-status column width to 240 px.

- [x] **Step 4: Update the visual fixture and snapshots**

Show same-store, cross-store, and both duplicate groups with exact labels and colors. Regenerate CSS and snapshots with `pnpm test:visual -- --update-snapshots`.

- [x] **Step 5: Verify GREEN**

Run: `pnpm vitest run tests/unit/operator-view.test.ts tests/unit/google-repository.test.ts && pnpm test:visual`

Expected: all focused unit and visual tests pass.

### Task 2: Explicit Synchronization Summary

**Files:**

- Modify: `src/sync/sync-job.ts`
- Modify: `src/sheets/types.ts`
- Modify: `src/sheets/columns.ts`
- Modify: `src/sheets/google-repository.ts`
- Modify: `tests/integration/sync-job.test.ts`
- Modify: `tests/unit/sheets-columns.test.ts`
- Modify: `tests/unit/google-repository.test.ts`
- Modify: `tests/e2e/mock-sync.cli.spec.ts`

**Interfaces:**

- Produces: explicit `SyncJobResult` fields from the approved design
- Produces: an 11-column localized `RunLogRow`
- Consumes: the current run's selected `StoreConfig[]`, synchronized count, and combined Sheet rows

- [x] **Step 1: Write failing integration, unit, and E2E tests**

Assert full sync and `--store` sync values independently. Parse CLI JSON, verify `syncedProductsThisRun` and `sheetTotalProducts`, and verify `totalProducts`, `successCount`, `failureCount`, and `duplicateCount` are absent. Assert the exact localized run-log headers and appended row.

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run tests/integration/sync-job.test.ts tests/unit/sheets-columns.test.ts tests/unit/google-repository.test.ts && pnpm playwright test tests/e2e/mock-sync.cli.spec.ts`

Expected: failures because current result fields and run-log columns are ambiguous.

- [x] **Step 3: Implement explicit result and run-log mappings**

Return `syncScope`, `selectedStores`, `syncedProductsThisRun`, `sheetTotalProducts`, `sheetExtractionSuccess`, `sheetExtractionFailure`, `sheetDuplicateProductRows`, and `summary`. Populate the localized run log with the same semantics and let the existing repository resize its managed table.

- [x] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/integration/sync-job.test.ts tests/unit/sheets-columns.test.ts tests/unit/google-repository.test.ts && pnpm playwright test tests/e2e/mock-sync.cli.spec.ts`

Expected: focused integration, unit, and E2E tests pass.

### Task 3: Documentation And Full Verification

**Files:**

- Modify: `docs/architecture/google-sheets-layout.md`
- Modify: `docs/operations/live-smoke-test.md`
- Modify: `docs/operations/oracle-cloud-systemd.md`

**Interfaces:**

- Consumes: final duplicate labels, palettes, result keys, and run-log columns from Tasks 1 and 2

- [x] **Step 1: Update operator and deployment documentation**

Document the three status palettes, explain that duplicate counts are product rows, show the new command output, and record that code deployment and scheduler activation remain separate server steps.

- [x] **Step 2: Run full verification**

Run: `pnpm test:all && pnpm build`

Expected: typecheck, lint, formatting, unit, integration, E2E, visual tests, and production build all pass.

- [ ] **Step 3: Review the branch diff and push the existing PR branch**

Verify no secrets or live product data appear in the diff, create atomic commits following repository history, and push `naver-smartstore-car-plate-tracker-mvp`.

# Duplicate Visibility And Sync Summary Design

## Goal

Make the three duplicate meanings visually distinguishable in every operator-facing Google Sheet, and make command output unambiguous about what was synchronized in the current run versus what exists across the whole managed sheet.

## Duplicate Presentation

The first two operator columns remain the only duplicate-highlighted cells so the tables stay restrained. Each duplicate status gets a stable label and low-saturation semantic palette:

| Domain status              | Korean label                   | Background | Text      | Group border |
| -------------------------- | ------------------------------ | ---------- | --------- | ------------ |
| `duplicated_in_same_store` | `같은 스토어 내 중복`          | `#FFF3C4`  | `#5B3A00` | `#B7791F`    |
| `duplicated_across_stores` | `두 스토어 간 중복`            | `#E8F0FE`  | `#174EA6` | `#3B6FC4`    |
| `duplicated_both`          | `같은 스토어 + 두 스토어 중복` | `#FCE8E6`  | `#8A1C1C` | `#C5221F`    |

Rows with the same normalized plate remain adjacent. A medium top and bottom border encloses each plate group. In a cross-store group containing more than one row-level duplicate status, each row keeps its exact status color while the outer border uses the highest-information status in this order: both, across stores, same store.

The duplicate-status column grows from 160 px to 240 px so every Korean label remains readable without depending on truncation. All foreground/background pairs must retain WCAG AA contrast of at least 4.5:1.

## Synchronization Result

`SyncJobResult` must stop exposing the ambiguous keys `totalProducts`, `successCount`, `failureCount`, and `duplicateCount`. It instead exposes:

- `syncScope`: `all_stores` or `selected_stores`
- `selectedStores`: display names of stores requested in this run
- `syncedProductsThisRun`: non-deleted products fetched and written for selected stores in this run
- `sheetTotalProducts`: all preserved and newly synchronized product rows in the managed sheet
- `sheetExtractionSuccess`: rows across the whole sheet with successful plate extraction
- `sheetExtractionFailure`: rows across the whole sheet without successful plate extraction
- `sheetDuplicateProductRows`: rows across the whole sheet whose duplicate status is not unique; this is not a unique vehicle-number group count
- `summary`: concise Korean text that states the current-run scope first and whole-sheet totals second

The CLI and scheduler log the same structure. The developer-facing `실행 기록` tab uses explicit Korean headers for the same values, including separate columns for execution scope, target stores, current-run synchronized products, and whole-sheet totals.

## Compatibility And Migration

This branch has not been merged, so ambiguous result keys are removed instead of retained as aliases. Existing Sheet product data is unchanged. The managed `실행 기록` table is resized to the new header width by the repository's existing table synchronization path on the next successful run.

## Verification

- Unit tests verify three distinct palettes, exact Korean labels, WCAG AA contrast, and status-specific Google Sheets formatting requests.
- Integration tests verify full-store and selected-store result semantics.
- E2E tests parse actual CLI JSON and reject the old ambiguous keys.
- Visual tests show all three duplicate types in light and dark surrounding chrome.
- Typecheck, lint, formatting, build, unit, integration, E2E, and visual suites must pass before pushing.

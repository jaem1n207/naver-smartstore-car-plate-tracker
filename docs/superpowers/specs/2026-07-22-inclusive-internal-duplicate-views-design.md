# Inclusive Internal Duplicate Views Design

## Goal

Make each store-specific internal duplicate tab a complete action queue for duplicate listings inside that store. A listing must not disappear from the internal queue merely because the same normalized vehicle plate also exists in the other store.

## Current Problem

The domain model already distinguishes four row-level states:

- `unique`
- `duplicated_in_same_store`
- `duplicated_across_stores`
- `duplicated_both`

The current store-specific tabs include only `duplicated_in_same_store`. This makes the three duplicate tabs mutually exclusive, but it hides `duplicated_both` rows from the internal queue. For example, when store A has two listings for one plate and store B has one, the two store A listings appear only in the cross-store tab even though resolving the internal duplication is the operator's first priority.

## Decision

Keep the existing duplicate analysis and row-level status values. Change only the membership rules for the derived duplicate views:

- A store-specific internal duplicate tab includes that store's rows whose status is `duplicated_in_same_store` or `duplicated_both`.
- The cross-store duplicate tab continues to include rows whose status is `duplicated_across_stores` or `duplicated_both`.
- A `duplicated_both` row therefore appears intentionally in both its own store's internal duplicate tab and the cross-store duplicate tab.
- Every row preserves its exact duplicate label and status-specific color in every view. A `duplicated_both` row remains labeled `같은 스토어 + 두 스토어 중복` inside an internal tab.

The duplicate tabs are task-oriented projections, not mutually exclusive categories. This deliberate overlap prevents an operator from missing the higher-priority internal action.

## View Membership Matrix

| Plate distribution | Store A internal tab | Store B internal tab | Cross-store tab |
| ------------------ | -------------------- | -------------------- | --------------- |
| A: 2, B: 0         | Two A rows           | None                 | None            |
| A: 2, B: 1         | Two A rows           | None                 | All three rows  |
| A: 1, B: 2         | None                 | Two B rows           | All three rows  |
| A: 2, B: 2         | Two A rows           | Two B rows           | All four rows   |
| A: 1, B: 1         | None                 | None                 | Both rows       |

Deleted products remain excluded from all derived operator views.

## Architecture And Components

Duplicate analysis remains in `src/domain/duplicates/analyze.ts`; it continues to assign one exact status to each product row from normalized plate counts.

View membership becomes a shared Sheets-layer concern. Define reusable pure predicates for:

- a status that represents duplication within the row's own store;
- a status that represents duplication across stores.

Both `GoogleSheetRepository` and `InMemorySheetRepository` use the same predicates. Store A and B filtering remains separate from status membership so each internal tab contains only its own store's actionable rows. Centralizing the status predicates prevents the production and test repositories from silently diverging.

No tab names, column schemas, raw-data values, duplicate labels, status colors, sorting rules, or public synchronization result fields change.

## Data Flow

1. The sync job reads active product rows and recalculates duplicate statuses across the preserved full-sheet dataset.
2. Raw data is written with the existing exact status for every row.
3. Each inventory tab receives all active rows for its store, unchanged.
4. Each internal duplicate tab selects its own store's `duplicated_in_same_store` and `duplicated_both` rows.
5. The cross-store tab selects all `duplicated_across_stores` and `duplicated_both` rows.
6. Existing sorting, grouping, labels, colors, and borders are applied to every derived view.

The next successful synchronization rewrites the derived tabs with the new membership rules. No spreadsheet migration or manual cleanup is required.

## Error Handling

This change introduces no fallback or partial-success behavior. A failure while writing a derived view follows the existing synchronization error path and must not be recorded as a successful completed sync. A later successful sync rewrites the managed views from canonical raw data.

Unknown duplicate statuses continue to fail through the existing strict parsing and exhaustive type handling. The new predicates must not treat an unknown status as actionable.

## Documentation Updates

The implementation must update every current operator-facing or operational document that describes or verifies duplicate view membership:

- `README.md`: replace the mutually exclusive view statement with the task-oriented inclusive rules.
- `docs/architecture/google-sheets-layout.md`: update Duplicate Semantics to describe intentional overlap and the exact membership of each view.
- `docs/operations/live-smoke-test.md`: require verification of an A:2/B:1 or A:1/B:2 case in both the appropriate internal tab and the cross-store tab.

Historical design specifications and completed implementation plans remain unchanged records of earlier decisions. This specification supersedes only their former mutually exclusive view-membership decision.

## Verification

Automated tests must cover the membership matrix through both repository implementations:

- A:2/B:1 includes only the two A rows in the A internal tab and all three rows in the cross-store tab.
- A:1/B:2 includes only the two B rows in the B internal tab and all three rows in the cross-store tab.
- A:2/B:2 includes each store's two rows in its internal tab and all four rows in the cross-store tab.
- A:1/B:1 leaves both internal tabs empty and includes both rows in the cross-store tab.
- Same-store-only duplicates retain their existing behavior.
- Deleted products remain absent from all derived views.
- `duplicated_both` keeps the exact Korean label and approved status-specific styling in an internal tab.
- The Google Sheets and in-memory repositories produce equivalent membership results.

Run the relevant unit and integration suites, then the repository's full typecheck, lint, formatting, build, unit, integration, E2E, and visual verification before shipping.

## Acceptance Criteria

- An operator using a store-specific internal duplicate tab sees every active listing that participates in a duplicate within that store.
- Cross-store context remains available without information loss.
- Rows from the other store do not leak into a store-specific internal tab.
- No schema, tab-name, or migration change is required.
- Current documentation no longer describes the three duplicate views as mutually exclusive after the behavior ships.

## Out Of Scope

- Replacing the three duplicate tabs with a unified management tab.
- Adding a new priority column or workflow state.
- Changing duplicate identity, plate normalization, or row-level status calculation.
- Changing manual-note ownership or operator formatting beyond preserving the existing status presentation.

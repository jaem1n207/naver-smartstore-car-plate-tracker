# Inclusive Internal Duplicate Views Implementation Plan

**Status:** Completed and verified on 2026-07-22.

> **Execution record:** The checked steps below were completed with subagent-driven development and independent review. Final review also added direct Google `DELETE` projection coverage. A separate macOS deployment-test failure was traced to non-canonical `/var/folders/...` fixture roots and fixed by resolving each security-sensitive temporary root before production validation. The final `pnpm test:all` gate passed.

**Goal:** Make every store-specific internal duplicate tab include all active rows duplicated inside that store, including rows that are also duplicated across stores.

**Architecture:** Keep duplicate analysis and the four row-level statuses unchanged. Centralize task-oriented view membership as pure status predicates in `operator-view.ts`, then make both Sheet repository implementations consume those predicates so production and test behavior cannot drift.

**Tech Stack:** Node.js 22, TypeScript 6, Vitest 4, Google Sheets API, Prettier, ESLint, Playwright, pnpm 11

## Global Constraints

- A store-specific internal duplicate tab includes only its own store's rows with `duplicated_in_same_store` or `duplicated_both`.
- The cross-store duplicate tab includes rows with `duplicated_across_stores` or `duplicated_both`.
- Preserve the exact `duplicated_both` label `같은 스토어 + 두 스토어 중복` and its existing style in every view.
- Continue excluding `DELETE` products from all derived views.
- Preserve existing Sheet write error propagation; do not catch or downgrade a failed derived-view write into a successful sync.
- Do not change duplicate analysis, plate normalization, tab names, columns, raw-data values, sorting, colors, borders, synchronization result fields, or manual-note ownership.
- Do not add TypeScript assertions, `@ts-ignore`, or `any`; use existing discriminated unions and typed helpers.
- Write and run failing regression tests before each production behavior change.
- Do not access the live Naver API or production Google Sheet from automated tests.
- Run implementation in an isolated worktree or non-`main` implementation branch when execution begins.

## File Structure

- `src/sheets/operator-view.ts`: own the two pure duplicate-view membership predicates alongside existing operator sorting and presentation rules.
- `src/sheets/in-memory-repository.ts`: consume shared membership predicates for the deterministic test repository.
- `src/sheets/google-repository.ts`: consume the same predicates for production Google Sheets view writes.
- `tests/unit/in-memory-sheet-repository.test.ts`: cover the complete A/B membership matrix and deleted-row regression without network access.
- `tests/unit/google-repository.test.ts`: cover the same membership matrix in emitted Sheet values and verify `duplicated_both` styling on an internal tab.
- `README.md`: describe duplicate tabs as task-oriented projections with deliberate overlap.
- `docs/architecture/google-sheets-layout.md`: define exact current view membership semantics.
- `docs/operations/live-smoke-test.md`: verify an asymmetric A:2/B:1 or A:1/B:2 case after deployment.

## Commit Structure

- 8 implementation files require at least `ceil(8/3) = 3` commits; this plan uses 4.
- Commit 1 contains the shared predicate, its first repository consumer, and the consumer's direct regression test because those three files form one independently testable unit.
- Commit 2 contains the production repository change and its direct unit test.
- Commit 3 updates the two canonical current-behavior descriptions together.
- Commit 4 updates the independently reviewable production smoke procedure.

---

### Task 1: Shared Membership Rules And In-Memory Projection

**Files:**

- Modify: `src/sheets/operator-view.ts:91-149`
- Modify: `src/sheets/in-memory-repository.ts:1-94`
- Test: `tests/unit/in-memory-sheet-repository.test.ts:18-126`

**Interfaces:**

- Consumes: `DuplicateStatus` from `src/domain/duplicates/types.ts`.
- Produces: `hasSameStoreDuplicate(status: DuplicateStatus): boolean`.
- Produces: `hasAcrossStoresDuplicate(status: DuplicateStatus): boolean`.
- Produces: in-memory internal and cross-store views selected from those predicates after the existing `DELETE` filter.

- [x] **Step 1: Replace the mutually exclusive in-memory test with the complete failing membership matrix**

Add the following typed cases after `baseRow` in `tests/unit/in-memory-sheet-repository.test.ts`:

```ts
type DuplicateViewCase = {
  readonly name: string;
  readonly rows: SheetProductRow[];
  readonly storeAInternal: string[];
  readonly storeBInternal: string[];
  readonly crossStore: string[];
};

const DUPLICATE_VIEW_CASES: DuplicateViewCase[] = [
  {
    name: "A:2, B:0",
    rows: [
      duplicateRow("A", "1101", "10가1000", "duplicated_in_same_store"),
      duplicateRow("A", "1102", "10가1000", "duplicated_in_same_store"),
    ],
    storeAInternal: ["1101", "1102"],
    storeBInternal: [],
    crossStore: [],
  },
  {
    name: "A:2, B:1",
    rows: [
      duplicateRow("A", "2102", "20나2000", "duplicated_both"),
      duplicateRow("B", "4101", "20나2000", "duplicated_across_stores"),
      duplicateRow("A", "2101", "20나2000", "duplicated_both"),
    ],
    storeAInternal: ["2101", "2102"],
    storeBInternal: [],
    crossStore: ["2101", "2102", "4101"],
  },
  {
    name: "A:1, B:2",
    rows: [
      duplicateRow("B", "4202", "30다3000", "duplicated_both"),
      duplicateRow("A", "3101", "30다3000", "duplicated_across_stores"),
      duplicateRow("B", "4201", "30다3000", "duplicated_both"),
    ],
    storeAInternal: [],
    storeBInternal: ["4201", "4202"],
    crossStore: ["4201", "4202", "3101"],
  },
  {
    name: "A:2, B:2",
    rows: [
      duplicateRow("B", "4302", "40라4000", "duplicated_both"),
      duplicateRow("A", "5102", "40라4000", "duplicated_both"),
      duplicateRow("B", "4301", "40라4000", "duplicated_both"),
      duplicateRow("A", "5101", "40라4000", "duplicated_both"),
    ],
    storeAInternal: ["5101", "5102"],
    storeBInternal: ["4301", "4302"],
    crossStore: ["5101", "5102", "4301", "4302"],
  },
  {
    name: "A:1, B:1",
    rows: [
      duplicateRow("B", "4401", "50마5000", "duplicated_across_stores"),
      duplicateRow("A", "6101", "50마5000", "duplicated_across_stores"),
    ],
    storeAInternal: [],
    storeBInternal: [],
    crossStore: ["6101", "4401"],
  },
];
```

Replace `keeps store-only and cross-store duplicate views mutually exclusive` with:

```ts
it.each(DUPLICATE_VIEW_CASES)(
  "projects $name duplicate rows into task-oriented views",
  async ({ rows, storeAInternal, storeBInternal, crossStore }) => {
    const repository = new InMemorySheetRepository();

    await repository.writeViews(rows);

    expect(channelProductNumbers(repository.viewRows[A_STORE_DUPLICATES_TAB])).toEqual(
      storeAInternal,
    );
    expect(channelProductNumbers(repository.viewRows[B_STORE_DUPLICATES_TAB])).toEqual(
      storeBInternal,
    );
    expect(channelProductNumbers(repository.viewRows[ACROSS_STORES_DUPLICATES_TAB])).toEqual(
      crossStore,
    );
  },
);
```

Add these helpers near the existing `firstRow` helper:

```ts
function duplicateRow(
  storeKey: SheetProductRow["storeKey"],
  channelProductNo: string,
  normalizedPlate: string,
  duplicateStatus: SheetProductRow["duplicateStatus"],
): SheetProductRow {
  const storeName = storeKey === "A" ? "Store A" : "Store B";
  const storeSlug = storeKey === "A" ? "store-a" : "store-b";

  return {
    ...baseRow,
    storeKey,
    storeName,
    storeBaseUrl: `https://example.com/${storeSlug}`,
    channelProductNo,
    productUrl: `https://example.com/${storeSlug}/products/${channelProductNo}`,
    rawPlate: normalizedPlate,
    normalizedPlate,
    duplicateStatus,
  };
}

function channelProductNumbers(rows: readonly SheetProductRow[] | undefined): string[] {
  return (rows ?? []).map((row) => row.channelProductNo);
}
```

- [x] **Step 2: Run the in-memory regression test to verify RED**

Run:

```bash
pnpm vitest run tests/unit/in-memory-sheet-repository.test.ts
```

Expected: the A:2/B:1, A:1/B:2, and A:2/B:2 cases fail because `duplicated_both` rows are absent from internal duplicate views.

- [x] **Step 3: Add the shared pure membership predicates**

Add these exports after `findDuplicateGroups` in `src/sheets/operator-view.ts`:

```ts
export function hasSameStoreDuplicate(status: DuplicateStatus): boolean {
  return status === "duplicated_in_same_store" || status === "duplicated_both";
}

export function hasAcrossStoresDuplicate(status: DuplicateStatus): boolean {
  return status === "duplicated_across_stores" || status === "duplicated_both";
}
```

They intentionally accept `DuplicateStatus`, not `SheetProductRow`, so status semantics stay independent from store selection.

- [x] **Step 4: Make the in-memory repository consume the shared predicates**

Remove the `DuplicateStatus` type import. Replace the `operator-view.js` import with:

```ts
import {
  hasAcrossStoresDuplicate,
  hasSameStoreDuplicate,
  sortOperatorRows,
} from "./operator-view.js";
```

Replace the three duplicate projections in `writeViews` with:

```ts
[A_STORE_DUPLICATES_TAB]: cloneOperatorRows(
  activeRows.filter(
    (row) => isStoreARow(row) && hasSameStoreDuplicate(row.duplicateStatus),
  ),
),
[B_STORE_DUPLICATES_TAB]: cloneOperatorRows(
  activeRows.filter(
    (row) => isStoreBRow(row) && hasSameStoreDuplicate(row.duplicateStatus),
  ),
),
[ACROSS_STORES_DUPLICATES_TAB]: cloneOperatorRows(
  activeRows.filter((row) => hasAcrossStoresDuplicate(row.duplicateStatus)),
),
```

Delete the local `hasAcrossStoresDuplicate`, `isSameStoreOnlyDuplicate`, and `isDuplicateStatus` functions. Keep `hasExtractionFailure`, `isStoreARow`, and `isStoreBRow` unchanged.

- [x] **Step 5: Run focused tests and typecheck to verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/in-memory-sheet-repository.test.ts tests/unit/operator-view.test.ts
```

Expected: all focused tests pass.

Run:

```bash
pnpm typecheck
```

Expected: TypeScript exits successfully with no unused imports or signature errors.

- [x] **Step 6: Commit the shared membership unit**

```bash
git add src/sheets/operator-view.ts src/sheets/in-memory-repository.ts tests/unit/in-memory-sheet-repository.test.ts
git commit -m "Define duplicate view membership rules"
```

Justification: the shared predicate, its first repository consumer, and the consumer's direct matrix test are inseparable as one independently testable behavior unit.

### Task 2: Google Sheets Projection And Internal Styling Regression

**Files:**

- Modify: `src/sheets/google-repository.ts:7-32,123-146,932-962`
- Test: `tests/unit/google-repository.test.ts:330-805`

**Interfaces:**

- Consumes: `hasSameStoreDuplicate(status: DuplicateStatus): boolean` from Task 1.
- Consumes: `hasAcrossStoresDuplicate(status: DuplicateStatus): boolean` from Task 1.
- Produces: production Sheet values whose internal and cross-store membership matches the in-memory repository exactly.

- [x] **Step 1: Add the complete Google repository membership matrix**

Add the following definitions after `baseRow` in `tests/unit/google-repository.test.ts`:

```ts
type GoogleDuplicateViewCase = {
  readonly name: string;
  readonly rows: SheetProductRow[];
  readonly storeAInternal: string[];
  readonly storeBInternal: string[];
  readonly crossStore: string[];
};

const GOOGLE_DUPLICATE_VIEW_CASES: GoogleDuplicateViewCase[] = [
  {
    name: "A:2, B:0",
    rows: [
      googleDuplicateRow("A", "1101", "10가1000", "duplicated_in_same_store"),
      googleDuplicateRow("A", "1102", "10가1000", "duplicated_in_same_store"),
    ],
    storeAInternal: ["1101", "1102"],
    storeBInternal: [],
    crossStore: [],
  },
  {
    name: "A:2, B:1",
    rows: [
      googleDuplicateRow("A", "2102", "20나2000", "duplicated_both"),
      googleDuplicateRow("B", "4101", "20나2000", "duplicated_across_stores"),
      googleDuplicateRow("A", "2101", "20나2000", "duplicated_both"),
    ],
    storeAInternal: ["2101", "2102"],
    storeBInternal: [],
    crossStore: ["2101", "2102", "4101"],
  },
  {
    name: "A:1, B:2",
    rows: [
      googleDuplicateRow("B", "4202", "30다3000", "duplicated_both"),
      googleDuplicateRow("A", "3101", "30다3000", "duplicated_across_stores"),
      googleDuplicateRow("B", "4201", "30다3000", "duplicated_both"),
    ],
    storeAInternal: [],
    storeBInternal: ["4201", "4202"],
    crossStore: ["4201", "4202", "3101"],
  },
  {
    name: "A:2, B:2",
    rows: [
      googleDuplicateRow("B", "4302", "40라4000", "duplicated_both"),
      googleDuplicateRow("A", "5102", "40라4000", "duplicated_both"),
      googleDuplicateRow("B", "4301", "40라4000", "duplicated_both"),
      googleDuplicateRow("A", "5101", "40라4000", "duplicated_both"),
    ],
    storeAInternal: ["5101", "5102"],
    storeBInternal: ["4301", "4302"],
    crossStore: ["5101", "5102", "4301", "4302"],
  },
  {
    name: "A:1, B:1",
    rows: [
      googleDuplicateRow("B", "4401", "50마5000", "duplicated_across_stores"),
      googleDuplicateRow("A", "6101", "50마5000", "duplicated_across_stores"),
    ],
    storeAInternal: [],
    storeBInternal: [],
    crossStore: ["6101", "4401"],
  },
];
```

Replace `writes mutually exclusive store-only and cross-store duplicate tables` with:

```ts
it.each(GOOGLE_DUPLICATE_VIEW_CASES)(
  "writes $name duplicate rows into task-oriented tables",
  async ({ rows, storeAInternal, storeBInternal, crossStore }) => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews(rows);

    expect(googleapisMock.updateCalls[2]?.requestBody?.values).toEqual(
      expectedOperatorValues(rows, storeAInternal),
    );
    expect(googleapisMock.updateCalls[3]?.requestBody?.values).toEqual(
      expectedOperatorValues(rows, storeBInternal),
    );
    expect(googleapisMock.updateCalls[4]?.requestBody?.values).toEqual(
      expectedOperatorValues(rows, crossStore),
    );
  },
);
```

Add these helpers above `createRepository`:

```ts
function googleDuplicateRow(
  storeKey: SheetProductRow["storeKey"],
  channelProductNo: string,
  normalizedPlate: string,
  duplicateStatus: SheetProductRow["duplicateStatus"],
): SheetProductRow {
  const storeName = storeKey === "A" ? STORE_A_DISPLAY_NAME : STORE_B_DISPLAY_NAME;
  const storeSlug = storeKey === "A" ? "store-east" : "store-west";

  return {
    ...baseRow,
    storeKey,
    storeName,
    storeBaseUrl: `https://example.com/${storeSlug}`,
    channelProductNo,
    productUrl: `https://example.com/${storeSlug}/products/${channelProductNo}`,
    rawPlate: normalizedPlate,
    normalizedPlate,
    duplicateStatus,
  };
}

function expectedOperatorValues(
  rows: readonly SheetProductRow[],
  channelProductNumbers: readonly string[],
): string[][] {
  return [
    OPERATOR_VIEW_HEADERS,
    ...channelProductNumbers.map((channelProductNo) =>
      sheetProductRowToOperatorValues(productRow(rows, channelProductNo)),
    ),
  ];
}

function productRow(rows: readonly SheetProductRow[], channelProductNo: string): SheetProductRow {
  const row = rows.find((candidate) => candidate.channelProductNo === channelProductNo);

  if (row === undefined) {
    throw new Error(`Missing test product row: ${channelProductNo}`);
  }

  return row;
}
```

- [x] **Step 2: Extend the existing formatting regression to the internal tab**

In `formats a realistic mixed group on the across-store duplicate tab`, add this assertion after the existing cross-store formatting assertions:

```ts
const storeAInternalUpdateCellsRequest = requests
  .filter(hasUpdateCellsRequest)
  .find((request) => request.updateCells.start.sheetId === 3);
const storeAInternalFormattedRows = storeAInternalUpdateCellsRequest?.updateCells.rows ?? [];

expect(
  storeAInternalFormattedRows.map((row) =>
    [0, 1].map((columnIndex) => row.values?.[columnIndex]?.userEnteredFormat?.backgroundColorStyle),
  ),
).toEqual([
  [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
  [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
  [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
  [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
]);
```

This verifies that `duplicated_both` keeps its approved red palette inside an internal duplicate tab while same-store-only rows keep amber.

- [x] **Step 3: Run the Google repository test to verify RED**

Run:

```bash
pnpm vitest run tests/unit/google-repository.test.ts
```

Expected: asymmetric and A:2/B:2 matrix cases fail because internal tables omit `duplicated_both`; the new sheet 3 formatting assertion also sees only same-store-only rows.

- [x] **Step 4: Make the Google repository consume the shared predicates**

Remove the `DuplicateStatus` type import. Add `hasAcrossStoresDuplicate` and `hasSameStoreDuplicate` to the existing `operator-view.js` import:

```ts
import {
  displayStatusStyle,
  duplicateStatusStyle,
  findDuplicateGroups,
  hasAcrossStoresDuplicate,
  hasSameStoreDuplicate,
  productStatusStyle,
  SHEET_HEADER_STYLE,
  sortOperatorRows,
} from "./operator-view.js";
```

Replace the three duplicate view writes with:

```ts
await this.replaceOperatorSheet(
  this.tabNames.storeADuplicates,
  activeRows.filter((row) => isStoreARow(row) && hasSameStoreDuplicate(row.duplicateStatus)),
);
await this.replaceOperatorSheet(
  this.tabNames.storeBDuplicates,
  activeRows.filter((row) => isStoreBRow(row) && hasSameStoreDuplicate(row.duplicateStatus)),
);
await this.replaceOperatorSheet(
  this.tabNames.acrossStoresDuplicates,
  activeRows.filter((row) => hasAcrossStoresDuplicate(row.duplicateStatus)),
);
```

Delete the local `hasAcrossStoresDuplicate`, `isSameStoreOnlyDuplicate`, and `isDuplicateStatus` functions. Keep active-product, store, and extraction-failure predicates unchanged.

- [x] **Step 5: Run repository parity and focused verification**

Run:

```bash
pnpm vitest run tests/unit/in-memory-sheet-repository.test.ts tests/unit/google-repository.test.ts tests/unit/operator-view.test.ts tests/unit/sheets-columns.test.ts
```

Expected: all focused unit tests pass, including exact Korean value serialization and internal-tab formatting.

Run:

```bash
pnpm typecheck
```

Expected: TypeScript exits successfully.

- [x] **Step 6: Commit the production projection**

```bash
git add src/sheets/google-repository.ts tests/unit/google-repository.test.ts
git commit -m "Apply inclusive duplicate views to Google Sheets"
```

### Task 3: Canonical Behavior Documentation

**Files:**

- Modify: `README.md:59-73`
- Modify: `docs/architecture/google-sheets-layout.md:100-108`

**Interfaces:**

- Consumes: the final view membership rules implemented in Tasks 1 and 2.
- Produces: canonical user and architecture descriptions that no longer claim the duplicate tabs are mutually exclusive.

- [x] **Step 1: Update the README's operator-tab contract**

Replace the mutually exclusive sentence after the operator column description with:

```markdown
The duplicate tabs are task-oriented views and intentionally overlap. Each store-specific internal duplicate tab contains that store's rows marked `같은 스토어 내 중복` or `같은 스토어 + 두 스토어 중복`; the cross-store tab contains rows marked `두 스토어 간 중복` or `같은 스토어 + 두 스토어 중복`. A row duplicated both ways therefore appears in its own store's internal action queue and in the cross-store view.
```

- [x] **Step 2: Update the architecture's Duplicate Semantics section**

Replace the paragraph after the three status definitions with these exact paragraphs:

```markdown
The two inventory tabs may contain rows with any of these statuses. Each store-specific internal duplicate tab contains only that store's rows whose status is `duplicated_in_same_store` or `duplicated_both`. The cross-store duplicate tab contains all rows whose status is `duplicated_across_stores` or `duplicated_both`.

The duplicate tabs are task-oriented projections rather than mutually exclusive categories. A `duplicated_both` row appears intentionally in both its own store's internal duplicate tab and the cross-store tab, preserving the exact `같은 스토어 + 두 스토어 중복` label and style in both places. For an A:2/B:1 plate, the two A rows appear in the A internal tab, no row appears in the B internal tab, and all three rows appear in the cross-store tab.

`sheetDuplicateProductRows` deliberately counts every non-unique product row, so two products sharing one plate contribute two rows even though they form one plate group.

The next successful synchronization rewrites the derived duplicate tabs with these membership rules. No spreadsheet migration or manual cleanup is required.
```

- [x] **Step 3: Verify current behavior documentation and formatting**

Run:

```bash
rg -n "mutually exclusive" README.md docs/architecture tests
```

Expected: no matches and exit status 1. Historical specs and completed plans are intentionally outside this current-contract scan.

Run:

```bash
pnpm exec prettier README.md docs/architecture/google-sheets-layout.md --check
```

Expected: both files use Prettier code style.

- [x] **Step 4: Commit the canonical descriptions**

```bash
git add README.md docs/architecture/google-sheets-layout.md
git commit -m "Document inclusive duplicate view semantics"
```

Justification: README and the Sheets architecture document are the two canonical current-behavior descriptions and must agree in the same commit.

### Task 4: Operational Verification And Full Quality Gate

**Files:**

- Modify: `docs/operations/live-smoke-test.md:13-29`

**Interfaces:**

- Consumes: the shipped view membership and styling behavior from Tasks 1 and 2.
- Produces: an explicit live verification step for the asymmetric duplicate case that originally exposed the operator confusion.

- [x] **Step 1: Strengthen the duplicate-view smoke check**

Replace sequence item 13 with:

```markdown
13. Confirm a known asymmetric duplicate case: for a normalized plate with two active listings in one store and one in the other, the two same-store listings appear in that store's internal duplicate tab, the other store's internal duplicate tab has no row for that plate, and all three listings appear in the cross-store duplicate tab. Confirm the two internally duplicated rows retain `같은 스토어 + 두 스토어 중복` in both views.
```

- [x] **Step 2: Run documentation checks**

Run:

```bash
pnpm exec prettier docs/operations/live-smoke-test.md --check
```

Expected: the smoke-test document uses Prettier code style.

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [x] **Step 3: Run the complete repository verification gate**

Run:

```bash
pnpm test:all
```

Expected: typecheck, ESLint, Prettier, unit, integration, deployment, E2E, and visual suites all pass. No command may contact the live Naver API or production Google Sheet.

- [x] **Step 4: Audit the final diff against the approved design**

Run:

```bash
git diff --stat HEAD~3
```

Expected before the final documentation commit: exactly the planned source, test, and current-document files are present; no tab schema, status label, color, sorting, sync-result, or plate-analysis file is modified.

Run:

```bash
git status --short
```

Expected before the final documentation commit: only `docs/operations/live-smoke-test.md` is modified.

- [x] **Step 5: Commit the live verification procedure**

```bash
git add docs/operations/live-smoke-test.md
git commit -m "Update duplicate view smoke verification"
```

- [x] **Step 6: Verify the final history and clean worktree**

Run:

```bash
git status --short --branch
```

Expected: the implementation branch is clean.

Run:

```bash
git log -5 --oneline
```

Expected: the four implementation commits appear after the approved design commit in dependency order:

```text
Update duplicate view smoke verification
Document inclusive duplicate view semantics
Apply inclusive duplicate views to Google Sheets
Define duplicate view membership rules
Document inclusive internal duplicate views
```

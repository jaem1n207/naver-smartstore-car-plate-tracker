# Bestbridge Display Name Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change Store B's displayed label from `트럭판매왕 화물특장 (truckhub)` to `베스트브릿지 (truckhub)` while renaming the existing managed Google Sheets tabs in place and preserving every sheet ID, table ID, row, and operator note.

**Architecture:** Treat each fixed `SheetTabDefinition.tableName` as the stable identity of a managed tab and treat the human-readable tab title as mutable configuration. A pure migration planner will resolve current titles, stable managed-table identities, and legacy titles before any Sheets value write; `GoogleSheetRepository` will execute only the resulting rename/add actions, refetch metadata, and continue using the existing table IDs. Conflicting title/table ownership fails closed during `prepareRunLog()` or the first repository initialization, before Naver reads or Sheet value writes.

**Tech Stack:** Node.js 22.23.1, TypeScript 6 with strict NodeNext, pnpm 11.10.0, Vitest 4, Google Sheets API v4 through `googleapis`

**Spec:** `docs/architecture/google-sheets-layout.md`; `docs/architecture/system-overview.md`

## Global Constraints

- Preserve the current data contract: all registered non-`DELETE` products remain included.
- Preserve `storeKey + channelProductNo` as product identity; the display name must not affect row matching.
- The exact new Store B display label is `베스트브릿지 (truckhub)`.
- Reuse existing sheets and native tables by `sheetId` and `tableId`; do not create replacement tabs for a display-name-only change.
- Respect Google Sheets' spreadsheet-wide table-name uniqueness contract: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets
- Preserve unknown tabs unchanged.
- Fail before `spreadsheets.values.get`, `spreadsheets.values.update`, or Naver API calls when a desired title conflicts with a managed table on another sheet.
- Keep legacy generic Korean and English tab migration behavior.
- Use two-space indentation, double quotes, semicolons, trailing commas, and 100-character width.
- Use `.js` in relative TypeScript imports and `import type` for type-only imports.
- Do not use `any`, non-null assertions, type assertions, `@ts-ignore`, or boolean function parameters.
- Automated tests must use mocked Google APIs and must not access the live Naver API or production Sheet.
- Use focused Vitest tests during RED/GREEN; do not run Playwright, E2E, visual tests, or a browser for this change.
- Do not edit the protected production environment until the code is merged, deployed, and a separate production-write approval is given.
- Never print `/etc/naver-smartstore-car-plate-tracker/app.env`, credentials, spreadsheet IDs, or raw product exports.
- Product-search completeness guards and automatic public SmartStore-name discovery are independent work and are out of scope.

---

## File Structure

- Create `src/sheets/tab-migration.ts`: pure managed-tab identity resolution and fail-closed migration planning.
- Create `tests/unit/tab-migration.test.ts`: focused unit coverage for display-name renames and conflicts.
- Modify `src/sheets/google-repository.ts`: translate Google metadata to the pure planner and execute its rename/add actions.
- Modify `tests/unit/google-repository.test.ts`: prove old configured-name tabs are renamed in place and their table IDs are reused.
- Modify `docs/architecture/google-sheets-layout.md`: define stable table identity and mutable tab-title behavior.
- Modify `docs/architecture/system-overview.md`: record initialization and failure-order guarantees.
- Modify `docs/operations/google-service-account.md`: document the configuration boundary for `STORE_*_NAME`.
- Modify `docs/operations/live-smoke-test.md`: add post-deploy display-name migration checks.

---

### Task 1: Plan Tab Renames From Stable Table Identity

**Files:**

- Create: `src/sheets/tab-migration.ts`
- Create: `tests/unit/tab-migration.test.ts`

**Interfaces:**

- Consumes: `SheetTabDefinition` from `src/sheets/columns.ts`
- Produces:
  - `SheetTableMetadata`
  - `SheetTabMetadata`
  - `TabMigrationAction`
  - `planTabMigrations(definitions, sheets): readonly TabMigrationAction[]`

- [ ] **Step 1: Write the failing migration-planner tests**

Create `tests/unit/tab-migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createManagedSheetTabs, type ManagedSheetTabs } from "../../src/sheets/columns.js";
import { planTabMigrations, type SheetTabMetadata } from "../../src/sheets/tab-migration.js";

const STORE_A_DISPLAY_NAME = "최트럭 (truck-king)";
const OLD_STORE_B_DISPLAY_NAME = "트럭판매왕 화물특장 (truckhub)";
const NEW_STORE_B_DISPLAY_NAME = "베스트브릿지 (truckhub)";

describe("planTabMigrations", () => {
  it("renames display-dependent tabs by stable managed table name", () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);

    expect(planTabMigrations(newTabs.definitions, managedSheets(oldTabs))).toEqual([
      {
        kind: "rename",
        sheetId: 2,
        title: newTabs.names.storeBView,
      },
      {
        kind: "rename",
        sheetId: 4,
        title: newTabs.names.storeBDuplicates,
      },
      {
        kind: "rename",
        sheetId: 5,
        title: newTabs.names.acrossStoresDuplicates,
      },
    ]);
  });

  it("fails when a desired title and its managed table belong to different sheets", () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const occupiedTitle: SheetTabMetadata = {
      sheetId: 99,
      title: newTabs.names.storeBView,
      tables: [],
    };

    expect(() =>
      planTabMigrations(newTabs.definitions, [...managedSheets(oldTabs), occupiedTitle]),
    ).toThrow(
      '관리 탭 제목 충돌: "베스트브릿지 (truckhub) 매물" 탭과 ' +
        '"managed_store_b_inventory" 테이블이 서로 다른 시트에 있습니다',
    );
  });

  it("fails when a managed table has moved away from A1", () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const sheets = managedSheets(oldTabs).map((sheet) =>
      sheet.sheetId === 2
        ? {
            ...sheet,
            tables: sheet.tables.map((table) => ({
              ...table,
              startRowIndex: 1,
            })),
          }
        : sheet,
    );

    expect(() => planTabMigrations(newTabs.definitions, sheets)).toThrow(
      '관리 테이블이 A1에서 시작하지 않습니다: "managed_store_b_inventory"',
    );
  });
});

function managedSheets(tabs: ManagedSheetTabs): SheetTabMetadata[] {
  return tabs.definitions.map((definition, index) => ({
    sheetId: index + 1,
    title: definition.title,
    tables: [
      {
        tableId: `managed-table-${String(index + 1)}`,
        name: definition.tableName,
        startRowIndex: 0,
        startColumnIndex: 0,
      },
    ],
  }));
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm vitest run tests/unit/tab-migration.test.ts
```

Expected: FAIL because `src/sheets/tab-migration.ts` does not exist.

- [ ] **Step 3: Add the minimal pure migration planner**

Create `src/sheets/tab-migration.ts`:

```ts
import type { SheetTabDefinition } from "./columns.js";

export interface SheetTableMetadata {
  readonly tableId: string;
  readonly name: string;
  readonly startRowIndex: number;
  readonly startColumnIndex: number;
}

export interface SheetTabMetadata {
  readonly sheetId: number;
  readonly title: string;
  readonly tables: readonly SheetTableMetadata[];
}

export type TabMigrationAction =
  | {
      readonly kind: "rename";
      readonly sheetId: number;
      readonly title: string;
    }
  | {
      readonly kind: "add";
      readonly title: string;
      readonly columnCount: number;
    };

export function planTabMigrations(
  definitions: readonly SheetTabDefinition[],
  sheets: readonly SheetTabMetadata[],
): readonly TabMigrationAction[] {
  const sheetsByTitle = new Map<string, SheetTabMetadata>();
  const sheetsByTableName = collectManagedTables(definitions, sheets);
  const actions: TabMigrationAction[] = [];

  for (const sheet of sheets) {
    sheetsByTitle.set(sheet.title, sheet);
  }

  for (const definition of definitions) {
    const titledSheet = sheetsByTitle.get(definition.title);
    const tableSheet = sheetsByTableName.get(definition.tableName);

    if (
      titledSheet !== undefined &&
      tableSheet !== undefined &&
      titledSheet.sheetId !== tableSheet.sheetId
    ) {
      throw new Error(
        `관리 탭 제목 충돌: "${definition.title}" 탭과 ` +
          `"${definition.tableName}" 테이블이 서로 다른 시트에 있습니다`,
      );
    }

    if (titledSheet !== undefined) {
      continue;
    }

    if (tableSheet !== undefined) {
      actions.push({
        kind: "rename",
        sheetId: tableSheet.sheetId,
        title: definition.title,
      });
      continue;
    }

    const legacySheet = firstLegacySheet(definition, sheetsByTitle);

    if (legacySheet !== undefined) {
      actions.push({
        kind: "rename",
        sheetId: legacySheet.sheetId,
        title: definition.title,
      });
      continue;
    }

    actions.push({
      kind: "add",
      title: definition.title,
      columnCount: definition.columnCount,
    });
  }

  return actions;
}

function collectManagedTables(
  definitions: readonly SheetTabDefinition[],
  sheets: readonly SheetTabMetadata[],
): Map<string, SheetTabMetadata> {
  const managedNames = new Set(definitions.map((definition) => definition.tableName));
  const sheetsByTableName = new Map<string, SheetTabMetadata>();

  for (const sheet of sheets) {
    for (const table of sheet.tables) {
      if (!managedNames.has(table.name)) {
        continue;
      }

      if (table.startRowIndex !== 0 || table.startColumnIndex !== 0) {
        throw new Error(`관리 테이블이 A1에서 시작하지 않습니다: "${table.name}"`);
      }

      const existingSheet = sheetsByTableName.get(table.name);

      if (existingSheet !== undefined && existingSheet.sheetId !== sheet.sheetId) {
        throw new Error(`관리 테이블 이름이 중복되었습니다: "${table.name}"`);
      }

      sheetsByTableName.set(table.name, sheet);
    }
  }

  return sheetsByTableName;
}

function firstLegacySheet(
  definition: SheetTabDefinition,
  sheetsByTitle: ReadonlyMap<string, SheetTabMetadata>,
): SheetTabMetadata | undefined {
  for (const legacyTitle of definition.legacyTitles) {
    const sheet = sheetsByTitle.get(legacyTitle);

    if (sheet !== undefined) {
      return sheet;
    }
  }

  return undefined;
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
pnpm vitest run tests/unit/tab-migration.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit the pure planner**

```bash
git add src/sheets/tab-migration.ts tests/unit/tab-migration.test.ts
git commit -m "Resolve managed tabs by stable table identity"
```

---

### Task 2: Integrate Stable Identity Into GoogleSheetRepository

**Files:**

- Modify: `src/sheets/google-repository.ts:1-14`
- Modify: `src/sheets/google-repository.ts:230-312`
- Modify: `src/sheets/google-repository.ts:405-418`
- Modify: `tests/unit/google-repository.test.ts:1-14`
- Modify: `tests/unit/google-repository.test.ts:420-500`
- Modify: `tests/unit/google-repository.test.ts:1437-1507`

**Interfaces:**

- Consumes:
  - `planTabMigrations(definitions, sheets): readonly TabMigrationAction[]`
  - `SheetTabMetadata`
  - `TabMigrationAction`
- Produces:
  - `sheetMetadataForMigration(sheets): SheetTabMetadata[]`
  - `tabMigrationRequest(action): sheets_v4.Schema$Request`
  - Existing `GoogleSheetRepository` API remains unchanged.

- [ ] **Step 1: Add the failing repository-level rename and conflict tests**

Add these constants below the existing display-name constants in
`tests/unit/google-repository.test.ts`:

```ts
const OLD_STORE_B_DISPLAY_NAME = "트럭판매왕 화물특장 (truckhub)";
const NEW_STORE_B_DISPLAY_NAME = "베스트브릿지 (truckhub)";
```

Add the following tests beside the existing legacy-tab migration tests:

```ts
it("renames configured store tabs and reuses their native tables", async () => {
  const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
  const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
  googleapisMock.queueSpreadsheetSheets(sheetsForManagedTabs(oldTabs));
  googleapisMock.queueSpreadsheetSheets(sheetsForManagedTabs(newTabs));

  for (let index = 0; index < 6; index += 1) {
    googleapisMock.queueGetValues([]);
  }

  const repository = await createRepository({
    storeBDisplayName: NEW_STORE_B_DISPLAY_NAME,
  });

  await repository.writeViews([baseRow]);

  const bootstrapRequests = googleapisMock.batchUpdateCalls[0]?.requestBody?.requests ?? [];
  expect(bootstrapRequests).toEqual([
    {
      updateSheetProperties: {
        properties: {
          sheetId: 2,
          title: newTabs.names.storeBView,
        },
        fields: "title",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId: 4,
          title: newTabs.names.storeBDuplicates,
        },
        fields: "title",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId: 5,
          title: newTabs.names.acrossStoresDuplicates,
        },
        fields: "title",
      },
    },
  ]);

  const allRequests = googleapisMock.batchUpdateCalls.flatMap(
    (call) => call.requestBody?.requests ?? [],
  );
  expect(allRequests.filter(hasAddTableRequest)).toEqual([]);
  expect(
    allRequests.filter(hasUpdateTableRequest).map((request) => request.updateTable.table.tableId),
  ).toEqual(expect.arrayContaining(["managed-table-2", "managed-table-4", "managed-table-5"]));
});

it("fails before value access when the new title is already occupied", async () => {
  const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
  const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
  googleapisMock.queueSpreadsheetSheets([
    ...sheetsForManagedTabs(oldTabs),
    sheetMetadata(99, newTabs.names.storeBView, 8, 12),
  ]);
  const repository = await createRepository({
    storeBDisplayName: NEW_STORE_B_DISPLAY_NAME,
  });

  await expect(repository.readRawData()).rejects.toThrow(
    '관리 탭 제목 충돌: "베스트브릿지 (truckhub) 매물" 탭과 ' +
      '"managed_store_b_inventory" 테이블이 서로 다른 시트에 있습니다',
  );

  expect(googleapisMock.batchUpdateCalls).toEqual([]);
  expect(googleapisMock.valuesGetCalls).toEqual([]);
});
```

Update the type import from `src/sheets/columns.ts`:

```ts
import type { ManagedSheetTabs, SheetTabDefinition } from "../../src/sheets/columns.js";
```

Add this fixture helper above `localizedSheetsWithStoreATable()`:

```ts
function sheetsForManagedTabs(
  tabs: ManagedSheetTabs,
): NonNullable<SpreadsheetResponse["data"]["sheets"]> {
  return tabs.definitions.map((definition, index) => ({
    ...sheetMetadata(index + 1, definition.title, index, definition.columnCount),
    tables: [
      {
        tableId: `managed-table-${String(index + 1)}`,
        name: definition.tableName,
        range: {
          sheetId: index + 1,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: definition.columnCount,
        },
      },
    ],
  }));
}
```

- [ ] **Step 2: Run only the two new repository tests and confirm RED**

Run:

```bash
pnpm vitest run tests/unit/google-repository.test.ts \
  -t "renames configured store tabs|fails before value access"
```

Expected:

- The rename test fails because the repository adds new sheets instead of resolving old tabs by
  `tableName`.
- The conflict test fails because the repository accepts the occupied desired title.

- [ ] **Step 3: Translate Google metadata to the pure planner**

Add these imports to `src/sheets/google-repository.ts`:

```ts
import {
  planTabMigrations,
  type SheetTabMetadata,
  type TabMigrationAction,
} from "./tab-migration.js";
```

Replace the bootstrap loop in `initializeTabs()` with:

```ts
const bootstrapRequests = planTabMigrations(
  this.tabDefinitions,
  sheetMetadataForMigration(initialSheets),
).map(tabMigrationRequest);
```

Keep the existing conditional `batchUpdate`, metadata refetch, metadata capture, and layout update
after this replacement.

Add these helpers near `renameSheetRequest()` and `addSheetRequest()`:

```ts
function sheetMetadataForMigration(sheets: readonly sheets_v4.Schema$Sheet[]): SheetTabMetadata[] {
  const metadata: SheetTabMetadata[] = [];

  for (const sheet of sheets) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title;

    if (typeof sheetId !== "number" || typeof title !== "string") {
      continue;
    }

    const tables = (sheet.tables ?? []).flatMap((table) => {
      if (typeof table.tableId !== "string" || typeof table.name !== "string") {
        return [];
      }

      return [
        {
          tableId: table.tableId,
          name: table.name,
          startRowIndex: table.range?.startRowIndex ?? 0,
          startColumnIndex: table.range?.startColumnIndex ?? 0,
        },
      ];
    });

    metadata.push({
      sheetId,
      title,
      tables,
    });
  }

  return metadata;
}

function tabMigrationRequest(action: TabMigrationAction): sheets_v4.Schema$Request {
  switch (action.kind) {
    case "rename":
      return renameSheetRequest(action.sheetId, action.title);
    case "add":
      return addSheetRequest(action.title, action.columnCount);
  }
}
```

Delete `firstExistingSheetId()` because the pure planner now owns legacy-title resolution.

- [ ] **Step 4: Run the new repository tests and confirm GREEN**

Run:

```bash
pnpm vitest run tests/unit/google-repository.test.ts \
  -t "renames configured store tabs|fails before value access"
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Run all affected Sheet unit tests**

Run:

```bash
pnpm vitest run tests/unit/tab-migration.test.ts tests/unit/google-repository.test.ts
```

Expected: both files pass. Existing generic Korean/English migrations, missing-tab creation, unknown
tab preservation, manual-table reuse, run-log migration, and formatting tests remain green.

- [ ] **Step 6: Commit the repository integration**

```bash
git add src/sheets/google-repository.ts tests/unit/google-repository.test.ts
git commit -m "Reuse managed tables after store renames"
```

---

### Task 3: Document Stable Managed-Tab Identity

**Files:**

- Modify: `docs/architecture/google-sheets-layout.md:116-126`
- Modify: `docs/architecture/system-overview.md:13-17`

**Interfaces:**

- Consumes: the `tableName`-based migration contract implemented in Tasks 1-2
- Produces: the architecture invariant used by future Sheet and migration changes

- [ ] **Step 1: Update the native-table migration contract**

Replace the opening bullets under `## Native Tables And Migration` in
`docs/architecture/google-sheets-layout.md` with:

```markdown
Every managed range uses the Google Sheets native table feature. The fixed managed table name is
the stable identity; the human-readable tab title may change when a configured store display name
changes. During sync:

- A tab already using the current configured title remains in place.
- If the current title is absent but the fixed managed table name exists, that table's sheet is
  renamed in place. Its `sheetId`, `tableId`, values, notes, and formatting are preserved.
- Legacy generic Korean and English titles remain fallback migration candidates when no stable
  managed table is present.
- A current title and its stable managed table on different sheets is a configuration conflict.
  Initialization stops before any Sheet value write.
- A table beginning at A1 is reused by its `tableId` and resized.
- A missing table is created only when neither a current tab, stable managed table, nor legacy tab
  exists.
- Unknown tabs without a managed table identity are preserved.
```

Keep the existing bullets for empty views, stale columns, formatting cleanup, and run-log migration.

- [ ] **Step 2: Update the system initialization summary**

Replace the managed-tab initialization paragraph in `docs/architecture/system-overview.md` with:

```markdown
Each repository instance initializes the sheet structure once. Managed native table names are
stable identities, while configured store display names determine mutable tab titles. A display
name change renames the sheet containing the matching managed table instead of creating a new tab.
Previous `A스토어 매물`, `B스토어 매물`, `스토어 내부 중복`, and legacy English tabs remain
fallback migration candidates. Unknown tabs are preserved. If a desired title and its managed
table belong to different sheets, initialization fails before Naver reads or Sheet value writes.
```

- [ ] **Step 3: Check the two architecture files**

Run:

```bash
pnpm exec prettier docs/architecture/google-sheets-layout.md \
  docs/architecture/system-overview.md --check
```

Expected: both files pass Prettier.

- [ ] **Step 4: Commit the architecture contract**

```bash
git add docs/architecture/google-sheets-layout.md docs/architecture/system-overview.md
git commit -m "Define stable managed tab identity"
```

---

### Task 4: Document Configuration And Live Verification

**Files:**

- Modify: `docs/operations/google-service-account.md:112-118`
- Modify: `docs/operations/live-smoke-test.md:13-30`

**Interfaces:**

- Consumes: stable managed-tab identity and fail-closed conflicts from Tasks 1-3
- Produces: operator instructions for changing `STORE_*_NAME` and verifying a live rename

- [ ] **Step 1: Document the protected display-name change boundary**

Add this paragraph after the display-label explanation in
`docs/operations/google-service-account.md`:

```markdown
`STORE_A_NAME` and `STORE_B_NAME` are mutable display configuration, not store identity. Before
changing either value in the protected production environment, deploy a release that supports
stable managed-table migration. The next successful full sync must rename the affected inventory,
internal-duplicate, and cross-store tabs in place while preserving their sheet and table IDs. Do
not delete old tabs or copy rows manually.
```

- [ ] **Step 2: Add a display-name migration smoke subsection**

Insert this subsection after the main sequence in `docs/operations/live-smoke-test.md`:

```markdown
## Store display-name migration

For a deliberate `STORE_A_NAME` or `STORE_B_NAME` change:

1. Before editing the protected environment, record the affected inventory, internal-duplicate,
   and cross-store tab titles, `sheetId` values, native `tableId` values, and current product-row
   count.
2. Confirm the deployed release contains stable managed-table migration before changing the name.
3. Change only the intended `STORE_*_NAME`; keep `STORE_*_BASE_URL`, store key, Naver credentials,
   and spreadsheet ID unchanged.
4. Run one deliberate full sync with the scheduler stopped through the documented transient-unit
   procedure.
5. Confirm the three affected tabs use the new configured display name and the old titles are
   absent.
6. Confirm every recorded `sheetId` and `tableId` is unchanged, the inventory product IDs are
   unchanged, and the current product-row count matches the pre-change count.
7. Confirm the latest run-log row uses the new display name and the service resumes with no
   `scheduled sync failed` record.
8. On any conflict or sync failure, restore the protected environment backup before restarting the
   scheduler. Do not delete, merge, or manually copy managed tabs.
```

- [ ] **Step 3: Check the two operations files**

Run:

```bash
pnpm exec prettier docs/operations/google-service-account.md \
  docs/operations/live-smoke-test.md --check
```

Expected: both files pass Prettier.

- [ ] **Step 4: Commit the operations guidance**

```bash
git add docs/operations/google-service-account.md docs/operations/live-smoke-test.md
git commit -m "Document store display name migration"
```

---

### Task 5: Run The Proportional Repository Gate

**Files:**

- Verify only; no file changes expected

**Interfaces:**

- Consumes: all code, tests, and documentation from Tasks 1-4
- Produces: fresh evidence that the focused behavior and repository static contracts pass

- [ ] **Step 1: Run the pure migration tests**

```bash
pnpm vitest run tests/unit/tab-migration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the Google repository tests**

```bash
pnpm vitest run tests/unit/google-repository.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript validation**

```bash
pnpm typecheck
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 4: Run lint**

```bash
pnpm lint
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 5: Run formatting validation**

```bash
pnpm format:check
```

Expected: exit 0.

- [ ] **Step 6: Review the final diff and commit boundaries**

```bash
git diff --check
git status --short
git log -4 --oneline
```

Expected:

- `git diff --check` exits 0.
- `git status --short` is empty.
- Four focused commits exist in dependency order:
  1. `Resolve managed tabs by stable table identity`
  2. `Reuse managed tables after store renames`
  3. `Define stable managed tab identity`
  4. `Document store display name migration`

Do not run Playwright, E2E, visual tests, or a live API as part of this local gate.

---

### Task 6: Deploy Then Change The Production Display Name

**Files:**

- External protected configuration: `/etc/naver-smartstore-car-plate-tracker/app.env`
- Temporary root-only backup: `/root/carplate-store-name-before-bestbridge.env`
- No repository file changes

**Interfaces:**

- Consumes:
  - A merged and deployed release containing Tasks 1-5
  - Current Store B baseline: 294 product rows, 283 `PROHIBITION`, 11 `SALE`
  - Current old label: `트럭판매왕 화물특장 (truckhub)`
- Produces:
  - New label: `베스트브릿지 (truckhub)`
  - Existing three affected `sheetId` and `tableId` values preserved

This task changes production. Stop here until the user explicitly approves the production write
after the code release is deployed.

- [ ] **Step 1: Confirm the deployed release and current service health**

Run on Oracle:

```bash
sudo systemctl is-active --quiet car-plate-tracker.service
sudo test "$(sudo cat /var/lib/naver-smartstore-car-plate-tracker/deployment/deployed-sha)" = \
  "$(sudo sed -n 's/^APP_REVISION=//p' \
    /opt/naver-smartstore-car-plate-tracker/current/release.env)"
sudo journalctl -u car-plate-tracker.service -n 20 --no-pager --output=cat
```

Expected:

- Service is active.
- Deployed SHA equals the current release revision containing Tasks 1-5.
- Recent records contain `scheduled sync completed` and no unresolved `scheduled sync failed`.

- [ ] **Step 2: Capture pre-change managed table metadata**

Run on Oracle:

```bash
sudo install -m 0600 -o carplate -g carplate /dev/null /tmp/carplate-audit-tabs.mjs
sudo -u carplate tee /tmp/carplate-audit-tabs.mjs >/dev/null <<'NODE'
import {
  auth as googleAuth,
  sheets as createSheetsClient,
} from "googleapis/build/src/apis/sheets/index.js";

const authOptions = {
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
};

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  authOptions.keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
  authOptions.credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8"),
  );
} else {
  throw new Error("Google credential source is missing");
}

const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

if (!spreadsheetId) {
  throw new Error("Spreadsheet ID is missing");
}

const sheets = createSheetsClient({
  version: "v4",
  auth: new googleAuth.GoogleAuth(authOptions),
});
const response = await sheets.spreadsheets.get({
  spreadsheetId,
  fields: "sheets(properties(sheetId,title),tables(tableId,name,range))",
});
const managed = {};

for (const sheet of response.data.sheets ?? []) {
  const sheetId = sheet.properties?.sheetId;
  const title = sheet.properties?.title;

  if (typeof sheetId !== "number" || typeof title !== "string") {
    continue;
  }

  for (const table of sheet.tables ?? []) {
    if (
      typeof table.name !== "string" ||
      typeof table.tableId !== "string" ||
      !table.name.startsWith("managed_")
    ) {
      continue;
    }

    managed[table.name] = {
      sheetId,
      tableId: table.tableId,
      title,
      endRowIndex: table.range?.endRowIndex ?? null,
    };
  }
}

const sortedManaged = Object.fromEntries(
  Object.entries(managed).sort(([left], [right]) => left.localeCompare(right)),
);

console.log(JSON.stringify(sortedManaged, null, 2));
NODE

sudo -u carplate sh -c \
  'cd /opt/naver-smartstore-car-plate-tracker/current &&
   exec node --env-file=/etc/naver-smartstore-car-plate-tracker/app.env \
   /tmp/carplate-audit-tabs.mjs' > /tmp/carplate-tabs-before.json
```

Expected:

- `/tmp/carplate-tabs-before.json` contains only managed table metadata.
- `managed_store_b_inventory` belongs to `트럭판매왕 화물특장 (truckhub) 매물`.
- `managed_store_b_duplicates` belongs to
  `트럭판매왕 화물특장 (truckhub) 내부 차량번호 중복`.
- `managed_across_stores_duplicates` belongs to
  `최트럭 (truck-king)·트럭판매왕 화물특장 (truckhub) 차량번호 중복`.

- [ ] **Step 3: Back up and change only STORE_B_NAME**

Run on Oracle:

```bash
env_file=/etc/naver-smartstore-car-plate-tracker/app.env
backup=/root/carplate-store-name-before-bestbridge.env

sudo test ! -e "$backup"
sudo grep -qx 'STORE_B_NAME=트럭판매왕 화물특장' "$env_file"
sudo test "$(sudo awk -F= '$1 == "STORE_B_NAME" { count += 1 } END { print count + 0 }' \
  "$env_file")" = 1
sudo install -m 0600 -o root -g root "$env_file" "$backup"
sudo sed -i \
  's/^STORE_B_NAME=트럭판매왕 화물특장$/STORE_B_NAME=베스트브릿지/' \
  "$env_file"
sudo grep -qx 'STORE_B_NAME=베스트브릿지' "$env_file"
sudo test "$(sudo stat -c '%U:%G:%a' "$env_file")" = "root:root:600"
```

Expected: exactly one `STORE_B_NAME` line changes. No other environment value is printed or edited.

- [ ] **Step 4: Run one full sync with automatic environment rollback on failure**

Run on Oracle:

```bash
sudo /usr/bin/bash -Eeuo pipefail <<'BASH'
service=car-plate-tracker.service
env_file=/etc/naver-smartstore-car-plate-tracker/app.env
backup=/root/carplate-store-name-before-bestbridge.env
sync_status=0

if ! systemctl stop "$service"; then
  install -m 0600 -o root -g root "$backup" "$env_file"
  systemctl start "$service"
  exit 1
fi

systemd-run --wait --collect --service-type=exec \
  --uid=carplate \
  --gid=carplate \
  --working-directory=/opt/naver-smartstore-car-plate-tracker/current \
  --property=EnvironmentFile="$env_file" \
  --property=EnvironmentFile=-/opt/naver-smartstore-car-plate-tracker/current/release.env \
  /usr/bin/node \
  /opt/naver-smartstore-car-plate-tracker/current/dist/src/cli/sync-once.js ||
  sync_status=$?

if ((sync_status != 0)); then
  install -m 0600 -o root -g root "$backup" "$env_file"
fi

if ! systemctl start "$service"; then
  install -m 0600 -o root -g root "$backup" "$env_file"
  systemctl start "$service"
  exit 1
fi

systemctl is-active --quiet "$service"
exit "$sync_status"
BASH
```

Expected:

- Success: the full sync exits 0 and the scheduler restarts with `STORE_B_NAME=베스트브릿지`.
- Failure: the old environment is restored before the scheduler restarts, and the command exits
  nonzero.

- [ ] **Step 5: Capture and validate post-change table identity**

Run:

```bash
sudo -u carplate sh -c \
  'cd /opt/naver-smartstore-car-plate-tracker/current &&
   exec node --env-file=/etc/naver-smartstore-car-plate-tracker/app.env \
   /tmp/carplate-audit-tabs.mjs' > /tmp/carplate-tabs-after.json
```

Then run:

```bash
python3 - <<'PY'
import json
from pathlib import Path

before = json.loads(Path("/tmp/carplate-tabs-before.json").read_text())
after = json.loads(Path("/tmp/carplate-tabs-after.json").read_text())
expected_titles = {
    "managed_store_b_inventory": "베스트브릿지 (truckhub) 매물",
    "managed_store_b_duplicates": "베스트브릿지 (truckhub) 내부 차량번호 중복",
    "managed_across_stores_duplicates":
        "최트럭 (truck-king)·베스트브릿지 (truckhub) 차량번호 중복",
}
old_titles = {
    "트럭판매왕 화물특장 (truckhub) 매물",
    "트럭판매왕 화물특장 (truckhub) 내부 차량번호 중복",
    "최트럭 (truck-king)·트럭판매왕 화물특장 (truckhub) 차량번호 중복",
}

if set(before) != set(after):
    raise SystemExit("managed table set changed")

for table_name, expected_title in expected_titles.items():
    if after[table_name]["title"] != expected_title:
        raise SystemExit(f"unexpected title for {table_name}")
    if before[table_name]["sheetId"] != after[table_name]["sheetId"]:
        raise SystemExit(f"sheetId changed for {table_name}")
    if before[table_name]["tableId"] != after[table_name]["tableId"]:
        raise SystemExit(f"tableId changed for {table_name}")

if old_titles.intersection(item["title"] for item in after.values()):
    raise SystemExit("old managed title remains")
PY
```

Expected: exit 0.

- [ ] **Step 6: Verify user-visible rows and run output**

Check the live Sheet and the latest sync record:

- `베스트브릿지 (truckhub) 매물` contains 294 product rows.
- Product statuses remain 283 `PROHIBITION` and 11 `SALE`.
- All 294 rows show `베스트브릿지 (truckhub)` in `스토어 표시명`.
- The old Store B inventory, internal-duplicate, and cross-store titles are absent.
- The latest `실행 기록` row names `베스트브릿지 (truckhub)`.
- The service journal contains `sync completed` for the deliberate run and a new
  `scheduler started` record with no following `scheduled sync failed`.

If any count differs before the rollout begins, stop and establish a fresh API/Sheet baseline before
editing the environment; do not force the historical 294/283/11 values onto changed live data.

- [ ] **Step 7: Remove the root-only backup after verified success**

After reporting the successful rename and confirming that rollback is no longer required:

```bash
sudo shred -u /root/carplate-store-name-before-bestbridge.env
rm -f /tmp/carplate-audit-tabs.mjs \
  /tmp/carplate-tabs-before.json \
  /tmp/carplate-tabs-after.json
```

Report that the protected backup and temporary metadata snapshots were removed and are not
recoverable. If verification failed, keep the backup, restore the old environment, restart the
scheduler, and report the exact failed invariant.

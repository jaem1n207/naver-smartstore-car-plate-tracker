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

  it("fails when an unknown tab occupies a desired managed title", () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const sheets = managedSheets(oldTabs).filter((sheet) => sheet.sheetId !== 2);

    sheets.push({
      sheetId: 99,
      title: newTabs.names.storeBView,
      tables: [],
    });

    expect(() => planTabMigrations(newTabs.definitions, sheets)).toThrow(
      '관리 탭 제목 충돌: "베스트브릿지 (truckhub) 매물" 탭에 ' +
        '"managed_store_b_inventory" 관리 테이블이 없습니다',
    );
  });

  it("renames the generic Korean legacy store tab", () => {
    const tabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const definition = definitionByTableName(tabs, "managed_store_b_inventory");

    expect(planTabMigrations([definition], [legacySheet(10, "B스토어 매물")])).toEqual([
      {
        kind: "rename",
        sheetId: 10,
        title: "베스트브릿지 (truckhub) 매물",
      },
    ]);
  });

  it("renames the generic English legacy store tab", () => {
    const tabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const definition = definitionByTableName(tabs, "managed_store_b_inventory");

    expect(planTabMigrations([definition], [legacySheet(11, "B_Store_View")])).toEqual([
      {
        kind: "rename",
        sheetId: 11,
        title: "베스트브릿지 (truckhub) 매물",
      },
    ]);
  });

  it("adopts and canonicalizes a legacy tab's existing A1 table", () => {
    const tabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const definition = definitionByTableName(tabs, "managed_store_b_inventory");
    const sheet: SheetTabMetadata = {
      sheetId: 12,
      title: "B스토어 매물",
      tables: [
        {
          tableId: "legacy-table-12",
          name: "기존 B스토어 테이블",
          startRowIndex: 0,
          startColumnIndex: 0,
        },
      ],
    };

    expect(planTabMigrations([definition], [sheet])).toEqual([
      {
        kind: "rename",
        sheetId: 12,
        title: "베스트브릿지 (truckhub) 매물",
        tableRename: {
          tableId: "legacy-table-12",
          name: "managed_store_b_inventory",
        },
      },
    ]);
  });

  it("fails when a legacy candidate contains another definition's managed table", () => {
    const tabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    const storeADefinition = definitionByTableName(tabs, "managed_store_a_inventory");
    const storeBDefinition = definitionByTableName(tabs, "managed_store_b_inventory");
    const sheet: SheetTabMetadata = {
      sheetId: 13,
      title: "B스토어 매물",
      tables: [
        {
          tableId: "managed-table-13",
          name: storeADefinition.tableName,
          startRowIndex: 0,
          startColumnIndex: 0,
        },
      ],
    };

    expect(() => planTabMigrations([storeADefinition, storeBDefinition], [sheet])).toThrow(
      '관리 탭 소유권 충돌: "B스토어 매물" 탭에 ' +
        '"managed_store_a_inventory" 관리 테이블이 있습니다',
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

function definitionByTableName(tabs: ManagedSheetTabs, tableName: string) {
  const definition = tabs.definitions.find((candidate) => candidate.tableName === tableName);

  if (definition === undefined) {
    throw new Error(`Missing test definition: ${tableName}`);
  }

  return definition;
}

function legacySheet(sheetId: number, title: string): SheetTabMetadata {
  return {
    sheetId,
    title,
    tables: [],
  };
}

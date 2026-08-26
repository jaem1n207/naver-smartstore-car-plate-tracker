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
      readonly tableRename?: {
        readonly tableId: string;
        readonly name: string;
      };
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
  const managedTableNames = new Set(definitions.map((definition) => definition.tableName));
  const ownersBySheetId = new Map<number, SheetTabDefinition>();
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

    if (titledSheet !== undefined && tableSheet === undefined) {
      throw new Error(
        `관리 탭 제목 충돌: "${definition.title}" 탭에 ` +
          `"${definition.tableName}" 관리 테이블이 없습니다`,
      );
    }

    if (titledSheet !== undefined) {
      claimSheet(titledSheet, definition, ownersBySheetId);
      continue;
    }

    if (tableSheet !== undefined) {
      claimSheet(tableSheet, definition, ownersBySheetId);
      actions.push({
        kind: "rename",
        sheetId: tableSheet.sheetId,
        title: definition.title,
      });
      continue;
    }

    const legacySheet = firstLegacySheet(definition, sheetsByTitle);

    if (legacySheet !== undefined) {
      rejectForeignManagedTable(legacySheet, definition, managedTableNames);
      claimSheet(legacySheet, definition, ownersBySheetId);
      const adoptableTable = tableStartingAtFirstCell(legacySheet);

      actions.push({
        kind: "rename",
        sheetId: legacySheet.sheetId,
        title: definition.title,
        ...(adoptableTable === undefined
          ? {}
          : {
              tableRename: {
                tableId: adoptableTable.tableId,
                name: definition.tableName,
              },
            }),
      });
      continue;
    }

    actions.push({
      kind: "add",
      title: definition.title,
      columnCount: definition.columnCount,
    });
  }

  validateActions(actions);

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

function claimSheet(
  sheet: SheetTabMetadata,
  definition: SheetTabDefinition,
  ownersBySheetId: Map<number, SheetTabDefinition>,
): void {
  const existingOwner = ownersBySheetId.get(sheet.sheetId);

  if (existingOwner !== undefined && existingOwner.tableName !== definition.tableName) {
    throw new Error(
      `관리 시트 소유권 충돌: ${String(sheet.sheetId)}번 시트가 ` +
        `"${existingOwner.tableName}" 및 "${definition.tableName}" 정의에 연결됩니다`,
    );
  }

  ownersBySheetId.set(sheet.sheetId, definition);
}

function rejectForeignManagedTable(
  sheet: SheetTabMetadata,
  definition: SheetTabDefinition,
  managedTableNames: ReadonlySet<string>,
): void {
  const foreignTable = sheet.tables.find(
    (table) => managedTableNames.has(table.name) && table.name !== definition.tableName,
  );

  if (foreignTable === undefined) {
    return;
  }

  throw new Error(
    `관리 탭 소유권 충돌: "${sheet.title}" 탭에 ` + `"${foreignTable.name}" 관리 테이블이 있습니다`,
  );
}

function tableStartingAtFirstCell(sheet: SheetTabMetadata): SheetTableMetadata | undefined {
  const tables = sheet.tables.filter(
    (table) => table.startRowIndex === 0 && table.startColumnIndex === 0,
  );

  if (tables.length > 1) {
    throw new Error(`관리 탭 테이블 소유권이 모호합니다: "${sheet.title}"`);
  }

  return tables[0];
}

function validateActions(actions: readonly TabMigrationAction[]): void {
  const migratedSheetIds = new Set<number>();

  for (const action of actions) {
    if (action.kind !== "rename") {
      continue;
    }

    if (migratedSheetIds.has(action.sheetId)) {
      throw new Error(`관리 시트 마이그레이션이 중복되었습니다: ${String(action.sheetId)}번`);
    }

    migratedSheetIds.add(action.sheetId);
  }
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

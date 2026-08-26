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

    if (titledSheet !== undefined && tableSheet === undefined) {
      throw new Error(
        `관리 탭 제목 충돌: "${definition.title}" 탭에 ` +
          `"${definition.tableName}" 관리 테이블이 없습니다`,
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

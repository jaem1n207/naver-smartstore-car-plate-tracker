import {
  auth as googleAuth,
  sheets as createSheetsClient,
  type sheets_v4,
} from "googleapis/build/src/apis/sheets/index.js";
import { z } from "zod";
import {
  createManagedSheetTabs,
  OPERATOR_VIEW_COLUMNS,
  OPERATOR_VIEW_HEADERS,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RAW_DATA_TAB,
  LEGACY_RUN_LOG_HEADERS,
  RUN_LOG_HEADERS,
  RUN_LOG_TAB,
  sheetProductRowToOperatorValues,
  sheetProductRowToValues,
  valuesToSheetProductRow,
} from "./columns.js";
import type { SheetTabDefinition, SheetTabNames } from "./columns.js";
import {
  planTabMigrations,
  type SheetTabMetadata,
  type TabMigrationAction,
} from "./tab-migration.js";
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
import type { DuplicateGroup, DuplicateGroupStyle, OperatorCellStyle } from "./operator-view.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const RAW_DATA_END_COLUMN = columnNameForColumnCount(RAW_DATA_COLUMNS.length);
const RUN_LOG_END_COLUMN = columnNameForColumnCount(RUN_LOG_HEADERS.length);
const MAX_MANAGED_PRODUCT_COLUMNS = RAW_DATA_COLUMNS.length;
const MIN_TABLE_ROW_COUNT = 2;
const OPERATOR_COLUMN_WIDTHS: readonly number[] = [
  120, 240, 320, 220, 125, 135, 240, 170, 170, 220, 170, 320,
];
const OPERATOR_FORMAT_FIELDS =
  "userEnteredFormat(backgroundColorStyle,textFormat.bold,textFormat.foregroundColorStyle)";
const HEADER_FORMAT_FIELDS =
  "userEnteredFormat(backgroundColorStyle,textFormat.bold,textFormat.foregroundColorStyle,horizontalAlignment,verticalAlignment)";

type ManagedTableSpec = {
  readonly name: string;
  readonly range: sheets_v4.Schema$GridRange;
  readonly columnProperties: sheets_v4.Schema$TableColumnProperties[];
  readonly rowsProperties: sheets_v4.Schema$TableRowsProperties;
};

const GoogleServiceAccountCredentialsSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().trim().min(1),
  private_key_id: z.string().trim().min(1),
  private_key: z.string().min(1),
  client_email: z.email(),
  client_id: z.string().trim().min(1),
});

export interface GoogleSheetRepositoryOptions {
  readonly spreadsheetId: string;
  readonly storeADisplayName: string;
  readonly storeBDisplayName: string;
  readonly credentialsFile?: string | undefined;
  readonly serviceAccountJsonBase64?: string | undefined;
}

export class GoogleSheetRepository implements SheetRepository {
  private readonly spreadsheetId: string;
  private readonly sheets: sheets_v4.Sheets;
  private readonly tabDefinitions: readonly SheetTabDefinition[];
  private readonly tabNames: SheetTabNames;
  private readonly sheetIdsByTitle = new Map<string, number>();
  private readonly gridColumnCountsByTitle = new Map<string, number>();
  private readonly tableIdsByTitle = new Map<string, string>();
  private initializeTabsPromise: Promise<void> | undefined;

  constructor(options: GoogleSheetRepositoryOptions) {
    this.spreadsheetId = options.spreadsheetId;
    const managedTabs = createManagedSheetTabs(
      options.storeADisplayName,
      options.storeBDisplayName,
    );
    this.tabDefinitions = managedTabs.definitions;
    this.tabNames = managedTabs.names;

    const credentials = decodeServiceAccountCredentials(options.serviceAccountJsonBase64);
    const auth = new googleAuth.GoogleAuth({
      scopes: [SPREADSHEETS_SCOPE],
      ...(options.credentialsFile === undefined ? {} : { keyFile: options.credentialsFile }),
      ...(credentials === undefined ? {} : { credentials }),
    });

    this.sheets = createSheetsClient({ version: "v4", auth });
  }

  async prepareRunLog(): Promise<void> {
    await this.ensureTabs();
    await this.writeRunLogHeader(await this.readRunLogValues());
  }

  async readRawData(): Promise<SheetProductRow[]> {
    await this.ensureTabs();

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RAW_DATA_TAB, `A2:${RAW_DATA_END_COLUMN}`),
    });

    return googleValuesToRows(response.data.values).map((row, index) =>
      parseRawDataRow(row, index + 2),
    );
  }

  async writeRawData(rows: SheetProductRow[]): Promise<void> {
    await this.ensureTabs();
    await this.replaceSheet(RAW_DATA_TAB, rawDataValues(rows));
  }

  async writeViews(rows: SheetProductRow[]): Promise<void> {
    await this.ensureTabs();

    const activeRows = rows.filter(isActiveProductRow);

    await this.replaceOperatorSheet(this.tabNames.storeAView, activeRows.filter(isStoreARow));
    await this.replaceOperatorSheet(this.tabNames.storeBView, activeRows.filter(isStoreBRow));
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
    await this.replaceSheet(
      this.tabNames.extractionFailures,
      rawDataValues(activeRows.filter(hasExtractionFailure)),
    );
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    await this.ensureTabs();
    const currentValues = await this.readRunLogValues();
    const currentRowCount = currentValues.length;

    await this.writeRunLogHeader(currentValues);
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RUN_LOG_TAB, `A:${RUN_LOG_END_COLUMN}`),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            row.runStartedAt,
            row.runFinishedAt,
            runModeLabel(row.mode),
            syncScopeLabel(row.syncScope),
            row.selectedStores.join(", "),
            row.syncedProductsThisRun,
            row.sheetTotalProducts,
            row.sheetExtractionSuccess,
            row.sheetExtractionFailure,
            row.sheetDuplicateProductRows,
            row.summary,
          ],
        ],
      },
    });
    await this.syncManagedTable(
      this.definitionForTitle(RUN_LOG_TAB),
      Math.max(currentRowCount + 1, MIN_TABLE_ROW_COUNT),
    );
  }

  private async readRunLogValues(): Promise<unknown[][]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RUN_LOG_TAB, `A:${RUN_LOG_END_COLUMN}`),
    });

    return googleValuesToRows(response.data.values);
  }

  private async writeRunLogHeader(currentValues: readonly unknown[][]): Promise<void> {
    if (hasExactHeader(currentValues[0], RUN_LOG_HEADERS)) {
      return;
    }

    const values =
      currentValues.length === 0
        ? [RUN_LOG_HEADERS]
        : hasExactHeader(currentValues[0], LEGACY_RUN_LOG_HEADERS)
          ? migrateLegacyRunLogValues(currentValues)
          : undefined;

    if (values === undefined) {
      throw new Error(
        "실행 기록 헤더가 지원되지 않는 형식입니다. 빈 시트, 기존 8열 헤더, 현재 11열 헤더만 사용할 수 있습니다",
      );
    }

    const endRow = values.length;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RUN_LOG_TAB, `A1:${RUN_LOG_END_COLUMN}${String(endRow)}`),
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }

  private ensureTabs(): Promise<void> {
    this.initializeTabsPromise ??= this.initializeTabs().catch((error: unknown) => {
      this.initializeTabsPromise = undefined;
      throw error;
    });

    return this.initializeTabsPromise;
  }

  private async initializeTabs(): Promise<void> {
    const initialSheets = await this.fetchSheetMetadata();
    const bootstrapRequests = planTabMigrations(
      this.tabDefinitions,
      sheetMetadataForMigration(initialSheets),
    ).map(tabMigrationRequest);

    if (bootstrapRequests.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: bootstrapRequests },
      });
    }

    const finalSheets =
      bootstrapRequests.length > 0 ? await this.fetchSheetMetadata() : initialSheets;
    this.captureManagedSheetMetadata(finalSheets);
    const layoutRequests = createManagedLayoutRequests(
      this.tabDefinitions,
      this.sheetIdsByTitle,
      this.gridColumnCountsByTitle,
    );

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: layoutRequests },
    });
  }

  private async fetchSheetMetadata(): Promise<sheets_v4.Schema$Sheet[]> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields:
        "sheets(properties(sheetId,title,index,gridProperties(columnCount)),tables(tableId,name,range))",
    });

    return response.data.sheets ?? [];
  }

  private captureManagedSheetMetadata(sheets: readonly sheets_v4.Schema$Sheet[]): void {
    this.sheetIdsByTitle.clear();
    this.gridColumnCountsByTitle.clear();
    this.tableIdsByTitle.clear();

    for (const sheet of sheets) {
      const sheetId = sheet.properties?.sheetId;
      const title = sheet.properties?.title;

      if (typeof sheetId !== "number" || typeof title !== "string") {
        continue;
      }

      this.sheetIdsByTitle.set(title, sheetId);

      const columnCount = sheet.properties?.gridProperties?.columnCount;

      if (typeof columnCount === "number") {
        this.gridColumnCountsByTitle.set(title, columnCount);
      }

      const managedTable = firstTableStartingAtFirstCell(sheet.tables);
      const tableId = managedTable?.tableId;

      if (typeof tableId === "string") {
        this.tableIdsByTitle.set(title, tableId);
      }
    }
  }

  private async replaceOperatorSheet(tabName: string, rows: SheetProductRow[]): Promise<void> {
    const sortedRows = sortOperatorRows(rows);
    const targetRowCount = await this.replaceSheet(tabName, operatorViewValues(sortedRows));
    const sheetId = this.sheetIdsByTitle.get(tabName);

    if (sheetId === undefined) {
      throw new Error(`관리 대상 시트 ID를 찾을 수 없습니다: ${tabName}`);
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: createOperatorFormattingRequests(sheetId, sortedRows, targetRowCount),
      },
    });
  }

  private async replaceSheet(tabName: string, values: string[][]): Promise<number> {
    const definition = this.definitionForTitle(tabName);
    const gridColumnCount = this.gridColumnCountsByTitle.get(tabName) ?? definition.columnCount;
    const clearColumnCount = Math.max(
      definition.columnCount,
      Math.min(gridColumnCount, MAX_MANAGED_PRODUCT_COLUMNS),
    );
    const clearEndColumn = columnNameForColumnCount(clearColumnCount);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(tabName, `A:${clearEndColumn}`),
    });
    const currentRowCount = googleValuesToRows(response.data.values).length;
    const tableRowCount = Math.max(values.length, MIN_TABLE_ROW_COUNT);
    const targetRowCount = Math.max(currentRowCount, tableRowCount);

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(tabName, `A1:${clearEndColumn}${String(targetRowCount)}`),
      valueInputOption: "RAW",
      requestBody: {
        values: padRowsAndColumns(values, targetRowCount, clearColumnCount),
      },
    });
    await this.syncManagedTable(definition, tableRowCount);

    return targetRowCount;
  }

  private definitionForTitle(title: string): SheetTabDefinition {
    const definition = this.tabDefinitions.find((candidate) => candidate.title === title);

    if (definition === undefined) {
      throw new Error(`관리 대상 시트 정의를 찾을 수 없습니다: ${title}`);
    }

    return definition;
  }

  private async syncManagedTable(definition: SheetTabDefinition, rowCount: number): Promise<void> {
    const sheetId = this.sheetIdsByTitle.get(definition.title);

    if (sheetId === undefined) {
      throw new Error(`관리 대상 시트 ID를 찾을 수 없습니다: ${definition.title}`);
    }

    const existingTableId = this.tableIdsByTitle.get(definition.title);
    const table = managedTable(definition, sheetId, rowCount);
    const request: sheets_v4.Schema$Request =
      existingTableId === undefined
        ? { addTable: { table } }
        : {
            updateTable: {
              table: {
                tableId: existingTableId,
                range: table.range,
                columnProperties: table.columnProperties,
                rowsProperties: table.rowsProperties,
              },
              fields: "range,columnProperties,rowsProperties",
            },
          };
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [request] },
    });
    const addedTableId = response.data.replies?.[0]?.addTable?.table?.tableId;

    if (typeof addedTableId === "string") {
      this.tableIdsByTitle.set(definition.title, addedTableId);
    }
  }
}

function rawDataValues(rows: SheetProductRow[]): string[][] {
  return [RAW_DATA_HEADERS, ...rows.map(sheetProductRowToValues)];
}

function operatorViewValues(rows: SheetProductRow[]): string[][] {
  return [OPERATOR_VIEW_HEADERS, ...rows.map(sheetProductRowToOperatorValues)];
}

function googleValuesToRows(values: unknown): unknown[][] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter(isGoogleValueRow);
}

function isGoogleValueRow(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseRawDataRow(row: unknown[], sheetRowNumber: number): SheetProductRow {
  try {
    return valuesToSheetProductRow(row.map(String));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${RAW_DATA_TAB} ${String(sheetRowNumber)}행: ${error.message}`, {
        cause: error,
      });
    }

    throw new Error(`${RAW_DATA_TAB} ${String(sheetRowNumber)}행을 읽지 못했습니다`, {
      cause: error,
    });
  }
}

function padRowsAndColumns(
  rows: string[][],
  targetRowCount: number,
  targetColumnCount: number,
): string[][] {
  const paddedRows = rows.map((row) => padColumns(row, targetColumnCount));

  while (paddedRows.length < targetRowCount) {
    paddedRows.push(blankRow(targetColumnCount));
  }

  return paddedRows;
}

function padColumns(row: readonly string[], targetColumnCount: number): string[] {
  const paddedRow = [...row];

  while (paddedRow.length < targetColumnCount) {
    paddedRow.push("");
  }

  return paddedRow;
}

function blankRow(columnCount: number): string[] {
  return Array.from({ length: columnCount }, () => "");
}

function columnNameForColumnCount(columnCount: number): string {
  let remainingColumnCount = columnCount;
  let columnName = "";

  while (remainingColumnCount > 0) {
    const alphabetIndex = (remainingColumnCount - 1) % 26;
    columnName = String.fromCharCode(65 + alphabetIndex) + columnName;
    remainingColumnCount = Math.floor((remainingColumnCount - 1) / 26);
  }

  return columnName;
}

function sheetRange(tabName: string, range: string): string {
  return `'${tabName.replaceAll("'", "''")}'!${range}`;
}

function renameSheetRequest(sheetId: number, title: string): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: {
        sheetId,
        title,
      },
      fields: "title",
    },
  };
}

function addSheetRequest(title: string, columnCount: number): sheets_v4.Schema$Request {
  return {
    addSheet: {
      properties: {
        title,
        gridProperties: {
          columnCount,
          frozenRowCount: 1,
        },
      },
    },
  };
}

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

function createManagedLayoutRequests(
  definitions: readonly SheetTabDefinition[],
  sheetIdsByTitle: ReadonlyMap<string, number>,
  gridColumnCountsByTitle: ReadonlyMap<string, number>,
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];

  definitions.forEach((definition, index) => {
    const sheetId = sheetIdsByTitle.get(definition.title);

    if (sheetId === undefined) {
      throw new Error(`관리 대상 시트 ID를 찾을 수 없습니다: ${definition.title}`);
    }

    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          index,
          gridProperties: {
            frozenRowCount: 1,
            ...(definition.operatorFacing ? { frozenColumnCount: 2 } : {}),
          },
        },
        fields: definition.operatorFacing
          ? "index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount"
          : "index,gridProperties.frozenRowCount",
      },
    });
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 36 },
        fields: "pixelSize",
      },
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: definition.columnCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: colorStyleFromHex(SHEET_HEADER_STYLE.backgroundHex),
            textFormat: {
              bold: true,
              foregroundColorStyle: colorStyleFromHex(SHEET_HEADER_STYLE.foregroundHex),
            },
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: HEADER_FORMAT_FIELDS,
      },
    });

    if (!definition.operatorFacing) {
      return;
    }

    for (const [columnIndex, pixelSize] of OPERATOR_COLUMN_WIDTHS.entries()) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: columnIndex,
            endIndex: columnIndex + 1,
          },
          properties: { pixelSize, hiddenByUser: false },
          fields: "pixelSize,hiddenByUser",
        },
      });
    }

    const gridColumnCount = gridColumnCountsByTitle.get(definition.title) ?? definition.columnCount;

    if (gridColumnCount > definition.columnCount) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: definition.columnCount,
            endIndex: gridColumnCount,
          },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      });
    }
  });

  return requests;
}

function firstTableStartingAtFirstCell(
  tables: sheets_v4.Schema$Table[] | null | undefined,
): sheets_v4.Schema$Table | undefined {
  return (tables ?? []).find(
    (table) =>
      (table.range?.startRowIndex ?? 0) === 0 && (table.range?.startColumnIndex ?? 0) === 0,
  );
}

function managedTable(
  definition: SheetTabDefinition,
  sheetId: number,
  rowCount: number,
): ManagedTableSpec {
  return {
    name: definition.tableName,
    range: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: rowCount,
      startColumnIndex: 0,
      endColumnIndex: definition.columnCount,
    },
    columnProperties: definition.headers.map((header, columnIndex) => ({
      columnIndex,
      columnName: header,
    })),
    rowsProperties: {
      headerColorStyle: colorStyleFromHex(SHEET_HEADER_STYLE.backgroundHex),
      firstBandColorStyle: rgbColorStyle(1, 1, 1),
      secondBandColorStyle: rgbColorStyle(0.96, 0.97, 0.97),
    },
  };
}

function rgbColorStyle(red: number, green: number, blue: number): sheets_v4.Schema$ColorStyle {
  return { rgbColor: { red, green, blue } };
}

function colorStyleFromHex(hex: string): sheets_v4.Schema$ColorStyle {
  if (!/^#[\dA-F]{6}$/iu.test(hex)) {
    throw new Error(`Invalid sheet color: ${hex}`);
  }

  return rgbColorStyle(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );
}

function createOperatorFormattingRequests(
  sheetId: number,
  rows: readonly SheetProductRow[],
  targetRowCount: number,
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  const duplicateGroups = findDuplicateGroups(rows);

  if (rows.length > 0) {
    requests.push({
      updateCells: {
        start: { sheetId, rowIndex: 1, columnIndex: 0 },
        rows: rows.map((row) => ({
          values: OPERATOR_VIEW_COLUMNS.map((column) => ({
            userEnteredFormat: operatorCellFormat(row, column),
          })),
        })),
        fields: OPERATOR_FORMAT_FIELDS,
      },
    });
  }

  const firstStaleRowIndex = rows.length + 1;

  if (firstStaleRowIndex < targetRowCount) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: firstStaleRowIndex,
          endRowIndex: targetRowCount,
          startColumnIndex: 0,
          endColumnIndex: OPERATOR_VIEW_COLUMNS.length,
        },
        cell: { userEnteredFormat: { textFormat: { bold: false } } },
        fields: OPERATOR_FORMAT_FIELDS,
      },
    });
  }

  requests.push({
    updateBorders: {
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex: targetRowCount,
        startColumnIndex: 0,
        endColumnIndex: OPERATOR_VIEW_COLUMNS.length,
      },
      top: { style: "NONE" },
      bottom: { style: "NONE" },
      innerHorizontal: { style: "NONE" },
    },
  });

  for (const group of duplicateGroups) {
    const groupStyle = duplicateGroupStyleForRows(rows, group);
    const border = {
      style: "SOLID_MEDIUM",
      colorStyle: colorStyleFromHex(groupStyle.borderHex),
    };
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: group.startIndex + 1,
          endRowIndex: group.endIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        top: border,
        bottom: border,
      },
    });
  }

  return requests;
}

function duplicateGroupStyleForRows(
  rows: readonly SheetProductRow[],
  group: DuplicateGroup,
): DuplicateGroupStyle {
  const groupRows = rows.slice(group.startIndex, group.endIndex);

  const statusPriority: readonly SheetProductRow["duplicateStatus"][] = [
    "duplicated_both",
    "duplicated_across_stores",
    "duplicated_in_same_store",
  ];

  for (const status of statusPriority) {
    if (groupRows.some((row) => row.duplicateStatus === status)) {
      const style = duplicateStatusStyle(status);

      if (style !== undefined) {
        return style;
      }
    }
  }

  throw new Error(`Duplicate group has no duplicate status: ${group.plate}`);
}

function operatorCellFormat(
  row: SheetProductRow,
  column: (typeof OPERATOR_VIEW_COLUMNS)[number],
): sheets_v4.Schema$CellFormat {
  const statusStyle = statusStyleForColumn(row, column);
  const duplicateKeyStyle =
    column === "normalizedPlate" || column === "duplicateStatus"
      ? duplicateStatusStyle(row.duplicateStatus)
      : undefined;
  const backgroundHex = statusStyle?.backgroundHex ?? duplicateKeyStyle?.backgroundHex;
  const foregroundHex =
    statusStyle?.foregroundHex ??
    (column === "productUrl" ? undefined : duplicateKeyStyle?.foregroundHex);

  return {
    ...(backgroundHex === undefined
      ? {}
      : { backgroundColorStyle: colorStyleFromHex(backgroundHex) }),
    textFormat: {
      bold: statusStyle !== undefined || duplicateKeyStyle !== undefined,
      ...(foregroundHex === undefined
        ? {}
        : { foregroundColorStyle: colorStyleFromHex(foregroundHex) }),
    },
  };
}

function statusStyleForColumn(
  row: SheetProductRow,
  column: (typeof OPERATOR_VIEW_COLUMNS)[number],
): OperatorCellStyle | undefined {
  switch (column) {
    case "duplicateStatus":
      return duplicateStatusStyle(row.duplicateStatus);
    case "displayStatus":
      return row.displayStatus.trim().length === 0
        ? undefined
        : displayStatusStyle(row.displayStatus);
    case "productStatus":
      return row.productStatus.trim().length === 0
        ? undefined
        : productStatusStyle(row.productStatus);
    default:
      return undefined;
  }
}

function decodeServiceAccountCredentials(encodedJson: string | undefined) {
  if (encodedJson === undefined) {
    return undefined;
  }

  try {
    const decodedJson = Buffer.from(encodedJson, "base64").toString("utf8");
    const parsedJson: unknown = JSON.parse(decodedJson);

    return GoogleServiceAccountCredentialsSchema.parse(parsedJson);
  } catch (error) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 must contain a Base64-encoded Google service account JSON credential",
      { cause: error },
    );
  }
}

function runModeLabel(mode: RunLogRow["mode"]): string {
  return mode === "live" ? "실제 연동" : "모의 실행";
}

function syncScopeLabel(scope: RunLogRow["syncScope"]): string {
  return scope === "all_stores" ? "전체 스토어" : "선택 스토어";
}

function hasExactHeader(row: readonly unknown[] | undefined, expected: readonly string[]): boolean {
  return (
    row !== undefined &&
    row.length === expected.length &&
    row.every((value, index) => value === expected[index])
  );
}

function legacyRunLogRowToValues(row: readonly unknown[]): unknown[] {
  if (isBlankRunLogRow(row)) {
    return RUN_LOG_HEADERS.map(() => "");
  }

  return [
    row[0] ?? "",
    row[1] ?? "",
    row[2] ?? "",
    "이전 형식",
    "",
    "",
    row[3] ?? "",
    row[4] ?? "",
    row[5] ?? "",
    row[6] ?? "",
    row[7] ?? "",
  ];
}

function migrateLegacyRunLogValues(currentValues: readonly unknown[][]): unknown[][] {
  const legacyRows = currentValues.slice(1);

  if (legacyRows.some(hasNonEmptyLegacyTrailingCell)) {
    throw new Error(
      "실행 기록 기존 8열 데이터의 I:K 영역에 값이 있어 자동 마이그레이션할 수 없습니다",
    );
  }

  return [RUN_LOG_HEADERS, ...legacyRows.map(legacyRunLogRowToValues)];
}

function hasNonEmptyLegacyTrailingCell(row: readonly unknown[]): boolean {
  return row.slice(LEGACY_RUN_LOG_HEADERS.length).some((value) => !isBlankRunLogCell(value));
}

function isBlankRunLogRow(row: readonly unknown[]): boolean {
  return row.every(isBlankRunLogCell);
}

function isBlankRunLogCell(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

function isActiveProductRow(row: SheetProductRow): boolean {
  return row.productStatus !== "DELETE";
}

function isStoreARow(row: SheetProductRow): boolean {
  return row.storeKey === "A";
}

function isStoreBRow(row: SheetProductRow): boolean {
  return row.storeKey === "B";
}

function hasExtractionFailure(row: SheetProductRow): boolean {
  return row.extractionStatus !== "success";
}

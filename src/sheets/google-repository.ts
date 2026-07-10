import {
  auth as googleAuth,
  sheets as createSheetsClient,
  type sheets_v4,
} from "googleapis/build/src/apis/sheets/index.js";
import { z } from "zod";
import type { DuplicateStatus } from "../domain/duplicates/types.js";
import {
  createManagedSheetTabs,
  OPERATOR_VIEW_HEADERS,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RAW_DATA_TAB,
  RUN_LOG_HEADERS,
  RUN_LOG_TAB,
  sheetProductRowToOperatorValues,
  sheetProductRowToValues,
  valuesToSheetProductRow,
} from "./columns.js";
import type { SheetTabDefinition, SheetTabNames } from "./columns.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const RAW_DATA_END_COLUMN = columnNameForColumnCount(RAW_DATA_COLUMNS.length);
const RUN_LOG_END_COLUMN = columnNameForColumnCount(RUN_LOG_HEADERS.length);
const MAX_MANAGED_PRODUCT_COLUMNS = RAW_DATA_COLUMNS.length;
const MIN_TABLE_ROW_COUNT = 2;
const OPERATOR_COLUMN_WIDTHS: readonly number[] = [
  120, 160, 320, 220, 100, 110, 240, 170, 170, 220, 170, 320,
];

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

    await this.replaceSheet(
      this.tabNames.storeAView,
      operatorViewValues(activeRows.filter(isStoreARow)),
    );
    await this.replaceSheet(
      this.tabNames.storeBView,
      operatorViewValues(activeRows.filter(isStoreBRow)),
    );
    await this.replaceSheet(
      this.tabNames.storeADuplicates,
      operatorViewValues(
        activeRows.filter((row) => isStoreARow(row) && isSameStoreOnlyDuplicate(row)),
      ),
    );
    await this.replaceSheet(
      this.tabNames.storeBDuplicates,
      operatorViewValues(
        activeRows.filter((row) => isStoreBRow(row) && isSameStoreOnlyDuplicate(row)),
      ),
    );
    await this.replaceSheet(
      this.tabNames.acrossStoresDuplicates,
      operatorViewValues(activeRows.filter(hasAcrossStoresDuplicate)),
    );
    await this.replaceSheet(
      this.tabNames.extractionFailures,
      rawDataValues(activeRows.filter(hasExtractionFailure)),
    );
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    await this.ensureTabs();
    const currentValuesResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RUN_LOG_TAB, `A:${RUN_LOG_END_COLUMN}`),
    });
    const currentRowCount = googleValuesToRows(currentValuesResponse.data.values).length;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(RUN_LOG_TAB, `A1:${RUN_LOG_END_COLUMN}1`),
      valueInputOption: "RAW",
      requestBody: {
        values: [RUN_LOG_HEADERS],
      },
    });
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
            row.totalProducts,
            row.successCount,
            row.failureCount,
            row.duplicateCount,
            row.message,
          ],
        ],
      },
    });
    await this.syncManagedTable(
      this.definitionForTitle(RUN_LOG_TAB),
      Math.max(currentRowCount + 1, MIN_TABLE_ROW_COUNT),
    );
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
    const initialSheetIdsByTitle = collectSheetIdsByTitle(initialSheets);
    const bootstrapRequests: sheets_v4.Schema$Request[] = [];

    for (const tab of this.tabDefinitions) {
      const localizedSheetId = initialSheetIdsByTitle.get(tab.title);

      if (localizedSheetId !== undefined) {
        continue;
      }

      const legacySheetId = firstExistingSheetId(initialSheetIdsByTitle, tab.legacyTitles);

      if (legacySheetId !== undefined) {
        bootstrapRequests.push(renameSheetRequest(legacySheetId, tab.title));
        continue;
      }

      bootstrapRequests.push(addSheetRequest(tab.title, tab.columnCount));
    }

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

  private async replaceSheet(tabName: string, values: string[][]): Promise<void> {
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

function firstExistingSheetId(
  sheetIdsByTitle: ReadonlyMap<string, number>,
  titles: readonly string[],
): number | undefined {
  for (const title of titles) {
    const sheetId = sheetIdsByTitle.get(title);

    if (sheetId !== undefined) {
      return sheetId;
    }
  }

  return undefined;
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

function collectSheetIdsByTitle(
  sheets: sheets_v4.Schema$Sheet[] | null | undefined,
): Map<string, number> {
  const sheetIdsByTitle = new Map<string, number>();

  for (const sheet of sheets ?? []) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title;

    if (typeof sheetId === "number" && typeof title === "string") {
      sheetIdsByTitle.set(title, sheetId);
    }
  }

  return sheetIdsByTitle;
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
          gridProperties: { frozenRowCount: 1 },
        },
        fields: "index,gridProperties.frozenRowCount",
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
      headerColorStyle: rgbColorStyle(0.87, 0.93, 0.9),
      firstBandColorStyle: rgbColorStyle(1, 1, 1),
      secondBandColorStyle: rgbColorStyle(0.96, 0.97, 0.97),
    },
  };
}

function rgbColorStyle(red: number, green: number, blue: number): sheets_v4.Schema$ColorStyle {
  return { rgbColor: { red, green, blue } };
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

function isActiveProductRow(row: SheetProductRow): boolean {
  return row.productStatus !== "DELETE";
}

function isStoreARow(row: SheetProductRow): boolean {
  return row.storeKey === "A";
}

function isStoreBRow(row: SheetProductRow): boolean {
  return row.storeKey === "B";
}

function hasAcrossStoresDuplicate(row: SheetProductRow): boolean {
  return isDuplicateStatus(row.duplicateStatus, "duplicated_across_stores", "duplicated_both");
}

function isSameStoreOnlyDuplicate(row: SheetProductRow): boolean {
  return row.duplicateStatus === "duplicated_in_same_store";
}

function hasExtractionFailure(row: SheetProductRow): boolean {
  return row.extractionStatus !== "success";
}

function isDuplicateStatus(
  status: DuplicateStatus,
  primaryStatus: DuplicateStatus,
  sharedStatus: DuplicateStatus,
): boolean {
  return status === primaryStatus || status === sharedStatus;
}

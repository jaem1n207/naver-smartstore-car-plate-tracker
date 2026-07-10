import {
  auth as googleAuth,
  sheets as createSheetsClient,
  type sheets_v4,
} from "googleapis/build/src/apis/sheets/index.js";
import { z } from "zod";
import type { DuplicateStatus } from "../domain/duplicates/types.js";
import {
  createManagedSheetTabs,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RAW_DATA_TAB,
  RUN_LOG_HEADERS,
  RUN_LOG_TAB,
  sheetProductRowToValues,
  valuesToSheetProductRow,
} from "./columns.js";
import type { SheetTabDefinition, SheetTabNames } from "./columns.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const RAW_DATA_END_COLUMN = columnNameForColumnCount(RAW_DATA_COLUMNS.length);
const RUN_LOG_END_COLUMN = columnNameForColumnCount(RUN_LOG_HEADERS.length);

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
    await this.replaceSheet(RAW_DATA_TAB, viewValues(rows));
  }

  async writeViews(rows: SheetProductRow[]): Promise<void> {
    await this.ensureTabs();

    const activeRows = rows.filter(isActiveProductRow);

    await this.replaceSheet(this.tabNames.storeAView, viewValues(activeRows.filter(isStoreARow)));
    await this.replaceSheet(this.tabNames.storeBView, viewValues(activeRows.filter(isStoreBRow)));
    await this.replaceSheet(
      this.tabNames.acrossStoresDuplicates,
      viewValues(activeRows.filter(hasAcrossStoresDuplicate)),
    );
    await this.replaceSheet(
      this.tabNames.sameStoreDuplicates,
      viewValues(activeRows.filter(hasSameStoreDuplicate)),
    );
    await this.replaceSheet(
      this.tabNames.extractionFailures,
      viewValues(activeRows.filter(hasExtractionFailure)),
    );
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    await this.ensureTabs();
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
  }

  private ensureTabs(): Promise<void> {
    this.initializeTabsPromise ??= this.initializeTabs().catch((error: unknown) => {
      this.initializeTabsPromise = undefined;
      throw error;
    });

    return this.initializeTabsPromise;
  }

  private async initializeTabs(): Promise<void> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties(sheetId,title)",
    });
    const sheetIdsByTitle = collectSheetIdsByTitle(response.data.sheets);
    const requests: sheets_v4.Schema$Request[] = [];

    for (const tab of this.tabDefinitions) {
      const localizedSheetId = sheetIdsByTitle.get(tab.title);

      if (localizedSheetId !== undefined) {
        requests.push(freezeHeaderRowRequest(localizedSheetId));
        continue;
      }

      const legacySheetId = firstExistingSheetId(sheetIdsByTitle, tab.legacyTitles);

      if (legacySheetId !== undefined) {
        requests.push(renameAndFreezeSheetRequest(legacySheetId, tab.title));
        continue;
      }

      requests.push(addSheetRequest(tab.title, tab.columnCount));
    }

    if (requests.length === 0) {
      return;
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
  }

  private async replaceSheet(tabName: string, values: string[][]): Promise<void> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(tabName, `A:${RAW_DATA_END_COLUMN}`),
    });
    const currentRowCount = googleValuesToRows(response.data.values).length;
    const targetRowCount = Math.max(currentRowCount, values.length);

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: sheetRange(tabName, `A1:${RAW_DATA_END_COLUMN}${String(targetRowCount)}`),
      valueInputOption: "RAW",
      requestBody: {
        values: padRows(values, targetRowCount),
      },
    });
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

function viewValues(rows: SheetProductRow[]): string[][] {
  return [RAW_DATA_HEADERS, ...rows.map(sheetProductRowToValues)];
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

function padRows(rows: string[][], targetRowCount: number): string[][] {
  const paddedRows = [...rows];

  while (paddedRows.length < targetRowCount) {
    paddedRows.push(blankRawDataRow());
  }

  return paddedRows;
}

function blankRawDataRow(): string[] {
  return RAW_DATA_COLUMNS.map(() => "");
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

function freezeHeaderRowRequest(sheetId: number): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 1 },
      },
      fields: "gridProperties.frozenRowCount",
    },
  };
}

function renameAndFreezeSheetRequest(sheetId: number, title: string): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: {
        sheetId,
        title,
        gridProperties: { frozenRowCount: 1 },
      },
      fields: "title,gridProperties.frozenRowCount",
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

function hasSameStoreDuplicate(row: SheetProductRow): boolean {
  return isDuplicateStatus(row.duplicateStatus, "duplicated_in_same_store", "duplicated_both");
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

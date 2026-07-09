import { google, type sheets_v4 } from "googleapis";
import type { DuplicateStatus } from "../domain/duplicates/types.js";
import { RAW_DATA_COLUMNS, sheetProductRowToValues, valuesToSheetProductRow } from "./columns.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const RAW_DATA_TAB = "RawData";
const A_STORE_VIEW_TAB = "A_Store_View";
const B_STORE_VIEW_TAB = "B_Store_View";
const ACROSS_STORES_DUPLICATES_TAB = "Across_Stores_Duplicates";
const SAME_STORE_DUPLICATES_TAB = "Same_Store_Duplicates";
const EXTRACTION_FAILURES_TAB = "Extraction_Failures";
const RUN_LOG_TAB = "RunLog";
const RAW_DATA_END_COLUMN = columnNameForColumnCount(RAW_DATA_COLUMNS.length);

export class GoogleSheetRepository implements SheetRepository {
  private readonly sheets: sheets_v4.Sheets;

  constructor(private readonly spreadsheetId: string) {
    const auth = new google.auth.GoogleAuth({
      scopes: [SPREADSHEETS_SCOPE],
    });

    this.sheets = google.sheets({ version: "v4", auth });
  }

  async readRawData(): Promise<SheetProductRow[]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${RAW_DATA_TAB}!A2:${RAW_DATA_END_COLUMN}`,
    });

    return googleValuesToRows(response.data.values).map((row, index) =>
      parseRawDataRow(row, index + 2),
    );
  }

  async writeRawData(rows: SheetProductRow[]): Promise<void> {
    await this.replaceSheet(RAW_DATA_TAB, viewValues(rows));
  }

  async writeViews(rows: SheetProductRow[]): Promise<void> {
    const activeRows = rows.filter(isActiveProductRow);

    await this.replaceSheet(A_STORE_VIEW_TAB, viewValues(activeRows.filter(isStoreARow)));
    await this.replaceSheet(B_STORE_VIEW_TAB, viewValues(activeRows.filter(isStoreBRow)));
    await this.replaceSheet(
      ACROSS_STORES_DUPLICATES_TAB,
      viewValues(activeRows.filter(hasAcrossStoresDuplicate)),
    );
    await this.replaceSheet(
      SAME_STORE_DUPLICATES_TAB,
      viewValues(activeRows.filter(hasSameStoreDuplicate)),
    );
    await this.replaceSheet(
      EXTRACTION_FAILURES_TAB,
      viewValues(activeRows.filter(hasExtractionFailure)),
    );
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${RUN_LOG_TAB}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            row.runStartedAt,
            row.runFinishedAt,
            row.mode,
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

  private async replaceSheet(tabName: string, values: string[][]): Promise<void> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:${RAW_DATA_END_COLUMN}`,
    });
    const currentRowCount = googleValuesToRows(response.data.values).length;
    const targetRowCount = Math.max(currentRowCount, values.length);

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A1:${RAW_DATA_END_COLUMN}${String(targetRowCount)}`,
      valueInputOption: "RAW",
      requestBody: {
        values: padRows(values, targetRowCount),
      },
    });
  }
}

function viewValues(rows: SheetProductRow[]): string[][] {
  return [RAW_DATA_COLUMNS, ...rows.map(sheetProductRowToValues)];
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
      throw new Error(`${RAW_DATA_TAB} row ${String(sheetRowNumber)}: ${error.message}`, {
        cause: error,
      });
    }

    throw new Error(`${RAW_DATA_TAB} row ${String(sheetRowNumber)}: Failed to parse row`, {
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

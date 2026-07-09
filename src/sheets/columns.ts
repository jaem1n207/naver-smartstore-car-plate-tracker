import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { PlateExtractionStatus } from "../domain/plate/types.js";
import type { SheetProductRow } from "./types.js";

export type RawDataColumn = keyof SheetProductRow;

export const RAW_DATA_COLUMNS: RawDataColumn[] = [
  "storeKey",
  "storeName",
  "storeBaseUrl",
  "channelProductNo",
  "originProductNo",
  "productUrl",
  "productName",
  "productStatus",
  "displayStatus",
  "rawPlate",
  "normalizedPlate",
  "extractionStatus",
  "duplicateStatus",
  "firstSeenAt",
  "lastSyncedAt",
  "lastErrorAt",
  "errorMessage",
  "detailContentHash",
  "detailTextSnippet",
  "apiTraceId",
  "manualNote",
];

export function parseStoreKey(value: string): SheetProductRow["storeKey"] {
  if (value === "A" || value === "B") {
    return value;
  }

  return "A";
}

export function parsePlateExtractionStatus(value: string): PlateExtractionStatus {
  if (
    value === "success" ||
    value === "not_found" ||
    value === "invalid_format" ||
    value === "ambiguous"
  ) {
    return value;
  }

  return "not_found";
}

export function parseDuplicateStatus(value: string): DuplicateStatus {
  if (
    value === "unique" ||
    value === "duplicated_in_same_store" ||
    value === "duplicated_across_stores" ||
    value === "duplicated_both"
  ) {
    return value;
  }

  return "unique";
}

export function sheetProductRowToValues(row: SheetProductRow): string[] {
  return RAW_DATA_COLUMNS.map((column) => row[column]);
}

export function valuesToSheetProductRow(values: readonly string[]): SheetProductRow {
  return {
    storeKey: parseStoreKey(valueForColumn(values, "storeKey")),
    storeName: valueForColumn(values, "storeName"),
    storeBaseUrl: valueForColumn(values, "storeBaseUrl"),
    channelProductNo: valueForColumn(values, "channelProductNo"),
    originProductNo: valueForColumn(values, "originProductNo"),
    productUrl: valueForColumn(values, "productUrl"),
    productName: valueForColumn(values, "productName"),
    productStatus: valueForColumn(values, "productStatus"),
    displayStatus: valueForColumn(values, "displayStatus"),
    rawPlate: valueForColumn(values, "rawPlate"),
    normalizedPlate: valueForColumn(values, "normalizedPlate"),
    extractionStatus: parsePlateExtractionStatus(valueForColumn(values, "extractionStatus")),
    duplicateStatus: parseDuplicateStatus(valueForColumn(values, "duplicateStatus")),
    firstSeenAt: valueForColumn(values, "firstSeenAt"),
    lastSyncedAt: valueForColumn(values, "lastSyncedAt"),
    lastErrorAt: valueForColumn(values, "lastErrorAt"),
    errorMessage: valueForColumn(values, "errorMessage"),
    detailContentHash: valueForColumn(values, "detailContentHash"),
    detailTextSnippet: valueForColumn(values, "detailTextSnippet"),
    apiTraceId: valueForColumn(values, "apiTraceId"),
    manualNote: valueForColumn(values, "manualNote"),
  };
}

function valueForColumn(values: readonly string[], column: RawDataColumn): string {
  const index = RAW_DATA_COLUMNS.indexOf(column);

  return values[index] ?? "";
}

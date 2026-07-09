import { describe, expect, it } from "vitest";
import {
  RAW_DATA_COLUMNS,
  sheetProductRowToValues,
  valuesToSheetProductRow,
} from "../../src/sheets/columns.js";
import type { SheetProductRow } from "../../src/sheets/types.js";

const baseRow: SheetProductRow = {
  storeKey: "A",
  storeName: "Store A",
  storeBaseUrl: "https://example.com/store-a",
  channelProductNo: "2001",
  originProductNo: "1001",
  productUrl: "https://example.com/store-a/products/2001",
  productName: "Synthetic product",
  productStatus: "SALE",
  displayStatus: "ON",
  rawPlate: "123 가 4567",
  normalizedPlate: "123가4567",
  extractionStatus: "success",
  duplicateStatus: "unique",
  firstSeenAt: "2026-07-09T00:00:00.000Z",
  lastSyncedAt: "2026-07-09T00:00:00.000Z",
  lastErrorAt: "",
  errorMessage: "",
  detailContentHash: "hash",
  detailTextSnippet: "snippet",
  apiTraceId: "",
  manualNote: "note",
};

describe("sheet row column helpers", () => {
  it("round-trips a row through canonical values", () => {
    const values = sheetProductRowToValues(baseRow);

    expect(valuesToSheetProductRow(values)).toEqual(baseRow);
  });

  it("keeps column coverage aligned with SheetProductRow keys", () => {
    expect([...RAW_DATA_COLUMNS].sort()).toEqual(Object.keys(baseRow).sort());
  });

  it("uses empty strings for missing trailing cells", () => {
    const values = sheetProductRowToValues(baseRow).slice(0, -1);

    expect(valuesToSheetProductRow(values)).toEqual({
      ...baseRow,
      manualNote: "",
    });
  });

  it("rejects invalid enum cells instead of silently changing them", () => {
    const values = sheetProductRowToValues(baseRow);
    const storeKeyIndex = RAW_DATA_COLUMNS.indexOf("storeKey");
    const extractionStatusIndex = RAW_DATA_COLUMNS.indexOf("extractionStatus");
    const duplicateStatusIndex = RAW_DATA_COLUMNS.indexOf("duplicateStatus");

    values[storeKeyIndex] = "C";
    expect(() => valuesToSheetProductRow(values)).toThrow("Invalid storeKey value: C");

    values[storeKeyIndex] = "A";
    values[extractionStatusIndex] = "unknown";
    expect(() => valuesToSheetProductRow(values)).toThrow(
      "Invalid extractionStatus value: unknown",
    );

    values[extractionStatusIndex] = "success";
    values[duplicateStatusIndex] = "unknown";
    expect(() => valuesToSheetProductRow(values)).toThrow("Invalid duplicateStatus value: unknown");
  });
});

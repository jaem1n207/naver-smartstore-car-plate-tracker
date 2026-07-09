import { describe, expect, it } from "vitest";
import {
  ACROSS_STORES_DUPLICATES_TAB,
  EXTRACTION_FAILURES_TAB,
  SAME_STORE_DUPLICATES_TAB,
} from "../../src/sheets/columns.js";
import { InMemorySheetRepository } from "../../src/sheets/in-memory-repository.js";
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
  rawPlate: "123가4567",
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
  manualNote: "",
};

describe("InMemorySheetRepository", () => {
  it("excludes deleted rows from every view", async () => {
    const repository = new InMemorySheetRepository();
    const deletedRow: SheetProductRow = {
      ...baseRow,
      productStatus: "DELETE",
      extractionStatus: "not_found",
      duplicateStatus: "duplicated_both",
    };

    await repository.writeViews([baseRow, deletedRow]);

    expect(Object.values(repository.viewRows).every((rows) => rows.length <= 1)).toBe(true);
    expect(repository.viewRows[EXTRACTION_FAILURES_TAB]).toEqual([]);
    expect(repository.viewRows[ACROSS_STORES_DUPLICATES_TAB]).toEqual([]);
    expect(repository.viewRows[SAME_STORE_DUPLICATES_TAB]).toEqual([]);
  });

  it("clones rows at repository boundaries", async () => {
    const repository = new InMemorySheetRepository();
    const rows = [baseRow];

    await repository.writeRawData(rows);
    firstRow(rows).productName = "changed outside";
    const readRows = await repository.readRawData();
    firstRow(readRows).productName = "changed after read";

    expect(firstRow(repository.rawRows).productName).toBe("Synthetic product");
  });
});

function firstRow(rows: SheetProductRow[]): SheetProductRow {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one row");
  }

  return row;
}

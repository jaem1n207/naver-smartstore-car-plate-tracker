import { describe, expect, it } from "vitest";
import {
  A_STORE_DUPLICATES_TAB,
  A_STORE_VIEW_TAB,
  ACROSS_STORES_DUPLICATES_TAB,
  B_STORE_DUPLICATES_TAB,
  EXTRACTION_FAILURES_TAB,
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
    expect(repository.viewRows[A_STORE_DUPLICATES_TAB]).toEqual([]);
    expect(repository.viewRows[B_STORE_DUPLICATES_TAB]).toEqual([]);
  });

  it("keeps store-only and cross-store duplicate views mutually exclusive", async () => {
    const repository = new InMemorySheetRepository();
    const storeADuplicate: SheetProductRow = {
      ...baseRow,
      duplicateStatus: "duplicated_in_same_store",
    };
    const storeBDuplicate: SheetProductRow = {
      ...baseRow,
      storeKey: "B",
      storeName: "Store B",
      channelProductNo: "4001",
      productUrl: "https://example.com/store-b/products/4001",
      duplicateStatus: "duplicated_in_same_store",
    };
    const crossStoreDuplicate: SheetProductRow = {
      ...baseRow,
      channelProductNo: "2002",
      productUrl: "https://example.com/store-a/products/2002",
      duplicateStatus: "duplicated_both",
    };

    await repository.writeViews([storeADuplicate, storeBDuplicate, crossStoreDuplicate]);

    expect(repository.viewRows[A_STORE_DUPLICATES_TAB]).toEqual([storeADuplicate]);
    expect(repository.viewRows[B_STORE_DUPLICATES_TAB]).toEqual([storeBDuplicate]);
    expect(repository.viewRows[ACROSS_STORES_DUPLICATES_TAB]).toEqual([crossStoreDuplicate]);
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

  it("groups duplicate plates before unique inventory rows", async () => {
    const repository = new InMemorySheetRepository();
    const uniqueRow: SheetProductRow = {
      ...baseRow,
      channelProductNo: "3001",
      normalizedPlate: "999라9999",
    };
    const secondDuplicateRow: SheetProductRow = {
      ...baseRow,
      channelProductNo: "2002",
      normalizedPlate: "111가1111",
      duplicateStatus: "duplicated_in_same_store",
    };
    const firstDuplicateRow: SheetProductRow = {
      ...secondDuplicateRow,
      channelProductNo: "2001",
    };

    await repository.writeViews([uniqueRow, secondDuplicateRow, firstDuplicateRow]);

    expect(repository.viewRows[A_STORE_VIEW_TAB]?.map((row) => row.channelProductNo)).toEqual([
      "2001",
      "2002",
      "3001",
    ]);
  });
});

function firstRow(rows: SheetProductRow[]): SheetProductRow {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one row");
  }

  return row;
}

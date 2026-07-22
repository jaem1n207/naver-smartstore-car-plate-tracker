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

type DuplicateViewCase = {
  readonly name: string;
  readonly rows: SheetProductRow[];
  readonly storeAInternal: string[];
  readonly storeBInternal: string[];
  readonly crossStore: string[];
};

const DUPLICATE_VIEW_CASES: DuplicateViewCase[] = [
  {
    name: "A:2, B:0",
    rows: [
      duplicateRow("A", "1101", "10가1000", "duplicated_in_same_store"),
      duplicateRow("A", "1102", "10가1000", "duplicated_in_same_store"),
    ],
    storeAInternal: ["1101", "1102"],
    storeBInternal: [],
    crossStore: [],
  },
  {
    name: "A:2, B:1",
    rows: [
      duplicateRow("A", "2102", "20나2000", "duplicated_both"),
      duplicateRow("B", "4101", "20나2000", "duplicated_across_stores"),
      duplicateRow("A", "2101", "20나2000", "duplicated_both"),
    ],
    storeAInternal: ["2101", "2102"],
    storeBInternal: [],
    crossStore: ["2101", "2102", "4101"],
  },
  {
    name: "A:1, B:2",
    rows: [
      duplicateRow("B", "4202", "30다3000", "duplicated_both"),
      duplicateRow("A", "3101", "30다3000", "duplicated_across_stores"),
      duplicateRow("B", "4201", "30다3000", "duplicated_both"),
    ],
    storeAInternal: [],
    storeBInternal: ["4201", "4202"],
    crossStore: ["4201", "4202", "3101"],
  },
  {
    name: "A:2, B:2",
    rows: [
      duplicateRow("B", "4302", "40라4000", "duplicated_both"),
      duplicateRow("A", "5102", "40라4000", "duplicated_both"),
      duplicateRow("B", "4301", "40라4000", "duplicated_both"),
      duplicateRow("A", "5101", "40라4000", "duplicated_both"),
    ],
    storeAInternal: ["5101", "5102"],
    storeBInternal: ["4301", "4302"],
    crossStore: ["5101", "5102", "4301", "4302"],
  },
  {
    name: "A:1, B:1",
    rows: [
      duplicateRow("B", "4401", "50마5000", "duplicated_across_stores"),
      duplicateRow("A", "6101", "50마5000", "duplicated_across_stores"),
    ],
    storeAInternal: [],
    storeBInternal: [],
    crossStore: ["6101", "4401"],
  },
];

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

  it.each(DUPLICATE_VIEW_CASES)(
    "projects $name duplicate rows into task-oriented views",
    async ({ rows, storeAInternal, storeBInternal, crossStore }) => {
      const repository = new InMemorySheetRepository();

      await repository.writeViews(rows);

      expect(channelProductNumbers(repository.viewRows[A_STORE_DUPLICATES_TAB])).toEqual(
        storeAInternal,
      );
      expect(channelProductNumbers(repository.viewRows[B_STORE_DUPLICATES_TAB])).toEqual(
        storeBInternal,
      );
      expect(channelProductNumbers(repository.viewRows[ACROSS_STORES_DUPLICATES_TAB])).toEqual(
        crossStore,
      );
    },
  );

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

function duplicateRow(
  storeKey: SheetProductRow["storeKey"],
  channelProductNo: string,
  normalizedPlate: string,
  duplicateStatus: SheetProductRow["duplicateStatus"],
): SheetProductRow {
  const storeName = storeKey === "A" ? "Store A" : "Store B";
  const storeSlug = storeKey === "A" ? "store-a" : "store-b";

  return {
    ...baseRow,
    storeKey,
    storeName,
    storeBaseUrl: `https://example.com/${storeSlug}`,
    channelProductNo,
    productUrl: `https://example.com/${storeSlug}/products/${channelProductNo}`,
    rawPlate: normalizedPlate,
    normalizedPlate,
    duplicateStatus,
  };
}

function channelProductNumbers(rows: readonly SheetProductRow[] | undefined): string[] {
  return (rows ?? []).map((row) => row.channelProductNo);
}

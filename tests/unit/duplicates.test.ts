import { describe, expect, it } from "vitest";
import { analyzeDuplicates } from "../../src/domain/duplicates/analyze.js";
import type { ProductRecord } from "../../src/domain/duplicates/types.js";

const base: Pick<ProductRecord, "productName" | "extractionStatus"> = {
  productName: "product",
  extractionStatus: "success",
};

describe("analyzeDuplicates", () => {
  it("marks unique rows", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "2", normalizedPlate: "234나5678" },
    ];
    const result = analyzeDuplicates(rows);

    expect(result.map((row) => row.duplicateStatus)).toEqual(["unique", "unique"]);
    expect(result.map((row) => row.channelProductNo)).toEqual(["1", "2"]);
    expect(result[0]).toEqual({ ...rows[0], duplicateStatus: "unique" });
  });

  it("marks same-store duplicates", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "A", channelProductNo: "2", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_in_same_store",
      "duplicated_in_same_store",
    ]);
  });

  it("marks cross-store duplicates", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "2", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_across_stores",
      "duplicated_across_stores",
    ]);
  });

  it("marks rows that are duplicated both ways", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "A", channelProductNo: "2", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "3", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_both",
      "duplicated_both",
      "duplicated_across_stores",
    ]);
  });

  it("marks repeated rows in both stores as duplicated both ways", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "A", channelProductNo: "2", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "3", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "4", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_both",
      "duplicated_both",
      "duplicated_both",
      "duplicated_both",
    ]);
  });

  it("ignores extraction failures", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      {
        productName: "failure",
        storeKey: "B",
        channelProductNo: "2",
        extractionStatus: "not_found",
      },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual(["unique", "unique"]);
  });

  it("ignores successful rows without normalized plates", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "" },
      { ...base, storeKey: "B", channelProductNo: "2", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual(["unique", "unique"]);
  });
});

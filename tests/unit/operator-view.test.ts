import { describe, expect, it } from "vitest";
import {
  DISPLAY_STATUS_STYLES,
  DUPLICATE_GROUP_STYLE,
  duplicateStatusStyle,
  displayStatusStyle,
  findDuplicateGroups,
  productStatusStyle,
  PRODUCT_STATUS_STYLES,
  SHEET_HEADER_STYLE,
  sortOperatorRows,
  UNKNOWN_STATUS_STYLE,
} from "../../src/sheets/operator-view.js";
import type { SheetProductRow } from "../../src/sheets/types.js";

const baseRow: SheetProductRow = {
  storeKey: "A",
  storeName: "Store A",
  storeBaseUrl: "https://example.com/store-a",
  channelProductNo: "1",
  originProductNo: "1001",
  productUrl: "https://example.com/store-a/products/1",
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

describe("operator sheet presentation", () => {
  it("places duplicate plates first and keeps each plate group adjacent", () => {
    const rows = [
      row("4", "999라9999", "unique"),
      row("3", "222나2222", "duplicated_in_same_store"),
      row("2", "111가1111", "duplicated_both", "B"),
      row("5", "", "unique"),
      row("1", "111가1111", "duplicated_both"),
    ];

    const sortedRows = sortOperatorRows(rows);

    expect(sortedRows.map((candidate) => candidate.channelProductNo)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(findDuplicateGroups(sortedRows)).toEqual([
      { plate: "111가1111", startIndex: 0, endIndex: 2 },
      { plate: "222나2222", startIndex: 2, endIndex: 3 },
    ]);
  });

  it("uses color for duplicate and exception states while leaving normal states neutral", () => {
    expect(duplicateStatusStyle("unique")).toBeUndefined();
    expect(duplicateStatusStyle("duplicated_in_same_store")).toBe(DUPLICATE_GROUP_STYLE);
    expect(duplicateStatusStyle("duplicated_across_stores")).toBe(DUPLICATE_GROUP_STYLE);
    expect(duplicateStatusStyle("duplicated_both")).toBe(DUPLICATE_GROUP_STYLE);
    expect(displayStatusStyle("ON")).toBeUndefined();
    expect(productStatusStyle("SALE")).toBeUndefined();
    expect(displayStatusStyle("SUSPENSION")).toEqual(productStatusStyle("OUTOFSTOCK"));
    expect(productStatusStyle("REJECTION")).toEqual(productStatusStyle("PROHIBITION"));
    expect(productStatusStyle("UNKNOWN")).toEqual(UNKNOWN_STATUS_STYLE);
    expect(uniqueBackgroundCount(PRODUCT_STATUS_STYLES)).toBe(4);
    expect(uniqueBackgroundCount(DISPLAY_STATUS_STYLES)).toBe(2);
  });

  it("keeps every managed color pairing at WCAG AA contrast or better", () => {
    const styles = [
      SHEET_HEADER_STYLE,
      UNKNOWN_STATUS_STYLE,
      DUPLICATE_GROUP_STYLE,
      ...Object.values(PRODUCT_STATUS_STYLES),
      ...Object.values(DISPLAY_STATUS_STYLES),
    ];

    for (const style of styles) {
      expect(contrastRatio(style.foregroundHex, style.backgroundHex)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function row(
  channelProductNo: string,
  normalizedPlate: string,
  duplicateStatus: SheetProductRow["duplicateStatus"],
  storeKey: SheetProductRow["storeKey"] = "A",
): SheetProductRow {
  return {
    ...baseRow,
    storeKey,
    storeName: storeKey === "A" ? "Store A" : "Store B",
    channelProductNo,
    productUrl: `https://example.com/${storeKey}/products/${channelProductNo}`,
    normalizedPlate,
    duplicateStatus,
  };
}

function uniqueBackgroundCount(
  styles: Readonly<Record<string, { backgroundHex: string }>>,
): number {
  return new Set(Object.values(styles).map((style) => style.backgroundHex)).size;
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const foreground = relativeLuminance(foregroundHex);
  const background = relativeLuminance(backgroundHex);
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);

  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((channel) =>
    Number.parseInt(channel, 16),
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const normalized = channel / 255;

    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

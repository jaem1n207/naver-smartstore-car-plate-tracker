import { describe, expect, it } from "vitest";
import type { DuplicateStatus } from "../../src/domain/duplicates/types.js";
import type { PlateExtractionStatus } from "../../src/domain/plate/types.js";
import {
  createManagedSheetTabs,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
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

const extractionStatusCases: Array<{
  status: PlateExtractionStatus;
  label: string;
}> = [
  { status: "success", label: "성공" },
  { status: "not_found", label: "찾지 못함" },
  { status: "invalid_format", label: "형식 오류" },
  { status: "ambiguous", label: "여러 후보" },
];

const duplicateStatusCases: Array<{
  status: DuplicateStatus;
  label: string;
}> = [
  { status: "unique", label: "중복 없음" },
  { status: "duplicated_in_same_store", label: "스토어 내부 중복" },
  { status: "duplicated_across_stores", label: "양쪽 스토어 중복" },
  { status: "duplicated_both", label: "내부 및 양쪽 중복" },
];

describe("sheet row column helpers", () => {
  it("round-trips a row through canonical values", () => {
    const values = sheetProductRowToValues(baseRow);

    expect(valuesToSheetProductRow(values)).toEqual(baseRow);
    expect(values[11]).toBe("성공");
    expect(values[12]).toBe("중복 없음");
  });

  it("uses Korean headers for every canonical column", () => {
    expect(RAW_DATA_HEADERS).toEqual([
      "내부 스토어 코드",
      "스토어 표시명",
      "스토어 주소",
      "채널 상품번호",
      "원상품번호",
      "상품 URL",
      "상품명",
      "상품 상태",
      "전시 상태",
      "차량번호 원본",
      "정규화 차량번호",
      "추출 상태",
      "중복 상태",
      "최초 감지일시",
      "마지막 동기화일시",
      "마지막 오류일시",
      "오류 메시지",
      "상세설명 해시",
      "상세설명 일부",
      "API 추적 ID",
      "관리자 메모",
    ]);
  });

  it("uses configured store display names in operator-facing tab titles", () => {
    const tabs = createManagedSheetTabs("동부트럭 (store-east)", "서부트럭 (store-west)");

    expect(tabs.names.storeAView).toBe("동부트럭 (store-east) 매물");
    expect(tabs.names.storeBView).toBe("서부트럭 (store-west) 매물");
    expect(tabs.names.acrossStoresDuplicates).toBe(
      "동부트럭 (store-east)·서부트럭 (store-west) 공통 매물",
    );
    expect(tabs.definitions[1]?.legacyTitles).toEqual(["A스토어 매물", "A_Store_View"]);
    expect(tabs.definitions[2]?.legacyTitles).toEqual(["B스토어 매물", "B_Store_View"]);
  });

  it("sanitizes invalid Google Sheets title characters and caps title length", () => {
    const longName = "가".repeat(120);
    const tabs = createManagedSheetTabs("동부/트럭", longName);

    expect(tabs.names.storeAView).toBe("동부 트럭 매물");
    expect(Array.from(tabs.names.storeBView)).toHaveLength(100);
    expect(tabs.names.storeBView.endsWith(" 매물")).toBe(true);
  });

  it("continues to parse legacy English status values", () => {
    const values = sheetProductRowToValues(baseRow);
    values[11] = "not_found";
    values[12] = "duplicated_across_stores";

    expect(valuesToSheetProductRow(values)).toEqual({
      ...baseRow,
      extractionStatus: "not_found",
      duplicateStatus: "duplicated_across_stores",
    });
  });

  it("round-trips every Korean extraction and duplicate status label", () => {
    for (const extractionCase of extractionStatusCases) {
      for (const duplicateCase of duplicateStatusCases) {
        const row: SheetProductRow = {
          ...baseRow,
          extractionStatus: extractionCase.status,
          duplicateStatus: duplicateCase.status,
        };
        const values = sheetProductRowToValues(row);

        expect(values[11]).toBe(extractionCase.label);
        expect(values[12]).toBe(duplicateCase.label);
        expect(valuesToSheetProductRow(values)).toEqual(row);
      }
    }
  });

  it("keeps column coverage aligned with SheetProductRow keys", () => {
    expect(RAW_DATA_COLUMNS).toEqual([
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
    ]);
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

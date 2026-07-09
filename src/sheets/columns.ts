import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { PlateExtractionStatus } from "../domain/plate/types.js";
import type { SheetProductRow } from "./types.js";

export type RawDataColumn = keyof SheetProductRow;

export interface SheetTabDefinition {
  readonly title: string;
  readonly legacyTitles: readonly string[];
  readonly columnCount: number;
}

export interface SheetTabNames {
  readonly rawData: string;
  readonly storeAView: string;
  readonly storeBView: string;
  readonly acrossStoresDuplicates: string;
  readonly sameStoreDuplicates: string;
  readonly extractionFailures: string;
  readonly runLog: string;
}

export interface ManagedSheetTabs {
  readonly names: SheetTabNames;
  readonly definitions: readonly SheetTabDefinition[];
}

export const RAW_DATA_TAB = "원본 데이터";
export const A_STORE_VIEW_TAB = "A스토어 매물";
export const B_STORE_VIEW_TAB = "B스토어 매물";
export const ACROSS_STORES_DUPLICATES_TAB = "양쪽 스토어 중복";
export const SAME_STORE_DUPLICATES_TAB = "스토어 내부 중복";
export const EXTRACTION_FAILURES_TAB = "차량번호 추출 실패";
export const RUN_LOG_TAB = "실행 기록";

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

const RAW_DATA_HEADER_BY_COLUMN: Record<RawDataColumn, string> = {
  storeKey: "내부 스토어 코드",
  storeName: "스토어 표시명",
  storeBaseUrl: "스토어 주소",
  channelProductNo: "채널 상품번호",
  originProductNo: "원상품번호",
  productUrl: "상품 URL",
  productName: "상품명",
  productStatus: "상품 상태",
  displayStatus: "전시 상태",
  rawPlate: "차량번호 원본",
  normalizedPlate: "정규화 차량번호",
  extractionStatus: "추출 상태",
  duplicateStatus: "중복 상태",
  firstSeenAt: "최초 감지일시",
  lastSyncedAt: "마지막 동기화일시",
  lastErrorAt: "마지막 오류일시",
  errorMessage: "오류 메시지",
  detailContentHash: "상세설명 해시",
  detailTextSnippet: "상세설명 일부",
  apiTraceId: "API 추적 ID",
  manualNote: "관리자 메모",
};

const EXTRACTION_STATUS_LABELS: Record<PlateExtractionStatus, string> = {
  success: "성공",
  not_found: "찾지 못함",
  invalid_format: "형식 오류",
  ambiguous: "여러 후보",
};

const DUPLICATE_STATUS_LABELS: Record<DuplicateStatus, string> = {
  unique: "중복 없음",
  duplicated_in_same_store: "스토어 내부 중복",
  duplicated_across_stores: "양쪽 스토어 중복",
  duplicated_both: "내부 및 양쪽 중복",
};

export const RAW_DATA_HEADERS = RAW_DATA_COLUMNS.map((column) => RAW_DATA_HEADER_BY_COLUMN[column]);

export const RUN_LOG_HEADERS: string[] = [
  "실행 시작일시",
  "실행 종료일시",
  "실행 모드",
  "전체 상품 수",
  "추출 성공 수",
  "추출 실패 수",
  "중복 상품 수",
  "실행 결과",
];

export function createManagedSheetTabs(
  storeADisplayName: string,
  storeBDisplayName: string,
): ManagedSheetTabs {
  const names: SheetTabNames = {
    rawData: RAW_DATA_TAB,
    storeAView: sheetTitle(storeADisplayName, "매물"),
    storeBView: sheetTitle(storeBDisplayName, "매물"),
    acrossStoresDuplicates: sheetTitle(`${storeADisplayName}·${storeBDisplayName}`, "공통 매물"),
    sameStoreDuplicates: SAME_STORE_DUPLICATES_TAB,
    extractionFailures: EXTRACTION_FAILURES_TAB,
    runLog: RUN_LOG_TAB,
  };

  return {
    names,
    definitions: [
      {
        title: names.rawData,
        legacyTitles: ["RawData"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.storeAView,
        legacyTitles: [A_STORE_VIEW_TAB, "A_Store_View"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.storeBView,
        legacyTitles: [B_STORE_VIEW_TAB, "B_Store_View"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.acrossStoresDuplicates,
        legacyTitles: [ACROSS_STORES_DUPLICATES_TAB, "Across_Stores_Duplicates"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.sameStoreDuplicates,
        legacyTitles: ["Same_Store_Duplicates"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.extractionFailures,
        legacyTitles: ["Extraction_Failures"],
        columnCount: RAW_DATA_COLUMNS.length,
      },
      {
        title: names.runLog,
        legacyTitles: ["RunLog"],
        columnCount: RUN_LOG_HEADERS.length,
      },
    ],
  };
}

export function parseStoreKey(value: string): SheetProductRow["storeKey"] {
  if (value === "A" || value === "B") {
    return value;
  }

  throw new Error(`Invalid storeKey value: ${value}`);
}

export function parsePlateExtractionStatus(value: string): PlateExtractionStatus {
  switch (value) {
    case "success":
    case "성공":
      return "success";
    case "not_found":
    case "찾지 못함":
      return "not_found";
    case "invalid_format":
    case "형식 오류":
      return "invalid_format";
    case "ambiguous":
    case "여러 후보":
      return "ambiguous";
    default:
      throw new Error(`Invalid extractionStatus value: ${value}`);
  }
}

export function parseDuplicateStatus(value: string): DuplicateStatus {
  switch (value) {
    case "unique":
    case "중복 없음":
      return "unique";
    case "duplicated_in_same_store":
    case "스토어 내부 중복":
      return "duplicated_in_same_store";
    case "duplicated_across_stores":
    case "양쪽 스토어 중복":
      return "duplicated_across_stores";
    case "duplicated_both":
    case "내부 및 양쪽 중복":
      return "duplicated_both";
    default:
      throw new Error(`Invalid duplicateStatus value: ${value}`);
  }
}

export function sheetProductRowToValues(row: SheetProductRow): string[] {
  return RAW_DATA_COLUMNS.map((column) => valueForSheet(row, column));
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

function valueForSheet(row: SheetProductRow, column: RawDataColumn): string {
  if (column === "extractionStatus") {
    return EXTRACTION_STATUS_LABELS[row.extractionStatus];
  }

  if (column === "duplicateStatus") {
    return DUPLICATE_STATUS_LABELS[row.duplicateStatus];
  }

  return row[column];
}

function sheetTitle(prefix: string, suffix: string): string {
  const normalizedPrefix = prefix
    .replace(/[:\\/?*[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const safePrefix = normalizedPrefix.length > 0 ? normalizedPrefix : "스토어";
  const suffixWithSpace = ` ${suffix}`;
  const maxPrefixCharacters = 100 - Array.from(suffixWithSpace).length;

  return `${Array.from(safePrefix).slice(0, maxPrefixCharacters).join("")}${suffixWithSpace}`;
}

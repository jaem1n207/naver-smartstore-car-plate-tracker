import { createHash } from "node:crypto";
import { load } from "cheerio";
import he from "he";
import type { AppEnv } from "../config/env.js";
import type { StoreConfig } from "../config/stores.js";
import type { DuplicateStatus } from "../domain/duplicates/types.js";
import { analyzeDuplicates } from "../domain/duplicates/analyze.js";
import { extractPlateFromHtml } from "../domain/plate/extract.js";
import type { PlateExtractionResult } from "../domain/plate/types.js";
import type {
  NaverCommerceClient,
  NaverProductDetail,
  NaverProductSummary,
} from "../naver/types.js";
import type { SheetProductRow, SheetRepository, SyncScope } from "../sheets/types.js";

export interface SyncJobDependencies {
  readonly env: AppEnv;
  readonly stores: readonly StoreConfig[];
  readonly naverClient: NaverCommerceClient;
  readonly sheetRepository: SheetRepository;
  readonly now: () => Date;
}

export interface SyncJobResult {
  readonly syncScope: SyncScope;
  readonly selectedStores: readonly string[];
  readonly syncedProductsThisRun: number;
  readonly sheetTotalProducts: number;
  readonly sheetExtractionSuccess: number;
  readonly sheetExtractionFailure: number;
  readonly sheetDuplicateProductRows: number;
  readonly summary: string;
}

export async function runSyncJob(dependencies: SyncJobDependencies): Promise<SyncJobResult> {
  const selectedStoreKeys = validateSelectedStores(dependencies.stores);
  await dependencies.sheetRepository.prepareRunLog();
  const runStartedAt = dependencies.now().toISOString();
  const existingRows = await dependencies.sheetRepository.readRawData();
  const existingRowsByProduct = mapRowsByProduct(existingRows);
  const rows = existingRows.filter((row) => !selectedStoreKeys.has(row.storeKey));
  let syncedProductCount = 0;

  for (const store of dependencies.stores) {
    const summaries = await dependencies.naverClient.searchProducts(store);

    for (const summary of summaries.filter(isNotDeletedProduct)) {
      const detail = await dependencies.naverClient.getProductDetail(
        store,
        summary.channelProductNo,
      );
      const mergedProduct = mergeDetailWithSummary(summary, detail);
      const existingRow = existingRowsByProduct.get(
        productKey(store.storeKey, mergedProduct.channelProductNo),
      );

      rows.push(createSheetProductRow(store, mergedProduct, existingRow, runStartedAt));
      syncedProductCount += 1;
    }
  }

  const rowsWithDuplicateStatuses = applyDuplicateStatuses(rows);
  const sheetSummary = summarizeRows(rowsWithDuplicateStatuses);
  const syncScope = syncScopeForStoreKeys(selectedStoreKeys);
  const selectedStores = dependencies.stores.map((store) => store.storeDisplayName);
  const result: SyncJobResult = {
    syncScope,
    selectedStores,
    syncedProductsThisRun: syncedProductCount,
    ...sheetSummary,
    summary: syncRunSummary(syncScope, selectedStores, syncedProductCount, sheetSummary),
  };

  await dependencies.sheetRepository.writeRawData(rowsWithDuplicateStatuses);
  await dependencies.sheetRepository.writeViews(rowsWithDuplicateStatuses);
  await dependencies.sheetRepository.appendRunLog({
    runStartedAt,
    runFinishedAt: dependencies.now().toISOString(),
    mode: dependencies.env.naverApiMode,
    ...result,
  });

  return result;
}

function validateSelectedStores(
  stores: readonly StoreConfig[],
): ReadonlySet<StoreConfig["storeKey"]> {
  if (stores.length === 0) {
    throw new Error("동기화 대상 스토어를 하나 이상 선택해야 합니다");
  }

  const storeKeys = new Set<StoreConfig["storeKey"]>();

  for (const store of stores) {
    if (storeKeys.has(store.storeKey)) {
      throw new Error(`동기화 대상 스토어 키가 중복되었습니다: ${store.storeKey}`);
    }

    storeKeys.add(store.storeKey);
  }

  return storeKeys;
}

function syncScopeForStoreKeys(storeKeys: ReadonlySet<StoreConfig["storeKey"]>): SyncScope {
  return storeKeys.size === 2 && storeKeys.has("A") && storeKeys.has("B")
    ? "all_stores"
    : "selected_stores";
}

function syncRunSummary(
  syncScope: SyncScope,
  selectedStores: readonly string[],
  syncedProductCount: number,
  sheetSummary: WholeSheetSummary,
): string {
  const scopeLabel = syncScope === "all_stores" ? "전체 스토어" : "선택 스토어";

  return `${scopeLabel} 동기화 완료 | 대상: ${selectedStores.join(", ")} | 이번 실행 동기화 ${String(syncedProductCount)}개 | 시트 전체 상품 ${String(sheetSummary.sheetTotalProducts)}개 | 시트 전체 차량번호 추출 성공 ${String(sheetSummary.sheetExtractionSuccess)}개, 실패 ${String(sheetSummary.sheetExtractionFailure)}개 | 시트 전체 중복 상태 상품 행 ${String(sheetSummary.sheetDuplicateProductRows)}개`;
}

type MergedProduct = {
  readonly originProductNo: string;
  readonly channelProductNo: string;
  readonly productName: string;
  readonly productStatus: string;
  readonly displayStatus: string;
  readonly detailContent: string;
};

function isNotDeletedProduct(summary: NaverProductSummary): boolean {
  return summary.productStatus !== "DELETE";
}

function mapRowsByProduct(rows: readonly SheetProductRow[]): Map<string, SheetProductRow> {
  const rowsByProduct = new Map<string, SheetProductRow>();

  for (const row of rows) {
    rowsByProduct.set(productKey(row.storeKey, row.channelProductNo), row);
  }

  return rowsByProduct;
}

function productKey(storeKey: StoreConfig["storeKey"], channelProductNo: string): string {
  return `${storeKey}:${channelProductNo}`;
}

function mergeDetailWithSummary(
  summary: NaverProductSummary,
  detail: NaverProductDetail,
): MergedProduct {
  return {
    originProductNo: nonEmptyValue(detail.originProductNo, summary.originProductNo),
    channelProductNo: nonEmptyValue(detail.channelProductNo, summary.channelProductNo),
    productName: nonEmptyValue(detail.productName, summary.productName),
    productStatus: nonEmptyValue(detail.productStatus, summary.productStatus),
    displayStatus: nonEmptyValue(detail.displayStatus, summary.displayStatus),
    detailContent: detail.detailContent,
  };
}

function nonEmptyValue(
  preferredValue: string | undefined,
  fallbackValue: string | undefined,
): string {
  if (preferredValue !== undefined && preferredValue.trim().length > 0) {
    return preferredValue;
  }

  if (fallbackValue !== undefined && fallbackValue.trim().length > 0) {
    return fallbackValue;
  }

  return "";
}

function createSheetProductRow(
  store: StoreConfig,
  product: MergedProduct,
  existingRow: SheetProductRow | undefined,
  syncedAt: string,
): SheetProductRow {
  const extraction = extractPlateFromHtml(product.detailContent);
  const extractionFailureMessage = failureMessageForExtraction(extraction);

  return {
    storeKey: store.storeKey,
    storeName: store.storeDisplayName,
    storeBaseUrl: store.storeBaseUrl,
    channelProductNo: product.channelProductNo,
    originProductNo: product.originProductNo,
    productUrl: productUrl(store.storeBaseUrl, product.channelProductNo),
    productName: product.productName,
    productStatus: product.productStatus,
    displayStatus: product.displayStatus,
    rawPlate: rawPlateForExtraction(extraction),
    normalizedPlate: normalizedPlateForExtraction(extraction),
    extractionStatus: extraction.status,
    duplicateStatus: "unique",
    firstSeenAt: existingRow?.firstSeenAt ?? syncedAt,
    lastSyncedAt: syncedAt,
    lastErrorAt: extraction.status === "success" ? "" : syncedAt,
    errorMessage: extractionFailureMessage,
    detailContentHash: sha256Hex(product.detailContent),
    detailTextSnippet: readableSnippet(product.detailContent),
    apiTraceId: "",
    manualNote: existingRow?.manualNote ?? "",
  };
}

function rawPlateForExtraction(extraction: PlateExtractionResult): string {
  if (extraction.status === "success" || extraction.status === "invalid_format") {
    return extraction.rawPlate;
  }

  return "";
}

function normalizedPlateForExtraction(extraction: PlateExtractionResult): string {
  if (extraction.status === "success") {
    return extraction.normalizedPlate;
  }

  return "";
}

function failureMessageForExtraction(extraction: PlateExtractionResult): string {
  if (extraction.status === "success") {
    return "";
  }

  return extraction.message;
}

function productUrl(storeBaseUrl: string, channelProductNo: string): string {
  return `${storeBaseUrl.replace(/\/+$/u, "")}/products/${channelProductNo}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readableSnippet(html: string): string {
  const $ = load(html);

  $("script, style, noscript").remove();

  const text = he.decode($.root().text()).normalize("NFKC").replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);

  if (characters.length <= 120) {
    return text;
  }

  return characters.slice(0, 120).join("");
}

function applyDuplicateStatuses(rows: readonly SheetProductRow[]): SheetProductRow[] {
  const duplicateStatusesByProduct = new Map<string, DuplicateStatus>();

  for (const analyzedRow of analyzeDuplicates(rows)) {
    duplicateStatusesByProduct.set(
      productKey(analyzedRow.storeKey, analyzedRow.channelProductNo),
      analyzedRow.duplicateStatus,
    );
  }

  return rows.map((row) => ({
    ...row,
    duplicateStatus:
      duplicateStatusesByProduct.get(productKey(row.storeKey, row.channelProductNo)) ?? "unique",
  }));
}

type WholeSheetSummary = {
  readonly sheetTotalProducts: number;
  readonly sheetExtractionSuccess: number;
  readonly sheetExtractionFailure: number;
  readonly sheetDuplicateProductRows: number;
};

function summarizeRows(rows: readonly SheetProductRow[]): WholeSheetSummary {
  const sheetExtractionSuccess = rows.filter((row) => row.extractionStatus === "success").length;
  const sheetDuplicateProductRows = rows.filter((row) => row.duplicateStatus !== "unique").length;

  return {
    sheetTotalProducts: rows.length,
    sheetExtractionSuccess,
    sheetExtractionFailure: rows.length - sheetExtractionSuccess,
    sheetDuplicateProductRows,
  };
}

import { describe, expect, it } from "vitest";
import type { StoreConfig } from "../../src/config/stores.js";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";
import { MockNaverCommerceClient } from "../../src/naver/mock-client.js";
import type { NaverProductSummary } from "../../src/naver/types.js";
import { ACROSS_STORES_DUPLICATES_TAB, EXTRACTION_FAILURES_TAB } from "../../src/sheets/columns.js";
import { InMemorySheetRepository } from "../../src/sheets/in-memory-repository.js";
import type { SheetProductRow } from "../../src/sheets/types.js";
import { runSyncJob } from "../../src/sync/sync-job.js";

const env = loadEnv({
  NODE_ENV: "test",
  TZ: "Asia/Seoul",
  LOG_LEVEL: "silent",
  NAVER_API_MODE: "mock",
  ALLOW_LIVE_NAVER_API: "false",
  NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
  SYNC_CRON: "*/5 * * * *",
  STORE_A_NAME: "Store A",
  STORE_A_BASE_URL: "https://example.com/store-a",
  STORE_A_CLIENT_ID: "store-a-client",
  STORE_A_CLIENT_SECRET: "store-a-secret",
  STORE_B_NAME: "Store B",
  STORE_B_BASE_URL: "https://example.com/store-b",
  STORE_B_CLIENT_ID: "store-b-client",
  STORE_B_CLIENT_SECRET: "store-b-secret",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
});

describe("runSyncJob", () => {
  it("returns explicit whole-sheet totals for a full-store sync", async () => {
    const sheets = new InMemorySheetRepository();
    const result = await runSyncJob({
      env,
      stores: loadStores(env),
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(result).toEqual({
      syncScope: "all_stores",
      selectedStores: ["Store A (store-a)", "Store B (store-b)"],
      syncedProductsThisRun: 5,
      sheetTotalProducts: 5,
      sheetExtractionSuccess: 4,
      sheetExtractionFailure: 1,
      sheetDuplicateProductRows: 3,
      summary:
        "전체 스토어 동기화 완료 | 대상: Store A (store-a), Store B (store-b) | 이번 실행 동기화 5개 | 시트 전체 상품 5개 | 시트 전체 차량번호 추출 성공 4개, 실패 1개 | 시트 전체 중복 상태 상품 행 3개",
    });
    expect(sheets.rawRows).toHaveLength(5);
    expect(sheets.rawRows.find((row) => row.storeKey === "A")?.storeName).toBe("Store A (store-a)");
    expect(sheets.rawRows.find((row) => row.storeKey === "B")?.storeName).toBe("Store B (store-b)");
    expect(sheets.viewRows[EXTRACTION_FAILURES_TAB]).toHaveLength(1);
    expect(sheets.viewRows[ACROSS_STORES_DUPLICATES_TAB]).toHaveLength(3);
    expect(sheets.runLogs).toHaveLength(1);
    expect(sheets.runLogs[0]).toEqual({
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:00:00.000Z",
      mode: "mock",
      ...result,
    });
  });

  it("preserves firstSeenAt and manualNote during upsert", async () => {
    const sheets = new InMemorySheetRepository();
    sheets.rawRows = [
      {
        storeKey: "A",
        storeName: "Store A",
        storeBaseUrl: "https://example.com/store-a",
        channelProductNo: "2001",
        originProductNo: "1001",
        productUrl: "https://example.com/store-a/products/2001",
        productName: "old",
        productStatus: "SALE",
        displayStatus: "ON",
        rawPlate: "",
        normalizedPlate: "",
        extractionStatus: "not_found",
        duplicateStatus: "unique",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        lastErrorAt: "",
        errorMessage: "",
        detailContentHash: "",
        detailTextSnippet: "",
        apiTraceId: "",
        manualNote: "operator note",
      },
    ];

    await runSyncJob({
      env,
      stores: loadStores(env),
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const row = sheets.rawRows.find((candidate) => candidate.channelProductNo === "2001");

    expect(row?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.manualNote).toBe("operator note");
  });

  it("returns current-run counts separately from preserved sheet rows for a store-scoped sync", async () => {
    const sheets = new InMemorySheetRepository();
    const configuredStores = loadStores(env);
    sheets.rawRows = [existingStoreBRow()];

    const result = await runSyncJob({
      env,
      stores: [configuredStores[0]],
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(sheets.rawRows.filter((row) => row.storeKey === "A")).toHaveLength(3);
    expect(sheets.rawRows.filter((row) => row.storeKey === "B")).toEqual([existingStoreBRow()]);
    expect(result).toEqual({
      syncScope: "selected_stores",
      selectedStores: ["Store A (store-a)"],
      syncedProductsThisRun: 3,
      sheetTotalProducts: 4,
      sheetExtractionSuccess: 3,
      sheetExtractionFailure: 1,
      sheetDuplicateProductRows: 2,
      summary:
        "선택 스토어 동기화 완료 | 대상: Store A (store-a) | 이번 실행 동기화 3개 | 시트 전체 상품 4개 | 시트 전체 차량번호 추출 성공 3개, 실패 1개 | 시트 전체 중복 상태 상품 행 2개",
    });
    expect(sheets.runLogs[0]).toEqual({
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:00:00.000Z",
      mode: "mock",
      ...result,
    });
  });

  it("rejects duplicate store keys before API calls or Sheet writes", async () => {
    const sheets = new InMemorySheetRepository();
    const naverClient = new CountingMockNaverCommerceClient();
    const storeA = loadStores(env)[0];

    await expect(
      runSyncJob({
        env,
        stores: [storeA, storeA],
        naverClient,
        sheetRepository: sheets,
        now: () => new Date("2026-07-09T00:00:00.000Z"),
      }),
    ).rejects.toThrow("동기화 대상 스토어 키가 중복되었습니다: A");

    expect(naverClient.searchCalls).toBe(0);
    expect(sheets.rawRows).toEqual([]);
    expect(sheets.viewRows).toEqual({});
    expect(sheets.runLogs).toEqual([]);
  });

  it("rejects an empty store selection before API calls or Sheet writes", async () => {
    const sheets = new InMemorySheetRepository();
    const naverClient = new CountingMockNaverCommerceClient();

    await expect(
      runSyncJob({
        env,
        stores: [],
        naverClient,
        sheetRepository: sheets,
        now: () => new Date("2026-07-09T00:00:00.000Z"),
      }),
    ).rejects.toThrow("동기화 대상 스토어를 하나 이상 선택해야 합니다");

    expect(naverClient.searchCalls).toBe(0);
    expect(sheets.rawRows).toEqual([]);
    expect(sheets.viewRows).toEqual({});
    expect(sheets.runLogs).toEqual([]);
  });

  it("stops before Sheet reads, Naver API calls, or writes when run-log preflight fails", async () => {
    const sheets = new PreflightFailingSheetRepository();
    const naverClient = new CountingMockNaverCommerceClient();

    await expect(
      runSyncJob({
        env,
        stores: loadStores(env),
        naverClient,
        sheetRepository: sheets,
        now: () => new Date("2026-07-09T00:00:00.000Z"),
      }),
    ).rejects.toThrow("invalid run-log header");

    expect(sheets.preflightCalls).toBe(1);
    expect(sheets.readCalls).toBe(0);
    expect(naverClient.searchCalls).toBe(0);
    expect(sheets.rawWriteCalls).toBe(0);
    expect(sheets.viewWriteCalls).toBe(0);
    expect(sheets.runLogAppendCalls).toBe(0);
  });
});

class CountingMockNaverCommerceClient extends MockNaverCommerceClient {
  searchCalls = 0;

  override async searchProducts(store: StoreConfig): Promise<NaverProductSummary[]> {
    this.searchCalls += 1;

    return super.searchProducts(store);
  }
}

class PreflightFailingSheetRepository extends InMemorySheetRepository {
  preflightCalls = 0;
  readCalls = 0;
  rawWriteCalls = 0;
  viewWriteCalls = 0;
  runLogAppendCalls = 0;

  prepareRunLog(): Promise<void> {
    this.preflightCalls += 1;

    return Promise.reject(new Error("invalid run-log header"));
  }

  override readRawData(): Promise<SheetProductRow[]> {
    this.readCalls += 1;

    return super.readRawData();
  }

  override writeRawData(rows: SheetProductRow[]): Promise<void> {
    this.rawWriteCalls += 1;

    return super.writeRawData(rows);
  }

  override writeViews(rows: SheetProductRow[]): Promise<void> {
    this.viewWriteCalls += 1;

    return super.writeViews(rows);
  }

  override appendRunLog(
    row: Parameters<InMemorySheetRepository["appendRunLog"]>[0],
  ): Promise<void> {
    this.runLogAppendCalls += 1;

    return super.appendRunLog(row);
  }
}

function existingStoreBRow(): SheetProductRow {
  return {
    storeKey: "B",
    storeName: "Store B (store-b)",
    storeBaseUrl: "https://example.com/store-b",
    channelProductNo: "2999",
    originProductNo: "1999",
    productUrl: "https://example.com/store-b/products/2999",
    productName: "existing Store B product",
    productStatus: "SALE",
    displayStatus: "ON",
    rawPlate: "999하9999",
    normalizedPlate: "999하9999",
    extractionStatus: "success",
    duplicateStatus: "unique",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    lastErrorAt: "",
    errorMessage: "",
    detailContentHash: "existing-hash",
    detailTextSnippet: "existing snippet",
    apiTraceId: "",
    manualNote: "preserve me",
  };
}

import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";
import { MockNaverCommerceClient } from "../../src/naver/mock-client.js";
import { ACROSS_STORES_DUPLICATES_TAB, EXTRACTION_FAILURES_TAB } from "../../src/sheets/columns.js";
import { InMemorySheetRepository } from "../../src/sheets/in-memory-repository.js";
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
  STORE_A_ACCOUNT_ID: "store-a-account",
  STORE_B_NAME: "Store B",
  STORE_B_BASE_URL: "https://example.com/store-b",
  STORE_B_CLIENT_ID: "store-b-client",
  STORE_B_CLIENT_SECRET: "store-b-secret",
  STORE_B_ACCOUNT_ID: "store-b-account",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
});

describe("runSyncJob", () => {
  it("syncs mock products into raw and view rows", async () => {
    const sheets = new InMemorySheetRepository();
    const result = await runSyncJob({
      env,
      stores: loadStores(env),
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(result.totalProducts).toBe(5);
    expect(result.successCount).toBe(4);
    expect(result.failureCount).toBe(1);
    expect(sheets.rawRows).toHaveLength(5);
    expect(sheets.viewRows[EXTRACTION_FAILURES_TAB]).toHaveLength(1);
    expect(sheets.viewRows[ACROSS_STORES_DUPLICATES_TAB]).toHaveLength(3);
    expect(sheets.runLogs).toHaveLength(1);
    expect(sheets.runLogs[0]?.message).toBe("총 5개 상품 동기화 완료");
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
});

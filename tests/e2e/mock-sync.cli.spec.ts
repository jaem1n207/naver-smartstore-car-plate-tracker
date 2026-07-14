import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("mock sync CLI emits explicit full-store result JSON", async () => {
  const { stdout, stderr } = await execFileAsync(
    "node",
    ["--import", "tsx", "src/cli/sync-once.ts"],
    {
      env: cliEnv(),
      timeout: 20_000,
    },
  );

  expect(stderr).toBe("");
  expect(stdout).not.toContain("store-a-secret");
  expect(stdout).not.toContain("store-b-secret");
  expectSyncLog(stdout, {
    syncScope: "all_stores",
    selectedStores: ["Store A (store-a)", "Store B (store-b)"],
    syncedProductsThisRun: 5,
    sheetTotalProducts: 5,
    sheetExtractionSuccess: 4,
    sheetExtractionFailure: 1,
    sheetDuplicateProductRows: 3,
  });
});

test("mock sync CLI emits explicit selected-store result JSON for a Smartstore URL slug", async () => {
  const { stdout, stderr } = await execFileAsync(
    "node",
    ["--import", "tsx", "src/cli/sync-once.ts", "--store=store-a"],
    {
      env: cliEnv(),
      timeout: 20_000,
    },
  );

  expect(stderr).toBe("");
  expect(stdout).not.toContain("store-a-secret");
  expect(stdout).not.toContain("store-b-secret");
  expectSyncLog(stdout, {
    syncScope: "selected_stores",
    selectedStores: ["Store A (store-a)"],
    syncedProductsThisRun: 3,
    sheetTotalProducts: 3,
    sheetExtractionSuccess: 2,
    sheetExtractionFailure: 1,
    sheetDuplicateProductRows: 2,
  });
});

function expectSyncLog(stdout: string, expected: Record<string, unknown>): void {
  const logs = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);

      return parsed;
    })
    .filter(isRecord);
  const syncLog = logs.find((log) => log.msg === "sync completed");

  expect(syncLog).toBeDefined();
  expect(syncLog).toMatchObject(expected);
  expect(syncLog).not.toHaveProperty("totalProducts");
  expect(syncLog).not.toHaveProperty("successCount");
  expect(syncLog).not.toHaveProperty("failureCount");
  expect(syncLog).not.toHaveProperty("duplicateCount");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  return {
    ...env,
    NODE_ENV: "test",
    TZ: "Asia/Seoul",
    LOG_LEVEL: "info",
    NAVER_API_MODE: "mock",
    ALLOW_LIVE_NAVER_API: "false",
    NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
    SYNC_CRON: "*/5 * * * *",
    STORE_A_NAME: "Store A",
    STORE_A_BASE_URL: "https://example.com/store-a",
    STORE_A_CLIENT_ID: "store-a-client",
    STORE_A_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    STORE_B_NAME: "Store B",
    STORE_B_BASE_URL: "https://example.com/store-b",
    STORE_B_CLIENT_ID: "store-b-client",
    STORE_B_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
  };
}

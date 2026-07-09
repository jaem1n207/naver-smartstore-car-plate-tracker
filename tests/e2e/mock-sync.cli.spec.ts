import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("mock sync CLI exits successfully", async () => {
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
});

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  return {
    ...env,
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
    STORE_A_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    STORE_A_ACCOUNT_ID: "store-a-account",
    STORE_B_NAME: "Store B",
    STORE_B_BASE_URL: "https://example.com/store-b",
    STORE_B_CLIENT_ID: "store-b-client",
    STORE_B_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    STORE_B_ACCOUNT_ID: "store-b-account",
    GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
  };
}

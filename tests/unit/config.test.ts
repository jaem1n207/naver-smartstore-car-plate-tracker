import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";

const baseEnv = {
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
};

describe("loadEnv", () => {
  it("loads mock mode without live permission", () => {
    const env = loadEnv(baseEnv);

    expect(env.naverApiMode).toBe("mock");
    expect(env.allowLiveNaverApi).toBe(false);
  });

  it("rejects live mode unless explicitly allowed", () => {
    expect(() =>
      loadEnv({ ...baseEnv, NAVER_API_MODE: "live", ALLOW_LIVE_NAVER_API: "false" }),
    ).toThrow("Live Naver API mode requires ALLOW_LIVE_NAVER_API=true");
  });
});

describe("loadStores", () => {
  it("builds two store configs", () => {
    const stores = loadStores(loadEnv(baseEnv));

    expect(stores).toHaveLength(2);
    expect(stores.map((store) => store.storeKey)).toEqual(["A", "B"]);
  });
});

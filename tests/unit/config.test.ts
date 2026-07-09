import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createStoreDisplayName, loadStores } from "../../src/config/stores.js";

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

  it("trims required operational text values", () => {
    const env = loadEnv({
      ...baseEnv,
      STORE_A_NAME: " Store A ",
      STORE_A_CLIENT_ID: " store-a-client ",
      STORE_A_CLIENT_SECRET: " store-a-secret ",
      STORE_A_ACCOUNT_ID: " store-a-account ",
      STORE_B_NAME: " Store B ",
      STORE_B_CLIENT_ID: " store-b-client ",
      STORE_B_CLIENT_SECRET: " store-b-secret ",
      STORE_B_ACCOUNT_ID: " store-b-account ",
      GOOGLE_SHEETS_SPREADSHEET_ID: " spreadsheet-id ",
    });

    expect(env.storeAName).toBe("Store A");
    expect(env.storeAClientId).toBe("store-a-client");
    expect(env.storeAClientSecret).toBe("store-a-secret");
    expect(env.storeAAccountId).toBe("store-a-account");
    expect(env.storeBName).toBe("Store B");
    expect(env.storeBClientId).toBe("store-b-client");
    expect(env.storeBClientSecret).toBe("store-b-secret");
    expect(env.storeBAccountId).toBe("store-b-account");
    expect(env.googleSheetsSpreadsheetId).toBe("spreadsheet-id");
  });

  it("rejects whitespace-only required operational text values", () => {
    expect(() => loadEnv({ ...baseEnv, STORE_A_CLIENT_SECRET: "   " })).toThrow();
  });

  it("treats blank optional Google credential values as unset", () => {
    const env = loadEnv({
      ...baseEnv,
      GOOGLE_APPLICATION_CREDENTIALS: "  ",
      GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "",
    });

    expect(env.googleApplicationCredentials).toBeUndefined();
    expect(env.googleServiceAccountJsonBase64).toBeUndefined();
  });

  it("rejects ambiguous Google credential sources", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        GOOGLE_APPLICATION_CREDENTIALS: "/secure/service-account.json",
        GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "encoded-json",
      }),
    ).toThrow(
      "Configure only one of GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
    );
  });
});

describe("loadStores", () => {
  it("builds two store configs", () => {
    const stores = loadStores(loadEnv(baseEnv));

    expect(stores).toEqual([
      {
        storeKey: "A",
        storeName: "Store A",
        storeDisplayName: "Store A (store-a)",
        storeBaseUrl: "https://example.com/store-a",
        clientId: "store-a-client",
        clientSecret: "store-a-secret",
        accountId: "store-a-account",
      },
      {
        storeKey: "B",
        storeName: "Store B",
        storeDisplayName: "Store B (store-b)",
        storeBaseUrl: "https://example.com/store-b",
        clientId: "store-b-client",
        clientSecret: "store-b-secret",
        accountId: "store-b-account",
      },
    ]);
  });

  it("builds a human-readable store label from the configured name and URL slug", () => {
    expect(createStoreDisplayName("동부트럭", "https://example.com/store-east/")).toBe(
      "동부트럭 (store-east)",
    );
    expect(createStoreDisplayName("동부트럭 (store-east)", "https://example.com/store-east")).toBe(
      "동부트럭 (store-east)",
    );
  });
});

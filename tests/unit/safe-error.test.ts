import { describe, expect, it } from "vitest";
import { runtimeSecretValues, safeErrorLog } from "../../src/logging/safe-error.js";

describe("safeErrorLog", () => {
  it("keeps only safe error fields and redacts configured secrets", () => {
    const error = new Error("request failed with super-secret");
    Reflect.set(error, "code", "GW.AUTHN");
    Reflect.set(error, "status", 401);
    Reflect.set(error, "config", {
      headers: {
        Authorization: "Bearer super-secret",
      },
    });

    expect(safeErrorLog(error, ["super-secret"])).toEqual({
      name: "Error",
      message: "request failed with [REDACTED]",
      code: "GW.AUTHN",
      status: 401,
    });
  });

  it("handles non-error thrown values without inspecting nested objects", () => {
    expect(safeErrorLog("bad-token", ["bad-token"])).toEqual({
      name: "UnknownError",
      message: "[REDACTED]",
      code: undefined,
      status: undefined,
    });
  });

  it("collects runtime secret values from raw environment without validation", () => {
    expect(
      runtimeSecretValues({
        STORE_A_CLIENT_ID: "client-a",
        STORE_A_CLIENT_SECRET: "secret-a",
        STORE_A_ACCOUNT_ID: "account-a",
        STORE_B_CLIENT_ID: "client-b",
        STORE_B_CLIENT_SECRET: "secret-b",
        STORE_B_ACCOUNT_ID: "account-b",
        GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "google-json",
      }),
    ).toEqual([
      "client-a",
      "secret-a",
      "account-a",
      "client-b",
      "secret-b",
      "account-b",
      "google-json",
    ]);
  });
});

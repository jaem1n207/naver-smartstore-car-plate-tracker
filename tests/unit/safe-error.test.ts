import { describe, expect, it } from "vitest";
import { safeErrorLog } from "../../src/logging/safe-error.js";

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
});

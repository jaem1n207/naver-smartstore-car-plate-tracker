import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/logging/redact.js";

describe("redactSecrets", () => {
  it("masks configured secret values", () => {
    const result = redactSecrets("client secret is abc123 and token is live-token", [
      "abc123",
      "live-token",
    ]);

    expect(result).toBe("client secret is [REDACTED] and token is [REDACTED]");
  });

  it("ignores empty secret values", () => {
    const result = redactSecrets("safe message", ["", "   "]);

    expect(result).toBe("safe message");
  });

  it("redacts overlapping secret values longest first", () => {
    const result = redactSecrets("token is abc123", ["abc", "abc123"]);

    expect(result).toBe("token is [REDACTED]");
  });
});

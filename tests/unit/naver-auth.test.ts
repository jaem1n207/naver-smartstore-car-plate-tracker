import { describe, expect, it } from "vitest";
import { createClientSecretSign, TokenCache } from "../../src/naver/auth.js";

describe("createClientSecretSign", () => {
  it("returns base64 bcrypt text", () => {
    const signature = createClientSecretSign({
      clientId: "aaaabbbbcccc",
      clientSecret: "$2a$04$abcdefghijklmnopqrstuu",
      timestamp: 1_643_961_623_299,
    });

    const decoded = Buffer.from(signature, "base64").toString("utf8");

    expect(decoded).toContain("$2a$04$");
    expect(decoded.length).toBeGreaterThan(20);
  });
});

describe("TokenCache", () => {
  it("returns cached token before safety window", () => {
    const cache = new TokenCache(() => 1_000_000);
    cache.set("A", { accessToken: "token", expiresIn: 300 });

    expect(cache.get("A")).toBe("token");
  });

  it("returns undefined after expiry safety window", () => {
    const cache = new TokenCache(() => 1_000_000);
    cache.set("A", { accessToken: "token", expiresIn: 30 });

    expect(cache.get("A")).toBeUndefined();
  });
});

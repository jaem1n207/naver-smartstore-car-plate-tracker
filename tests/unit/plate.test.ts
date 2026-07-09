import { describe, expect, it } from "vitest";
import { normalizePlateCandidate } from "../../src/domain/plate/normalize.js";

describe("normalizePlateCandidate", () => {
  it("removes spaces and separators", () => {
    expect(normalizePlateCandidate("123 가 4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123-가-4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123 | 가 | 4567")).toBe("123가4567");
  });
});

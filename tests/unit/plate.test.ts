import { describe, expect, it } from "vitest";
import { extractPlateFromHtml } from "../../src/domain/plate/extract.js";
import { normalizePlateCandidate } from "../../src/domain/plate/normalize.js";

describe("normalizePlateCandidate", () => {
  it("removes spaces and separators", () => {
    expect(normalizePlateCandidate("123 가 4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123-가-4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123 | 가 | 4567")).toBe("123가4567");
  });
});

describe("extractPlateFromHtml", () => {
  it("extracts a label-near plate", () => {
    const result = extractPlateFromHtml("<p>차량번호 123 가 4567</p>");

    expect(result).toEqual({
      status: "success",
      rawPlate: "123 가 4567",
      normalizedPlate: "123가4567",
      candidates: ["123가4567"],
    });
  });

  it("extracts a table-form plate", () => {
    const result = extractPlateFromHtml(
      "<table><tr><th>차량번호</th><td>123-가-4567</td></tr></table>",
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(`Expected success, got ${result.status}`);
    }
    expect(result.normalizedPlate).toBe("123가4567");
  });

  it("returns not_found when only image content exists", () => {
    const result = extractPlateFromHtml(
      '<p>상세 이미지를 확인하세요.</p><img src="plate.jpg" alt="차량 사진">',
    );

    expect(result).toEqual({
      status: "not_found",
      candidates: [],
      message: "No text vehicle plate candidate found",
    });
  });

  it("returns ambiguous for multiple different valid plates", () => {
    const result = extractPlateFromHtml("<p>차량번호 123가4567</p><p>이전번호 234나5678</p>");

    expect(result).toEqual({
      status: "ambiguous",
      candidates: ["123가4567", "234나5678"],
      message: "Multiple different vehicle plate candidates found",
    });
  });

  it("returns invalid_format when a label-near value is malformed", () => {
    const result = extractPlateFromHtml("<p>차량번호 12가456</p>");

    expect(result).toEqual({
      status: "invalid_format",
      rawPlate: "12가456",
      candidates: [],
      message: "Label-near vehicle plate value did not match supported format",
    });
  });
});

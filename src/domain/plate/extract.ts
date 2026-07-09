import { load } from "cheerio";
import he from "he";
import { isSupportedPlate, normalizePlateCandidate } from "./normalize.js";
import type { PlateExtractionResult } from "./types.js";

const NO_TEXT_PLATE_MESSAGE = "텍스트에서 차량번호 후보를 찾지 못했습니다";
const INVALID_LABEL_NEAR_MESSAGE = "차량번호 항목 근처 값이 지원 형식과 일치하지 않습니다";
const AMBIGUOUS_PLATE_MESSAGE = "서로 다른 차량번호 후보가 여러 개 발견되었습니다";

const PLATE_CANDIDATE_PATTERN =
  /(?<![0-9])(?:[0-9]{2,3}[\s\-_.:|/\\]*[가-힣][\s\-_.:|/\\]*[0-9]{4})(?![0-9])/gu;
const LABEL_PATTERN = /차량번호|차번|등록번호|자동차번호/gu;
const LABEL_VALUE_SEPARATOR_PATTERN = /^[\s:：|/\\_.-]*/u;
const LABEL_NEAR_VALUE_PATTERN = /^[0-9]{1,4}[\s\-_.:|/\\]*[가-힣][\s\-_.:|/\\]*[0-9]{1,5}/u;

export function extractPlateFromHtml(html: string): PlateExtractionResult {
  const text = htmlToText(html);
  const rawCandidates = findRawCandidates(text);
  const candidates = uniqueSupportedCandidates(rawCandidates);

  if (candidates.length === 0) {
    const labelNearPlate = findLabelNearPlate(text);

    if (labelNearPlate !== undefined && !isSupportedPlate(labelNearPlate)) {
      return {
        status: "invalid_format",
        rawPlate: labelNearPlate,
        candidates,
        message: INVALID_LABEL_NEAR_MESSAGE,
      };
    }

    return {
      status: "not_found",
      candidates,
      message: NO_TEXT_PLATE_MESSAGE,
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates,
      message: AMBIGUOUS_PLATE_MESSAGE,
    };
  }

  const normalizedPlate = candidates[0];

  if (normalizedPlate === undefined) {
    return {
      status: "not_found",
      candidates,
      message: NO_TEXT_PLATE_MESSAGE,
    };
  }

  const rawPlate = findRawPlateForCandidate(rawCandidates, normalizedPlate);

  if (rawPlate === undefined) {
    return {
      status: "not_found",
      candidates: [],
      message: NO_TEXT_PLATE_MESSAGE,
    };
  }

  return {
    status: "success",
    rawPlate,
    normalizedPlate,
    candidates,
  };
}

function htmlToText(html: string): string {
  const $ = load(html);

  $("script, style, noscript").remove();

  return he.decode($.root().text()).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function findLabelNearPlate(text: string): string | undefined {
  for (const match of text.matchAll(LABEL_PATTERN)) {
    const label = match[0];
    const value = findImmediateLabelValue(text.slice(match.index + label.length));

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function findImmediateLabelValue(textAfterLabel: string): string | undefined {
  const separator = LABEL_VALUE_SEPARATOR_PATTERN.exec(textAfterLabel)?.[0] ?? "";
  const match = LABEL_NEAR_VALUE_PATTERN.exec(textAfterLabel.slice(separator.length));

  return match?.[0]?.trim();
}

function findRawCandidates(text: string): string[] {
  return text.match(PLATE_CANDIDATE_PATTERN) ?? [];
}

function uniqueSupportedCandidates(rawCandidates: readonly string[]): string[] {
  const candidates: string[] = [];

  for (const rawCandidate of rawCandidates) {
    const normalizedCandidate = normalizePlateCandidate(rawCandidate);

    if (isSupportedPlate(normalizedCandidate) && !candidates.includes(normalizedCandidate)) {
      candidates.push(normalizedCandidate);
    }
  }

  return candidates;
}

function findRawPlateForCandidate(
  rawCandidates: readonly string[],
  normalizedPlate: string,
): string | undefined {
  return rawCandidates.find(
    (rawCandidate) => normalizePlateCandidate(rawCandidate) === normalizedPlate,
  );
}

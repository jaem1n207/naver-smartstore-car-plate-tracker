const SUPPORTED_PLATE_PATTERN = /^[0-9]{2,3}[가-힣][0-9]{4}$/u;

export function normalizePlateCandidate(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\-_.:|/\\]+/gu, "")
    .trim();
}

export function isSupportedPlate(value: string): boolean {
  return SUPPORTED_PLATE_PATTERN.test(normalizePlateCandidate(value));
}

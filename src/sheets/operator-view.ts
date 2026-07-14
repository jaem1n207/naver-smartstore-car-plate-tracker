import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { SheetProductRow } from "./types.js";

export interface OperatorCellStyle {
  readonly backgroundHex: string;
  readonly foregroundHex: string;
}

export interface DuplicateGroupStyle extends OperatorCellStyle {
  readonly borderHex: string;
}

export interface DuplicateGroup {
  readonly plate: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export const SHEET_HEADER_STYLE: OperatorCellStyle = {
  backgroundHex: "#174C3C",
  foregroundHex: "#FFFFFF",
};

export const UNKNOWN_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#E9ECEF",
  foregroundHex: "#343A40",
};

export const DUPLICATED_IN_SAME_STORE_STYLE: DuplicateGroupStyle = {
  backgroundHex: "#FFF3C4",
  foregroundHex: "#5B3A00",
  borderHex: "#B7791F",
};

export const DUPLICATED_ACROSS_STORES_STYLE: DuplicateGroupStyle = {
  backgroundHex: "#E8F0FE",
  foregroundHex: "#174EA6",
  borderHex: "#3B6FC4",
};

export const DUPLICATED_BOTH_STYLE: DuplicateGroupStyle = {
  backgroundHex: "#FCE8E6",
  foregroundHex: "#8A1C1C",
  borderHex: "#C5221F",
};

const INFORMATION_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#E8F0FE",
  foregroundHex: "#174EA6",
};

const WARNING_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#FCE8D5",
  foregroundHex: "#8A3B12",
};

const BLOCKED_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#FCE8E6",
  foregroundHex: "#8A1C1C",
};

const INACTIVE_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#E9ECEF",
  foregroundHex: "#343A40",
};

export const DISPLAY_STATUS_STYLES: Readonly<Record<string, OperatorCellStyle>> = {
  WAIT: INFORMATION_STATUS_STYLE,
  SUSPENSION: WARNING_STATUS_STYLE,
};

export const PRODUCT_STATUS_STYLES: Readonly<Record<string, OperatorCellStyle>> = {
  WAIT: INFORMATION_STATUS_STYLE,
  OUTOFSTOCK: WARNING_STATUS_STYLE,
  UNADMISSION: BLOCKED_STATUS_STYLE,
  REJECTION: BLOCKED_STATUS_STYLE,
  SUSPENSION: WARNING_STATUS_STYLE,
  CLOSE: INACTIVE_STATUS_STYLE,
  PROHIBITION: BLOCKED_STATUS_STYLE,
  DELETE: INACTIVE_STATUS_STYLE,
};

const DUPLICATE_STATUS_ORDER: Readonly<Record<DuplicateStatus, number>> = {
  duplicated_both: 0,
  duplicated_across_stores: 1,
  duplicated_in_same_store: 2,
  unique: 3,
};
const ROW_COLLATOR = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });

export function sortOperatorRows(rows: readonly SheetProductRow[]): SheetProductRow[] {
  return [...rows].sort(compareOperatorRows);
}

export function findDuplicateGroups(rows: readonly SheetProductRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  for (const [index, row] of rows.entries()) {
    const plate = row.normalizedPlate.trim();

    if (plate.length === 0 || row.duplicateStatus === "unique") {
      continue;
    }

    const previousGroup = groups.at(-1);

    if (previousGroup?.plate === plate && previousGroup.endIndex === index) {
      groups[groups.length - 1] = { ...previousGroup, endIndex: index + 1 };
      continue;
    }

    groups.push({
      plate,
      startIndex: index,
      endIndex: index + 1,
    });
  }

  return groups;
}

export function duplicateStatusStyle(status: DuplicateStatus): DuplicateGroupStyle | undefined {
  switch (status) {
    case "duplicated_in_same_store":
      return DUPLICATED_IN_SAME_STORE_STYLE;
    case "duplicated_across_stores":
      return DUPLICATED_ACROSS_STORES_STYLE;
    case "duplicated_both":
      return DUPLICATED_BOTH_STYLE;
    case "unique":
      return undefined;
  }
}

export function displayStatusStyle(status: string): OperatorCellStyle | undefined {
  if (status === "ON") {
    return undefined;
  }

  return DISPLAY_STATUS_STYLES[status] ?? UNKNOWN_STATUS_STYLE;
}

export function productStatusStyle(status: string): OperatorCellStyle | undefined {
  if (status === "SALE") {
    return undefined;
  }

  return PRODUCT_STATUS_STYLES[status] ?? UNKNOWN_STATUS_STYLE;
}

function compareOperatorRows(left: SheetProductRow, right: SheetProductRow): number {
  const categoryComparison = operatorRowCategory(left) - operatorRowCategory(right);

  if (categoryComparison !== 0) {
    return categoryComparison;
  }

  const plateComparison = ROW_COLLATOR.compare(left.normalizedPlate, right.normalizedPlate);

  if (plateComparison !== 0) {
    return plateComparison;
  }

  const duplicateStatusComparison =
    DUPLICATE_STATUS_ORDER[left.duplicateStatus] - DUPLICATE_STATUS_ORDER[right.duplicateStatus];

  if (duplicateStatusComparison !== 0) {
    return duplicateStatusComparison;
  }

  const storeComparison = ROW_COLLATOR.compare(left.storeName, right.storeName);

  if (storeComparison !== 0) {
    return storeComparison;
  }

  return ROW_COLLATOR.compare(left.channelProductNo, right.channelProductNo);
}

function operatorRowCategory(row: SheetProductRow): number {
  if (row.normalizedPlate.trim().length === 0) {
    return 2;
  }

  return row.duplicateStatus === "unique" ? 1 : 0;
}

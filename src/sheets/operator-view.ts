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
  readonly styleIndex: number;
}

export const SHEET_HEADER_STYLE: OperatorCellStyle = {
  backgroundHex: "#174C3C",
  foregroundHex: "#FFFFFF",
};

export const UNKNOWN_STATUS_STYLE: OperatorCellStyle = {
  backgroundHex: "#E5E7EB",
  foregroundHex: "#111827",
};

export const DUPLICATE_GROUP_STYLES: readonly DuplicateGroupStyle[] = [
  { backgroundHex: "#FFF4CC", foregroundHex: "#3A2A00", borderHex: "#9A6700" },
  { backgroundHex: "#E6F0FF", foregroundHex: "#102A43", borderHex: "#2563EB" },
  { backgroundHex: "#FDE8F0", foregroundHex: "#4A1530", borderHex: "#BE185D" },
  { backgroundHex: "#DFF7EE", foregroundHex: "#12372A", borderHex: "#0F766E" },
];

export const DUPLICATE_STATUS_STYLES = {
  unique: { backgroundHex: "#E5E7EB", foregroundHex: "#111827" },
  duplicated_in_same_store: { backgroundHex: "#FEF08A", foregroundHex: "#713F12" },
  duplicated_across_stores: { backgroundHex: "#BFDBFE", foregroundHex: "#1E3A8A" },
  duplicated_both: { backgroundHex: "#FECACA", foregroundHex: "#7F1D1D" },
} satisfies Readonly<Record<DuplicateStatus, OperatorCellStyle>>;

export const DISPLAY_STATUS_STYLES: Readonly<Record<string, OperatorCellStyle>> = {
  ON: { backgroundHex: "#BBF7D0", foregroundHex: "#14532D" },
  WAIT: { backgroundHex: "#BFDBFE", foregroundHex: "#1E3A8A" },
  SUSPENSION: { backgroundHex: "#FED7AA", foregroundHex: "#7C2D12" },
};

export const PRODUCT_STATUS_STYLES: Readonly<Record<string, OperatorCellStyle>> = {
  SALE: { backgroundHex: "#DCFCE7", foregroundHex: "#14532D" },
  WAIT: { backgroundHex: "#DBEAFE", foregroundHex: "#1E3A8A" },
  OUTOFSTOCK: { backgroundHex: "#FEF3C7", foregroundHex: "#78350F" },
  UNADMISSION: { backgroundHex: "#EDE9FE", foregroundHex: "#4C1D95" },
  REJECTION: { backgroundHex: "#FEE2E2", foregroundHex: "#7F1D1D" },
  SUSPENSION: { backgroundHex: "#FFEDD5", foregroundHex: "#7C2D12" },
  CLOSE: { backgroundHex: "#E5E7EB", foregroundHex: "#111827" },
  PROHIBITION: { backgroundHex: "#FCE7F3", foregroundHex: "#831843" },
  DELETE: { backgroundHex: "#D1D5DB", foregroundHex: "#111827" },
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
      styleIndex: groups.length % DUPLICATE_GROUP_STYLES.length,
    });
  }

  return groups;
}

export function duplicateStatusStyle(status: DuplicateStatus): OperatorCellStyle {
  return DUPLICATE_STATUS_STYLES[status];
}

export function displayStatusStyle(status: string): OperatorCellStyle {
  return DISPLAY_STATUS_STYLES[status] ?? UNKNOWN_STATUS_STYLE;
}

export function productStatusStyle(status: string): OperatorCellStyle {
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

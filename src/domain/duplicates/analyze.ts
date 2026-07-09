import type { ProductRecord, ProductRecordWithDuplicateStatus } from "./types.js";

export function analyzeDuplicates(
  rows: readonly ProductRecord[],
): ProductRecordWithDuplicateStatus[] {
  const plateGroups = groupSuccessfulRowsByPlate(rows);

  return rows.map((row) => {
    const plate = row.normalizedPlate;

    if (row.extractionStatus !== "success" || !plate) {
      return { ...row, duplicateStatus: "unique" };
    }

    const samePlateRows = plateGroups.get(plate) ?? [];
    const sameStoreCount = samePlateRows.filter(
      (candidate) => candidate.storeKey === row.storeKey,
    ).length;
    const storeCount = new Set(samePlateRows.map((candidate) => candidate.storeKey)).size;

    const duplicatedInSameStore = sameStoreCount > 1;
    const duplicatedAcrossStores = storeCount > 1;

    if (duplicatedInSameStore && duplicatedAcrossStores) {
      return { ...row, duplicateStatus: "duplicated_both" };
    }

    if (duplicatedInSameStore) {
      return { ...row, duplicateStatus: "duplicated_in_same_store" };
    }

    if (duplicatedAcrossStores) {
      return { ...row, duplicateStatus: "duplicated_across_stores" };
    }

    return { ...row, duplicateStatus: "unique" };
  });
}

function groupSuccessfulRowsByPlate(rows: readonly ProductRecord[]): Map<string, ProductRecord[]> {
  const groups = new Map<string, ProductRecord[]>();

  for (const row of rows) {
    if (row.extractionStatus !== "success" || !row.normalizedPlate) {
      continue;
    }

    const existing = groups.get(row.normalizedPlate) ?? [];
    existing.push(row);
    groups.set(row.normalizedPlate, existing);
  }

  return groups;
}

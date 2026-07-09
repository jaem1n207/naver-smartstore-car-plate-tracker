import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

export class InMemorySheetRepository implements SheetRepository {
  rawRows: SheetProductRow[] = [];
  viewRows: Record<string, SheetProductRow[]> = {};
  runLogs: RunLogRow[] = [];

  readRawData(): Promise<SheetProductRow[]> {
    return Promise.resolve(structuredClone(this.rawRows));
  }

  writeRawData(rows: SheetProductRow[]): Promise<void> {
    this.rawRows = structuredClone(rows);

    return Promise.resolve();
  }

  writeViews(rows: SheetProductRow[]): Promise<void> {
    this.viewRows = {
      A_Store_View: cloneRows(rows.filter(isActiveStoreARow)),
      B_Store_View: cloneRows(rows.filter(isActiveStoreBRow)),
      Across_Stores_Duplicates: cloneRows(rows.filter(hasAcrossStoresDuplicate)),
      Same_Store_Duplicates: cloneRows(rows.filter(hasSameStoreDuplicate)),
      Extraction_Failures: cloneRows(rows.filter(hasExtractionFailure)),
    };

    return Promise.resolve();
  }

  appendRunLog(row: RunLogRow): Promise<void> {
    this.runLogs.push(structuredClone(row));

    return Promise.resolve();
  }
}

function cloneRows(rows: SheetProductRow[]): SheetProductRow[] {
  return structuredClone(rows);
}

function isActiveStoreARow(row: SheetProductRow): boolean {
  return row.storeKey === "A" && row.productStatus !== "DELETE";
}

function isActiveStoreBRow(row: SheetProductRow): boolean {
  return row.storeKey === "B" && row.productStatus !== "DELETE";
}

function hasAcrossStoresDuplicate(row: SheetProductRow): boolean {
  return isDuplicateStatus(row.duplicateStatus, "duplicated_across_stores", "duplicated_both");
}

function hasSameStoreDuplicate(row: SheetProductRow): boolean {
  return isDuplicateStatus(row.duplicateStatus, "duplicated_in_same_store", "duplicated_both");
}

function hasExtractionFailure(row: SheetProductRow): boolean {
  return row.extractionStatus !== "success";
}

function isDuplicateStatus(
  status: DuplicateStatus,
  primaryStatus: DuplicateStatus,
  sharedStatus: DuplicateStatus,
): boolean {
  return status === primaryStatus || status === sharedStatus;
}

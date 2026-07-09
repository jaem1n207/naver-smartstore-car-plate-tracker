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
    const activeRows = rows.filter((row) => row.productStatus !== "DELETE");

    this.viewRows = {
      A_Store_View: cloneRows(activeRows.filter(isStoreARow)),
      B_Store_View: cloneRows(activeRows.filter(isStoreBRow)),
      Across_Stores_Duplicates: cloneRows(activeRows.filter(hasAcrossStoresDuplicate)),
      Same_Store_Duplicates: cloneRows(activeRows.filter(hasSameStoreDuplicate)),
      Extraction_Failures: cloneRows(activeRows.filter(hasExtractionFailure)),
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

function isStoreARow(row: SheetProductRow): boolean {
  return row.storeKey === "A";
}

function isStoreBRow(row: SheetProductRow): boolean {
  return row.storeKey === "B";
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

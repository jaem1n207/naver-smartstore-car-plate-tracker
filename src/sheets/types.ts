import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { PlateExtractionStatus } from "../domain/plate/types.js";

export type SheetProductRow = {
  storeKey: "A" | "B";
  storeName: string;
  storeBaseUrl: string;
  channelProductNo: string;
  originProductNo: string;
  productUrl: string;
  productName: string;
  productStatus: string;
  displayStatus: string;
  rawPlate: string;
  normalizedPlate: string;
  extractionStatus: PlateExtractionStatus;
  duplicateStatus: DuplicateStatus;
  firstSeenAt: string;
  lastSyncedAt: string;
  lastErrorAt: string;
  errorMessage: string;
  detailContentHash: string;
  detailTextSnippet: string;
  apiTraceId: string;
  manualNote: string;
};

export type RunLogRow = {
  runStartedAt: string;
  runFinishedAt: string;
  mode: "mock" | "live";
  totalProducts: number;
  successCount: number;
  failureCount: number;
  duplicateCount: number;
  message: string;
};

export type SheetRepository = {
  readRawData(): Promise<SheetProductRow[]>;
  writeRawData(rows: SheetProductRow[]): Promise<void>;
  writeViews(rows: SheetProductRow[]): Promise<void>;
  appendRunLog(row: RunLogRow): Promise<void>;
};

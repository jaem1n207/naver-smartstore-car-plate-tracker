import type { PlateExtractionStatus } from "../plate/types.js";

export type DuplicateStatus =
  "unique" | "duplicated_in_same_store" | "duplicated_across_stores" | "duplicated_both";

export type ProductRecord = {
  storeKey: "A" | "B";
  channelProductNo: string;
  productName: string;
  extractionStatus: PlateExtractionStatus;
  normalizedPlate?: string | undefined;
};

export type ProductRecordWithDuplicateStatus = ProductRecord & {
  duplicateStatus: DuplicateStatus;
};

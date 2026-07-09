import { beforeEach, describe, expect, it, vi } from "vitest";
import { RAW_DATA_COLUMNS, sheetProductRowToValues } from "../../src/sheets/columns.js";
import type { SheetProductRow, SheetRepository } from "../../src/sheets/types.js";

type AuthOptions = {
  scopes?: string[];
};

type SheetsOptions = {
  version?: string;
  auth?: unknown;
};

type ValuesGetParams = {
  spreadsheetId?: string;
  range?: string;
};

type ValuesUpdateParams = {
  spreadsheetId?: string;
  range?: string;
  valueInputOption?: string;
  requestBody?: {
    values?: unknown[][] | null;
  };
};

type ValuesAppendParams = {
  spreadsheetId?: string;
  range?: string;
  valueInputOption?: string;
  insertDataOption?: string;
  requestBody?: {
    values?: unknown[][] | null;
  };
};

type ValuesClearParams = {
  spreadsheetId?: string;
  range?: string;
};

type ValueRangeResponse = {
  data: {
    values?: unknown[][] | null;
  };
};

type UpdateResponse = {
  data: Record<string, never>;
};

const googleapisMock = vi.hoisted(() => {
  const authCalls: AuthOptions[] = [];
  const sheetsCalls: SheetsOptions[] = [];
  const getCalls: ValuesGetParams[] = [];
  const updateCalls: ValuesUpdateParams[] = [];
  const appendCalls: ValuesAppendParams[] = [];
  const clearCalls: ValuesClearParams[] = [];
  const getResponses: ValueRangeResponse[] = [];

  function GoogleAuth(options: AuthOptions): void {
    authCalls.push(options);
  }

  function get(params: ValuesGetParams): Promise<ValueRangeResponse> {
    getCalls.push(params);

    const response = getResponses.shift();

    if (response !== undefined) {
      return Promise.resolve(response);
    }

    return Promise.resolve({ data: { values: [] } });
  }

  function update(params: ValuesUpdateParams): Promise<UpdateResponse> {
    updateCalls.push(params);

    return Promise.resolve({ data: {} });
  }

  function append(params: ValuesAppendParams): Promise<UpdateResponse> {
    appendCalls.push(params);

    return Promise.resolve({ data: {} });
  }

  function clear(params: ValuesClearParams): Promise<UpdateResponse> {
    clearCalls.push(params);

    return Promise.resolve({ data: {} });
  }

  function sheets(options: SheetsOptions) {
    sheetsCalls.push(options);

    return {
      spreadsheets: {
        values: {
          append,
          clear,
          get,
          update,
        },
      },
    };
  }

  function queueGetValues(values: unknown[][]): void {
    getResponses.push({ data: { values } });
  }

  function reset(): void {
    authCalls.splice(0);
    sheetsCalls.splice(0);
    getCalls.splice(0);
    updateCalls.splice(0);
    appendCalls.splice(0);
    clearCalls.splice(0);
    getResponses.splice(0);
  }

  return {
    appendCalls,
    authCalls,
    clearCalls,
    getCalls,
    queueGetValues,
    reset,
    sheetsCalls,
    updateCalls,
    google: {
      auth: {
        GoogleAuth,
      },
      sheets,
    },
  };
});

vi.mock("googleapis", () => ({
  google: googleapisMock.google,
}));

const baseRow: SheetProductRow = {
  storeKey: "A",
  storeName: "Store A",
  storeBaseUrl: "https://example.com/store-a",
  channelProductNo: "2001",
  originProductNo: "1001",
  productUrl: "https://example.com/store-a/products/2001",
  productName: "Synthetic product",
  productStatus: "SALE",
  displayStatus: "ON",
  rawPlate: "123가4567",
  normalizedPlate: "123가4567",
  extractionStatus: "success",
  duplicateStatus: "unique",
  firstSeenAt: "2026-07-09T00:00:00.000Z",
  lastSyncedAt: "2026-07-09T00:00:00.000Z",
  lastErrorAt: "",
  errorMessage: "",
  detailContentHash: "hash",
  detailTextSnippet: "snippet",
  apiTraceId: "",
  manualNote: "operator note",
};

describe("GoogleSheetRepository", () => {
  beforeEach(() => {
    vi.resetModules();
    googleapisMock.reset();
  });

  it("reads raw data from RawData A2 through U and parses sparse trailing cells", async () => {
    const values = sheetProductRowToValues(baseRow).slice(0, -1);
    googleapisMock.queueGetValues([values]);
    const repository = await createRepository();

    const rows = await repository.readRawData();

    expect(googleapisMock.getCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "RawData!A2:U",
      },
    ]);
    expect(rows).toEqual([
      {
        ...baseRow,
        manualNote: "",
      },
    ]);
  });

  it("replaces raw data with an A through U update and no clear call", async () => {
    googleapisMock.queueGetValues([
      RAW_DATA_COLUMNS,
      sheetProductRowToValues(baseRow),
      sheetProductRowToValues(baseRow),
      sheetProductRowToValues(baseRow),
    ]);
    const repository = await createRepository();

    await repository.writeRawData([baseRow]);

    expect(googleapisMock.clearCalls).toEqual([]);
    expect(googleapisMock.getCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "RawData!A:U",
      },
    ]);
    expect(googleapisMock.updateCalls).toHaveLength(1);
    expect(only(googleapisMock.updateCalls)).toEqual({
      spreadsheetId: "spreadsheet-id",
      range: "RawData!A1:U4",
      valueInputOption: "RAW",
      requestBody: {
        values: [
          RAW_DATA_COLUMNS,
          sheetProductRowToValues(baseRow),
          blankRawDataRow(),
          blankRawDataRow(),
        ],
      },
    });
  });

  it("appends run logs with numeric counts under RAW input", async () => {
    const repository = await createRepository();

    await repository.appendRunLog({
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:01:00.000Z",
      mode: "live",
      totalProducts: 5,
      successCount: 4,
      failureCount: 1,
      duplicateCount: 3,
      message: "completed",
    });

    expect(googleapisMock.appendCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "RunLog!A:H",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            [
              "2026-07-09T00:00:00.000Z",
              "2026-07-09T00:01:00.000Z",
              "live",
              5,
              4,
              1,
              3,
              "completed",
            ],
          ],
        },
      },
    ]);
  });

  it("includes the RawData sheet row number when row parsing fails", async () => {
    const values = sheetProductRowToValues(baseRow);
    values[0] = "C";
    googleapisMock.queueGetValues([values]);
    const repository = await createRepository();

    await expect(repository.readRawData()).rejects.toThrow(
      "RawData row 2: Invalid storeKey value: C",
    );
  });
});

async function createRepository(): Promise<SheetRepository> {
  const module = await import("../../src/sheets/google-repository.js");

  return new module.GoogleSheetRepository("spreadsheet-id");
}

function blankRawDataRow(): string[] {
  return RAW_DATA_COLUMNS.map(() => "");
}

function only<T>(values: readonly T[]): T {
  const value = values[0];

  if (value === undefined) {
    throw new Error("Expected one value");
  }

  expect(values).toHaveLength(1);

  return value;
}

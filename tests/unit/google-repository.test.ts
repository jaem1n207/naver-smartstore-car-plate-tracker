import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagedSheetTabs,
  LEGACY_RUN_LOG_HEADERS,
  OPERATOR_VIEW_HEADERS,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RUN_LOG_HEADERS,
  sheetProductRowToOperatorValues,
  sheetProductRowToValues,
} from "../../src/sheets/columns.js";
import type { ManagedSheetTabs, SheetTabDefinition } from "../../src/sheets/columns.js";
import type { GoogleSheetRepositoryOptions } from "../../src/sheets/google-repository.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "../../src/sheets/types.js";

type AuthOptions = {
  scopes?: string[];
  keyFile?: string;
  credentials?: {
    type?: string;
    project_id?: string;
    private_key_id?: string;
    private_key?: string;
    client_email?: string;
    client_id?: string;
  };
};

type SheetsOptions = {
  version?: string;
  auth?: unknown;
};

type SpreadsheetGetParams = {
  spreadsheetId?: string;
  fields?: string;
};

type SpreadsheetBatchUpdateParams = {
  spreadsheetId?: string;
  requestBody?: {
    requests?: unknown[];
  };
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

type SpreadsheetResponse = {
  data: {
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        index?: number;
        gridProperties?: {
          columnCount?: number;
        };
      };
      tables?: Array<{
        tableId?: string;
        name?: string;
        range?: {
          sheetId?: number;
          startRowIndex?: number;
          endRowIndex?: number;
          startColumnIndex?: number;
          endColumnIndex?: number;
        };
      }>;
    }>;
  };
};

type ValueRangeResponse = {
  data: {
    values?: unknown[][] | null;
  };
};

type UpdateResponse = {
  data: {
    replies?: Array<{
      addTable?: {
        table?: {
          tableId?: string;
        };
      };
    }>;
  };
};

const googleapisMock = vi.hoisted(() => {
  const authCalls: AuthOptions[] = [];
  const sheetsCalls: SheetsOptions[] = [];
  const spreadsheetGetCalls: SpreadsheetGetParams[] = [];
  const batchUpdateCalls: SpreadsheetBatchUpdateParams[] = [];
  const valuesGetCalls: ValuesGetParams[] = [];
  const updateCalls: ValuesUpdateParams[] = [];
  const appendCalls: ValuesAppendParams[] = [];
  const spreadsheetResponses: SpreadsheetResponse[] = [];
  const valueResponses: ValueRangeResponse[] = [];
  let nextTableId = 100;

  function GoogleAuth(options: AuthOptions): void {
    authCalls.push(options);
  }

  function spreadsheetGet(params: SpreadsheetGetParams): Promise<SpreadsheetResponse> {
    spreadsheetGetCalls.push(params);
    const response = spreadsheetResponses.shift();

    return Promise.resolve(response ?? localizedSheetsResponse());
  }

  function batchUpdate(params: SpreadsheetBatchUpdateParams): Promise<UpdateResponse> {
    batchUpdateCalls.push(params);
    const replies = (params.requestBody?.requests ?? []).map((request) => {
      if (hasAddTable(request)) {
        nextTableId += 1;

        return { addTable: { table: { tableId: String(nextTableId) } } };
      }

      return {};
    });

    return Promise.resolve({ data: { replies } });
  }

  function valuesGet(params: ValuesGetParams): Promise<ValueRangeResponse> {
    valuesGetCalls.push(params);
    const response = valueResponses.shift();

    return Promise.resolve(response ?? { data: { values: [] } });
  }

  function update(params: ValuesUpdateParams): Promise<UpdateResponse> {
    updateCalls.push(params);

    return Promise.resolve({ data: {} });
  }

  function append(params: ValuesAppendParams): Promise<UpdateResponse> {
    appendCalls.push(params);

    return Promise.resolve({ data: {} });
  }

  function sheets(options: SheetsOptions) {
    sheetsCalls.push(options);

    return {
      spreadsheets: {
        batchUpdate,
        get: spreadsheetGet,
        values: {
          append,
          get: valuesGet,
          update,
        },
      },
    };
  }

  function queueSpreadsheetTitles(titles: readonly string[]): void {
    spreadsheetResponses.push({
      data: {
        sheets: titles.map((title, index) => ({
          properties: {
            sheetId: index + 1,
            title,
            index,
            gridProperties: { columnCount: 21 },
          },
        })),
      },
    });
  }

  function queueSpreadsheetSheets(
    sheets: NonNullable<SpreadsheetResponse["data"]["sheets"]>,
  ): void {
    spreadsheetResponses.push({ data: { sheets } });
  }

  function queueGetValues(values: unknown[][]): void {
    valueResponses.push({ data: { values } });
  }

  function reset(): void {
    authCalls.splice(0);
    sheetsCalls.splice(0);
    spreadsheetGetCalls.splice(0);
    batchUpdateCalls.splice(0);
    valuesGetCalls.splice(0);
    updateCalls.splice(0);
    appendCalls.splice(0);
    spreadsheetResponses.splice(0);
    valueResponses.splice(0);
    nextTableId = 100;
  }

  function localizedSheetsResponse(): SpreadsheetResponse {
    return {
      data: {
        sheets: sheetsForManagedTabs(MANAGED_TABS),
      },
    };
  }

  function hasAddTable(request: unknown): request is { addTable: unknown } {
    return typeof request === "object" && request !== null && "addTable" in request;
  }

  return {
    appendCalls,
    authCalls,
    batchUpdateCalls,
    queueGetValues,
    queueSpreadsheetSheets,
    queueSpreadsheetTitles,
    reset,
    sheetsCalls,
    spreadsheetGetCalls,
    updateCalls,
    valuesGetCalls,
    auth: {
      GoogleAuth,
    },
    sheets,
  };
});

vi.mock("googleapis/build/src/apis/sheets/index.js", () => ({
  auth: googleapisMock.auth,
  sheets: googleapisMock.sheets,
}));

const STORE_A_DISPLAY_NAME = "동부트럭 (store-east)";
const STORE_B_DISPLAY_NAME = "서부트럭 (store-west)";
const OLD_STORE_B_DISPLAY_NAME = "트럭판매왕 화물특장 (truckhub)";
const NEW_STORE_B_DISPLAY_NAME = "베스트브릿지 (truckhub)";
const MANAGED_TABS = createManagedSheetTabs(STORE_A_DISPLAY_NAME, STORE_B_DISPLAY_NAME);

const baseRow: SheetProductRow = {
  storeKey: "A",
  storeName: STORE_A_DISPLAY_NAME,
  storeBaseUrl: "https://example.com/store-east",
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

type GoogleDuplicateViewCase = {
  readonly name: string;
  readonly rows: SheetProductRow[];
  readonly storeAInternal: string[];
  readonly storeBInternal: string[];
  readonly crossStore: string[];
};

const GOOGLE_DUPLICATE_VIEW_CASES: GoogleDuplicateViewCase[] = [
  {
    name: "A:2, B:0",
    rows: [
      googleDuplicateRow("A", "1101", "10가1000", "duplicated_in_same_store"),
      googleDuplicateRow("A", "1102", "10가1000", "duplicated_in_same_store"),
    ],
    storeAInternal: ["1101", "1102"],
    storeBInternal: [],
    crossStore: [],
  },
  {
    name: "A:2, B:1",
    rows: [
      googleDuplicateRow("A", "2102", "20나2000", "duplicated_both"),
      googleDuplicateRow("B", "4101", "20나2000", "duplicated_across_stores"),
      googleDuplicateRow("A", "2101", "20나2000", "duplicated_both"),
    ],
    storeAInternal: ["2101", "2102"],
    storeBInternal: [],
    crossStore: ["2101", "2102", "4101"],
  },
  {
    name: "A:1, B:2",
    rows: [
      googleDuplicateRow("B", "4202", "30다3000", "duplicated_both"),
      googleDuplicateRow("A", "3101", "30다3000", "duplicated_across_stores"),
      googleDuplicateRow("B", "4201", "30다3000", "duplicated_both"),
    ],
    storeAInternal: [],
    storeBInternal: ["4201", "4202"],
    crossStore: ["4201", "4202", "3101"],
  },
  {
    name: "A:2, B:2",
    rows: [
      googleDuplicateRow("B", "4302", "40라4000", "duplicated_both"),
      googleDuplicateRow("A", "5102", "40라4000", "duplicated_both"),
      googleDuplicateRow("B", "4301", "40라4000", "duplicated_both"),
      googleDuplicateRow("A", "5101", "40라4000", "duplicated_both"),
    ],
    storeAInternal: ["5101", "5102"],
    storeBInternal: ["4301", "4302"],
    crossStore: ["5101", "5102", "4301", "4302"],
  },
  {
    name: "A:1, B:1",
    rows: [
      googleDuplicateRow("B", "4401", "50마5000", "duplicated_across_stores"),
      googleDuplicateRow("A", "6101", "50마5000", "duplicated_across_stores"),
    ],
    storeAInternal: [],
    storeBInternal: [],
    crossStore: ["6101", "4401"],
  },
];

describe("GoogleSheetRepository", () => {
  beforeEach(() => {
    vi.resetModules();
    googleapisMock.reset();
  });

  it("creates missing Korean tabs and freezes their header rows", async () => {
    googleapisMock.queueSpreadsheetTitles(["Sheet1"]);
    const repository = await createRepository();

    await repository.readRawData();

    expect(googleapisMock.spreadsheetGetCalls).toHaveLength(2);
    expect(googleapisMock.spreadsheetGetCalls.every(hasManagedMetadataFields)).toBe(true);
    const requests = googleapisMock.batchUpdateCalls[0]?.requestBody?.requests ?? [];
    expect(requests).toHaveLength(MANAGED_TABS.definitions.length);
    expect(requests).toEqual(
      MANAGED_TABS.definitions.map((tab) => ({
        addSheet: {
          properties: {
            title: tab.title,
            gridProperties: {
              columnCount: tab.columnCount,
              frozenRowCount: 1,
            },
          },
        },
      })),
    );
  });

  it("renames legacy English tabs to Korean without replacing their data", async () => {
    googleapisMock.queueSpreadsheetTitles(
      MANAGED_TABS.definitions.map((tab, index) => legacyTitleOrPlaceholder(tab, index, "last")),
    );
    const repository = await createRepository();

    await repository.readRawData();

    const requests = googleapisMock.batchUpdateCalls[0]?.requestBody?.requests ?? [];
    expect(requests.filter(hasRenameSheetRequest)).toHaveLength(7);
    expect(requests).toContainEqual({
      addSheet: {
        properties: {
          title: MANAGED_TABS.names.storeBDuplicates,
          gridProperties: { columnCount: 12, frozenRowCount: 1 },
        },
      },
    });
  });

  it("renames the previous generic Korean store tabs to configured store names", async () => {
    googleapisMock.queueSpreadsheetTitles(
      MANAGED_TABS.definitions.map((tab, index) => legacyTitleOrPlaceholder(tab, index, "first")),
    );
    const repository = await createRepository();

    await repository.readRawData();

    const requests = googleapisMock.batchUpdateCalls[0]?.requestBody?.requests ?? [];
    expect(requests.filter(hasRenameSheetRequest)).toHaveLength(7);
    expect(requests).toContainEqual({
      updateSheetProperties: {
        properties: {
          sheetId: 1,
          title: MANAGED_TABS.names.storeAView,
        },
        fields: "title",
      },
    });
  });

  it("renames configured store tabs and reuses their native tables", async () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    googleapisMock.queueSpreadsheetSheets(sheetsForManagedTabs(oldTabs));
    googleapisMock.queueSpreadsheetSheets(sheetsForManagedTabs(newTabs));

    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }

    const repository = await createRepository({
      storeBDisplayName: NEW_STORE_B_DISPLAY_NAME,
    });

    await repository.writeViews([baseRow]);

    const bootstrapRequests = googleapisMock.batchUpdateCalls[0]?.requestBody?.requests ?? [];
    expect(bootstrapRequests).toEqual([
      {
        updateSheetProperties: {
          properties: { sheetId: 2, title: newTabs.names.storeBView },
          fields: "title",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: 4, title: newTabs.names.storeBDuplicates },
          fields: "title",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: 5, title: newTabs.names.acrossStoresDuplicates },
          fields: "title",
        },
      },
    ]);

    const allRequests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    expect(allRequests.filter(hasAddTableRequest)).toEqual([]);
    expect(
      allRequests.filter(hasUpdateTableRequest).map((request) => request.updateTable.table.tableId),
    ).toEqual(expect.arrayContaining(["managed-table-2", "managed-table-4", "managed-table-5"]));
  });

  it("fails before value access when the new title is already occupied", async () => {
    const oldTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, OLD_STORE_B_DISPLAY_NAME);
    const newTabs = createManagedSheetTabs(STORE_A_DISPLAY_NAME, NEW_STORE_B_DISPLAY_NAME);
    googleapisMock.queueSpreadsheetSheets([
      ...sheetsForManagedTabs(oldTabs),
      sheetMetadata(99, newTabs.names.storeBView, 8, 12),
    ]);
    const repository = await createRepository({
      storeBDisplayName: NEW_STORE_B_DISPLAY_NAME,
    });

    await expect(repository.readRawData()).rejects.toThrow(
      '관리 탭 제목 충돌: "베스트브릿지 (truckhub) 매물" 탭과 ' +
        '"managed_store_b_inventory" 테이블이 서로 다른 시트에 있습니다',
    );

    expect(googleapisMock.batchUpdateCalls).toEqual([]);
    expect(googleapisMock.valuesGetCalls).toEqual([]);
  });

  it("initializes tabs once per repository instance", async () => {
    const repository = await createRepository();

    await repository.readRawData();
    await repository.writeRawData([]);

    expect(googleapisMock.spreadsheetGetCalls).toHaveLength(1);
  });

  it("orders operator tabs before developer tabs", async () => {
    const repository = await createRepository();

    await repository.readRawData();

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const indexUpdates = requests
      .filter(hasSheetIndexUpdate)
      .map((request) => request.updateSheetProperties.properties);

    expect(indexUpdates).toEqual(
      MANAGED_TABS.definitions.map((definition, index) => ({
        sheetId: index + 1,
        index,
        gridProperties: {
          frozenRowCount: 1,
          ...(definition.operatorFacing ? { frozenColumnCount: 2 } : {}),
        },
      })),
    );
  });

  it("formats a realistic mixed group on the across-store duplicate tab", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const bothDuplicate: SheetProductRow = {
      ...baseRow,
      productStatus: "OUTOFSTOCK",
      displayStatus: "SUSPENSION",
      duplicateStatus: "duplicated_both",
    };
    const secondBothDuplicate: SheetProductRow = {
      ...bothDuplicate,
      channelProductNo: "2002",
      productUrl: "https://example.com/store-a/products/2002",
    };
    const acrossStoresDuplicate: SheetProductRow = {
      ...bothDuplicate,
      storeKey: "B",
      storeName: STORE_B_DISPLAY_NAME,
      channelProductNo: "4001",
      productUrl: "https://example.com/store-b/products/4001",
      duplicateStatus: "duplicated_across_stores",
    };
    const firstSameStoreDuplicate: SheetProductRow = {
      ...bothDuplicate,
      channelProductNo: "2003",
      productUrl: "https://example.com/store-a/products/2003",
      normalizedPlate: "234나5678",
      duplicateStatus: "duplicated_in_same_store",
    };
    const secondSameStoreDuplicate: SheetProductRow = {
      ...firstSameStoreDuplicate,
      channelProductNo: "2004",
      productUrl: "https://example.com/store-a/products/2004",
    };
    const mixedGroup = [bothDuplicate, secondBothDuplicate, acrossStoresDuplicate];

    expect(
      mixedGroup.map((row) => ({
        storeKey: row.storeKey,
        duplicateStatus: row.duplicateStatus,
      })),
    ).toEqual([
      { storeKey: "A", duplicateStatus: "duplicated_both" },
      { storeKey: "A", duplicateStatus: "duplicated_both" },
      { storeKey: "B", duplicateStatus: "duplicated_across_stores" },
    ]);
    const repository = await createRepository();

    await repository.writeViews([
      secondSameStoreDuplicate,
      acrossStoresDuplicate,
      secondBothDuplicate,
      firstSameStoreDuplicate,
      bothDuplicate,
    ]);

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    expect(requests).toContainEqual({
      repeatCell: {
        range: {
          sheetId: 1,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 12,
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: rgbStyle("#174C3C"),
            textFormat: {
              bold: true,
              foregroundColorStyle: rgbStyle("#FFFFFF"),
            },
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE",
          },
        },
        fields:
          "userEnteredFormat(backgroundColorStyle,textFormat.bold,textFormat.foregroundColorStyle,horizontalAlignment,verticalAlignment)",
      },
    });

    const updateCellsRequest = requests
      .filter(hasUpdateCellsRequest)
      .find((request) => request.updateCells.start.sheetId === 5);
    const formattedRows = updateCellsRequest?.updateCells.rows ?? [];
    const formattedCells = formattedRows[0]?.values ?? [];
    const exceptionBackgrounds = [4, 5].map(
      (columnIndex) => formattedCells[columnIndex]?.userEnteredFormat?.backgroundColorStyle,
    );

    expect(updateCellsRequest?.updateCells.start).toEqual({
      sheetId: 5,
      rowIndex: 1,
      columnIndex: 0,
    });
    expect(formattedCells[2]?.userEnteredFormat?.textFormat?.foregroundColorStyle).toBeUndefined();
    expect(
      formattedRows.map((row) =>
        [0, 1].map(
          (columnIndex) => row.values?.[columnIndex]?.userEnteredFormat?.backgroundColorStyle,
        ),
      ),
    ).toEqual([
      [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
      [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
      [rgbStyle("#E8F0FE"), rgbStyle("#E8F0FE")],
    ]);
    const storeAInternalUpdateCellsRequest = requests
      .filter(hasUpdateCellsRequest)
      .find((request) => request.updateCells.start.sheetId === 3);
    const storeAInternalFormattedRows = storeAInternalUpdateCellsRequest?.updateCells.rows ?? [];

    expect(
      storeAInternalFormattedRows.map((row) =>
        [0, 1].map(
          (columnIndex) => row.values?.[columnIndex]?.userEnteredFormat?.backgroundColorStyle,
        ),
      ),
    ).toEqual([
      [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
      [rgbStyle("#FCE8E6"), rgbStyle("#FCE8E6")],
      [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
      [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
    ]);
    expect(exceptionBackgrounds).toEqual([rgbStyle("#FCE8D5"), rgbStyle("#FCE8D5")]);
    expect(formattedCells[3]?.userEnteredFormat).toEqual({ textFormat: { bold: false } });
    expect(requests).toContainEqual({
      updateBorders: {
        range: {
          sheetId: 5,
          startRowIndex: 1,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        top: {
          style: "SOLID_MEDIUM",
          colorStyle: rgbStyle("#C5221F"),
        },
        bottom: {
          style: "SOLID_MEDIUM",
          colorStyle: rgbStyle("#C5221F"),
        },
      },
    });
    const storeAUpdateCellsRequest = requests
      .filter(hasUpdateCellsRequest)
      .find((request) => request.updateCells.start.sheetId === 1);
    const storeAFormattedRows = storeAUpdateCellsRequest?.updateCells.rows ?? [];

    expect(
      storeAFormattedRows
        .slice(2)
        .map((row) =>
          [0, 1].map(
            (columnIndex) => row.values?.[columnIndex]?.userEnteredFormat?.backgroundColorStyle,
          ),
        ),
    ).toEqual([
      [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
      [rgbStyle("#FFF3C4"), rgbStyle("#FFF3C4")],
    ]);
    expect(requests).toContainEqual({
      updateBorders: {
        range: {
          sheetId: 1,
          startRowIndex: 3,
          endRowIndex: 5,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        top: {
          style: "SOLID_MEDIUM",
          colorStyle: rgbStyle("#B7791F"),
        },
        bottom: {
          style: "SOLID_MEDIUM",
          colorStyle: rgbStyle("#B7791F"),
        },
      },
    });
    expect(requests).toContainEqual({
      updateDimensionProperties: {
        range: {
          sheetId: 1,
          dimension: "COLUMNS",
          startIndex: 1,
          endIndex: 2,
        },
        properties: { pixelSize: 240, hiddenByUser: false },
        fields: "pixelSize,hiddenByUser",
      },
    });
  });

  it("clears obsolete duplicate row colors on the next sync", async () => {
    for (let index = 0; index < 12; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([
      {
        ...baseRow,
        duplicateStatus: "duplicated_in_same_store",
        displayStatus: "SUSPENSION",
        productStatus: "OUTOFSTOCK",
      },
    ]);
    await repository.writeViews([baseRow]);

    const sheetOneUpdates = googleapisMock.batchUpdateCalls
      .flatMap((call) => call.requestBody?.requests ?? [])
      .filter(hasUpdateCellsRequest)
      .filter((request) => request.updateCells.start.sheetId === 1);
    const latestFormats = sheetOneUpdates.at(-1)?.updateCells.rows[0]?.values ?? [];

    expect(latestFormats[0]?.userEnteredFormat).toEqual({ textFormat: { bold: false } });
    expect(latestFormats[1]?.userEnteredFormat).toEqual({ textFormat: { bold: false } });
    expect(latestFormats[4]?.userEnteredFormat).toEqual({ textFormat: { bold: false } });
    expect(latestFormats[5]?.userEnteredFormat).toEqual({ textFormat: { bold: false } });
  });

  it("reads raw data from the Korean raw tab and parses sparse trailing cells", async () => {
    const values = sheetProductRowToValues(baseRow).slice(0, -1);
    googleapisMock.queueGetValues([values]);
    const repository = await createRepository();

    const rows = await repository.readRawData();

    expect(googleapisMock.valuesGetCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'원본 데이터'!A2:U",
      },
    ]);
    expect(rows).toEqual([
      {
        ...baseRow,
        manualNote: "",
      },
    ]);
  });

  it("replaces raw data with Korean headers and localized statuses", async () => {
    googleapisMock.queueGetValues([
      RAW_DATA_HEADERS,
      sheetProductRowToValues(baseRow),
      sheetProductRowToValues(baseRow),
      sheetProductRowToValues(baseRow),
    ]);
    const repository = await createRepository();

    await repository.writeRawData([baseRow]);

    expect(googleapisMock.valuesGetCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'원본 데이터'!A:U",
      },
    ]);
    expect(only(googleapisMock.updateCalls)).toEqual({
      spreadsheetId: "spreadsheet-id",
      range: "'원본 데이터'!A1:U4",
      valueInputOption: "RAW",
      requestBody: {
        values: [
          RAW_DATA_HEADERS,
          sheetProductRowToValues(baseRow),
          blankRawDataRow(),
          blankRawDataRow(),
        ],
      },
    });
    expect(sheetProductRowToValues(baseRow)[11]).toBe("성공");
    expect(sheetProductRowToValues(baseRow)[12]).toBe("중복 없음");
  });

  it("writes every derived view to its Korean tab", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    expect(googleapisMock.valuesGetCalls.map((call) => call.range)).toEqual([
      "'동부트럭 (store-east) 매물'!A:L",
      "'서부트럭 (store-west) 매물'!A:L",
      "'동부트럭 (store-east) 내부 차량번호 중복'!A:L",
      "'서부트럭 (store-west) 내부 차량번호 중복'!A:L",
      "'동부트럭 (store-east)·서부트럭 (store-west) 차량번호 중복'!A:L",
      "'차량번호 추출 실패'!A:U",
    ]);
    expect(googleapisMock.updateCalls.map((call) => call.range)).toEqual([
      "'동부트럭 (store-east) 매물'!A1:L2",
      "'서부트럭 (store-west) 매물'!A1:L2",
      "'동부트럭 (store-east) 내부 차량번호 중복'!A1:L2",
      "'서부트럭 (store-west) 내부 차량번호 중복'!A1:L2",
      "'동부트럭 (store-east)·서부트럭 (store-west) 차량번호 중복'!A1:L2",
      "'차량번호 추출 실패'!A1:U2",
    ]);
    expect(googleapisMock.updateCalls[0]?.requestBody?.values).toEqual([
      OPERATOR_VIEW_HEADERS,
      sheetProductRowToOperatorValues(baseRow),
    ]);
  });

  it.each(GOOGLE_DUPLICATE_VIEW_CASES)(
    "writes $name duplicate rows into task-oriented tables",
    async ({ rows, storeAInternal, storeBInternal, crossStore }) => {
      for (let index = 0; index < 6; index += 1) {
        googleapisMock.queueGetValues([]);
      }
      const repository = await createRepository();

      await repository.writeViews(rows);

      expect(googleapisMock.updateCalls[2]?.requestBody?.values).toEqual(
        expectedOperatorValues(rows, storeAInternal),
      );
      expect(googleapisMock.updateCalls[3]?.requestBody?.values).toEqual(
        expectedOperatorValues(rows, storeBInternal),
      );
      expect(googleapisMock.updateCalls[4]?.requestBody?.values).toEqual(
        expectedOperatorValues(rows, crossStore),
      );
    },
  );

  it("excludes deleted duplicated rows from every derived view", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const deletedDuplicate: SheetProductRow = {
      ...googleDuplicateRow("A", "7101", "60바6000", "duplicated_both"),
      productStatus: "DELETE",
      extractionStatus: "not_found",
    };
    const repository = await createRepository();

    await repository.writeViews([deletedDuplicate]);

    for (let index = 0; index < 5; index += 1) {
      expect(googleapisMock.updateCalls[index]?.requestBody?.values).toEqual(
        expectedOperatorValues([], []),
      );
    }
    expect(googleapisMock.updateCalls[5]?.requestBody?.values).toEqual([
      RAW_DATA_HEADERS,
      blankRawDataRow(),
    ]);
  });

  it("reuses a native Google Sheets table for a managed view", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const updateTableRequest = requests
      .filter(hasUpdateTableRequest)
      .find((request) => request.updateTable.table.tableId === "managed-table-1");

    expect(updateTableRequest?.updateTable).toMatchObject({
      table: {
        tableId: "managed-table-1",
        range: {
          sheetId: 1,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 12,
        },
      },
    });
  });

  it("reuses and resizes an existing manually-created table", async () => {
    googleapisMock.queueSpreadsheetSheets(localizedSheetsWithStoreATable());
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const updateTableRequest = requests
      .filter(hasUpdateTableRequest)
      .find((request) => request.updateTable.table.tableId === "manual-store-a-table");

    expect(updateTableRequest?.updateTable).toMatchObject({
      table: {
        tableId: "manual-store-a-table",
        range: {
          sheetId: 1,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 12,
        },
      },
      fields: "range,columnProperties,rowsProperties",
    });
    expect(googleapisMock.valuesGetCalls[0]?.range).toBe("'동부트럭 (store-east) 매물'!A:U");
    expect(googleapisMock.updateCalls[0]?.range).toBe("'동부트럭 (store-east) 매물'!A1:U2");
    expect(
      googleapisMock.updateCalls[0]?.requestBody?.values?.every((row) => row.length === 21),
    ).toBe(true);
    expect(requests).toContainEqual({
      updateDimensionProperties: {
        range: {
          sheetId: 1,
          dimension: "COLUMNS",
          startIndex: 12,
          endIndex: 21,
        },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    });
  });

  it("preserves the manual duplicate table while splitting the legacy duplicate tab", async () => {
    googleapisMock.queueSpreadsheetSheets(legacySheetsWithManualDuplicateTable());
    googleapisMock.queueSpreadsheetSheets(localizedSheetsWithMigratedDuplicateTable());
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const updateTableRequest = requests
      .filter(hasUpdateTableRequest)
      .find((request) => request.updateTable.table.tableId === "manual-legacy-duplicates");

    expect(updateTableRequest?.updateTable.table).toMatchObject({
      tableId: "manual-legacy-duplicates",
      range: {
        sheetId: 3,
        startRowIndex: 0,
        endRowIndex: 2,
        startColumnIndex: 0,
        endColumnIndex: 12,
      },
    });
  });

  it("writes a Korean run-log header and appends localized mode values", async () => {
    const repository = await createRepository();

    await repository.appendRunLog({
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:01:00.000Z",
      mode: "live",
      syncScope: "all_stores",
      selectedStores: [STORE_A_DISPLAY_NAME, STORE_B_DISPLAY_NAME],
      syncedProductsThisRun: 5,
      sheetTotalProducts: 5,
      sheetExtractionSuccess: 4,
      sheetExtractionFailure: 1,
      sheetDuplicateProductRows: 3,
      summary: "동기화 완료",
    });

    expect(googleapisMock.updateCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'실행 기록'!A1:K1",
        valueInputOption: "RAW",
        requestBody: { values: [RUN_LOG_HEADERS] },
      },
    ]);
    expect(googleapisMock.appendCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'실행 기록'!A:K",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            [
              "2026-07-09T00:00:00.000Z",
              "2026-07-09T00:01:00.000Z",
              "실제 연동",
              "전체 스토어",
              "동부트럭 (store-east), 서부트럭 (store-west)",
              5,
              5,
              4,
              1,
              3,
              "동기화 완료",
            ],
          ],
        },
      },
    ]);
  });

  it("extends the existing run-log table on subsequent appends", async () => {
    googleapisMock.queueGetValues([]);
    googleapisMock.queueGetValues([
      RUN_LOG_HEADERS,
      [
        "2026-07-09T00:00:00.000Z",
        "2026-07-09T00:01:00.000Z",
        "실제 연동",
        "전체 스토어",
        "동부트럭 (store-east), 서부트럭 (store-west)",
        5,
        5,
        4,
        1,
        3,
        "첫 실행",
      ],
    ]);
    const repository = await createRepository();
    const firstRun: RunLogRow = {
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:01:00.000Z",
      mode: "live",
      syncScope: "all_stores",
      selectedStores: [STORE_A_DISPLAY_NAME, STORE_B_DISPLAY_NAME],
      syncedProductsThisRun: 5,
      sheetTotalProducts: 5,
      sheetExtractionSuccess: 4,
      sheetExtractionFailure: 1,
      sheetDuplicateProductRows: 3,
      summary: "첫 실행",
    };

    await repository.appendRunLog(firstRun);
    await repository.appendRunLog({
      ...firstRun,
      runStartedAt: "2026-07-09T00:05:00.000Z",
      runFinishedAt: "2026-07-09T00:06:00.000Z",
      summary: "두 번째 실행",
    });

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const updateTableRequests = requests.filter(
      (request): request is UpdateTableRequestValue =>
        hasUpdateTableRequest(request) && request.updateTable.table.tableId === "managed-table-8",
    );
    const updateTableRequest = updateTableRequests.at(-1);

    expect(updateTableRequest?.updateTable).toMatchObject({
      table: {
        tableId: "managed-table-8",
        range: {
          sheetId: 8,
          startRowIndex: 0,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 11,
        },
      },
      fields: "range,columnProperties,rowsProperties",
    });
  });

  it("migrates exact legacy run-log headers without relabeling legacy rows", async () => {
    googleapisMock.queueGetValues([
      [...LEGACY_RUN_LOG_HEADERS],
      [
        "2026-07-08T00:00:00.000Z",
        "2026-07-08T00:01:00.000Z",
        "모의 실행",
        8,
        6,
        2,
        4,
        "기존 실행",
      ],
    ]);
    const repository = await createRepository();

    await repository.appendRunLog({
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:01:00.000Z",
      mode: "mock",
      syncScope: "selected_stores",
      selectedStores: [STORE_A_DISPLAY_NAME],
      syncedProductsThisRun: 3,
      sheetTotalProducts: 4,
      sheetExtractionSuccess: 3,
      sheetExtractionFailure: 1,
      sheetDuplicateProductRows: 2,
      summary: "선택 실행",
    });

    expect(googleapisMock.updateCalls).toContainEqual({
      spreadsheetId: "spreadsheet-id",
      range: "'실행 기록'!A1:K2",
      valueInputOption: "RAW",
      requestBody: {
        values: [
          RUN_LOG_HEADERS,
          [
            "2026-07-08T00:00:00.000Z",
            "2026-07-08T00:01:00.000Z",
            "모의 실행",
            "이전 형식",
            "",
            "",
            8,
            6,
            2,
            4,
            "기존 실행",
          ],
        ],
      },
    });
    expect(googleapisMock.appendCalls[0]?.requestBody?.values).toEqual([
      [
        "2026-07-09T00:00:00.000Z",
        "2026-07-09T00:01:00.000Z",
        "모의 실행",
        "선택 스토어",
        "동부트럭 (store-east)",
        3,
        4,
        3,
        1,
        2,
        "선택 실행",
      ],
    ]);
  });

  it("rejects legacy run-log rows with non-empty I:K cells before updating or appending", async () => {
    googleapisMock.queueGetValues([
      [...LEGACY_RUN_LOG_HEADERS],
      [
        "2026-07-08T00:00:00.000Z",
        "2026-07-08T00:01:00.000Z",
        "모의 실행",
        8,
        6,
        2,
        4,
        "기존 실행",
        "보존해야 하는 값",
      ],
    ]);
    const repository = await createRepository();

    await expect(repository.prepareRunLog()).rejects.toThrow(
      "실행 기록 기존 8열 데이터의 I:K 영역에 값이 있어 자동 마이그레이션할 수 없습니다",
    );

    expect(googleapisMock.updateCalls).toEqual([]);
    expect(googleapisMock.appendCalls).toEqual([]);
  });

  it("preserves fully blank rows while migrating the legacy run log", async () => {
    googleapisMock.queueGetValues([
      [...LEGACY_RUN_LOG_HEADERS],
      ["2026-07-08T00:00:00.000Z", "2026-07-08T00:01:00.000Z", "모의 실행", 8, 6, 2, 4, "첫 실행"],
      [],
      [
        "2026-07-08T00:05:00.000Z",
        "2026-07-08T00:06:00.000Z",
        "모의 실행",
        9,
        7,
        2,
        5,
        "두 번째 실행",
      ],
    ]);
    const repository = await createRepository();

    await repository.prepareRunLog();

    expect(googleapisMock.updateCalls).toContainEqual({
      spreadsheetId: "spreadsheet-id",
      range: "'실행 기록'!A1:K4",
      valueInputOption: "RAW",
      requestBody: {
        values: [
          RUN_LOG_HEADERS,
          [
            "2026-07-08T00:00:00.000Z",
            "2026-07-08T00:01:00.000Z",
            "모의 실행",
            "이전 형식",
            "",
            "",
            8,
            6,
            2,
            4,
            "첫 실행",
          ],
          Array.from({ length: RUN_LOG_HEADERS.length }, () => ""),
          [
            "2026-07-08T00:05:00.000Z",
            "2026-07-08T00:06:00.000Z",
            "모의 실행",
            "이전 형식",
            "",
            "",
            9,
            7,
            2,
            5,
            "두 번째 실행",
          ],
        ],
      },
    });
    expect(googleapisMock.appendCalls).toEqual([]);
  });

  it("rejects an unknown non-empty run-log header without value writes", async () => {
    googleapisMock.queueGetValues([
      [
        "실행 시작일시",
        "실행 종료일시",
        "실행 모드",
        "알 수 없는 상품 수",
        "알 수 없는 성공 수",
        "알 수 없는 실패 수",
        "알 수 없는 중복 수",
        "실행 결과",
      ],
      [
        "2026-07-08T00:00:00.000Z",
        "2026-07-08T00:01:00.000Z",
        "모의 실행",
        8,
        6,
        2,
        4,
        "기존 실행",
      ],
    ]);
    const repository = await createRepository();

    await expect(
      repository.appendRunLog({
        runStartedAt: "2026-07-09T00:00:00.000Z",
        runFinishedAt: "2026-07-09T00:01:00.000Z",
        mode: "mock",
        syncScope: "selected_stores",
        selectedStores: [STORE_A_DISPLAY_NAME],
        syncedProductsThisRun: 3,
        sheetTotalProducts: 4,
        sheetExtractionSuccess: 3,
        sheetExtractionFailure: 1,
        sheetDuplicateProductRows: 2,
        summary: "선택 실행",
      }),
    ).rejects.toThrow(
      "실행 기록 헤더가 지원되지 않는 형식입니다. 빈 시트, 기존 8열 헤더, 현재 11열 헤더만 사용할 수 있습니다",
    );

    expect(googleapisMock.updateCalls).toEqual([]);
    expect(googleapisMock.appendCalls).toEqual([]);
  });

  it("uses a credentials file when one is configured", async () => {
    await createRepository({ credentialsFile: "/secure/google-service-account.json" });

    expect(only(googleapisMock.authCalls)).toEqual({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      keyFile: "/secure/google-service-account.json",
    });
  });

  it("validates and decodes Base64 service account credentials", async () => {
    const credentials = {
      type: "service_account",
      project_id: "synthetic-project",
      private_key_id: "synthetic-key-id",
      private_key: "synthetic-private-key",
      client_email: "sheet-writer@synthetic-project.iam.gserviceaccount.com",
      client_id: "1234567890",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const serviceAccountJsonBase64 = Buffer.from(JSON.stringify(credentials)).toString("base64");

    await createRepository({ serviceAccountJsonBase64 });

    expect(only(googleapisMock.authCalls)).toEqual({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      credentials: {
        type: credentials.type,
        project_id: credentials.project_id,
        private_key_id: credentials.private_key_id,
        private_key: credentials.private_key,
        client_email: credentials.client_email,
        client_id: credentials.client_id,
      },
    });
  });

  it("rejects malformed Base64 service account credentials without echoing them", async () => {
    const malformedCredential = Buffer.from('{"type":"authorized_user"}').toString("base64");

    await expect(
      createRepository({ serviceAccountJsonBase64: malformedCredential }),
    ).rejects.toThrow(
      "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 must contain a Base64-encoded Google service account JSON credential",
    );
  });

  it("includes the Korean raw tab row number when row parsing fails", async () => {
    const values = sheetProductRowToValues(baseRow);
    values[0] = "C";
    googleapisMock.queueGetValues([values]);
    const repository = await createRepository();

    await expect(repository.readRawData()).rejects.toThrow(
      "원본 데이터 2행: Invalid storeKey value: C",
    );
  });
});

function googleDuplicateRow(
  storeKey: SheetProductRow["storeKey"],
  channelProductNo: string,
  normalizedPlate: string,
  duplicateStatus: SheetProductRow["duplicateStatus"],
): SheetProductRow {
  const storeName = storeKey === "A" ? STORE_A_DISPLAY_NAME : STORE_B_DISPLAY_NAME;
  const storeSlug = storeKey === "A" ? "store-east" : "store-west";

  return {
    ...baseRow,
    storeKey,
    storeName,
    storeBaseUrl: `https://example.com/${storeSlug}`,
    channelProductNo,
    productUrl: `https://example.com/${storeSlug}/products/${channelProductNo}`,
    rawPlate: normalizedPlate,
    normalizedPlate,
    duplicateStatus,
  };
}

function expectedOperatorValues(
  rows: readonly SheetProductRow[],
  channelProductNumbers: readonly string[],
): string[][] {
  const values = [
    OPERATOR_VIEW_HEADERS,
    ...channelProductNumbers.map((channelProductNo) =>
      sheetProductRowToOperatorValues(productRow(rows, channelProductNo)),
    ),
  ];

  return channelProductNumbers.length === 0
    ? [...values, OPERATOR_VIEW_HEADERS.map(() => "")]
    : values;
}

function productRow(rows: readonly SheetProductRow[], channelProductNo: string): SheetProductRow {
  const row = rows.find((candidate) => candidate.channelProductNo === channelProductNo);

  if (row === undefined) {
    throw new Error(`Missing test product row: ${channelProductNo}`);
  }

  return row;
}

async function createRepository(
  overrides: Partial<GoogleSheetRepositoryOptions> = {},
): Promise<SheetRepository> {
  const module = await import("../../src/sheets/google-repository.js");

  return new module.GoogleSheetRepository({
    spreadsheetId: overrides.spreadsheetId ?? "spreadsheet-id",
    storeADisplayName: overrides.storeADisplayName ?? STORE_A_DISPLAY_NAME,
    storeBDisplayName: overrides.storeBDisplayName ?? STORE_B_DISPLAY_NAME,
    credentialsFile: overrides.credentialsFile,
    serviceAccountJsonBase64: overrides.serviceAccountJsonBase64,
  });
}

function legacyTitleOrPlaceholder(
  tab: SheetTabDefinition,
  index: number,
  position: "first" | "last",
): string {
  const title = position === "first" ? tab.legacyTitles[0] : tab.legacyTitles.at(-1);

  return title ?? `Unmanaged ${String(index + 1)}`;
}

function blankRawDataRow(): string[] {
  return RAW_DATA_COLUMNS.map(() => "");
}

function sheetsForManagedTabs(
  tabs: ManagedSheetTabs,
): NonNullable<SpreadsheetResponse["data"]["sheets"]> {
  return tabs.definitions.map((definition, index) => ({
    ...sheetMetadata(index + 1, definition.title, index, definition.columnCount),
    tables: [
      {
        tableId: `managed-table-${String(index + 1)}`,
        name: definition.tableName,
        range: {
          sheetId: index + 1,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: definition.columnCount,
        },
      },
    ],
  }));
}

function localizedSheetsWithStoreATable(): NonNullable<SpreadsheetResponse["data"]["sheets"]> {
  return sheetsForManagedTabs(MANAGED_TABS).map((sheet, index) =>
    index === 0
      ? {
          ...sheet,
          properties: {
            ...sheet.properties,
            gridProperties: { columnCount: 21 },
          },
          tables: [
            {
              tableId: "manual-store-a-table",
              name: "managed_store_a_inventory",
              range: {
                sheetId: 1,
                startRowIndex: 0,
                endRowIndex: 10,
                startColumnIndex: 0,
                endColumnIndex: 21,
              },
            },
          ],
        }
      : sheet,
  );
}

function legacySheetsWithManualDuplicateTable(): NonNullable<
  SpreadsheetResponse["data"]["sheets"]
> {
  return sheetsForManagedTabs(MANAGED_TABS).map((sheet, index) => {
    if (index === 2) {
      return {
        ...sheet,
        properties: {
          ...sheet.properties,
          title: "스토어 내부 중복",
          gridProperties: { columnCount: 21 },
        },
        tables: [manualDuplicateTable(3)],
      };
    }

    if (index === 4) {
      return {
        ...sheet,
        properties: {
          ...sheet.properties,
          title: "동부트럭 (store-east)·서부트럭 (store-west) 공통 매물",
          gridProperties: { columnCount: 21 },
        },
        tables: [],
      };
    }

    return sheet;
  });
}

function localizedSheetsWithMigratedDuplicateTable(): NonNullable<
  SpreadsheetResponse["data"]["sheets"]
> {
  const sheetIds = [1, 2, 3, 8, 4, 5, 6, 7];

  return MANAGED_TABS.definitions.map((definition, index) => ({
    ...sheetMetadata(
      sheetIds[index] ?? index + 1,
      definition.title,
      index,
      index < 5 ? 21 : definition.columnCount,
    ),
    ...(index === 2 ? { tables: [manualDuplicateTable(3)] } : {}),
  }));
}

function sheetMetadata(sheetId: number, title: string, index: number, columnCount: number) {
  return {
    properties: {
      sheetId,
      title,
      index,
      gridProperties: { columnCount },
    },
  };
}

function manualDuplicateTable(sheetId: number) {
  return {
    tableId: "manual-legacy-duplicates",
    name: "기존 중복 테이블",
    range: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: 61,
      startColumnIndex: 0,
      endColumnIndex: 21,
    },
  };
}

type SheetIndexUpdateRequest = {
  updateSheetProperties: {
    properties: {
      sheetId: number;
      index: number;
      gridProperties: { frozenRowCount: number };
    };
  };
};

type AddTableRequestValue = {
  addTable: {
    table: Record<string, unknown>;
  };
};

type UpdateTableRequestValue = {
  updateTable: {
    table: Record<string, unknown>;
    fields: unknown;
  };
};

type UpdateCellsRequestValue = {
  updateCells: {
    start: {
      sheetId: number;
      rowIndex: number;
      columnIndex: number;
    };
    rows: Array<{
      values?: Array<{
        userEnteredFormat?: {
          backgroundColorStyle?: unknown;
          textFormat?: {
            foregroundColorStyle?: unknown;
          };
        };
      }>;
    }>;
  };
};

function hasSheetIndexUpdate(value: unknown): value is SheetIndexUpdateRequest {
  if (!isRecord(value) || !isRecord(value.updateSheetProperties)) {
    return false;
  }

  const properties = value.updateSheetProperties.properties;

  return isRecord(properties) && typeof properties.index === "number";
}

function hasAddTableRequest(value: unknown): value is AddTableRequestValue {
  return isRecord(value) && isRecord(value.addTable) && isRecord(value.addTable.table);
}

function hasUpdateTableRequest(value: unknown): value is UpdateTableRequestValue {
  return isRecord(value) && isRecord(value.updateTable) && isRecord(value.updateTable.table);
}

function hasUpdateCellsRequest(value: unknown): value is UpdateCellsRequestValue {
  return (
    isRecord(value) &&
    isRecord(value.updateCells) &&
    isRecord(value.updateCells.start) &&
    Array.isArray(value.updateCells.rows)
  );
}

function rgbStyle(hex: string) {
  return {
    rgbColor: {
      red: Number.parseInt(hex.slice(1, 3), 16) / 255,
      green: Number.parseInt(hex.slice(3, 5), 16) / 255,
      blue: Number.parseInt(hex.slice(5, 7), 16) / 255,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasManagedMetadataFields(call: SpreadsheetGetParams): boolean {
  return (
    call.spreadsheetId === "spreadsheet-id" &&
    call.fields ===
      "sheets(properties(sheetId,title,index,gridProperties(columnCount)),tables(tableId,name,range))"
  );
}

function hasRenameSheetRequest(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.updateSheetProperties)) {
    return false;
  }

  return value.updateSheetProperties.fields === "title";
}

function only<T>(values: readonly T[]): T {
  const value = values[0];

  if (value === undefined) {
    throw new Error("Expected one value");
  }

  expect(values).toHaveLength(1);

  return value;
}

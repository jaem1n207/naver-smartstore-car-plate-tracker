import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagedSheetTabs,
  OPERATOR_VIEW_HEADERS,
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RUN_LOG_HEADERS,
  sheetProductRowToOperatorValues,
  sheetProductRowToValues,
} from "../../src/sheets/columns.js";
import type { SheetTabDefinition } from "../../src/sheets/columns.js";
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
        sheets: [
          {
            properties: {
              sheetId: 1,
              title: "동부트럭 (store-east) 매물",
              index: 0,
              gridProperties: { columnCount: 12 },
            },
          },
          {
            properties: {
              sheetId: 2,
              title: "서부트럭 (store-west) 매물",
              index: 1,
              gridProperties: { columnCount: 12 },
            },
          },
          {
            properties: {
              sheetId: 3,
              title: "동부트럭 (store-east) 내부 차량번호 중복",
              index: 2,
              gridProperties: { columnCount: 12 },
            },
          },
          {
            properties: {
              sheetId: 4,
              title: "서부트럭 (store-west) 내부 차량번호 중복",
              index: 3,
              gridProperties: { columnCount: 12 },
            },
          },
          {
            properties: {
              sheetId: 5,
              title: "동부트럭 (store-east)·서부트럭 (store-west) 차량번호 중복",
              index: 4,
              gridProperties: { columnCount: 12 },
            },
          },
          {
            properties: {
              sheetId: 6,
              title: "원본 데이터",
              index: 5,
              gridProperties: { columnCount: 21 },
            },
          },
          {
            properties: {
              sheetId: 7,
              title: "차량번호 추출 실패",
              index: 6,
              gridProperties: { columnCount: 21 },
            },
          },
          {
            properties: {
              sheetId: 8,
              title: "실행 기록",
              index: 7,
              gridProperties: { columnCount: 8 },
            },
          },
        ],
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
        gridProperties: { frozenRowCount: 1 },
      })),
    );
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

  it("writes mutually exclusive store-only and cross-store duplicate tables", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const storeAOnlyDuplicate: SheetProductRow = {
      ...baseRow,
      duplicateStatus: "duplicated_in_same_store",
    };
    const storeBOnlyDuplicate: SheetProductRow = {
      ...baseRow,
      storeKey: "B",
      storeName: STORE_B_DISPLAY_NAME,
      channelProductNo: "4001",
      productUrl: "https://example.com/store-b/products/4001",
      duplicateStatus: "duplicated_in_same_store",
    };
    const crossStoreDuplicate: SheetProductRow = {
      ...baseRow,
      channelProductNo: "2002",
      productUrl: "https://example.com/store-a/products/2002",
      duplicateStatus: "duplicated_both",
    };
    const repository = await createRepository();

    await repository.writeViews([storeAOnlyDuplicate, storeBOnlyDuplicate, crossStoreDuplicate]);

    expect(googleapisMock.updateCalls[2]?.requestBody?.values).toEqual([
      OPERATOR_VIEW_HEADERS,
      sheetProductRowToOperatorValues(storeAOnlyDuplicate),
    ]);
    expect(googleapisMock.updateCalls[3]?.requestBody?.values).toEqual([
      OPERATOR_VIEW_HEADERS,
      sheetProductRowToOperatorValues(storeBOnlyDuplicate),
    ]);
    expect(googleapisMock.updateCalls[4]?.requestBody?.values).toEqual([
      OPERATOR_VIEW_HEADERS,
      sheetProductRowToOperatorValues(crossStoreDuplicate),
    ]);
  });

  it("creates a native Google Sheets table for a managed view without one", async () => {
    for (let index = 0; index < 6; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const addTableRequest = requests
      .filter(hasAddTableRequest)
      .find((request) => request.addTable.table.name === "managed_store_a_inventory");

    expect(addTableRequest?.addTable.table).toMatchObject({
      name: "managed_store_a_inventory",
      range: {
        sheetId: 1,
        startRowIndex: 0,
        endRowIndex: 2,
        startColumnIndex: 0,
        endColumnIndex: 12,
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
      totalProducts: 5,
      successCount: 4,
      failureCount: 1,
      duplicateCount: 3,
      message: "동기화 완료",
    });

    expect(googleapisMock.updateCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'실행 기록'!A1:H1",
        valueInputOption: "RAW",
        requestBody: { values: [RUN_LOG_HEADERS] },
      },
    ]);
    expect(googleapisMock.appendCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        range: "'실행 기록'!A:H",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            [
              "2026-07-09T00:00:00.000Z",
              "2026-07-09T00:01:00.000Z",
              "실제 연동",
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
      ["2026-07-09T00:00:00.000Z", "2026-07-09T00:01:00.000Z", "실제 연동", 5, 4, 1, 3, "첫 실행"],
    ]);
    const repository = await createRepository();
    const firstRun: RunLogRow = {
      runStartedAt: "2026-07-09T00:00:00.000Z",
      runFinishedAt: "2026-07-09T00:01:00.000Z",
      mode: "live",
      totalProducts: 5,
      successCount: 4,
      failureCount: 1,
      duplicateCount: 3,
      message: "첫 실행",
    };

    await repository.appendRunLog(firstRun);
    await repository.appendRunLog({
      ...firstRun,
      runStartedAt: "2026-07-09T00:05:00.000Z",
      runFinishedAt: "2026-07-09T00:06:00.000Z",
      message: "두 번째 실행",
    });

    const requests = googleapisMock.batchUpdateCalls.flatMap(
      (call) => call.requestBody?.requests ?? [],
    );
    const updateTableRequest = requests
      .filter(hasUpdateTableRequest)
      .find((request) => request.updateTable.table.tableId === "101");

    expect(updateTableRequest?.updateTable).toMatchObject({
      table: {
        tableId: "101",
        range: {
          sheetId: 8,
          startRowIndex: 0,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
      },
      fields: "range,columnProperties,rowsProperties",
    });
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

function localizedSheetsWithStoreATable(): NonNullable<SpreadsheetResponse["data"]["sheets"]> {
  return MANAGED_TABS.definitions.map((definition, index) => ({
    properties: {
      sheetId: index + 1,
      title: definition.title,
      index,
      gridProperties: { columnCount: index === 0 ? 21 : definition.columnCount },
    },
    ...(index === 0
      ? {
          tables: [
            {
              tableId: "manual-store-a-table",
              name: "기존 수동 테이블",
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
      : {}),
  }));
}

function legacySheetsWithManualDuplicateTable(): NonNullable<
  SpreadsheetResponse["data"]["sheets"]
> {
  return [
    sheetMetadata(1, MANAGED_TABS.names.storeAView, 0, 21),
    sheetMetadata(2, MANAGED_TABS.names.storeBView, 1, 21),
    {
      ...sheetMetadata(3, "스토어 내부 중복", 2, 21),
      tables: [manualDuplicateTable(3)],
    },
    sheetMetadata(4, "동부트럭 (store-east)·서부트럭 (store-west) 공통 매물", 3, 21),
    sheetMetadata(5, MANAGED_TABS.names.rawData, 4, 21),
    sheetMetadata(6, MANAGED_TABS.names.extractionFailures, 5, 21),
    sheetMetadata(7, MANAGED_TABS.names.runLog, 6, 8),
  ];
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

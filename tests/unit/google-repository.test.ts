import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAW_DATA_COLUMNS,
  RAW_DATA_HEADERS,
  RUN_LOG_HEADERS,
  SHEET_TABS,
  sheetProductRowToValues,
} from "../../src/sheets/columns.js";
import type { GoogleSheetRepositoryOptions } from "../../src/sheets/google-repository.js";
import type { SheetProductRow, SheetRepository } from "../../src/sheets/types.js";

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
      };
    }>;
  };
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
  const spreadsheetGetCalls: SpreadsheetGetParams[] = [];
  const batchUpdateCalls: SpreadsheetBatchUpdateParams[] = [];
  const valuesGetCalls: ValuesGetParams[] = [];
  const updateCalls: ValuesUpdateParams[] = [];
  const appendCalls: ValuesAppendParams[] = [];
  const spreadsheetResponses: SpreadsheetResponse[] = [];
  const valueResponses: ValueRangeResponse[] = [];

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

    return Promise.resolve({ data: {} });
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
        sheets: titles.map((title, index) => ({ properties: { sheetId: index + 1, title } })),
      },
    });
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
  }

  function localizedSheetsResponse(): SpreadsheetResponse {
    return {
      data: {
        sheets: [
          { properties: { sheetId: 1, title: "원본 데이터" } },
          { properties: { sheetId: 2, title: "A스토어 매물" } },
          { properties: { sheetId: 3, title: "B스토어 매물" } },
          { properties: { sheetId: 4, title: "양쪽 스토어 중복" } },
          { properties: { sheetId: 5, title: "스토어 내부 중복" } },
          { properties: { sheetId: 6, title: "차량번호 추출 실패" } },
          { properties: { sheetId: 7, title: "실행 기록" } },
        ],
      },
    };
  }

  return {
    appendCalls,
    authCalls,
    batchUpdateCalls,
    queueGetValues,
    queueSpreadsheetTitles,
    reset,
    sheetsCalls,
    spreadsheetGetCalls,
    updateCalls,
    valuesGetCalls,
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

  it("creates missing Korean tabs and freezes their header rows", async () => {
    googleapisMock.queueSpreadsheetTitles(["Sheet1"]);
    const repository = await createRepository();

    await repository.readRawData();

    expect(googleapisMock.spreadsheetGetCalls).toEqual([
      {
        spreadsheetId: "spreadsheet-id",
        fields: "sheets.properties(sheetId,title)",
      },
    ]);
    const requests = only(googleapisMock.batchUpdateCalls).requestBody?.requests ?? [];
    expect(requests).toHaveLength(SHEET_TABS.length);
    expect(requests).toEqual(
      SHEET_TABS.map((tab) => ({
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
    googleapisMock.queueSpreadsheetTitles(SHEET_TABS.map((tab) => tab.legacyTitle));
    const repository = await createRepository();

    await repository.readRawData();

    const requests = only(googleapisMock.batchUpdateCalls).requestBody?.requests ?? [];
    expect(requests).toEqual(
      SHEET_TABS.map((tab, index) => ({
        updateSheetProperties: {
          properties: {
            sheetId: index + 1,
            title: tab.title,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "title,gridProperties.frozenRowCount",
        },
      })),
    );
  });

  it("initializes tabs once per repository instance", async () => {
    const repository = await createRepository();

    await repository.readRawData();
    await repository.writeRawData([]);

    expect(googleapisMock.spreadsheetGetCalls).toHaveLength(1);
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
    for (let index = 0; index < 5; index += 1) {
      googleapisMock.queueGetValues([]);
    }
    const repository = await createRepository();

    await repository.writeViews([baseRow]);

    expect(googleapisMock.valuesGetCalls.map((call) => call.range)).toEqual([
      "'A스토어 매물'!A:U",
      "'B스토어 매물'!A:U",
      "'양쪽 스토어 중복'!A:U",
      "'스토어 내부 중복'!A:U",
      "'차량번호 추출 실패'!A:U",
    ]);
    expect(googleapisMock.updateCalls.map((call) => call.range)).toEqual([
      "'A스토어 매물'!A1:U2",
      "'B스토어 매물'!A1:U1",
      "'양쪽 스토어 중복'!A1:U1",
      "'스토어 내부 중복'!A1:U1",
      "'차량번호 추출 실패'!A1:U1",
    ]);
    expect(googleapisMock.updateCalls[0]?.requestBody?.values).toEqual([
      RAW_DATA_HEADERS,
      sheetProductRowToValues(baseRow),
    ]);
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
    credentialsFile: overrides.credentialsFile,
    serviceAccountJsonBase64: overrides.serviceAccountJsonBase64,
  });
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

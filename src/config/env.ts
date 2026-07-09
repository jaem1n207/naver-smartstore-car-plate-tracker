import { z } from "zod";

const RequiredText = z.string().trim().min(1);

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  TZ: z.string().default("Asia/Seoul"),
  LOG_LEVEL: z.string().default("info"),
  NAVER_API_MODE: z.enum(["mock", "live"]).default("mock"),
  ALLOW_LIVE_NAVER_API: z.enum(["true", "false"]).default("false"),
  NAVER_API_BASE_URL: z.url().default("https://api.commerce.naver.com/external"),
  SYNC_CRON: z.string().default("*/5 * * * *"),
  STORE_A_NAME: RequiredText,
  STORE_A_BASE_URL: z.url(),
  STORE_A_CLIENT_ID: RequiredText,
  STORE_A_CLIENT_SECRET: RequiredText,
  STORE_A_ACCOUNT_ID: RequiredText,
  STORE_B_NAME: RequiredText,
  STORE_B_BASE_URL: z.url(),
  STORE_B_CLIENT_ID: RequiredText,
  STORE_B_CLIENT_SECRET: RequiredText,
  STORE_B_ACCOUNT_ID: RequiredText,
  GOOGLE_SHEETS_SPREADSHEET_ID: RequiredText,
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppEnv {
  readonly nodeEnv: string;
  readonly tz: string;
  readonly logLevel: string;
  readonly naverApiMode: "mock" | "live";
  readonly allowLiveNaverApi: boolean;
  readonly naverApiBaseUrl: string;
  readonly syncCron: string;
  readonly storeAName: string;
  readonly storeABaseUrl: string;
  readonly storeAClientId: string;
  readonly storeAClientSecret: string;
  readonly storeAAccountId: string;
  readonly storeBName: string;
  readonly storeBBaseUrl: string;
  readonly storeBClientId: string;
  readonly storeBClientSecret: string;
  readonly storeBAccountId: string;
  readonly googleSheetsSpreadsheetId: string;
  readonly googleApplicationCredentials: string | undefined;
  readonly googleServiceAccountJsonBase64: string | undefined;
  readonly raw: RawEnv;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const raw = EnvSchema.parse(source);
  const allowLiveNaverApi = raw.ALLOW_LIVE_NAVER_API === "true";

  if (raw.NAVER_API_MODE === "live" && !allowLiveNaverApi) {
    throw new Error("Live Naver API mode requires ALLOW_LIVE_NAVER_API=true");
  }

  return {
    nodeEnv: raw.NODE_ENV,
    tz: raw.TZ,
    logLevel: raw.LOG_LEVEL,
    naverApiMode: raw.NAVER_API_MODE,
    allowLiveNaverApi,
    naverApiBaseUrl: raw.NAVER_API_BASE_URL,
    syncCron: raw.SYNC_CRON,
    storeAName: raw.STORE_A_NAME,
    storeABaseUrl: raw.STORE_A_BASE_URL,
    storeAClientId: raw.STORE_A_CLIENT_ID,
    storeAClientSecret: raw.STORE_A_CLIENT_SECRET,
    storeAAccountId: raw.STORE_A_ACCOUNT_ID,
    storeBName: raw.STORE_B_NAME,
    storeBBaseUrl: raw.STORE_B_BASE_URL,
    storeBClientId: raw.STORE_B_CLIENT_ID,
    storeBClientSecret: raw.STORE_B_CLIENT_SECRET,
    storeBAccountId: raw.STORE_B_ACCOUNT_ID,
    googleSheetsSpreadsheetId: raw.GOOGLE_SHEETS_SPREADSHEET_ID,
    googleApplicationCredentials: raw.GOOGLE_APPLICATION_CREDENTIALS,
    googleServiceAccountJsonBase64: raw.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,
    raw,
  };
}

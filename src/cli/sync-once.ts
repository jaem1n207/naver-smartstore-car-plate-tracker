import "dotenv/config";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { LiveNaverCommerceClient } from "../naver/client.js";
import { MockNaverCommerceClient } from "../naver/mock-client.js";
import { GoogleSheetRepository } from "../sheets/google-repository.js";
import { InMemorySheetRepository } from "../sheets/in-memory-repository.js";
import { runSyncJob } from "../sync/sync-job.js";

const env = loadEnv();
const logger = pino({ level: env.logLevel === "silent" ? "silent" : env.logLevel });
const stores = loadStores(env);
const naverClient =
  env.naverApiMode === "live"
    ? new LiveNaverCommerceClient({ baseUrl: env.naverApiBaseUrl })
    : new MockNaverCommerceClient();
const sheetRepository =
  env.naverApiMode === "live"
    ? new GoogleSheetRepository(env.googleSheetsSpreadsheetId)
    : new InMemorySheetRepository();

const result = await runSyncJob({
  env,
  stores,
  naverClient,
  sheetRepository,
  now: () => new Date(),
});

logger.info(result, "sync completed");

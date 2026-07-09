import "dotenv/config";
import cron from "node-cron";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { safeErrorLog } from "../logging/safe-error.js";
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

let running = false;

cron.schedule(env.syncCron, async () => {
  if (running) {
    logger.warn("previous sync is still running");
    return;
  }

  running = true;

  try {
    const result = await runSyncJob({
      env,
      stores,
      naverClient,
      sheetRepository,
      now: () => new Date(),
    });

    logger.info(result, "scheduled sync completed");
  } catch (error) {
    logger.error({ error: safeErrorLog(error, runtimeSecrets()) }, "scheduled sync failed");
  } finally {
    running = false;
  }
});

logger.info({ cron: env.syncCron, mode: env.naverApiMode }, "scheduler started");

function runtimeSecrets(): string[] {
  return [
    env.storeAClientSecret,
    env.storeBClientSecret,
    env.storeAClientId,
    env.storeBClientId,
    env.storeAAccountId,
    env.storeBAccountId,
    env.googleServiceAccountJsonBase64 ?? "",
  ];
}

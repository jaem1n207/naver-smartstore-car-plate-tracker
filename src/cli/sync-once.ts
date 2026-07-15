import "dotenv/config";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { selectStoresFromArgs } from "./store-selection.js";
import { runtimeSecretValues, safeErrorLog } from "../logging/safe-error.js";
import { LiveNaverCommerceClient } from "../naver/client.js";
import { MockNaverCommerceClient } from "../naver/mock-client.js";
import { GoogleSheetRepository } from "../sheets/google-repository.js";
import { InMemorySheetRepository } from "../sheets/in-memory-repository.js";
import { runLockedSyncJob } from "../sync/run-locked-sync-job.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.logLevel === "silent" ? "silent" : env.logLevel });
  const stores = loadStores(env);
  const selectedStores = selectStoresFromArgs(stores, process.argv.slice(2));
  const naverClient =
    env.naverApiMode === "live"
      ? new LiveNaverCommerceClient({ baseUrl: env.naverApiBaseUrl })
      : new MockNaverCommerceClient();
  const sheetRepository =
    env.naverApiMode === "live"
      ? new GoogleSheetRepository({
          spreadsheetId: env.googleSheetsSpreadsheetId,
          storeADisplayName: stores[0].storeDisplayName,
          storeBDisplayName: stores[1].storeDisplayName,
          credentialsFile: env.googleApplicationCredentials,
          serviceAccountJsonBase64: env.googleServiceAccountJsonBase64,
        })
      : new InMemorySheetRepository();

  const result = await runLockedSyncJob(
    {
      env,
      stores: selectedStores,
      naverClient,
      sheetRepository,
      now: () => new Date(),
    },
    { lockDir: env.syncLockDir },
  );

  logger.info(result, "sync completed");
}

await main().catch((error: unknown) => {
  const logger = pino({ level: "error" });
  logger.error({ error: safeErrorLog(error, runtimeSecretValues(process.env)) }, "sync failed");
  process.exitCode = 1;
});

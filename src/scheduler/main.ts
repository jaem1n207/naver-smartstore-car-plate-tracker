import "dotenv/config";
import cron from "node-cron";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { runtimeSecretValues, safeErrorLog } from "../logging/safe-error.js";
import { LiveNaverCommerceClient } from "../naver/client.js";
import { MockNaverCommerceClient } from "../naver/mock-client.js";
import { GoogleSheetRepository } from "../sheets/google-repository.js";
import { InMemorySheetRepository } from "../sheets/in-memory-repository.js";
import { createScheduler, registerSchedulerShutdownHandlers } from "./scheduler.js";
import type { SchedulerLogger } from "./scheduler.js";
import { runLockedSyncJob } from "../sync/run-locked-sync-job.js";

function main(): void {
  const env = loadEnv();
  const logger = pino({ level: env.logLevel === "silent" ? "silent" : env.logLevel });
  const stores = loadStores(env);
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
  const secrets = runtimeSecrets(env);
  const schedulerLogger: SchedulerLogger = {
    error: (bindings, message) => {
      logger.error({ ...bindings, error: safeErrorLog(bindings.error, secrets) }, message);
    },
    info: (bindings, message) => {
      logger.info(bindings, message);
    },
    warn: (bindings, message) => {
      logger.warn(bindings, message);
    },
  };
  const controller = createScheduler({
    appRevision: env.appRevision,
    cron: env.syncCron,
    logger: schedulerLogger,
    mode: env.naverApiMode,
    runSync: () =>
      runLockedSyncJob(
        {
          env,
          stores,
          naverClient,
          sheetRepository,
          now: () => new Date(),
        },
        { lockDir: env.syncLockDir },
      ),
    schedule: (expression, callback) => cron.schedule(expression, callback),
  });

  registerSchedulerShutdownHandlers({
    controller,
    onError: (signal, error) => {
      logger.error({ error: safeErrorLog(error, secrets), signal }, "scheduler shutdown failed");
    },
  });
}

try {
  main();
} catch (error) {
  const logger = pino({ level: "error" });
  logger.error(
    { error: safeErrorLog(error, runtimeSecretValues(process.env)) },
    "scheduler startup failed",
  );
  process.exitCode = 1;
}

function runtimeSecrets(env: ReturnType<typeof loadEnv>): string[] {
  return [
    env.storeAClientSecret,
    env.storeBClientSecret,
    env.storeAClientId,
    env.storeBClientId,
    env.googleServiceAccountJsonBase64 ?? "",
  ];
}

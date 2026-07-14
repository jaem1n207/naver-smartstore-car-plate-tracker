import type { SyncJobResult } from "../sync/sync-job.js";

export interface ScheduledTask {
  stop(): Promise<void> | void;
}

export interface SchedulerLogger {
  error(bindings: Record<string, unknown>, message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface SchedulerController {
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

export interface SchedulerShutdownHandlerOptions {
  readonly controller: SchedulerController;
  readonly onError: (signal: NodeJS.Signals, error: unknown) => void;
}

export interface SchedulerOptions {
  readonly schedule: (expression: string, callback: () => Promise<void>) => ScheduledTask;
  readonly runSync: () => Promise<SyncJobResult>;
  readonly cron: string;
  readonly mode: "mock" | "live";
  readonly appRevision: string;
  readonly logger: SchedulerLogger;
}

export function createScheduler(options: SchedulerOptions): SchedulerController {
  let activeSync: Promise<void> | undefined;
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;

  const trigger = async (): Promise<void> => {
    if (draining) {
      options.logger.warn({ reason: "draining" }, "scheduled sync skipped");
      return;
    }

    if (activeSync !== undefined) {
      options.logger.warn({ reason: "active_sync" }, "scheduled sync skipped");
      return;
    }

    const syncPromise = Promise.resolve().then(async () => {
      if (draining) {
        options.logger.warn({ reason: "draining" }, "scheduled sync skipped");
        return;
      }

      try {
        const result = await options.runSync();
        options.logger.info({ ...result }, "scheduled sync completed");
      } catch (error: unknown) {
        options.logger.error({ error }, "scheduled sync failed");
      }
    });
    activeSync = syncPromise;

    try {
      await syncPromise;
    } finally {
      if (activeSync === syncPromise) {
        activeSync = undefined;
      }
    }
  };

  const task = options.schedule(options.cron, trigger);
  options.logger.info(
    { appRevision: options.appRevision, cron: options.cron, mode: options.mode },
    "scheduler started",
  );

  return {
    shutdown: (signal) => {
      if (shutdownPromise !== undefined) {
        return shutdownPromise;
      }

      draining = true;
      shutdownPromise = (async () => {
        let stopError: unknown;
        let stopFailed = false;
        try {
          await task.stop();
        } catch (error: unknown) {
          stopError = error;
          stopFailed = true;
        }
        await activeSync;

        if (stopFailed) {
          throw stopError;
        }

        options.logger.info({ signal }, "scheduler stopped");
      })();

      return shutdownPromise;
    },
  };
}

export function registerSchedulerShutdownHandlers(
  options: SchedulerShutdownHandlerOptions,
): () => void {
  let observedShutdown: Promise<void> | undefined;
  const handleSignal = (signal: NodeJS.Signals): void => {
    const shutdown = options.controller.shutdown(signal);

    if (observedShutdown !== undefined) {
      return;
    }

    observedShutdown = shutdown;
    void shutdown
      .then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          options.onError(signal, error);
          process.exitCode = 1;
        },
      )
      .finally(unregister);
  };
  const handleSigterm = (): void => {
    handleSignal("SIGTERM");
  };
  const handleSigint = (): void => {
    handleSignal("SIGINT");
  };
  const unregister = (): void => {
    process.off("SIGTERM", handleSigterm);
    process.off("SIGINT", handleSigint);
  };

  process.on("SIGTERM", handleSigterm);
  process.on("SIGINT", handleSigint);

  return unregister;
}

import { describe, expect, it, vi } from "vitest";
import type {
  ScheduledTask,
  SchedulerLogger,
  SchedulerOptions,
} from "../../src/scheduler/scheduler.js";
import { createScheduler } from "../../src/scheduler/scheduler.js";
import type { SyncJobResult } from "../../src/sync/sync-job.js";

const syncResult: SyncJobResult = {
  syncScope: "all_stores",
  selectedStores: ["Store A", "Store B"],
  syncedProductsThisRun: 5,
  sheetTotalProducts: 5,
  sheetExtractionSuccess: 4,
  sheetExtractionFailure: 1,
  sheetDuplicateProductRows: 3,
  summary: "동기화 완료",
};

describe("createScheduler", () => {
  it("logs the startup identity and schedules the configured expression", () => {
    const fixture = createFixture();

    createScheduler(fixture.options);

    expect(fixture.schedule).toHaveBeenCalledWith("*/5 * * * *", expect.any(Function));
    expect(fixture.logs).toContainEqual({
      level: "info",
      bindings: { appRevision: "revision-123", cron: "*/5 * * * *", mode: "mock" },
      message: "scheduler started",
    });
  });

  it("drains the active synchronization once and ignores repeated signals", async () => {
    const activeSync = deferred<SyncJobResult>();
    const fixture = createFixture(() => activeSync.promise);
    const controller = createScheduler(fixture.options);
    const trigger = fixture.getTrigger();
    const scheduledRun = trigger();
    await waitFor(() => fixture.runSync.mock.calls.length === 1);

    const firstShutdown = controller.shutdown("SIGTERM");
    const repeatedShutdown = controller.shutdown("SIGINT");
    let shutdownResolved = false;
    void firstShutdown.then(() => {
      shutdownResolved = true;
    });

    expect(repeatedShutdown).toBe(firstShutdown);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(shutdownResolved).toBe(false);

    await trigger();
    expect(fixture.runSync).toHaveBeenCalledTimes(1);

    activeSync.resolve(syncResult);
    await Promise.all([scheduledRun, firstShutdown, repeatedShutdown]);

    expect(shutdownResolved).toBe(true);
    expect(fixture.logs).toContainEqual({
      level: "info",
      bindings: syncResult,
      message: "scheduled sync completed",
    });
    expect(fixture.logs.filter((entry) => entry.message === "scheduler stopped")).toEqual([
      {
        level: "info",
        bindings: { signal: "SIGTERM" },
        message: "scheduler stopped",
      },
    ]);
  });

  it("does not start a trigger whose final acquisition check races with draining", async () => {
    const fixture = createFixture();
    const controller = createScheduler(fixture.options);
    const trigger = fixture.getTrigger();

    const scheduledRun = trigger();
    const shutdown = controller.shutdown("SIGTERM");
    await Promise.all([scheduledRun, shutdown]);

    expect(fixture.runSync).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });

  it("records a failed synchronization and still waits for its cleanup", async () => {
    let cleanupFinished = false;
    const fixture = createFixture(async () => {
      try {
        throw new Error("synchronization failed");
      } finally {
        await Promise.resolve();
        cleanupFinished = true;
      }
    });
    const controller = createScheduler(fixture.options);
    const scheduledRun = fixture.getTrigger()();
    await scheduledRun;
    await controller.shutdown("SIGTERM");

    expect(cleanupFinished).toBe(true);
    const errorLog = fixture.logs.find((entry) => entry.message === "scheduled sync failed");
    expect(errorLog?.level).toBe("error");
    expect(errorLog?.bindings.error).toBeInstanceOf(Error);
  });

  it("skips an overlapping trigger while a synchronization is active", async () => {
    const activeSync = deferred<SyncJobResult>();
    const fixture = createFixture(() => activeSync.promise);
    const controller = createScheduler(fixture.options);
    const trigger = fixture.getTrigger();
    const firstRun = trigger();
    await waitFor(() => fixture.runSync.mock.calls.length === 1);

    await trigger();

    expect(fixture.runSync).toHaveBeenCalledTimes(1);
    expect(fixture.logs).toContainEqual({
      level: "warn",
      bindings: { reason: "active_sync" },
      message: "scheduled sync skipped",
    });

    activeSync.resolve(syncResult);
    await firstRun;
    await controller.shutdown("SIGTERM");
  });

  it("still drains an active synchronization when stopping the cron task fails", async () => {
    const activeSync = deferred<SyncJobResult>();
    const stopError = new Error("cron stop failed");
    const fixture = createFixture(
      () => activeSync.promise,
      () => Promise.reject(stopError),
    );
    const controller = createScheduler(fixture.options);
    const scheduledRun = fixture.getTrigger()();
    await waitFor(() => fixture.runSync.mock.calls.length === 1);

    const shutdownResult = controller.shutdown("SIGTERM").then(
      () => "resolved",
      (error: unknown) => error,
    );
    const pendingMarker = await Promise.race([
      shutdownResult,
      new Promise<"pending">((resolve) => {
        setTimeout(() => {
          resolve("pending");
        }, 10);
      }),
    ]);
    expect(pendingMarker).toBe("pending");

    activeSync.resolve(syncResult);
    await scheduledRun;
    expect(await shutdownResult).toBe(stopError);
  });
});

interface LogEntry {
  readonly level: "error" | "info" | "warn";
  readonly bindings: Record<string, unknown>;
  readonly message: string;
}

function createFixture(
  runSyncImplementation: () => Promise<SyncJobResult> = () => Promise.resolve(syncResult),
  stopImplementation: () => Promise<void> | void = () => undefined,
) {
  let trigger: (() => Promise<void>) | undefined;
  const stop = vi.fn(stopImplementation);
  const task: ScheduledTask = { stop };
  const schedule = vi.fn((_: string, callback: () => Promise<void>) => {
    trigger = callback;
    return task;
  });
  const runSync = vi.fn(runSyncImplementation);
  const logs: LogEntry[] = [];
  const logger: SchedulerLogger = {
    error: (bindings, message) => logs.push({ level: "error", bindings, message }),
    info: (bindings, message) => logs.push({ level: "info", bindings, message }),
    warn: (bindings, message) => logs.push({ level: "warn", bindings, message }),
  };
  const options: SchedulerOptions = {
    appRevision: "revision-123",
    cron: "*/5 * * * *",
    logger,
    mode: "mock",
    runSync,
    schedule,
  };

  return {
    getTrigger: (): (() => Promise<void>) => {
      if (trigger === undefined) {
        throw new Error("Scheduler callback was not registered");
      }
      return trigger;
    },
    logs,
    options,
    runSync,
    schedule,
    stop,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

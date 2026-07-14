import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";
import { MockNaverCommerceClient } from "../../src/naver/mock-client.js";
import { InMemorySheetRepository } from "../../src/sheets/in-memory-repository.js";
import { acquireSyncLock } from "../../src/runtime/sync-lock.js";
import { runLockedSyncJob } from "../../src/sync/run-locked-sync-job.js";

const temporaryDirectories: string[] = [];
const env = loadEnv({
  NODE_ENV: "test",
  NAVER_API_MODE: "mock",
  ALLOW_LIVE_NAVER_API: "false",
  STORE_A_NAME: "Store A",
  STORE_A_BASE_URL: "https://example.com/store-a",
  STORE_A_CLIENT_ID: "store-a-client",
  STORE_A_CLIENT_SECRET: "store-a-secret",
  STORE_B_NAME: "Store B",
  STORE_B_BASE_URL: "https://example.com/store-b",
  STORE_B_CLIENT_ID: "store-b-client",
  STORE_B_CLIENT_SECRET: "store-b-secret",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runLockedSyncJob", () => {
  it("rejects a held lock before any Naver API or Sheet operation", async () => {
    const lockDir = await createLockPath();
    const lease = await acquireSyncLock(lockOptions(lockDir, 42, firstToken));
    const naverClient = new CountingNaverClient();
    const sheets = new CountingSheetRepository();

    await expect(
      runLockedSyncJob(
        syncDependencies(naverClient, sheets),
        lockOptions(lockDir, 84, secondToken),
      ),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });

    expect(naverClient.searchCalls).toBe(0);
    expect(sheets.operationCalls).toBe(0);
    await lease.release();
  });

  it("releases the lock when synchronization fails", async () => {
    const lockDir = await createLockPath();
    const sheets = new FailingSheetRepository();

    await expect(
      runLockedSyncJob(
        syncDependencies(new CountingNaverClient(), sheets),
        lockOptions(lockDir, 42, firstToken),
      ),
    ).rejects.toThrow("test sync failure");

    const nextLease = await acquireSyncLock(lockOptions(lockDir, 84, secondToken));
    await nextLease.release();
  });

  it("allows only one concurrent synchronization through the shared lock", async () => {
    const lockDir = await createLockPath();
    const blockingClient = new BlockingNaverClient();
    const firstRun = runLockedSyncJob(
      syncDependencies(blockingClient, new CountingSheetRepository()),
      lockOptions(lockDir, 42, firstToken),
    );
    await blockingClient.started;

    await expect(
      runLockedSyncJob(
        syncDependencies(new CountingNaverClient(), new CountingSheetRepository()),
        lockOptions(lockDir, 84, secondToken),
      ),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });

    blockingClient.continue();
    await expect(firstRun).resolves.toMatchObject({ syncedProductsThisRun: 5 });
  });
});

const firstToken = "0123456789abcdef0123456789abcdef";
const secondToken = "fedcba9876543210fedcba9876543210";

function lockOptions(lockDir: string, pid: number, token: string) {
  return {
    lockDir,
    pid,
    token,
    processExists: () => true,
    readProcessStartTicks: (processPid: number) => Promise.resolve(String(processPid * 10)),
  };
}

function syncDependencies(
  naverClient: MockNaverCommerceClient,
  sheetRepository: InMemorySheetRepository,
) {
  return {
    env,
    stores: loadStores(env),
    naverClient,
    sheetRepository,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
  };
}

class CountingNaverClient extends MockNaverCommerceClient {
  searchCalls = 0;

  override async searchProducts(
    ...parameters: Parameters<MockNaverCommerceClient["searchProducts"]>
  ) {
    this.searchCalls += 1;

    return super.searchProducts(...parameters);
  }
}

class BlockingNaverClient extends CountingNaverClient {
  readonly started: Promise<void>;
  private resolveStarted: () => void = () => undefined;
  private resolveContinue: () => void = () => undefined;
  private readonly continuation: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.continuation = new Promise((resolve) => {
      this.resolveContinue = resolve;
    });
  }

  continue(): void {
    this.resolveContinue();
  }

  override async searchProducts(
    ...parameters: Parameters<MockNaverCommerceClient["searchProducts"]>
  ) {
    this.resolveStarted();
    await this.continuation;

    return super.searchProducts(...parameters);
  }
}

class CountingSheetRepository extends InMemorySheetRepository {
  operationCalls = 0;

  override prepareRunLog(): Promise<void> {
    this.operationCalls += 1;

    return super.prepareRunLog();
  }
}

class FailingSheetRepository extends InMemorySheetRepository {
  override prepareRunLog(): Promise<void> {
    return Promise.reject(new Error("test sync failure"));
  }
}

async function createLockPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "carplate-locked-sync-"));
  temporaryDirectories.push(parent);

  return join(parent, "sync.lock");
}

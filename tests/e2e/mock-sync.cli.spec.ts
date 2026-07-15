import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("mock sync CLI emits explicit full-store result JSON", async () => {
  const { stdout, stderr } = await runCli(["--import", "tsx", "src/cli/sync-once.ts"]);

  expect(stderr).toBe("");
  expect(stdout).not.toContain("store-a-secret");
  expect(stdout).not.toContain("store-b-secret");
  expectSyncLog(stdout, {
    syncScope: "all_stores",
    selectedStores: ["Store A (store-a)", "Store B (store-b)"],
    syncedProductsThisRun: 5,
    sheetTotalProducts: 5,
    sheetExtractionSuccess: 4,
    sheetExtractionFailure: 1,
    sheetDuplicateProductRows: 3,
  });
});

test("mock sync CLI emits explicit selected-store result JSON for a Smartstore URL slug", async () => {
  const { stdout, stderr } = await runCli([
    "--import",
    "tsx",
    "src/cli/sync-once.ts",
    "--store=store-a",
  ]);

  expect(stderr).toBe("");
  expect(stdout).not.toContain("store-a-secret");
  expect(stdout).not.toContain("store-b-secret");
  expectSyncLog(stdout, {
    syncScope: "selected_stores",
    selectedStores: ["Store A (store-a)"],
    syncedProductsThisRun: 3,
    sheetTotalProducts: 3,
    sheetExtractionSuccess: 2,
    sheetExtractionFailure: 1,
    sheetDuplicateProductRows: 2,
  });
});

test("compiled mock sync CLI uses the same result contract", async () => {
  const { stdout, stderr } = await runCli(["dist/src/cli/sync-once.js"]);

  expect(stderr).toBe("");
  expectSyncLog(stdout, {
    syncScope: "all_stores",
    selectedStores: ["Store A (store-a)", "Store B (store-b)"],
    syncedProductsThisRun: 5,
    sheetTotalProducts: 5,
    sheetExtractionSuccess: 4,
    sheetExtractionFailure: 1,
    sheetDuplicateProductRows: 3,
  });
});

test("a second CLI process cannot synchronize while another process holds the lock", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "carplate-cli-contention-"));
  const lockDir = join(runtimeDirectory, "sync.lock");
  const readyFile = join(runtimeDirectory, "ready");
  const holder = spawn(
    "node",
    ["--import", "tsx", "--input-type=module", "--eval", holderScript, lockDir, readyFile],
    { stdio: "ignore" },
  );

  try {
    await waitForFile(readyFile, holder);
    const result = await runNodeProcess(["dist/src/cli/sync-once.js"], lockDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("sync completed");
    expect(result.stdout + result.stderr).toContain("SYNC_LOCK_HELD");
  } finally {
    holder.kill("SIGTERM");
    await waitForExit(holder);
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

const holderScript = `
import { writeFile } from "node:fs/promises";
import { acquireSyncLock } from "./src/runtime/sync-lock.ts";
const lockDir = process.argv[1];
const readyFile = process.argv[2];
if (lockDir === undefined || readyFile === undefined) process.exit(2);
const lease = await acquireSyncLock({ lockDir });
await writeFile(readyFile, "ready", "utf8");
process.once("SIGTERM", async () => {
  await lease.release();
  process.exit(0);
});
setInterval(() => undefined, 1_000);
`;

function expectSyncLog(stdout: string, expected: Record<string, unknown>): void {
  const logs = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);

      return parsed;
    })
    .filter(isRecord);
  const syncLog = logs.find((log) => log.msg === "sync completed");

  expect(syncLog).toBeDefined();
  expect(syncLog).toMatchObject(expected);
  expect(syncLog).not.toHaveProperty("totalProducts");
  expect(syncLog).not.toHaveProperty("successCount");
  expect(syncLog).not.toHaveProperty("failureCount");
  expect(syncLog).not.toHaveProperty("duplicateCount");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runCli(arguments_: readonly string[]) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "carplate-cli-e2e-"));

  try {
    return await execFileAsync("node", arguments_, {
      env: cliEnv(join(runtimeDirectory, "sync.lock")),
      timeout: 20_000,
    });
  } finally {
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
}

async function runNodeProcess(
  arguments_: readonly string[],
  syncLockDir: string,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn("node", arguments_, {
    env: cliEnv(syncLockDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitForExit(child);

  return { exitCode: child.exitCode, stdout, stderr };
}

async function waitForFile(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`Lock holder exited before acquiring the lock: ${String(child.exitCode)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error("Timed out waiting for lock holder");
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    child.once("exit", () => {
      resolve();
    });
    child.once("error", reject);
  });
}

function cliEnv(syncLockDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  return {
    ...env,
    NODE_ENV: "test",
    TZ: "Asia/Seoul",
    LOG_LEVEL: "info",
    NAVER_API_MODE: "mock",
    ALLOW_LIVE_NAVER_API: "false",
    NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
    SYNC_CRON: "*/5 * * * *",
    SYNC_LOCK_DIR: syncLockDir,
    STORE_A_NAME: "Store A",
    STORE_A_BASE_URL: "https://example.com/store-a",
    STORE_A_CLIENT_ID: "store-a-client",
    STORE_A_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    STORE_B_NAME: "Store B",
    STORE_B_BASE_URL: "https://example.com/store-b",
    STORE_B_CLIENT_ID: "store-b-client",
    STORE_B_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
    GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
  };
}

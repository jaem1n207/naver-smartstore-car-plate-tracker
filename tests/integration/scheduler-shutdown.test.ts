import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], { timeout: 60_000 });
}, 70_000);

describe("compiled scheduler shutdown", () => {
  it("waits for an active locked sync to finish before the child exits", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "carplate-scheduler-shutdown-"));
    const lockDir = join(runtimeDirectory, "sync.lock");
    const readyFile = join(runtimeDirectory, "ready");
    const child = spawn("node", ["--input-type=module", "--eval", compiledSchedulerScript], {
      env: {
        ...process.env,
        APP_REVISION: "revision-active-sync",
        READY_FILE: readyFile,
        SYNC_LOCK_DIR: lockDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = collectOutput(child);

    try {
      await waitForFile(readyFile, child);
      await access(lockDir);
      child.kill("SIGTERM");

      await expectProcessStillRunning(child, 25);
      await access(lockDir);
      child.kill("SIGTERM");

      await expectProcessStillRunning(child, 50);
      await access(lockDir);
      await waitForExit(child, 5_000);

      expect(child.exitCode).toBe(0);
      await expect(access(lockDir)).rejects.toThrow();
      expect(output.stderr()).toBe("");
      expect(parseLogs(output.stdout())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            appRevision: "revision-active-sync",
            cron: "test-cron",
            mode: "mock",
            msg: "scheduler started",
          }),
          expect.objectContaining({
            msg: "scheduled sync completed",
            sheetTotalProducts: 0,
            syncedProductsThisRun: 0,
          }),
          expect.objectContaining({ msg: "scheduler stopped", signal: "SIGTERM" }),
        ]),
      );
      expect(parseLogs(output.stdout()).some((entry) => "result" in entry)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      await rm(runtimeDirectory, { force: true, recursive: true });
    }
  });

  it("wires APP_REVISION into production startup logs without exposing secrets", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "carplate-scheduler-main-"));
    const child = spawn("node", ["dist/src/scheduler/main.js"], {
      env: schedulerEnv(join(runtimeDirectory, "sync.lock")),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = collectOutput(child);

    try {
      await waitForLog(output.stdout, "scheduler started", child);
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);

      const combinedOutput = output.stdout() + output.stderr();
      expect(child.exitCode).toBe(0);
      expect(parseLogs(output.stdout())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            appRevision: "release-main-abcdef",
            cron: "0 0 1 1 *",
            mode: "mock",
            msg: "scheduler started",
          }),
        ]),
      );
      expect(combinedOutput).not.toContain("store-a-secret-value");
      expect(combinedOutput).not.toContain("store-b-secret-value");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      await rm(runtimeDirectory, { force: true, recursive: true });
    }
  });

  it("redacts secrets from a compiled-main mock synchronization failure", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "carplate-scheduler-failure-"));
    const entrypoint = join(process.cwd(), "dist/src/scheduler/main.js");
    const child = spawn("node", [entrypoint], {
      cwd: runtimeDirectory,
      env: schedulerEnv(join(runtimeDirectory, "sync.lock"), {
        SYNC_CRON: "*/1 * * * * *",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = collectOutput(child);

    try {
      await waitForLog(output.stdout, "scheduled sync failed", child);
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);

      const combinedOutput = output.stdout() + output.stderr();
      const failureLog = parseLogs(output.stdout()).find(
        (entry) => entry.msg === "scheduled sync failed",
      );
      const loggedError = failureLog?.error;
      if (!isRecord(loggedError)) {
        throw new Error("Compiled scheduler did not emit a structured error");
      }
      expect(child.exitCode).toBe(0);
      expect(failureLog?.msg).toBe("scheduled sync failed");
      expect(loggedError.name).toBe("Error");
      expect(combinedOutput).not.toContain("store-a-client");
      expect(combinedOutput).not.toContain("store-a-secret-value");
      expect(combinedOutput).not.toContain("store-b-client");
      expect(combinedOutput).not.toContain("store-b-secret-value");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      await rm(runtimeDirectory, { force: true, recursive: true });
    }
  });
});

const compiledSchedulerScript = `
import { writeFile } from "node:fs/promises";
import {
  createScheduler,
  registerSchedulerShutdownHandlers,
} from "./dist/src/scheduler/scheduler.js";
import { acquireSyncLock } from "./dist/src/runtime/sync-lock.js";

const lockDir = process.env.SYNC_LOCK_DIR;
const readyFile = process.env.READY_FILE;
if (lockDir === undefined || readyFile === undefined) throw new Error("Missing test paths");
let trigger;
const logger = {
  error: (bindings, message) => console.log(JSON.stringify({ ...bindings, msg: message })),
  info: (bindings, message) => console.log(JSON.stringify({ ...bindings, msg: message })),
  warn: (bindings, message) => console.log(JSON.stringify({ ...bindings, msg: message })),
};
const controller = createScheduler({
  appRevision: process.env.APP_REVISION ?? "missing",
  cron: "test-cron",
  logger,
  mode: "mock",
  runSync: async () => {
    const lease = await acquireSyncLock({ lockDir });
    try {
      await writeFile(readyFile, "ready", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        syncScope: "all_stores",
        selectedStores: ["Store A", "Store B"],
        syncedProductsThisRun: 0,
        sheetTotalProducts: 0,
        sheetExtractionSuccess: 0,
        sheetExtractionFailure: 0,
        sheetDuplicateProductRows: 0,
        summary: "done",
      };
    } finally {
      await lease.release();
    }
  },
  schedule: (_expression, callback) => {
    trigger = callback;
    return { stop: () => undefined };
  },
});
registerSchedulerShutdownHandlers({
  controller,
  onError: (_signal, error) => {
    console.log(JSON.stringify({ error: String(error), msg: "scheduler shutdown failed" }));
  },
});
if (trigger === undefined) throw new Error("Missing scheduled callback");
await trigger();
`;

function schedulerEnv(syncLockDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_REVISION: "release-main-abcdef",
    NODE_ENV: "test",
    TZ: "Asia/Seoul",
    LOG_LEVEL: "info",
    NAVER_API_MODE: "mock",
    ALLOW_LIVE_NAVER_API: "false",
    NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
    SYNC_CRON: "0 0 1 1 *",
    SYNC_LOCK_DIR: syncLockDir,
    STORE_A_NAME: "Store A",
    STORE_A_BASE_URL: "https://example.com/store-a",
    STORE_A_CLIENT_ID: "store-a-client",
    STORE_A_CLIENT_SECRET: "store-a-secret-value",
    STORE_B_NAME: "Store B",
    STORE_B_BASE_URL: "https://example.com/store-b",
    STORE_B_CLIENT_ID: "store-b-client",
    STORE_B_CLIENT_SECRET: "store-b-secret-value",
    GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
    ...overrides,
  };
}

function collectOutput(child: ChildProcessWithoutNullStreams): {
  readonly stderr: () => string;
  readonly stdout: () => string;
} {
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

  return { stderr: () => stderr, stdout: () => stdout };
}

function parseLogs(output: string): Record<string, unknown>[] {
  const logs: Record<string, unknown>[] = [];
  for (const line of output.trim().split("\n")) {
    if (line.length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) logs.push(parsed);
  }
  return logs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitForFile(path: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null) throw new Error(`Child exited early: ${String(child.exitCode)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for child readiness");
}

async function waitForLog(
  getOutput: () => string,
  message: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (getOutput().includes(message)) return;
    if (child.exitCode !== null) throw new Error(`Child exited early: ${String(child.exitCode)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for log: ${message}`);
}

async function expectProcessStillRunning(
  child: ChildProcessWithoutNullStreams,
  durationMs: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  expect(child.exitCode).toBeNull();
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

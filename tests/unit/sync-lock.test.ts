import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSyncLock, SyncLockHeldError } from "../../src/runtime/sync-lock.js";

const temporaryDirectories: string[] = [];
const firstToken = "0123456789abcdef0123456789abcdef";
const secondToken = "fedcba9876543210fedcba9876543210";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("acquireSyncLock", () => {
  it("atomically acquires a new lock and writes the exact owner contract", async () => {
    const lockDir = await createLockPath();
    const lease = await acquireSyncLock({
      lockDir,
      pid: 42,
      token: firstToken,
      processExists: () => true,
      readProcessStartTicks: () => Promise.resolve("1234"),
    });

    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toBe(
      `pid=42\nstart_ticks=1234\ntoken=${firstToken}\n`,
    );
    expect(lease.owner).toEqual({ pid: 42, startTicks: "1234", token: firstToken });

    await lease.release();

    await expectPathToBeMissing(lockDir);
  });

  it("fails with a stable error when the recorded owner is still active", async () => {
    const lockDir = await createLockPath();
    await writeOwner(lockDir, 42, "1234", firstToken);

    const acquisition = acquireSyncLock({
      lockDir,
      pid: 84,
      token: secondToken,
      processExists: () => true,
      readProcessStartTicks: () => Promise.resolve("1234"),
    });

    await expect(acquisition).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });
    await expect(acquisition).rejects.toBeInstanceOf(SyncLockHeldError);
    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toContain(firstToken);
  });

  it("reclaims a stale lock when its process no longer exists", async () => {
    const lockDir = await createLockPath();
    await writeOwner(lockDir, 42, "1234", firstToken);

    const lease = await acquireSyncLock({
      lockDir,
      pid: 84,
      token: secondToken,
      processExists: () => false,
      readProcessStartTicks: () => Promise.resolve("5678"),
    });

    expect(lease.owner).toEqual({ pid: 84, startTicks: "5678", token: secondToken });
    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toContain(secondToken);
    await lease.release();
  });

  it("reclaims a stale lock when a reused PID has different Linux start ticks", async () => {
    const lockDir = await createLockPath();
    await writeOwner(lockDir, 42, "1234", firstToken);

    const lease = await acquireSyncLock({
      lockDir,
      pid: 84,
      token: secondToken,
      processExists: () => true,
      readProcessStartTicks: (pid) => Promise.resolve(pid === 42 ? "9999" : "5678"),
    });

    expect(lease.owner.startTicks).toBe("5678");
    await lease.release();
  });

  it("reclaims an empty orphan lock directory after the publication grace period", async () => {
    const lockDir = await createLockPath();
    await mkdir(lockDir);
    await agePath(lockDir);

    const lease = await acquireSyncLock({
      lockDir,
      pid: 84,
      token: secondToken,
      processExists: () => true,
      readProcessStartTicks: () => Promise.resolve("5678"),
    });

    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toContain(secondToken);
    await lease.release();
  });

  it("preserves a fresh empty lock directory while its owner may still be publishing", async () => {
    const lockDir = await createLockPath();
    await mkdir(lockDir);

    await expect(
      acquireSyncLock({
        lockDir,
        pid: 84,
        token: secondToken,
        processExists: () => true,
        readProcessStartTicks: () => Promise.resolve("5678"),
      }),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });
    await expect(readdir(lockDir)).resolves.toEqual([]);
  });

  it("preserves unexpected entries in an old ownerless lock directory", async () => {
    const lockDir = await createLockPath();
    await mkdir(lockDir);
    await writeFile(join(lockDir, "unexpected"), "keep", "ascii");
    await agePath(lockDir);

    await expect(
      acquireSyncLock({
        lockDir,
        pid: 84,
        token: secondToken,
        processExists: () => false,
        readProcessStartTicks: () => Promise.resolve("5678"),
      }),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });
    await expect(readFile(join(lockDir, "unexpected"), "ascii")).resolves.toBe("keep");
  });

  it("fails closed when an existing owner file is malformed", async () => {
    const lockDir = await createLockPath();
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner"), "pid=nope\n", "ascii");

    await expect(
      acquireSyncLock({
        lockDir,
        pid: 84,
        token: secondToken,
        processExists: () => false,
        readProcessStartTicks: () => Promise.resolve("5678"),
      }),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });
    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toBe("pid=nope\n");
  });

  it("rejects unexpected stale-lock entries instead of deleting them", async () => {
    const lockDir = await createLockPath();
    await writeOwner(lockDir, 42, "1234", firstToken);
    await writeFile(join(lockDir, "unexpected"), "keep", "ascii");

    await expect(
      acquireSyncLock({
        lockDir,
        pid: 84,
        token: secondToken,
        processExists: () => false,
        readProcessStartTicks: () => Promise.resolve("5678"),
      }),
    ).rejects.toMatchObject({ code: "SYNC_LOCK_HELD" });
    await expect(readdir(lockDir)).resolves.toEqual(["owner", "unexpected"]);
  });

  it("does not release a lock whose owner token no longer matches the lease", async () => {
    const lockDir = await createLockPath();
    const lease = await acquireSyncLock({
      lockDir,
      pid: 42,
      token: firstToken,
      processExists: () => true,
      readProcessStartTicks: () => Promise.resolve("1234"),
    });
    await writeFile(
      join(lockDir, "owner"),
      `pid=84\nstart_ticks=5678\ntoken=${secondToken}\n`,
      "ascii",
    );

    await lease.release();

    await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toContain(secondToken);
  });
});

async function createLockPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "carplate-sync-lock-"));
  temporaryDirectories.push(parent);

  return join(parent, "sync.lock");
}

async function writeOwner(
  lockDir: string,
  pid: number,
  startTicks: string,
  token: string,
): Promise<void> {
  await mkdir(lockDir);
  await writeFile(
    join(lockDir, "owner"),
    `pid=${String(pid)}\nstart_ticks=${startTicks}\ntoken=${token}\n`,
    "ascii",
  );
}

async function expectPathToBeMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function agePath(path: string): Promise<void> {
  const oldTimestamp = new Date(Date.now() - 61_000);
  await utimes(path, oldTimestamp, oldTimestamp);
}

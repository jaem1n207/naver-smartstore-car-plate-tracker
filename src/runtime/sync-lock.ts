import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const ownerFileName = "owner";
const emptyOrphanMinimumAgeMs = 60_000;
const tokenPattern = /^[0-9a-f]{32}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;
const ownerPattern =
  /^pid=([1-9][0-9]*)\nstart_ticks=([1-9][0-9]*|unknown)\ntoken=([0-9a-f]{32})\n$/u;

export interface SyncLockOwner {
  readonly pid: number;
  readonly startTicks: string;
  readonly token: string;
}

export interface SyncLockOptions {
  readonly lockDir: string;
  readonly pid?: number;
  readonly token?: string;
  readonly processExists?: (pid: number) => boolean;
  readonly readProcessStartTicks?: (pid: number) => Promise<string | undefined>;
}

export interface SyncLockLease {
  readonly owner: SyncLockOwner;
  release(): Promise<void>;
}

export class SyncLockHeldError extends Error {
  readonly code = "SYNC_LOCK_HELD";

  constructor(message = "Synchronization lock is already held") {
    super(message);
    this.name = "SyncLockHeldError";
  }
}

export async function acquireSyncLock(options: SyncLockOptions): Promise<SyncLockLease> {
  const dependencies = normalizedOptions(options);
  await mkdir(dirname(dependencies.lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(dependencies.lockDir);
      return await createLease(dependencies);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      const reclaimed = await reclaimStaleLock(dependencies);
      if (!reclaimed) {
        throw new SyncLockHeldError();
      }
    }
  }

  throw new SyncLockHeldError();
}

interface NormalizedSyncLockOptions {
  readonly lockDir: string;
  readonly pid: number;
  readonly token: string;
  readonly processExists: (pid: number) => boolean;
  readonly readProcessStartTicks: (pid: number) => Promise<string | undefined>;
}

function normalizedOptions(options: SyncLockOptions): NormalizedSyncLockOptions {
  const pid = options.pid ?? process.pid;
  const token = options.token ?? randomBytes(16).toString("hex");

  if (options.lockDir.trim().length === 0) {
    throw new Error("Synchronization lock directory must not be empty");
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Synchronization lock PID must be a positive integer");
  }

  if (!tokenPattern.test(token)) {
    throw new Error("Synchronization lock token must be 32 lowercase hexadecimal characters");
  }

  return {
    lockDir: options.lockDir,
    pid,
    token,
    processExists: options.processExists ?? defaultProcessExists,
    readProcessStartTicks: options.readProcessStartTicks ?? readLinuxProcessStartTicks,
  };
}

async function createLease(options: NormalizedSyncLockOptions): Promise<SyncLockLease> {
  const startTicks = (await options.readProcessStartTicks(options.pid)) ?? "unknown";
  const owner: SyncLockOwner = { pid: options.pid, startTicks, token: options.token };
  const temporaryOwnerPath = join(options.lockDir, `.owner.${options.token}.tmp`);
  const ownerPath = join(options.lockDir, ownerFileName);

  try {
    const ownerFile = await open(temporaryOwnerPath, "wx", 0o600);
    try {
      await ownerFile.writeFile(serializeOwner(owner), "ascii");
      await ownerFile.sync();
    } finally {
      await ownerFile.close();
    }
    await rename(temporaryOwnerPath, ownerPath);
  } catch (error: unknown) {
    await removeIfPresent(temporaryOwnerPath);
    await removeEmptyDirectoryIfPresent(options.lockDir);
    throw error;
  }

  return {
    owner,
    release: async () => releaseOwnedLock(options.lockDir, owner.token),
  };
}

async function reclaimStaleLock(options: NormalizedSyncLockOptions): Promise<boolean> {
  const owner = await readExistingOwner(options.lockDir);
  if (owner === undefined) {
    return await reclaimEmptyOrphanLock(options.lockDir);
  }

  if (!(await isStaleOwner(owner, options))) {
    return false;
  }

  if (!(await containsOnlyOwnerFile(options.lockDir))) {
    return false;
  }

  const currentOwner = await readExistingOwner(options.lockDir);
  if (currentOwner === undefined || serializeOwner(currentOwner) !== serializeOwner(owner)) {
    return false;
  }

  await unlink(join(options.lockDir, ownerFileName));
  try {
    await rmdir(options.lockDir);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw new SyncLockHeldError("Synchronization lock contains unexpected entries");
    }
  }

  return true;
}

async function reclaimEmptyOrphanLock(lockDir: string): Promise<boolean> {
  let modifiedAt: number;
  try {
    const metadata = await lstat(lockDir);
    if (!metadata.isDirectory()) {
      return false;
    }
    modifiedAt = metadata.mtimeMs;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }

  if (Date.now() - modifiedAt < emptyOrphanMinimumAgeMs) {
    return false;
  }

  try {
    if ((await readdir(lockDir)).length !== 0) {
      return false;
    }
    await rmdir(lockDir);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function isStaleOwner(
  owner: SyncLockOwner,
  options: NormalizedSyncLockOptions,
): Promise<boolean> {
  if (!options.processExists(owner.pid)) {
    return true;
  }

  if (owner.startTicks === "unknown") {
    return false;
  }

  const currentStartTicks = await options.readProcessStartTicks(owner.pid);

  return currentStartTicks !== undefined && currentStartTicks !== owner.startTicks;
}

async function releaseOwnedLock(lockDir: string, token: string): Promise<void> {
  const owner = await readExistingOwner(lockDir);
  if (owner === undefined || owner.token !== token) {
    return;
  }

  if (!(await containsOnlyOwnerFile(lockDir))) {
    return;
  }

  await removeIfPresent(join(lockDir, ownerFileName));
  await removeEmptyDirectoryIfPresent(lockDir);
}

async function readExistingOwner(lockDir: string): Promise<SyncLockOwner | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(lockDir, ownerFileName), "ascii");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return parseOwner(contents);
}

function parseOwner(contents: string): SyncLockOwner | undefined {
  const match = ownerPattern.exec(contents);
  const pidText = match?.[1];
  const startTicks = match?.[2];
  const token = match?.[3];
  if (pidText === undefined || startTicks === undefined || token === undefined) {
    return undefined;
  }

  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }

  return { pid, startTicks, token };
}

function serializeOwner(owner: SyncLockOwner): string {
  return `pid=${String(owner.pid)}\nstart_ticks=${owner.startTicks}\ntoken=${owner.token}\n`;
}

async function containsOnlyOwnerFile(lockDir: string): Promise<boolean> {
  try {
    const entries = await readdir(lockDir);

    return entries.length === 1 && entries[0] === ownerFileName;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "EPERM") {
      return true;
    }
    if (errorCode(error) === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function readLinuxProcessStartTicks(pid: number): Promise<string | undefined> {
  let statContents: string;
  try {
    statContents = await readFile(`/proc/${String(pid)}/stat`, "ascii");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const commandEnd = statContents.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }

  const fieldsAfterCommand = statContents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];

  return startTicks !== undefined && positiveIntegerPattern.test(startTicks)
    ? startTicks
    : undefined;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function removeEmptyDirectoryIfPresent(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") {
      throw error;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

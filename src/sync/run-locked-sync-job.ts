import type { SyncLockOptions } from "../runtime/sync-lock.js";
import { acquireSyncLock } from "../runtime/sync-lock.js";
import type { SyncJobDependencies, SyncJobResult } from "./sync-job.js";
import { runSyncJob } from "./sync-job.js";

export async function runLockedSyncJob(
  dependencies: SyncJobDependencies,
  lockOptions: SyncLockOptions,
): Promise<SyncJobResult> {
  const lease = await acquireSyncLock(lockOptions);

  try {
    return await runSyncJob(dependencies);
  } finally {
    await lease.release();
  }
}

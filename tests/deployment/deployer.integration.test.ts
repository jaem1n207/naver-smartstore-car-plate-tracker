import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deployScript = join(repositoryRoot, "ops/deployment/deploy.sh");
const buildCandidateScript = join(repositoryRoot, "ops/deployment/build-candidate.sh");
const recoverScript = join(repositoryRoot, "ops/deployment/recover.sh");
const atomicFsScript = join(repositoryRoot, "ops/deployment/atomic_fs.py");
const temporaryDirectories: string[] = [];
const currentUid = process.getuid?.() ?? 0;

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await runProcess("chmod", ["-R", "u+w", directory]);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("deployment request validation and monotonic revisions", () => {
  it("independently rejects the wrong UID, malformed arguments, and unsafe roots", async () => {
    const fixture = await DeploymentFixture.create();

    await fixture.writeConfig({ expectedUid: currentUid + 1 });
    await expect(fixture.deploy(fixture.revisions.b)).resolves.toMatchObject({ code: 1 });

    await fixture.writeConfig();
    await expect(fixture.deploy(fixture.revisions.b, "extra")).resolves.toMatchObject({ code: 1 });
    await expect(fixture.deploy(fixture.revisions.b.toUpperCase())).resolves.toMatchObject({
      code: 1,
    });

    const realState = `${fixture.stateRoot}-real`;
    await mkdir(realState, { mode: 0o700 });
    await rm(fixture.stateRoot, { recursive: true });
    await symlink(realState, fixture.stateRoot);
    await expect(fixture.deploy(fixture.revisions.b)).resolves.toMatchObject({ code: 1 });
    expect(await fixture.systemctlLog()).toBe("");
  });

  it("fetches the configured fixed origin directly and permits only origin/main HEAD initially", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.b);
    await fixture.configureMaliciousRepositoryRemote();

    const historical = await fixture.deploy(fixture.revisions.a);
    expect(historical.code).toBe(1);
    expect(await fixture.currentRevision()).toBeNull();

    const head = await fixture.deploy(fixture.revisions.b);
    expect(
      head.code,
      `${head.stderr}${head.stdout}\nsystemctl:\n${await fixture.systemctlLog()}\nsystemd-run:\n${await fixture.systemdRunLog()}`,
    ).toBe(0);
    expect(parseResult(head.stdout)).toMatchObject({
      activatedSha: fixture.revisions.b,
      outcome: "deployed",
      requestedSha: fixture.revisions.b,
    });
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    const systemdRun = await fixture.systemdRunLog();
    for (const deniedRange of [
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "::1/128",
      "fc00::/7",
      "fe80::/10",
    ]) {
      expect(systemdRun).toContain(`--property=IPAddressDeny=${deniedRange}`);
    }
    expect(systemdRun).toContain("--setenv=npm_config_registry=https://registry.npmjs.org/");
    expect(systemdRun).toContain("--setenv=npm_config_strict_ssl=true");
  });

  it("deploys only forward revisions and treats equal or stale requests as successful no-ops", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);

    const operationsBeforeNoOps = await fixture.systemctlLog();
    const equal = await fixture.deploy(fixture.revisions.b);
    const stale = await fixture.deploy(fixture.revisions.a);

    expect(equal.code, equal.stderr).toBe(0);
    expect(stale.code, stale.stderr).toBe(0);
    expect(parseResult(equal.stdout).outcome).toBe("unchanged");
    expect(parseResult(stale.stdout).outcome).toBe("superseded");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    expect(await fixture.systemctlLog()).toBe(operationsBeforeNoOps);
  }, 15_000);

  it.each([
    ["equal", "a"],
    ["stale", "a"],
  ] as const)(
    "reconciles a pending activation before an %s no-op",
    async (classification, request) => {
      const fixture = await DeploymentFixture.create();
      await fixture.setMain(fixture.revisions.a);
      expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);

      if (classification === "stale") {
        await fixture.setMain(fixture.revisions.b);
        expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);
      }

      const knownGood = classification === "equal" ? fixture.revisions.a : fixture.revisions.b;
      const candidate = classification === "equal" ? fixture.revisions.b : fixture.revisions.c;
      await fixture.setMain(candidate);
      await fixture.writeConfig({ crashAfter: "current-link" });
      expect((await fixture.deploy(candidate)).code).toBe(97);
      await fixture.writeConfig();

      const result = await fixture.deploy(fixture.revisions[request]);

      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(parseResult(result.stdout).outcome).toBe("superseded");
      expect(await fixture.currentRevision()).toBe(knownGood);
      await expect(readFile(join(fixture.stateRoot, "activation-state"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    30_000,
  );

  it("fails closed when fetched main diverges from the durable deployed revision", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.b);
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);
    await fixture.setMain(fixture.revisions.divergent);

    const result = await fixture.deploy(fixture.revisions.divergent);

    expect(result.code).toBe(1);
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
  });

  it("does not activate a request superseded while its candidate is building", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.setBuildMode("advance-main");

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(parseResult(result.stdout).outcome).toBe("superseded");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    expect(await fixture.serviceIsActive()).toBe(true);
  }, 30_000);
});

describe("deployment preflight and coordination", () => {
  it.each([
    ["swap", { swapKiB: 2_097_151 }],
    ["disk", { diskKiB: 3_145_727 }],
    ["memory", { memoryKiB: 131_071 }],
  ] as const)("rejects insufficient %s before stopping the scheduler", async (_name, resources) => {
    const fixture = await DeploymentFixture.create();
    await fixture.writeResources(resources);

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(await fixture.systemctlLog()).toBe("");
    expect(Object.keys(parseResult(result.stdout)).sort()).toEqual([
      "activatedSha",
      "diagnosticId",
      "outcome",
      "previousSha",
      "requestedSha",
    ]);
  });

  it("stops gracefully before acquiring and holding the shared sync lock", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.holdSyncLock(350);

    const startedAt = Date.now();
    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code, result.stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(await fixture.systemctlLog()).toMatch(
      /^stop\nstart --job-mode=ignore-dependencies car-plate-tracker\.service\n$/u,
    );
  });

  it("uses a fixed activation path while a normal dependency start is blocked by recovery", async () => {
    const fixture = await DeploymentFixture.create();
    const lockHolder = fixture.holdDeployLock(1_500);
    await fixture.waitForControlFile("deploy-lock-held");

    const normalStart = await fixture.startWithNormalDependencies();

    expect(normalStart.code).toBe(1);
    expect(await fixture.systemctlLog()).toBe(
      "start car-plate-tracker.service\nrecovery-lock-blocked\n",
    );
    await lockHolder;

    await fixture.setMain(fixture.revisions.c);
    const deployed = await fixture.deploy(fixture.revisions.c);
    expect(deployed.code, deployed.stderr).toBe(0);
    expect(await fixture.systemctlLog()).toContain(
      "start --job-mode=ignore-dependencies car-plate-tracker.service\n",
    );
  });

  it("rejects a concurrent deployment through the root deployment flock", async () => {
    const fixture = await DeploymentFixture.create();
    const lockHolder = fixture.holdDeployLock(1_500);
    await fixture.waitForControlFile("deploy-lock-held");

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(await fixture.systemctlLog()).toBe("");
    await lockHolder;
  });
});

describe("candidate build, sealing, and activation", () => {
  it("runs the secretless transient build contract and seals a release with release.env", async () => {
    const fixture = await DeploymentFixture.create();

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code, result.stderr).toBe(0);
    const systemdRun = await fixture.systemdRunLog();
    for (const expected of [
      "--wait",
      "--collect",
      "KillMode=control-group",
      "RuntimeMaxSec=30min",
      "MemoryMax=900M",
      "MemorySwapMax=2G",
      "TasksMax=128",
      "ProtectSystem=strict",
      "NoNewPrivileges=true",
      "PrivateNetwork=true",
      "LimitFSIZE=536870912",
      "TemporaryFileSystem=/tmp:size=256M,nr_inodes=65536,mode=1777",
    ]) {
      expect(systemdRun).toContain(expected);
    }
    expect(systemdRun).toContain(`--unit=carplate-fetch-${fixture.revisions.b}`);
    expect(systemdRun).toContain("--unit=carplate-build");
    expect(systemdRun).not.toContain("NAVER_");
    expect(systemdRun).not.toContain("GOOGLE_");
    await expect(
      readFile(join(fixture.releasePath(fixture.revisions.b), "release.env"), "ascii"),
    ).resolves.toBe(`APP_REVISION=${fixture.revisions.b}\n`);
    expect(await pathExists(join(fixture.appRoot, "candidates", fixture.revisions.b))).toBe(false);
    expect(await pathExists(join(fixture.appRoot, "package-store", fixture.revisions.b))).toBe(
      false,
    );
  });

  it("retains only current and previous releases across A/B/C activation", async () => {
    const fixture = await DeploymentFixture.create();

    for (const revision of [fixture.revisions.a, fixture.revisions.b, fixture.revisions.c]) {
      await fixture.setMain(revision);
      expect((await fixture.deploy(revision)).code).toBe(0);
    }

    expect(await fixture.releaseRevisions()).toEqual(
      [fixture.revisions.b, fixture.revisions.c].sort(),
    );
    expect(await fixture.previousRevision()).toBe(fixture.revisions.b);
  }, 30_000);

  it("boot recovery reconciles every durable activation crash point", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);

    for (const crashAfter of [
      "pending-journal",
      "previous-link",
      "current-link",
      "service-start",
      "health-success",
      "marker-write",
    ]) {
      await fixture.writeConfig({ crashAfter });
      expect((await fixture.deploy(fixture.revisions.b)).code).toBe(97);
      await fixture.writeConfig();
      expect((await fixture.recover()).code).toBe(0);
      expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    }

    await fixture.writeConfig({ crashAfter: "pending-clear" });
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(97);
    await fixture.writeConfig();
    expect((await fixture.recover()).code).toBe(0);
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
  }, 30_000);

  it("uses the pending journal as recovery truth before classifying the next request", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.writeConfig({ crashAfter: "marker-write" });

    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(97);
    await chmod(join(fixture.releasePath(fixture.revisions.b), "release.env"), 0o640);
    await writeFile(
      join(fixture.releasePath(fixture.revisions.b), "release.env"),
      "APP_REVISION=damaged\n",
    );
    await fixture.writeConfig();

    const result = await fixture.deploy(fixture.revisions.a);

    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      activatedSha: fixture.revisions.a,
      outcome: "superseded",
      previousSha: fixture.revisions.a,
      requestedSha: fixture.revisions.a,
    });
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    await expect(readFile(join(fixture.stateRoot, "deployed-sha"), "ascii")).resolves.toBe(
      `${fixture.revisions.a}\n`,
    );
    await expect(readFile(join(fixture.stateRoot, "activation-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fixture.releaseRevisions()).toEqual([fixture.revisions.a]);
  }, 30_000);

  it("removes allowlisted abandoned build artifacts while retaining current and previous", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);

    const diagnosticId = "0123456789abcdef01234567";
    const abandonedCandidate = join(fixture.appRoot, "candidates", fixture.revisions.c);
    const abandonedPackageStore = join(fixture.appRoot, "package-store", fixture.revisions.c);
    const abandonedArchive = join(fixture.stateRoot, `.candidate.${diagnosticId}.tar`);
    const abandonedRelease = join(
      fixture.appRoot,
      "releases",
      `.${fixture.revisions.c}.${diagnosticId}.tmp`,
    );
    const unrelatedStateFile = join(fixture.stateRoot, ".candidate.keep");
    const unrelatedRelease = join(fixture.appRoot, "releases", ".keep.tmp");
    const symlinkDiagnosticId = "fedcba9876543210fedcba98";
    const candidateSymlink = join(fixture.appRoot, "candidates", fixture.revisions.divergent);
    const packageStoreSymlink = join(fixture.appRoot, "package-store", fixture.revisions.divergent);
    const archiveSymlink = join(fixture.stateRoot, `.candidate.${symlinkDiagnosticId}.tar`);
    const releaseSymlink = join(
      fixture.appRoot,
      "releases",
      `.${fixture.revisions.divergent}.${symlinkDiagnosticId}.tmp`,
    );
    await mkdir(abandonedCandidate);
    await mkdir(abandonedPackageStore);
    await writeFile(abandonedArchive, "partial archive\n");
    await mkdir(abandonedRelease);
    await writeFile(unrelatedStateFile, "keep\n");
    await mkdir(unrelatedRelease);
    await symlink(fixture.releasePath(fixture.revisions.a), candidateSymlink);
    await symlink(fixture.releasePath(fixture.revisions.a), packageStoreSymlink);
    await symlink(unrelatedStateFile, archiveSymlink);
    await symlink(fixture.releasePath(fixture.revisions.a), releaseSymlink);

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    for (const abandonedPath of [
      abandonedCandidate,
      abandonedPackageStore,
      abandonedArchive,
      abandonedRelease,
    ]) {
      expect(await pathExists(abandonedPath)).toBe(false);
    }
    expect(await pathExists(unrelatedStateFile)).toBe(true);
    expect(await pathExists(unrelatedRelease)).toBe(true);
    expect(await readlink(candidateSymlink)).toBe(fixture.releasePath(fixture.revisions.a));
    expect(await readlink(packageStoreSymlink)).toBe(fixture.releasePath(fixture.revisions.a));
    expect(await readlink(archiveSymlink)).toBe(unrelatedStateFile);
    expect(await readlink(releaseSymlink)).toBe(fixture.releasePath(fixture.revisions.a));
    expect(await fixture.releaseRevisions()).toEqual(
      [fixture.revisions.a, fixture.revisions.b].sort(),
    );
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    expect(await fixture.previousRevision()).toBe(fixture.revisions.a);
  }, 30_000);

  it("does not clean an abandoned workspace while a process still references it", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.b);
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);

    const candidate = join(fixture.appRoot, "candidates", fixture.revisions.c);
    const packageStore = join(fixture.appRoot, "package-store", fixture.revisions.c);
    const processFileDescriptors = join(fixture.procRoot, "777", "fd");
    await mkdir(candidate);
    await mkdir(packageStore);
    await mkdir(processFileDescriptors, { recursive: true });
    await writeFile(join(candidate, "active-build"), "still running\n");
    await symlink(join(candidate, "active-build"), join(processFileDescriptors, "3"));

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(await pathExists(candidate)).toBe(true);
    expect(await pathExists(packageStore)).toBe(true);
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    expect(await fixture.serviceIsActive()).toBe(true);
  }, 15_000);

  it.each(["escape", "fifo", "cgroup", "fd", "daemon"] as const)(
    "rejects an isolated build with a surviving or unsafe %s artifact",
    async (isolationFailure) => {
      const fixture = await DeploymentFixture.create();
      await fixture.setBuildMode(isolationFailure);

      const result = await fixture.deploy(fixture.revisions.b);

      expect(result.code).toBe(1);
      expect(await fixture.currentRevision()).toBeNull();
    },
    15_000,
  );

  it("restarts the existing release after build failure without changing links", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.setBuildMode("fail");

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("candidate_failed_restarted");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    expect(await pathExists(join(fixture.appRoot, "candidates", fixture.revisions.b))).toBe(false);
    expect(await pathExists(join(fixture.appRoot, "package-store", fixture.revisions.b))).toBe(
      false,
    );
  });

  it("retains the two known-good releases after a candidate build failure", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    expect((await fixture.deploy(fixture.revisions.b)).code).toBe(0);
    await fixture.setMain(fixture.revisions.c);
    await fixture.setBuildMode("fail");

    expect((await fixture.deploy(fixture.revisions.c)).code).toBe(1);

    expect(await fixture.releaseRevisions()).toEqual(
      [fixture.revisions.a, fixture.revisions.b].sort(),
    );
    expect(await pathExists(join(fixture.appRoot, "candidates", fixture.revisions.c))).toBe(false);
    expect(await pathExists(join(fixture.appRoot, "package-store", fixture.revisions.c))).toBe(
      false,
    );
  }, 30_000);

  it("rolls back activation without another fetch or build and verifies the rollback invocation", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    const buildCountBefore = await fixture.systemdRunLog();
    await fixture.failNextStarts(1);

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("activation_failed_rolled_back");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    expect((await fixture.systemdRunLog()).split("systemd-run").length).toBe(
      buildCountBefore.split("systemd-run").length + 2,
    );
  }, 15_000);

  it("preserves both known-good releases when C activation fails after A and B", async () => {
    const fixture = await DeploymentFixture.create();
    for (const revision of [fixture.revisions.a, fixture.revisions.b]) {
      await fixture.setMain(revision);
      expect((await fixture.deploy(revision)).code).toBe(0);
    }
    await fixture.setMain(fixture.revisions.c);
    await fixture.failNextStarts(1);

    const result = await fixture.deploy(fixture.revisions.c);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("activation_failed_rolled_back");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    expect(await fixture.previousRevision()).toBe(fixture.revisions.a);
    expect(await fixture.releaseRevisions()).toEqual(
      [fixture.revisions.a, fixture.revisions.b].sort(),
    );
  }, 30_000);

  it("restores both known-good links when C activation fails during marker publication", async () => {
    const fixture = await DeploymentFixture.create();
    for (const revision of [fixture.revisions.a, fixture.revisions.b]) {
      await fixture.setMain(revision);
      expect((await fixture.deploy(revision)).code).toBe(0);
    }
    await fixture.setMain(fixture.revisions.c);
    await fixture.failNextMarkerWrite();

    const result = await fixture.deploy(fixture.revisions.c);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("deployment_failed_recovered");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.b);
    expect(await fixture.previousRevision()).toBe(fixture.revisions.a);
    expect(await fixture.releaseRevisions()).toEqual(
      [fixture.revisions.a, fixture.revisions.b].sort(),
    );
  }, 30_000);

  it("fails closed when activation and rollback both fail", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.failNextStarts(2);

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout)).toMatchObject({
      activatedSha: "",
      outcome: "deployment_recovery_failed",
    });
  }, 15_000);

  it("reports no activated release when the known-good restart cannot be verified", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.setBuildMode("fail");
    await fixture.failNextStarts(1);

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout)).toMatchObject({
      activatedSha: "",
      outcome: "deployment_recovery_failed",
    });
  }, 15_000);

  it("rejects an immediate restart-count change and rolls back the candidate", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.restartNextStart();

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("activation_failed_rolled_back");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
  }, 15_000);

  it("polls for the exact startup record while continuously validating the invocation", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.c);
    await fixture.delayNextStartupRecord(2);
    await fixture.writeConfig({ healthSeconds: 1 });

    const delayed = await fixture.deploy(fixture.revisions.c);

    expect(delayed.code, `${delayed.stderr}\n${delayed.stdout}`).toBe(0);
    expect(await fixture.journalctlCalls()).toBeGreaterThanOrEqual(2);
    expect(await fixture.journalctlLog()).toMatch(
      /^(journalctl --no-pager --output=cat _SYSTEMD_INVOCATION_ID=[0-9a-f]{32}\n)+$/u,
    );

    const changedFixture = await DeploymentFixture.create();
    await changedFixture.setMain(changedFixture.revisions.a);
    expect((await changedFixture.deploy(changedFixture.revisions.a)).code).toBe(0);
    await changedFixture.setMain(changedFixture.revisions.b);
    await changedFixture.delayNextStartupRecord(2);
    await changedFixture.changeInvocationDuringJournalPoll(2);
    await changedFixture.writeConfig({ healthSeconds: 1 });
    const changed = await changedFixture.deploy(changedFixture.revisions.b);

    expect(changed.code).toBe(1);
    expect(parseResult(changed.stdout).outcome).toBe("activation_failed_rolled_back");
  }, 30_000);

  it("restores the known-good service when stop reports an error after stopping", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.failNextStopAfterStopping();

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("deployment_failed_recovered");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    expect(await fixture.serviceIsActive()).toBe(true);
  }, 15_000);

  it("emergency recovery rolls back when the durable marker write fails", async () => {
    const fixture = await DeploymentFixture.create();
    await fixture.setMain(fixture.revisions.a);
    expect((await fixture.deploy(fixture.revisions.a)).code).toBe(0);
    await fixture.setMain(fixture.revisions.b);
    await fixture.failNextMarkerWrite();

    const result = await fixture.deploy(fixture.revisions.b);

    expect(result.code).toBe(1);
    expect(parseResult(result.stdout).outcome).toBe("deployment_failed_recovered");
    expect(await fixture.currentRevision()).toBe(fixture.revisions.a);
    await expect(readFile(join(fixture.stateRoot, "deployed-sha"), "ascii")).resolves.toBe(
      `${fixture.revisions.a}\n`,
    );
    await expect(readFile(join(fixture.stateRoot, "activation-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);
});

describe("build-candidate helper", () => {
  it("fetches without lifecycle scripts then installs offline, builds, checks, and prunes", async () => {
    const root = await createTemporaryDirectory("carplate-build-helper-");
    const candidate = join(root, "candidate");
    const store = join(root, "store");
    const calls = join(root, "calls");
    await mkdir(candidate);
    await mkdir(store);
    await writeFile(join(candidate, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    await mkdir(join(candidate, "dist", "src", "scheduler"), { recursive: true });
    await writeFile(join(candidate, "dist", "src", "scheduler", "main.js"), "'use strict';\n");
    const command = join(root, "command-shim");
    await writeExecutable(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${shellQuote(calls)}\nexit 0\n`,
    );
    const config = join(root, "build-config.sh");
    await writeFile(
      config,
      [
        `BUILD_TEST_ALLOWED_ROOT=${shellQuote(root)}`,
        `BUILD_PNPM_COMMAND=${shellQuote(command)}`,
        `BUILD_NODE_COMMAND=${shellQuote(command)}`,
      ].join("\n"),
    );

    const fetchResult = await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; build_candidate_main fetch "$3" "$4"',
      "bash",
      config,
      buildCandidateScript,
      candidate,
      store,
    ]);
    const buildResult = await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; build_candidate_main build "$3" "$4"',
      "bash",
      config,
      buildCandidateScript,
      candidate,
      store,
    ]);

    expect(fetchResult.code, fetchResult.stderr).toBe(0);
    expect(buildResult.code, buildResult.stderr).toBe(0);
    expect(await readFile(calls, "utf8")).toBe(
      [
        "fetch --frozen-lockfile --ignore-scripts",
        "install --offline --frozen-lockfile --ignore-scripts",
        "build",
        "--check dist/src/scheduler/main.js",
        "prune --prod",
        "",
      ].join("\n"),
    );
  });

  it("rejects explicit remote and git sources in the dependency lockfile", async () => {
    const root = await createTemporaryDirectory("carplate-build-source-policy-");
    const candidate = join(root, "candidate");
    const store = join(root, "store");
    await mkdir(candidate);
    await mkdir(store);
    await writeFile(
      join(candidate, "pnpm-lock.yaml"),
      'lockfileVersion: "9.0"\npackages:\n  dependency:\n    resolution:\n      tarball: https://example.test/archive.tgz\n',
    );
    const config = join(root, "build-config.sh");
    await writeFile(
      config,
      [
        `BUILD_TEST_ALLOWED_ROOT=${shellQuote(root)}`,
        "BUILD_PNPM_COMMAND=/usr/bin/false",
        "BUILD_NODE_COMMAND=/usr/bin/false",
      ].join("\n"),
    );

    const result = await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; build_candidate_main fetch "$3" "$4"',
      "bash",
      config,
      buildCandidateScript,
      candidate,
      store,
    ]);

    expect(result.code).toBe(1);
  });
});

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface Revisions {
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly divergent: string;
}

interface ConfigOverrides {
  readonly crashAfter?: string;
  readonly expectedUid?: number;
  readonly healthSeconds?: number;
}

interface ResourceOverrides {
  readonly diskKiB?: number;
  readonly memoryKiB?: number;
  readonly swapKiB?: number;
}

class DeploymentFixture {
  readonly appRoot: string;
  readonly configPath: string;
  readonly controlRoot: string;
  readonly origin: string;
  readonly procRoot: string;
  readonly repository: string;
  readonly revisions: Revisions;
  readonly root: string;
  readonly runtimeRoot: string;
  readonly stateRoot: string;

  private constructor(root: string, revisions: Revisions) {
    this.root = root;
    this.appRoot = join(root, "opt", "app");
    this.stateRoot = join(root, "var", "deployment");
    this.runtimeRoot = join(root, "var", "runtime");
    this.controlRoot = join(root, "control");
    this.procRoot = join(root, "proc");
    this.origin = join(root, "origin");
    this.repository = join(this.appRoot, "repository.git");
    this.configPath = join(root, "deploy-test-config.sh");
    this.revisions = revisions;
  }

  static async create(): Promise<DeploymentFixture> {
    const root = await createTemporaryDirectory("carplate-deployer-");
    const origin = join(root, "origin");
    await runProcessExpectSuccess("git", ["init", "-q", "-b", "main", origin]);
    await runProcessExpectSuccess("git", [
      "-C",
      origin,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await runProcessExpectSuccess("git", ["-C", origin, "config", "user.name", "Deploy Tests"]);
    await writeReleaseSource(origin, "a");
    await runProcessExpectSuccess("git", ["-C", origin, "add", "."]);
    await runProcessExpectSuccess("git", ["-C", origin, "commit", "-q", "-m", "A"]);
    const a = await gitRevision(origin);
    await runProcessExpectSuccess("git", ["-C", origin, "branch", "divergent", a]);
    await writeReleaseSource(origin, "b");
    await runProcessExpectSuccess("git", ["-C", origin, "commit", "-q", "-am", "B"]);
    const b = await gitRevision(origin);
    await writeReleaseSource(origin, "c");
    await runProcessExpectSuccess("git", ["-C", origin, "commit", "-q", "-am", "C"]);
    const c = await gitRevision(origin);
    await runProcessExpectSuccess("git", ["-C", origin, "switch", "-q", "divergent"]);
    await writeFile(join(origin, "divergent"), "yes\n");
    await runProcessExpectSuccess("git", ["-C", origin, "add", "divergent"]);
    await runProcessExpectSuccess("git", ["-C", origin, "commit", "-q", "-m", "D"]);
    const divergent = await gitRevision(origin);
    await runProcessExpectSuccess("git", ["-C", origin, "switch", "-q", "main"]);
    await runProcessExpectSuccess("git", ["-C", origin, "reset", "-q", "--hard", b]);

    const fixture = new DeploymentFixture(root, { a, b, c, divergent });
    await fixture.initializeFilesystem();
    await fixture.writeConfig();
    return fixture;
  }

  async deploy(sha: string, ...extraArguments: string[]): Promise<ProcessResult> {
    return await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; shift 2; deploy_main "$@"',
      "bash",
      this.configPath,
      deployScript,
      sha,
      ...extraArguments,
    ]);
  }

  async writeConfig(overrides: ConfigOverrides = {}): Promise<void> {
    const values: Record<string, string | number> = {
      DEPLOY_APP_ENV: join(this.root, "etc", "app.env"),
      DEPLOY_APP_ROOT: this.appRoot,
      DEPLOY_ATOMIC_FS: join(this.controlRoot, "atomic-fs-shim"),
      DEPLOY_BUILD_SCRIPT: buildCandidateScript,
      DEPLOY_BUILD_CGROUP_NAME: "carplate-build.service",
      DEPLOY_CGROUP_ROOT: join(this.root, "cgroup"),
      DEPLOY_DF_COMMAND: join(this.controlRoot, "df-shim"),
      DEPLOY_EXPECTED_UID: overrides.expectedUid ?? currentUid,
      DEPLOY_HEALTH_SECONDS: overrides.healthSeconds ?? 0,
      DEPLOY_JOURNALCTL_COMMAND: join(this.controlRoot, "journalctl-shim"),
      DEPLOY_MEMORY_FILE: join(this.controlRoot, "meminfo"),
      DEPLOY_ORIGIN: this.origin,
      DEPLOY_PROC_ROOT: this.procRoot,
      DEPLOY_RELEASE_GROUP: "",
      DEPLOY_RELEASE_USER: "",
      DEPLOY_REPOSITORY: this.repository,
      DEPLOY_RUNTIME_ROOT: this.runtimeRoot,
      DEPLOY_STATE_ROOT: this.stateRoot,
      DEPLOY_SWAP_FILE: join(this.controlRoot, "swaps"),
      DEPLOY_SYNCHRONIZATION_WAIT_SECONDS: 3,
      DEPLOY_SYSTEMCTL_COMMAND: join(this.controlRoot, "systemctl-shim"),
      DEPLOY_SYSTEMD_RUN_COMMAND: join(this.controlRoot, "systemd-run-shim"),
      DEPLOY_TEST_CRASH_AFTER: overrides.crashAfter ?? "",
      RECOVER_APP_ROOT: this.appRoot,
      RECOVER_ATOMIC_FS: join(this.controlRoot, "atomic-fs-shim"),
      RECOVER_EXPECTED_UID: currentUid,
      RECOVER_STATE_ROOT: this.stateRoot,
    };
    await writeFile(
      this.configPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${shellQuote(String(value))}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
  }

  async writeResources(overrides: ResourceOverrides): Promise<void> {
    const swapKiB = overrides.swapKiB ?? 2_097_152;
    const memoryKiB = overrides.memoryKiB ?? 131_072;
    const diskKiB = overrides.diskKiB ?? 3_145_728;
    await writeFile(
      join(this.controlRoot, "swaps"),
      `Filename Type Size Used Priority\n/swapfile file ${String(swapKiB)} 0 -2\n`,
    );
    await writeFile(join(this.controlRoot, "meminfo"), `MemAvailable: ${String(memoryKiB)} kB\n`);
    await writeFile(join(this.controlRoot, "disk-kib"), `${String(diskKiB)}\n`);
  }

  async recover(): Promise<ProcessResult> {
    return await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; recover_main',
      "bash",
      this.configPath,
      recoverScript,
    ]);
  }

  async setMain(sha: string): Promise<void> {
    await runProcessExpectSuccess("git", ["-C", this.origin, "update-ref", "refs/heads/main", sha]);
  }

  async configureMaliciousRepositoryRemote(): Promise<void> {
    const malicious = join(this.root, "malicious");
    await runProcessExpectSuccess("git", ["init", "-q", "--bare", malicious]);
    await runProcessExpectSuccess("git", [
      `--git-dir=${this.repository}`,
      "remote",
      "add",
      "origin",
      malicious,
    ]);
  }

  async setBuildMode(mode: string): Promise<void> {
    await writeFile(join(this.controlRoot, "build-mode"), `${mode}\n`);
  }

  async failNextStarts(count: number): Promise<void> {
    await writeFile(join(this.controlRoot, "fail-start-count"), `${String(count)}\n`);
  }

  async restartNextStart(): Promise<void> {
    await writeFile(join(this.controlRoot, "restart-next-start"), "1\n");
  }

  async failNextStopAfterStopping(): Promise<void> {
    await writeFile(join(this.controlRoot, "fail-stop-after-stop"), "1\n");
  }

  async delayNextStartupRecord(polls: number): Promise<void> {
    await writeFile(join(this.controlRoot, "journal-delay"), `${String(polls)}\n`);
    await writeFile(join(this.controlRoot, "journalctl-calls"), "0\n");
  }

  async changeInvocationDuringJournalPoll(poll: number): Promise<void> {
    await writeFile(join(this.controlRoot, "change-invocation-on-poll"), `${String(poll)}\n`);
  }

  async journalctlCalls(): Promise<number> {
    return Number((await readFile(join(this.controlRoot, "journalctl-calls"), "ascii")).trim());
  }

  async journalctlLog(): Promise<string> {
    return await readOptionalFile(join(this.controlRoot, "journalctl.log"));
  }

  async failNextMarkerWrite(): Promise<void> {
    await writeFile(join(this.controlRoot, "fail-marker-write"), "1\n");
  }

  async holdSyncLock(milliseconds: number): Promise<void> {
    const signal = join(this.controlRoot, "sync-lock-held");
    const holder = runProcess("bash", [
      "-c",
      [
        'mkdir -m 2770 "$1"',
        'printf "pid=%s\\nstart_ticks=unknown\\ntoken=0123456789abcdef0123456789abcdef\\n" "$$" >"$1/owner"',
        'chmod 0640 "$1/owner"',
        'touch "$2"',
        `sleep ${String(milliseconds / 1000)}`,
        'rm "$1/owner"',
        'rmdir "$1"',
      ].join("; "),
      "bash",
      join(this.runtimeRoot, "sync.lock"),
      signal,
    ]);
    await this.waitForControlFile("sync-lock-held");
    void holder;
  }

  async holdDeployLock(milliseconds: number): Promise<ProcessResult> {
    return await runProcess("bash", [
      "-c",
      `mkdir "$1"; touch "$2"; sleep ${String(milliseconds / 1000)}; rmdir "$1"`,
      "bash",
      join(this.stateRoot, "deploy.lock.test-flock"),
      join(this.controlRoot, "deploy-lock-held"),
    ]);
  }

  async startWithNormalDependencies(): Promise<ProcessResult> {
    return await runProcess(join(this.controlRoot, "systemctl-shim"), [
      "start",
      "car-plate-tracker.service",
    ]);
  }

  async waitForControlFile(name: string): Promise<void> {
    const path = join(this.controlRoot, name);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`Timed out waiting for ${name}`);
  }

  releasePath(sha: string): string {
    return join(this.appRoot, "releases", sha);
  }

  async currentRevision(): Promise<string | null> {
    try {
      const target = await readlink(join(this.appRoot, "current"));
      return target.split("/").at(-1) ?? null;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async previousRevision(): Promise<string | null> {
    try {
      const target = await readlink(join(this.appRoot, "previous"));
      return target.split("/").at(-1) ?? null;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async releaseRevisions(): Promise<string[]> {
    const entries = await readdir(join(this.appRoot, "releases"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async serviceIsActive(): Promise<boolean> {
    return (await readFile(join(this.controlRoot, "service-active"), "ascii")).trim() === "1";
  }

  async systemctlLog(): Promise<string> {
    return await readOptionalFile(join(this.controlRoot, "systemctl.log"));
  }

  async systemdRunLog(): Promise<string> {
    return await readOptionalFile(join(this.controlRoot, "systemd-run.log"));
  }

  private async initializeFilesystem(): Promise<void> {
    await mkdir(join(this.appRoot, "candidates"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.appRoot, "releases"), { mode: 0o700 });
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.runtimeRoot, { mode: process.platform === "linux" ? 0o2770 : 0o770 });
    await chmod(this.runtimeRoot, process.platform === "linux" ? 0o2770 : 0o770);
    await mkdir(this.controlRoot, { mode: 0o700 });
    await mkdir(this.procRoot, { mode: 0o700 });
    await mkdir(join(this.root, "cgroup"), { mode: 0o700 });
    await mkdir(join(this.root, "etc"), { mode: 0o700 });
    await writeFile(join(this.root, "etc", "app.env"), "SYNC_CRON=*/5 * * * *\n", {
      mode: 0o600,
    });
    await runProcessExpectSuccess("git", ["init", "-q", "--bare", this.repository]);
    await this.writeResources({});
    await writeFile(join(this.controlRoot, "service-active"), "0\n");
    await writeFile(join(this.controlRoot, "invocation-counter"), "0\n");
    await writeFile(join(this.controlRoot, "nrestarts"), "0\n");
    await writeFile(join(this.controlRoot, "main-pid"), "4242\n");
    await writeFile(join(this.controlRoot, "build-mode"), "success\n");
    await writeFile(join(this.controlRoot, "fail-start-count"), "0\n");
    await writeFile(join(this.controlRoot, "journalctl-calls"), "0\n");
    await this.writeCommandShims();
  }

  private async writeCommandShims(): Promise<void> {
    const q = shellQuote;
    await writeExecutable(
      join(this.controlRoot, "atomic-fs-shim"),
      `#!/usr/bin/env python3
import os
import sys

failure = ${JSON.stringify(join(this.controlRoot, "fail-marker-write"))}
marker = ${JSON.stringify(join(this.stateRoot, "deployed-sha"))}
if "write-file" in sys.argv and marker in sys.argv and os.path.isfile(failure):
    os.unlink(failure)
    raise SystemExit(1)
os.execv(sys.executable, [sys.executable, ${JSON.stringify(atomicFsScript)}, *sys.argv[1:]])
`,
    );
    await writeExecutable(
      join(this.controlRoot, "df-shim"),
      `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'test 9999999 0 %s 0%% /\\n' "$(cat ${q(join(this.controlRoot, "disk-kib"))})"\n`,
    );
    await writeExecutable(join(this.controlRoot, "journalctl-shim"), createJournalctlShim(this));
    await writeExecutable(join(this.controlRoot, "systemctl-shim"), createSystemctlShim(this));
    await writeExecutable(join(this.controlRoot, "systemd-run-shim"), createSystemdRunShim(this));
  }
}

function createSystemctlShim(fixture: DeploymentFixture): string {
  const q = shellQuote;
  const control = fixture.controlRoot;
  return `#!/bin/sh
set -eu
command=$1
shift
case "$command" in
  stop)
    printf 'stop\\n' >>${q(join(control, "systemctl.log"))}
    printf '0\\n' >${q(join(control, "service-active"))}
    if [ -f ${q(join(control, "fail-stop-after-stop"))} ]; then
      rm ${q(join(control, "fail-stop-after-stop"))}
      exit 1
    fi
    ;;
  start)
    printf 'start %s\\n' "$*" >>${q(join(control, "systemctl.log"))}
    ignores_dependencies=0
    for argument in "$@"; do
      if [ "$argument" = "--job-mode=ignore-dependencies" ]; then
        ignores_dependencies=1
      fi
    done
    if [ "$ignores_dependencies" -eq 0 ] && [ -d ${q(join(fixture.stateRoot, "deploy.lock.test-flock"))} ]; then
      printf 'recovery-lock-blocked\\n' >>${q(join(control, "systemctl.log"))}
      exit 1
    fi
    failures=$(cat ${q(join(control, "fail-start-count"))})
    if [ "$failures" -gt 0 ]; then
      printf '%s\\n' "$((failures - 1))" >${q(join(control, "fail-start-count"))}
      exit 1
    fi
    counter=$(cat ${q(join(control, "invocation-counter"))})
    counter=$((counter + 1))
    printf '%s\\n' "$counter" >${q(join(control, "invocation-counter"))}
    invocation=$(printf '%032x' "$counter")
    printf '%s\\n' "$invocation" >${q(join(control, "invocation"))}
    printf '1\\n' >${q(join(control, "service-active"))}
    if [ -f ${q(join(control, "restart-next-start"))} ]; then
      restarts=$(cat ${q(join(control, "nrestarts"))})
      printf '%s\\n' "$((restarts + 1))" >${q(join(control, "nrestarts"))}
      rm ${q(join(control, "restart-next-start"))}
    fi
    revision=$(sed -n 's/^APP_REVISION=//p' ${q(join(fixture.appRoot, "current", "release.env"))})
    printf '{"msg":"scheduler started","mode":"live","cron":"*/5 * * * *","appRevision":"%s"}\\n' "$revision" >${q(join(control, "pending-journal.jsonl"))}
    if [ ! -f ${q(join(control, "journal-delay"))} ]; then
      cp ${q(join(control, "pending-journal.jsonl"))} ${q(join(control, "journal.jsonl"))}
    else
      : >${q(join(control, "journal.jsonl"))}
    fi
    ;;
  show)
    property=''
    for argument in "$@"; do
      case "$argument" in --property=*) property=$(printf '%s' "$argument" | cut -d= -f2) ;; esac
    done
    case "$property" in
      InvocationID) cat ${q(join(control, "invocation"))} 2>/dev/null || true ;;
      NRestarts) cat ${q(join(control, "nrestarts"))} ;;
      ActiveState) if [ "$(cat ${q(join(control, "service-active"))})" = 1 ]; then printf 'active\\n'; else printf 'inactive\\n'; fi ;;
      SubState) if [ "$(cat ${q(join(control, "service-active"))})" = 1 ]; then printf 'running\\n'; else printf 'dead\\n'; fi ;;
      MainPID) if [ "$(cat ${q(join(control, "service-active"))})" = 1 ]; then cat ${q(join(control, "main-pid"))}; else printf '0\\n'; fi ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`;
}

function createJournalctlShim(fixture: DeploymentFixture): string {
  const q = shellQuote;
  const control = fixture.controlRoot;
  return `#!/bin/sh
set -eu
printf 'journalctl %s\\n' "$*" >>${q(join(control, "journalctl.log"))}
calls=$(cat ${q(join(control, "journalctl-calls"))})
calls=$((calls + 1))
printf '%s\\n' "$calls" >${q(join(control, "journalctl-calls"))}
if [ -f ${q(join(control, "change-invocation-on-poll"))} ] \
  && [ "$(cat ${q(join(control, "change-invocation-on-poll"))})" -eq "$calls" ]; then
  printf '%032x\\n' 999 >${q(join(control, "invocation"))}
  rm ${q(join(control, "change-invocation-on-poll"))}
fi
if [ -f ${q(join(control, "journal-delay"))} ]; then
  delay=$(cat ${q(join(control, "journal-delay"))})
  if [ "$calls" -ge "$delay" ]; then
    cp ${q(join(control, "pending-journal.jsonl"))} ${q(join(control, "journal.jsonl"))}
    rm ${q(join(control, "journal-delay"))}
  fi
fi
cat ${q(join(control, "journal.jsonl"))}
`;
}

function createSystemdRunShim(fixture: DeploymentFixture): string {
  const q = shellQuote;
  const control = fixture.controlRoot;
  const cgroup = join(fixture.root, "cgroup", "carplate-build.service", "cgroup.procs");
  return `#!/bin/sh
set -eu
printf 'systemd-run %s\\n' "$*" >>${q(join(control, "systemd-run.log"))}
candidate=''
for argument in "$@"; do candidate=$argument; done
store=$candidate
for argument in "$@"; do
  if [ "$argument" = "$candidate" ]; then break; fi
  store=$argument
done
candidate=$(printf '%s\\n' "$*" | awk '{print $(NF-1)}')
mode=$(cat ${q(join(control, "build-mode"))})
case "$mode" in
  success) exit 0 ;;
  advance-main)
    git -C ${q(fixture.origin)} update-ref refs/heads/main ${q(fixture.revisions.c)}
    exit 0
    ;;
  fail) exit 1 ;;
  escape) ln -s ../../outside "$candidate/escaping"; exit 0 ;;
  fifo) mkfifo "$candidate/unsafe-fifo"; exit 0 ;;
  cgroup) mkdir -p ${q(join(fixture.root, "cgroup", "carplate-build.service"))}; printf '4242\\n' >${q(cgroup)}; exit 0 ;;
  fd) mkdir -p ${q(join(fixture.procRoot, "4242", "fd"))}; ln -s "$candidate/dist/src/scheduler/main.js" ${q(join(fixture.procRoot, "4242", "fd", "3"))}; exit 0 ;;
  daemon) mkdir -p ${q(join(fixture.procRoot, "4242"))}; ln -s "$candidate" ${q(join(fixture.procRoot, "4242", "cwd"))}; exit 0 ;;
  *) exit 1 ;;
esac
`;
}

function parseResult(stdout: string): Record<string, string> {
  const line = stdout
    .trim()
    .split("\n")
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  if (line === undefined) {
    throw new Error(`Missing safe result in: ${stdout}`);
  }
  const parsed: unknown = JSON.parse(line);
  return z.record(z.string(), z.string()).parse(parsed);
}

async function writeReleaseSource(repository: string, label: string): Promise<void> {
  await mkdir(join(repository, "dist", "src", "scheduler"), { recursive: true });
  await mkdir(join(repository, "node_modules", "runtime"), { recursive: true });
  await writeFile(join(repository, "package.json"), '{"name":"fixture"}\n');
  await writeFile(
    join(repository, "dist", "src", "scheduler", "main.js"),
    `'use strict'; console.log(${JSON.stringify(label)});\n`,
  );
  await writeFile(
    join(repository, "node_modules", "runtime", "index.js"),
    "module.exports = {};\n",
  );
}

async function gitRevision(repository: string): Promise<string> {
  const result = await runProcess("git", ["-C", repository, "rev-parse", "HEAD"]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function runProcessExpectSuccess(command: string, arguments_: string[]): Promise<void> {
  const result = await runProcess(command, arguments_);
  expect(result.code, result.stderr).toBe(0);
}

async function runProcess(command: string, arguments_: string[]): Promise<ProcessResult> {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", rejectProcess);
    child.on("close", (code) => {
      resolveProcess({ code, stderr, stdout });
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

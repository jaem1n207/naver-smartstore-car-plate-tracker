import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bootstrapScript = join(repositoryRoot, "ops/deployment/bootstrap.sh");
const systemdDirectory = join(repositoryRoot, "ops/deployment/systemd");
const reviewedDeploymentPaths = [
  "atomic_fs.py",
  "bootstrap.sh",
  "build-candidate.sh",
  "deploy-entrypoint.sh",
  "deploy.sh",
  "recover.sh",
  "lib/common.sh",
  "systemd/car-plate-tracker.service",
  "systemd/car-plate-tracker-recover.service",
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await runProcess("chmod", ["-R", "u+w", directory], process.env);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("deployment isolation contract", () => {
  it("allows 15 seconds for the production scheduler readiness record", async () => {
    const source = await readFile(bootstrapScript, "utf8");

    expect(source).toContain("BOOTSTRAP_HEALTH_SECONDS=15");
  });

  it("creates a trusted bootstrap fixture under a group-writable caller umask", async () => {
    const previousUmask = process.umask(0o002);
    const fixture = await createBootstrapFixture().finally(() => {
      process.umask(previousUmask);
    });

    for (const relativePath of ["lib/common.sh", "atomic_fs.py"]) {
      expect((await stat(join(fixture.reviewedScriptDirectory, relativePath))).mode & 0o777).toBe(
        0o600,
      );
    }

    const result = await runBootstrap(fixture);

    expect(result.code, result.stderr).toBe(0);
  }, 15_000);

  it("installs only separated accounts, root-controlled state, and constrained SSH access", async () => {
    const fixture = await createBootstrapFixture();
    const candidate = join(fixture.appRoot, "candidates", fixture.initialRevision);
    const packageStore = join(fixture.appRoot, "package-store", fixture.initialRevision);
    await Promise.all([
      mkdir(candidate, { recursive: true, mode: 0o700 }),
      mkdir(packageStore, { recursive: true, mode: 0o700 }),
    ]);

    const first = await runBootstrap(fixture);
    expect(first.code, first.stderr).toBe(0);

    await expect(readFile(join(fixture.etcDirectory, "app.env"), "utf8")).resolves.toBe(
      `NAVER_API_MODE=live\nGOOGLE_APPLICATION_CREDENTIALS=${fixture.googleDestination}\n`,
    );
    await expect(readFile(fixture.googleDestination, "utf8")).resolves.toBe(
      '{"type":"service_account"}\n',
    );
    expect((await stat(join(fixture.etcDirectory, "app.env"))).mode & 0o777).toBe(0o640);
    expect((await stat(fixture.googleDestination)).mode & 0o777).toBe(0o640);
    expect((await stat(join(fixture.stateRoot, "runtime"))).mode & 0o777).toBe(0o770);
    expect((await stat(join(fixture.stateRoot, "deployment"))).mode & 0o777).toBe(0o700);
    expect((await stat(fixture.etcDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(fixture.sshDirectory)).mode & 0o777).toBe(0o750);
    expect((await stat(fixture.authorizedKeys)).mode & 0o777).toBe(0o640);
    expect((await stat(join(fixture.appRoot, "candidates"))).mode & 0o777).toBe(0o710);
    expect((await stat(join(fixture.appRoot, "package-store"))).mode & 0o777).toBe(0o710);
    expect((await stat(candidate)).mode & 0o777).toBe(0o700);
    expect((await stat(packageStore)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.appRoot, "releases"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(fixture.appRoot, "repository.git"))).mode & 0o777).toBe(0o700);

    await expect(readFile(fixture.authorizedKeys, "utf8")).resolves.toContain(
      `command="${join(fixture.privilegedExecutableDirectory, "car-plate-tracker-deploy-entrypoint")}",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEfakeshimkey carplate-deploy\n`,
    );
    const sshdPolicy = await readFile(fixture.sshdDropIn, "utf8");
    expect(sshdPolicy).toContain(
      `Match User carplate-deploy\n    AuthorizedKeysFile ${fixture.authorizedKeys}`,
    );
    expect(sshdPolicy).toContain("AuthenticationMethods publickey");
    expect(sshdPolicy).toContain("PasswordAuthentication no");
    expect(sshdPolicy).toContain("KbdInteractiveAuthentication no");
    expect(sshdPolicy).toContain("PermitTTY no");
    expect(sshdPolicy).toContain("AllowTcpForwarding no");
    expect(sshdPolicy).toContain("X11Forwarding no");
    expect(sshdPolicy).toContain("PermitUserRC no");
    expect(sshdPolicy).toMatch(/ {4}GatewayPorts no\nMatch all\n$/);
    expect(sshdPolicy).toContain(
      `ForceCommand ${join(fixture.privilegedExecutableDirectory, "car-plate-tracker-deploy-entrypoint")}`,
    );
    expect(sshdPolicy).toContain("DisableForwarding yes");
    expect(sshdPolicy).toContain("AuthorizedKeysCommand none");
    expect(sshdPolicy).toContain("TrustedUserCAKeys none");
    await expect(readFile(fixture.sudoersFile, "utf8")).resolves.toContain(
      `${join(fixture.privilegedExecutableDirectory, "deploy-car-plate-tracker")} ^[0-9a-f]{40}$`,
    );

    const commands = await readCommands(fixture.commandLog);
    expect(commands).toContain(
      "useradd --system --gid carplate --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin carplate",
    );
    expect(commands).toContain(
      "useradd --system --gid carplate-build --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin carplate-build",
    );
    expect(commands).toContain(
      "useradd --system --gid carplate-deploy --home-dir /nonexistent --no-create-home --shell /bin/sh carplate-deploy",
    );
    expect(commands).toContain("passwd --lock carplate-deploy");
    expect(commands).toContain(
      `install -d -m 2770 -o root -g carplate ${join(fixture.stateRoot, "runtime")}`,
    );
    expect(commands).toContain(
      `install -d -m 0700 -o root -g root ${join(fixture.stateRoot, "deployment")}`,
    );
    expect(commands).toContain(
      `install -d -m 0710 -o root -g carplate-build ${join(fixture.appRoot, "candidates")}`,
    );
    expect(commands).toContain(
      `install -d -m 0710 -o root -g carplate-build ${join(fixture.appRoot, "package-store")}`,
    );
    expect(commands).toContain(
      `install -d -m 0750 -o root -g carplate-deploy ${fixture.sshDirectory}`,
    );
    expect(
      commands.some(
        (command) =>
          command.startsWith("install -m 0640 -o root -g carplate-deploy ") &&
          command.endsWith(` ${fixture.authorizedKeys}`),
      ),
    ).toBe(true);
    expect(commands).toContain(`visudo -cf ${fixture.sudoersFile}`);
    expect(commands).toContain(`sshd -t -f ${fixture.sshdConfig}`);
    expect(commands).toContain(
      `sshd -T -C user=carplate-deploy,host=localhost,addr=127.0.0.1 -f ${fixture.sshdConfig}`,
    );
    expect(commands).toContain("systemctl reload ssh.service");
    expect(commands).toContain("systemctl daemon-reload");
    expect(commands).toContain("systemctl enable car-plate-tracker.service");
    expect(commands).toContain("systemctl start car-plate-tracker.service");
    expect(
      commands.some((command) => command.includes(" /etc/") || command.includes(" /var/lib/")),
    ).toBe(false);

    await Promise.all(
      ["carplate", "carplate-build", "carplate-deploy"].map((user) =>
        writeFile(join(fixture.accountStateDirectory, `groups-${user}`), "sudo docker\n"),
      ),
    );

    const second = await runBootstrap(fixture);
    expect(second.code, second.stderr).toBe(0);
    await Promise.all(
      ["carplate", "carplate-build", "carplate-deploy"].map(async (user) => {
        await expect(
          readFile(join(fixture.accountStateDirectory, `groups-${user}`), "utf8"),
        ).resolves.toBe("");
      }),
    );
    const repeatedCommands = await readCommands(fixture.commandLog);
    expect(repeatedCommands.filter((command) => command.startsWith("useradd "))).toHaveLength(3);
    expect(
      repeatedCommands.filter((command) => command === "systemctl daemon-reload"),
    ).toHaveLength(2);
    expect(
      repeatedCommands.filter((command) => command === "systemctl reload ssh.service"),
    ).toHaveLength(2);
    expect(repeatedCommands).toContain("systemctl restart car-plate-tracker.service");
    for (const user of ["carplate", "carplate-build", "carplate-deploy"]) {
      expect(repeatedCommands.filter((command) => command === `id -u ${user}`)).toHaveLength(2);
      expect(repeatedCommands.filter((command) => command === `id -gn ${user}`)).toHaveLength(2);
      expect(repeatedCommands.filter((command) => command === `id -Gn ${user}`)).toHaveLength(2);
    }
  }, 15_000);

  it("rejects repeated bootstrap when deployment identities share a UID", async () => {
    const fixture = await createBootstrapFixture();
    const first = await runBootstrap(fixture);
    expect(first.code, first.stderr).toBe(0);

    const runtimeIdentity = await readFile(
      join(fixture.accountStateDirectory, "passwd-carplate"),
      "utf8",
    );
    const runtimeIdentityParts = runtimeIdentity.trim().split(":");
    const buildIdentityParts = (
      await readFile(join(fixture.accountStateDirectory, "passwd-carplate-build"), "utf8")
    )
      .trim()
      .split(":");
    const runtimeUid = runtimeIdentityParts[0];
    const buildGid = buildIdentityParts[1];
    if (runtimeUid === undefined || buildGid === undefined) {
      throw new Error("invalid account shim state");
    }
    await writeFile(
      join(fixture.accountStateDirectory, "passwd-carplate-build"),
      `${runtimeUid}:${buildGid}\n`,
    );

    const second = await runBootstrap(fixture);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("deployment account UIDs must be distinct nonzero values");
  }, 15_000);

  it("rejects an initial release source inside the managed application root", async () => {
    const fixture = await createBootstrapFixture({ initialSourceInAppRoot: true });

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "bootstrap sources must remain outside the managed application root",
    );
  });

  it("trusts only the configured initial checkout when Git detects different ownership", async () => {
    const fixture = await createBootstrapFixture();

    const result = await runBootstrap(fixture, {
      CARPLATE_TEST_DUBIOUS_INITIAL_SOURCE: "1",
    });

    expect(result.code, result.stderr).toBe(0);
    const commands = await readCommands(fixture.commandLog);
    expect(commands).toContain(
      `git -c safe.directory=${fixture.initialReleaseSource} -C ${fixture.initialReleaseSource} rev-parse --show-toplevel`,
    );
    expect(commands).toContain(
      `git -c safe.directory=${fixture.initialReleaseSource} -C ${fixture.initialReleaseSource} rev-parse --verify HEAD^{commit}`,
    );
  }, 15_000);

  it("rejects a reviewed source beneath a group-writable ancestor", async () => {
    const fixture = await createBootstrapFixture();
    await chmod(fixture.temporaryDirectory, 0o770);

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "reviewed bootstrap source must be owner-controlled and immutable",
    );
  });

  it("rejects a scheduler that is active only for the first post-start sample", async () => {
    const fixture = await createBootstrapFixture();
    await writeFile(join(fixture.accountStateDirectory, "systemctl-transient-active"), "1\n");

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("scheduler did not remain active after bootstrap");
  }, 15_000);

  it("rejects an active scheduler without the expected startup readiness record", async () => {
    const fixture = await createBootstrapFixture();
    await writeFile(join(fixture.accountStateDirectory, "systemctl-startup-not-ready"), "1\n");

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("scheduler startup readiness record was not observed");
  }, 15_000);

  it("rejects a writable reviewed bootstrap source", async () => {
    const fixture = await createBootstrapFixture();
    await chmod(fixture.reviewedScriptDirectory, 0o777);

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "reviewed bootstrap source must be owner-controlled and immutable",
    );
  }, 15_000);

  it("binds installed privileged assets to the exact reviewed Git revision", async () => {
    const fixture = await createBootstrapFixture();
    const marker = join(fixture.stateRoot, "deployment", "privileged-sha");

    const first = await runBootstrap(fixture);

    expect(first.code, first.stderr).toBe(0);
    await expect(readFile(marker, "ascii")).resolves.toBe(`${fixture.initialRevision}\n`);
    expect((await stat(marker)).mode & 0o777).toBe(0o600);

    const second = await runBootstrap(fixture);

    expect(second.code, second.stderr).toBe(0);
    await expect(readFile(marker, "ascii")).resolves.toBe(`${fixture.initialRevision}\n`);
  }, 15_000);

  it("rejects a reviewed deployment source that differs from the initial Git revision", async () => {
    const fixture = await createBootstrapFixture();
    await writeFile(
      join(fixture.reviewedScriptDirectory, "deploy.sh"),
      "#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf 'tampered\\n'\n",
    );

    const result = await runBootstrap(fixture);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "reviewed deployment source does not match initial Git revision",
    );
    expect(await pathExists(join(fixture.stateRoot, "deployment", "privileged-sha"))).toBe(false);
  }, 15_000);

  it("seals a secretless initial release before enabling the scheduler and preserves it on repeat", async () => {
    const fixture = await createBootstrapFixture();
    const temporaryRelease = join(
      fixture.appRoot,
      "releases",
      `.${fixture.initialRevision}.bootstrap.tmp`,
    );
    await mkdir(temporaryRelease, { recursive: true });
    await writeFile(join(temporaryRelease, "partial"), "remove me\n");

    const first = await runBootstrap(fixture);
    expect(first.code, first.stderr).toBe(0);

    const release = join(fixture.appRoot, "releases", fixture.initialRevision);
    const marker = join(fixture.stateRoot, "deployment", "deployed-sha");
    const current = join(fixture.appRoot, "current");
    await expect(readFile(marker, "ascii")).resolves.toBe(`${fixture.initialRevision}\n`);
    await expect(readlink(current)).resolves.toBe(`releases/${fixture.initialRevision}`);
    await expect(readFile(join(release, "release.env"), "ascii")).resolves.toBe(
      `APP_REVISION=${fixture.initialRevision}\n`,
    );
    await expect(readFile(join(release, "package.json"), "utf8")).resolves.toContain(
      '"name": "initial-release-fixture"',
    );
    await expect(readFile(join(release, "dist/src/scheduler/main.js"), "utf8")).resolves.toBe(
      'console.log("scheduler");\n',
    );
    await expect(readFile(join(release, "node_modules/runtime.txt"), "utf8")).resolves.toBe(
      "runtime dependency\n",
    );
    await expect(readFile(join(release, "pnpm-lock.yaml"), "utf8")).resolves.toBe(
      "lockfileVersion: '9.0'\n",
    );
    expect((await readdir(release)).sort()).toEqual([
      "dist",
      "node_modules",
      "package.json",
      "pnpm-lock.yaml",
      "release.env",
    ]);
    expect(await pathExists(join(release, ".env"))).toBe(false);
    expect(await pathExists(join(release, ".git"))).toBe(false);
    expect(await pathExists(join(release, "google-service-account.json"))).toBe(false);
    expect(await pathExists(join(release, "google-credentials.json"))).toBe(false);
    expect(await pathExists(join(release, "releases"))).toBe(false);
    expect(await pathExists(join(release, "repository.git"))).toBe(false);
    expect(await pathExists(temporaryRelease)).toBe(false);
    expect((await stat(release)).mode & 0o777).toBe(0o550);
    expect((await stat(join(release, "dist"))).mode & 0o777).toBe(0o550);
    expect((await stat(join(release, "package.json"))).mode & 0o777).toBe(0o440);
    expect((await stat(marker)).mode & 0o777).toBe(0o600);

    const releaseInode = (await stat(release)).ino;
    const markerInode = (await stat(marker)).ino;
    const currentInode = (await lstat(current)).ino;
    const second = await runBootstrap(fixture);
    expect(second.code, second.stderr).toBe(0);
    expect((await stat(release)).ino).toBe(releaseInode);
    expect((await stat(marker)).ino).toBe(markerInode);
    expect((await lstat(current)).ino).toBe(currentInode);

    const commands = await readCommands(fixture.commandLog);
    expect(
      commands.filter((command) => command === "systemctl enable car-plate-tracker.service"),
    ).toHaveLength(2);
    expect(
      commands.filter((command) => command === "systemctl start car-plate-tracker.service"),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command === "systemctl restart car-plate-tracker.service"),
    ).toHaveLength(1);
    expect(
      commands.some(
        (command) =>
          command ===
          `chown -hR root:carplate ${join(fixture.appRoot, "releases", `.${fixture.initialRevision}.bootstrap.tmp`)}`,
      ),
    ).toBe(true);
  }, 15_000);

  it("fails closed without replacing a malformed existing deployment marker", async () => {
    const fixture = await createBootstrapFixture();
    const marker = join(fixture.stateRoot, "deployment", "deployed-sha");
    const malformedMarker = `${fixture.initialRevision}\ntrailing-data`;
    await mkdir(join(fixture.stateRoot, "deployment"), { recursive: true });
    await writeFile(marker, malformedMarker, { mode: 0o600 });

    const result = await runBootstrap(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("existing deployed-sha marker is invalid");
    await expect(readFile(marker, "ascii")).resolves.toBe(malformedMarker);
    expect(await pathExists(join(fixture.appRoot, "current"))).toBe(false);

    const commands = await readCommands(fixture.commandLog);
    expect(commands).not.toContain("systemctl enable car-plate-tracker.service");
  }, 15_000);

  it("keeps the runtime service confined while permitting Node JIT", async () => {
    const runtimeUnit = await readFile(join(systemdDirectory, "car-plate-tracker.service"), "utf8");
    const recoveryUnit = await readFile(
      join(systemdDirectory, "car-plate-tracker-recover.service"),
      "utf8",
    );

    expect(runtimeUnit).toContain("User=carplate\nGroup=carplate");
    expect(runtimeUnit).toContain("Requires=car-plate-tracker-recover.service");
    expect(runtimeUnit).toContain("After=network-online.target car-plate-tracker-recover.service");
    expect(runtimeUnit).toContain(
      "WorkingDirectory=/opt/naver-smartstore-car-plate-tracker/current",
    );
    expect(runtimeUnit).toContain(
      "EnvironmentFile=/etc/naver-smartstore-car-plate-tracker/app.env",
    );
    expect(runtimeUnit).toContain(
      "EnvironmentFile=-/opt/naver-smartstore-car-plate-tracker/current/release.env",
    );
    expect(runtimeUnit).toContain(
      "ExecStart=/usr/bin/node /opt/naver-smartstore-car-plate-tracker/current/dist/src/scheduler/main.js",
    );
    expect(runtimeUnit).toContain("TimeoutStopSec=60min");
    expect(runtimeUnit).toContain("NoNewPrivileges=true");
    expect(runtimeUnit).toContain("CapabilityBoundingSet=");
    expect(runtimeUnit).toContain("PrivateTmp=true");
    expect(runtimeUnit).toContain("ProtectHome=true");
    expect(runtimeUnit).toContain("ProtectSystem=strict");
    expect(runtimeUnit).toContain("ProtectKernelTunables=true");
    expect(runtimeUnit).toContain("ProtectControlGroups=true");
    expect(runtimeUnit).toContain("ReadOnlyPaths=/etc/naver-smartstore-car-plate-tracker");
    expect(runtimeUnit).toContain("ReadOnlyPaths=/opt/naver-smartstore-car-plate-tracker/current");
    expect(runtimeUnit).toContain(
      "ReadWritePaths=/var/lib/naver-smartstore-car-plate-tracker/runtime",
    );
    expect(runtimeUnit).toContain("MemoryDenyWriteExecute=false");
    expect(runtimeUnit).not.toContain("MemoryDenyWriteExecute=true");
    expect(recoveryUnit).toContain("Before=car-plate-tracker.service");
    expect(recoveryUnit).toContain("ExecStart=/usr/local/sbin/recover-car-plate-tracker");
    expect(recoveryUnit).toContain("ReadWritePaths=/opt/naver-smartstore-car-plate-tracker");
    expect(recoveryUnit).toContain(
      "ReadWritePaths=/var/lib/naver-smartstore-car-plate-tracker/deployment",
    );
  });
});

interface BootstrapFixture {
  readonly accountStateDirectory: string;
  readonly appRoot: string;
  readonly authorizedKeys: string;
  readonly commandLog: string;
  readonly etcDirectory: string;
  readonly googleDestination: string;
  readonly googleSource: string;
  readonly sshdDropIn: string;
  readonly sshdConfig: string;
  readonly scriptDirectory: string;
  readonly privilegedExecutableDirectory: string;
  readonly stateRoot: string;
  readonly sudoersFile: string;
  readonly temporaryDirectory: string;
  readonly environmentSource: string;
  readonly initialReleaseSource: string;
  readonly initialRevision: string;
  readonly reviewedScriptDirectory: string;
  readonly shimDirectory: string;
  readonly sshDirectory: string;
}

interface BootstrapFixtureOptions {
  readonly initialSourceInAppRoot?: boolean;
}

async function createBootstrapFixture(
  options: BootstrapFixtureOptions = {},
): Promise<BootstrapFixture> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "carplate-bootstrap-"));
  temporaryDirectories.push(temporaryDirectory);
  const stateRoot = join(temporaryDirectory, "state");
  const appRoot = join(temporaryDirectory, "app");
  const etcDirectory = join(temporaryDirectory, "etc");
  const sshDirectory = join(temporaryDirectory, "ssh");
  const sudoersDirectory = join(temporaryDirectory, "sudoers.d");
  const scriptDirectory = join(temporaryDirectory, "installed-scripts");
  const privilegedExecutableDirectory = join(temporaryDirectory, "sbin");
  const reviewedScriptDirectory = join(temporaryDirectory, "reviewed-scripts");
  const shimDirectory = join(temporaryDirectory, "shims");
  const commandLog = join(temporaryDirectory, "commands.log");
  const accountStateDirectory = join(temporaryDirectory, "accounts");
  const initialReleaseSource = options.initialSourceInAppRoot
    ? appRoot
    : join(temporaryDirectory, "initial-source");
  const environmentSource = join(temporaryDirectory, "current.env");
  const googleSource = join(temporaryDirectory, "current-google.json");
  const authorizedKeys = join(sshDirectory, "carplate-deploy");
  const sshdDropIn = join(temporaryDirectory, "sshd_config.d", "carplate-deploy.conf");
  const sshdConfig = join(temporaryDirectory, "sshd_config");
  const sudoersFile = join(sudoersDirectory, "carplate-deploy");

  await Promise.all([
    mkdir(reviewedScriptDirectory, { recursive: true, mode: 0o700 }),
    mkdir(join(reviewedScriptDirectory, "lib"), { recursive: true, mode: 0o700 }),
    mkdir(shimDirectory, { recursive: true }),
    mkdir(accountStateDirectory, { recursive: true }),
    writeFile(
      environmentSource,
      "NAVER_API_MODE=live\nGOOGLE_SERVICE_ACCOUNT_JSON_BASE64=do-not-copy\n",
    ),
    writeFile(googleSource, '{"type":"service_account"}\n'),
    writeFile(
      join(temporaryDirectory, "deploy.pub"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEfakeshimkey carplate-deploy\n",
    ),
    writeFile(sshdConfig, "Include sshd_config.d/*.conf\n"),
  ]);
  await chmod(environmentSource, 0o600);
  await chmod(googleSource, 0o600);
  await writeReviewedScripts(reviewedScriptDirectory);
  const initialRevision = await writeInitialReleaseSource(
    initialReleaseSource,
    reviewedScriptDirectory,
  );
  await writeCommandShims(shimDirectory, commandLog, accountStateDirectory);

  return {
    accountStateDirectory,
    appRoot,
    authorizedKeys,
    commandLog,
    environmentSource,
    etcDirectory,
    googleDestination: join(etcDirectory, "google-service-account.json"),
    googleSource,
    initialReleaseSource,
    initialRevision,
    reviewedScriptDirectory,
    scriptDirectory,
    privilegedExecutableDirectory,
    shimDirectory,
    sshDirectory,
    sshdDropIn,
    sshdConfig,
    stateRoot,
    sudoersFile,
    temporaryDirectory,
  };
}

async function writeReviewedScripts(directory: string): Promise<void> {
  await copyReviewedDeploymentTree(join(repositoryRoot, "ops/deployment"), directory);
  await Promise.all([
    chmod(join(directory, "lib", "common.sh"), 0o600),
    chmod(join(directory, "atomic_fs.py"), 0o600),
  ]);
}

async function copyReviewedDeploymentTree(source: string, destination: string): Promise<void> {
  for (const relativePath of reviewedDeploymentPaths) {
    const destinationPath = join(destination, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(join(source, relativePath), destinationPath);
  }
}

async function writeInitialReleaseSource(
  directory: string,
  reviewedScriptDirectory: string,
): Promise<string> {
  await Promise.all([
    mkdir(join(directory, "dist/src/scheduler"), { recursive: true }),
    mkdir(join(directory, "node_modules"), { recursive: true }),
  ]);
  await copyReviewedDeploymentTree(reviewedScriptDirectory, join(directory, "ops/deployment"));
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      '{\n  "name": "initial-release-fixture",\n  "private": true\n}\n',
    ),
    writeFile(join(directory, "dist/src/scheduler/main.js"), 'console.log("scheduler");\n'),
    writeFile(join(directory, "node_modules/runtime.txt"), "runtime dependency\n"),
    writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    writeFile(join(directory, ".env"), "SECRET=do-not-copy\n"),
    writeFile(join(directory, "google-service-account.json"), '{"private_key":"do-not-copy"}\n'),
    writeFile(join(directory, "google-credentials.json"), '{"token":"do-not-copy"}\n'),
  ]);

  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Bootstrap Test"],
    ["config", "user.email", "bootstrap@example.test"],
    ["add", "package.json", "dist/src/scheduler/main.js", "pnpm-lock.yaml", "ops/deployment"],
    ["commit", "--quiet", "-m", "initial built checkout"],
  ]) {
    const result = await runProcess("git", ["-C", directory, ...arguments_], process.env);
    expect(result.code, result.stderr).toBe(0);
  }
  const revision = await runProcess("git", ["-C", directory, "rev-parse", "HEAD"], process.env);
  expect(revision.code, revision.stderr).toBe(0);
  const sha = revision.stdout.trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  return sha;
}

async function writeCommandShims(
  directory: string,
  commandLog: string,
  accountStateDirectory: string,
): Promise<void> {
  const shellDollar = "$";
  const shim = `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s %s\\n' "$(basename "$0")" "$*" >> ${shellQuote(commandLog)}
account_state=${shellQuote(accountStateDirectory)}
account_uid() {
  case "$1" in
    carplate) printf '2101\\n' ;;
    carplate-build) printf '2102\\n' ;;
    carplate-deploy) printf '2103\\n' ;;
    *) exit 2 ;;
  esac
}
group_gid() {
  case "$1" in
    carplate) printf '3101\\n' ;;
    carplate-build) printf '3102\\n' ;;
    carplate-deploy) printf '3103\\n' ;;
    *) exit 2 ;;
  esac
}
group_name_for_gid() {
  for group in carplate carplate-build carplate-deploy; do
    if [[ $(group_gid "$group") == "$1" ]]; then
      printf '%s\\n' "$group"
      return
    fi
  done
  exit 2
}
case "$(basename "$0")" in
  getent)
    [[ $1 == group || $1 == passwd ]] || exit 2
    state="$account_state/$1-$2"
    [[ -f $state ]] || exit 2
    if [[ $1 == group ]]; then
      printf '%s:x:%s:\\n' "$2" "$(<"$state")"
    else
      IFS=: read -r uid gid < "$state"
      printf '%s:x:%s:%s::/nonexistent:/usr/sbin/nologin\\n' "$2" "$uid" "$gid"
    fi
    ;;
  id)
    option=$1
    user=$2
    IFS=: read -r uid gid < "$account_state/passwd-$user"
    case "$option" in
      -u) printf '%s\\n' "$uid" ;;
      -gn) group_name_for_gid "$gid" ;;
      -Gn)
        primary_group=$(group_name_for_gid "$gid")
        supplementary=$(<"$account_state/groups-$user")
        printf '%s%s\\n' "$primary_group" "${shellDollar}{supplementary:+ $supplementary}"
        ;;
      *) exit 2 ;;
    esac
    ;;
  groupadd)
    group="${shellDollar}{!#}"
    group_gid "$group" > "$account_state/group-$group"
    ;;
  useradd)
    user="${shellDollar}{!#}"
    group=
    while (( $# > 0 )); do
      if [[ $1 == --gid ]]; then group=$2; break; fi
      shift
    done
    printf '%s:%s\\n' "$(account_uid "$user")" "$(group_gid "$group")" > "$account_state/passwd-$user"
    : > "$account_state/groups-$user"
    ;;
  usermod)
    user="${shellDollar}{!#}"
    IFS=: read -r uid current_gid < "$account_state/passwd-$user"
    group=
    supplementary=__unchanged__
    while (( $# > 1 )); do
      case "$1" in
        --gid) group=$2; shift 2 ;;
        --groups) supplementary=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n $group ]] || group=$user
    printf '%s:%s\\n' "$uid" "$(group_gid "$group")" > "$account_state/passwd-$user"
    if [[ $supplementary != __unchanged__ ]]; then
      printf '%s' "$supplementary" > "$account_state/groups-$user"
    fi
    ;;
  systemctl)
    service_state="$account_state/systemctl-active"
    invocation_state="$account_state/systemctl-invocation"
    invocation_counter="$account_state/systemctl-invocation-counter"
    case "$1" in
      is-active)
        [[ -f $service_state ]] || exit 1
        transient_state="$account_state/systemctl-transient-active"
        if [[ -f $transient_state ]]; then
          rm -f "$transient_state" "$service_state"
        fi
        ;;
      show)
        [[ -f $invocation_state ]] || exit 1
        property=
        for argument in "$@"; do
          case "$argument" in
            --property=*) property="${shellDollar}{argument#--property=}" ;;
          esac
        done
        case "$property" in
          InvocationID) cat "$invocation_state" ;;
          NRestarts) printf '0\\n' ;;
          *) exit 2 ;;
        esac
        ;;
      enable)
        ;;
      start|restart)
        counter=0
        [[ ! -f $invocation_counter ]] || counter=$(<"$invocation_counter")
        counter=$((counter + 1))
        printf '%s\n' "$counter" >"$invocation_counter"
        printf '%032x\n' "$counter" >"$invocation_state"
        : >"$service_state"
        ;;
      reload|daemon-reload)
        ;;
      *) exit 2 ;;
    esac
    ;;
  journalctl)
    if [[ -f "$account_state/systemctl-startup-not-ready" ]]; then
      printf '{}\\n'
      exit 0
    fi
    revision=$(sed -n 's/^APP_REVISION=//p' "$CARPLATE_APP_ROOT/current/release.env")
    cron=$(sed -n 's/^SYNC_CRON=//p' "$CARPLATE_ETC_DIR/app.env")
    mode=$(sed -n 's/^NAVER_API_MODE=//p' "$CARPLATE_ETC_DIR/app.env")
    [[ -n $cron ]] || cron='*/5 * * * *'
    printf '{"level":30,"cron":"%s","mode":"%s","appRevision":"%s","msg":"scheduler started"}\\n' \
      "$cron" "$mode" "$revision"
    ;;
  git)
    if [[ ${shellDollar}{CARPLATE_TEST_DUBIOUS_INITIAL_SOURCE:-} == 1 && " $* " == *" -C ${shellDollar}CARPLATE_INITIAL_RELEASE_SOURCE "* ]]; then
      [[ " $* " == *" -c safe.directory=${shellDollar}CARPLATE_INITIAL_RELEASE_SOURCE "* ]] || {
        printf '%s\\n' "fatal: detected dubious ownership in repository at '${shellDollar}CARPLATE_INITIAL_RELEASE_SOURCE'" >&2
        exit 128
      }
    fi
    /usr/bin/git "$@"
    ;;
  passwd|visudo|chown)
    ;;
  sshd)
    config="${shellDollar}{!#}"
    drop_in="$(dirname "$config")/sshd_config.d/carplate-deploy.conf"
    [[ -f $config && -f $drop_in ]] || exit 1
    if [[ $1 == -t ]]; then
      grep -q '^Match User carplate-deploy$' "$drop_in"
      exit
    fi
    [[ $1 == -T && $2 == -C && $3 == user=carplate-deploy,host=localhost,addr=127.0.0.1 && $4 == -f ]] || exit 2
    while read -r keyword value; do
      [[ -n ${shellDollar}{keyword:-} && $keyword != Match ]] || continue
      printf '%s %s\\n' "$(printf '%s' "$keyword" | tr '[:upper:]' '[:lower:]')" "$value"
    done < "$drop_in"
    ;;
  install)
    arguments=()
    while (( $# > 0 )); do
      case "$1" in
        -o|-g) shift 2 ;;
        *) arguments+=("$1"); shift ;;
      esac
    done
    /usr/bin/install "${shellDollar}{arguments[@]}"
    ;;
  *) exit 97 ;;
esac
`;
  await Promise.all(
    [
      "getent",
      "id",
      "groupadd",
      "useradd",
      "usermod",
      "passwd",
      "systemctl",
      "journalctl",
      "visudo",
      "sshd",
      "install",
      "chown",
      "git",
    ].map(async (command) => {
      const path = join(directory, command);
      await writeFile(path, shim, { mode: 0o700 });
    }),
  );
}

async function runBootstrap(
  fixture: BootstrapFixture,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const environment = {
    ...process.env,
    CARPLATE_APP_ROOT: fixture.appRoot,
    CARPLATE_AUTHORIZED_KEY_SOURCE: join(fixture.temporaryDirectory, "deploy.pub"),
    CARPLATE_AUTHORIZED_KEYS: fixture.authorizedKeys,
    CARPLATE_ENV_SOURCE: fixture.environmentSource,
    CARPLATE_ETC_DIR: fixture.etcDirectory,
    CARPLATE_GOOGLE_JSON_SOURCE: fixture.googleSource,
    CARPLATE_INITIAL_RELEASE_SOURCE: fixture.initialReleaseSource,
    CARPLATE_SCRIPT_DIR: fixture.scriptDirectory,
    CARPLATE_PRIVILEGED_EXECUTABLE_DIR: fixture.privilegedExecutableDirectory,
    CARPLATE_SSHD_DROPIN: fixture.sshdDropIn,
    CARPLATE_SSHD_CONFIG: fixture.sshdConfig,
    CARPLATE_STATE_ROOT: fixture.stateRoot,
    CARPLATE_SUDOERS_FILE: fixture.sudoersFile,
    CARPLATE_SYSTEMD_DIR: join(fixture.temporaryDirectory, "systemd"),
    CARPLATE_TEST_COMMAND_PATH: fixture.shimDirectory,
    CARPLATE_TEST_MODE: "1",
    CARPLATE_TEST_SOURCE_TRUST_ROOT: fixture.temporaryDirectory,
    CARPLATE_REVIEWED_SCRIPT_DIR: fixture.reviewedScriptDirectory,
    ...environmentOverrides,
  };
  return await runProcess("bash", [bootstrapScript], environment);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readCommands(commandLog: string): Promise<string[]> {
  const content = await readFile(commandLog, "utf8");
  return content.split("\n").filter((line) => line.length > 0);
}

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function runProcess(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, arguments_, {
      env: environment,
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
    child.on("error", rejectProcess);
    child.on("close", (code) => {
      resolveProcess({ code, stderr, stdout });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

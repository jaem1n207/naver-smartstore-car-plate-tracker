import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const recoveryScript = join(repositoryRoot, "ops/deployment/recover.sh");
const atomicFsScript = join(repositoryRoot, "ops/deployment/atomic_fs.py");
const firstSha = "1111111111111111111111111111111111111111";
const secondSha = "2222222222222222222222222222222222222222";
const temporaryDirectories: string[] = [];
const currentUid = process.getuid?.() ?? 0;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await runProcess("chmod", ["-R", "u+w", directory]);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("boot recovery across activation crash points", () => {
  it.each([
    ["pending journal", firstSha, firstSha, true],
    ["previous link", firstSha, firstSha, true],
    ["current link", secondSha, firstSha, true],
    ["service start", secondSha, firstSha, true],
    ["health success", secondSha, firstSha, true],
    ["marker write", secondSha, secondSha, true],
    ["pending clear", secondSha, secondSha, false],
  ] as const)("reconciles a crash after %s", async (_point, currentSha, markerSha, pending) => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(currentSha);
    await fixture.writeMarker(markerSha);
    if (pending) {
      await fixture.writePending(firstSha, secondSha);
    }

    const result = await fixture.recover();

    expect(result.code, result.stderr).toBe(0);
    const expected = pending ? firstSha : secondSha;
    expect(await fixture.currentSha()).toBe(expected);
    expect(await fixture.marker()).toBe(expected);
    expect(await fixture.pendingExists()).toBe(false);
  });

  it("repairs marker/current disagreement even when no pending journal remains", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(secondSha);
    await fixture.writeMarker(firstSha);

    const result = await fixture.recover();

    expect(result.code, result.stderr).toBe(0);
    expect(await fixture.currentSha()).toBe(firstSha);
    expect(await fixture.marker()).toBe(firstSha);
  });

  it("restores a missing current link from the durable marker", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.writeMarker(firstSha);

    const result = await fixture.recover();

    expect(result.code, result.stderr).toBe(0);
    expect(await fixture.currentSha()).toBe(firstSha);
  });
});

describe("recovery validation", () => {
  it("rejects wrong UID, arguments, unsafe roots, and lock contention", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(firstSha);
    await fixture.writeMarker(firstSha);

    await fixture.writeConfig(currentUid + 1);
    expect((await fixture.recover()).code).toBe(1);
    await fixture.writeConfig();
    expect((await fixture.recover("extra")).code).toBe(1);

    await mkdir(join(fixture.stateRoot, "deploy.lock.test-flock"));
    expect((await fixture.recover()).code).toBe(1);
    await rm(join(fixture.stateRoot, "deploy.lock.test-flock"), { recursive: true });

    const realState = `${fixture.stateRoot}-real`;
    await mkdir(realState, { mode: 0o700 });
    await rm(fixture.stateRoot, { recursive: true });
    await symlink(realState, fixture.stateRoot);
    expect((await fixture.recover()).code).toBe(1);
  });

  it.each([
    "not-json\n",
    `{"state":"pending","previousSha":"${firstSha}","previousSha":"${secondSha}","priorPreviousSha":"","candidateSha":"${secondSha}"}\n`,
    `{"state":"complete","previousSha":"${firstSha}","priorPreviousSha":"","candidateSha":"${secondSha}"}\n`,
    `{"state":"pending","previousSha":"short","priorPreviousSha":"","candidateSha":"${secondSha}"}\n`,
    `{"state":"pending","previousSha":"${firstSha}","priorPreviousSha":"short","candidateSha":"${secondSha}"}\n`,
  ])("fails closed for malformed pending state: %s", async (journal) => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(secondSha);
    await fixture.writeMarker(firstSha);
    await writeFile(join(fixture.stateRoot, "activation-state"), journal, { mode: 0o600 });

    const result = await fixture.recover();

    expect(result.code).toBe(1);
    expect(await fixture.currentSha()).toBe(secondSha);
    expect(await fixture.pendingExists()).toBe(true);
  });

  it("fails closed when the journal or marker points to a missing release", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(secondSha);
    await fixture.writeMarker(firstSha);
    await fixture.writePending("3333333333333333333333333333333333333333", secondSha);

    expect((await fixture.recover()).code).toBe(1);
    expect(await fixture.currentSha()).toBe(secondSha);
  });

  it("refuses to start without a durable marker", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(firstSha);

    expect((await fixture.recover()).code).toBe(1);
    expect(await fixture.currentSha()).toBe(firstSha);
  });

  it("rejects a release whose sealed tree permissions were weakened", async () => {
    const fixture = await RecoveryFixture.create();
    await fixture.linkCurrent(firstSha);
    await fixture.writeMarker(firstSha);
    await chmod(join(fixture.appRoot, "releases", firstSha, "package.json"), 0o660);

    expect((await fixture.recover()).code).toBe(1);
    expect(await fixture.currentSha()).toBe(firstSha);
  });
});

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

class RecoveryFixture {
  readonly appRoot: string;
  readonly configPath: string;
  readonly root: string;
  readonly stateRoot: string;

  private constructor(root: string) {
    this.root = root;
    this.appRoot = join(root, "opt", "app");
    this.stateRoot = join(root, "var", "deployment");
    this.configPath = join(root, "recovery-test-config.sh");
  }

  static async create(): Promise<RecoveryFixture> {
    const root = await createTemporaryDirectory("carplate-recovery-");
    const fixture = new RecoveryFixture(root);
    await mkdir(join(fixture.appRoot, "releases"), { recursive: true, mode: 0o700 });
    await mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
    for (const sha of [firstSha, secondSha]) {
      const release = join(fixture.appRoot, "releases", sha);
      await mkdir(release, { mode: 0o700 });
      await mkdir(join(release, "dist", "src", "scheduler"), { recursive: true, mode: 0o700 });
      await mkdir(join(release, "node_modules"), { mode: 0o700 });
      await writeFile(join(release, "package.json"), "{}\n", { mode: 0o440 });
      await writeFile(join(release, "dist", "src", "scheduler", "main.js"), "export {};\n", {
        mode: 0o440,
      });
      await writeFile(join(release, "release.env"), `APP_REVISION=${sha}\n`, { mode: 0o440 });
      await runProcess("chmod", ["-R", "a-w", release]);
    }
    await fixture.writeConfig();
    return fixture;
  }

  async writeConfig(expectedUid = currentUid): Promise<void> {
    await writeFile(
      this.configPath,
      [
        `RECOVER_APP_ROOT=${shellQuote(this.appRoot)}`,
        `RECOVER_ATOMIC_FS=${shellQuote(atomicFsScript)}`,
        `RECOVER_EXPECTED_UID=${String(expectedUid)}`,
        `RECOVER_STATE_ROOT=${shellQuote(this.stateRoot)}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }

  async recover(...arguments_: string[]): Promise<ProcessResult> {
    return await runProcess("bash", [
      "-c",
      'CARPLATE_SOURCE_TEST_CONFIG=$1; source "$2"; shift 2; recover_main "$@"',
      "bash",
      this.configPath,
      recoveryScript,
      ...arguments_,
    ]);
  }

  async linkCurrent(sha: string): Promise<void> {
    await symlink(`releases/${sha}`, join(this.appRoot, "current"));
  }

  async writeMarker(sha: string): Promise<void> {
    await writeFile(join(this.stateRoot, "deployed-sha"), `${sha}\n`, { mode: 0o600 });
  }

  async writePending(
    previousSha: string,
    candidateSha: string,
    priorPreviousSha = "",
  ): Promise<void> {
    await writeFile(
      join(this.stateRoot, "activation-state"),
      `${JSON.stringify({ candidateSha, previousSha, priorPreviousSha, state: "pending" })}\n`,
      { mode: 0o600 },
    );
  }

  async currentSha(): Promise<string> {
    const target = await readlink(join(this.appRoot, "current"));
    return target.split("/").at(-1) ?? "";
  }

  async marker(): Promise<string> {
    return (await readFile(join(this.stateRoot, "deployed-sha"), "ascii")).trim();
  }

  async pendingExists(): Promise<boolean> {
    try {
      await readFile(join(this.stateRoot, "activation-state"));
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
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

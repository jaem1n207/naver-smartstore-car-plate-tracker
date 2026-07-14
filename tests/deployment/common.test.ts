import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const commonScript = join(repositoryRoot, "ops/deployment/lib/common.sh");
const temporaryDirectories: string[] = [];
const firstSha = "abcdef0123456789abcdef0123456789abcdef01";
const emptySha = "";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("validate_sha", () => {
  it("accepts only an exact lowercase 40-hex revision", async () => {
    await expectShellSuccess("validate_sha", firstSha);

    for (const invalid of [
      firstSha.toUpperCase(),
      firstSha.slice(1),
      `${firstSha}0`,
      `g${firstSha.slice(1)}`,
      `${firstSha}; true`,
    ]) {
      await expectShellFailure("validate_sha", invalid);
    }
  });
});

describe("classify_revision", () => {
  it("distinguishes equal, stale, forward, and divergent histories", async () => {
    const repository = await createGitHistory();

    await expectShellOutput(
      "equal\n",
      "classify_revision",
      repository.gitDir,
      repository.a,
      repository.a,
    );
    await expectShellOutput(
      "forward\n",
      "classify_revision",
      repository.gitDir,
      repository.a,
      repository.b,
    );
    await expectShellOutput(
      "stale\n",
      "classify_revision",
      repository.gitDir,
      repository.b,
      repository.a,
    );
    await expectShellOutput(
      "divergent\n",
      "classify_revision",
      repository.gitDir,
      repository.b,
      repository.divergent,
    );
  });
});

describe("lock owner compatibility", () => {
  it("encodes the setgid parent contract and creates exact shared lock modes", async () => {
    const lockDir = await createTemporaryPath("carplate-shell-lock-");
    const parent = dirname(lockDir);
    const contract = await runShellBody(
      'printf "%s %s %s\\n" "$SYNC_LOCK_PARENT_MODE" "$SYNC_LOCK_DIRECTORY_MODE" "$SYNC_LOCK_OWNER_MODE"',
      [],
    );
    expect(contract.code, contract.stderr).toBe(0);
    expect(contract.stdout).toBe("2770 0770 0640\n");

    const acquisition = await runShellFunction("acquire_sync_lock", lockDir, "0");
    expect(acquisition.code, acquisition.stderr).toBe(0);
    const token = acquisition.stdout.trim();
    const parentMetadata = await stat(parent);
    const lockMetadata = await stat(lockDir);
    const ownerMetadata = await stat(join(lockDir, "owner"));
    expect(parentMetadata.mode & 0o777).toBe(0o770);
    expect(lockMetadata.mode & 0o777).toBe(0o770);
    expect(ownerMetadata.mode & 0o777).toBe(0o640);
    expect(lockMetadata.gid).toBe(parentMetadata.gid);
    expect(ownerMetadata.gid).toBe(lockMetadata.gid);
    if (process.platform === "linux") {
      expect(parentMetadata.mode & 0o2777).toBe(0o2770);
      expect(lockMetadata.mode & 0o2777).toBe(0o2770);
    }

    await expectShellSuccess("release_sync_lock", lockDir, token);
  });

  it("rejects a runtime parent without group recovery permissions", async () => {
    const lockDir = await createTemporaryPath("carplate-shell-lock-");
    await chmod(dirname(lockDir), 0o750);

    await expectShellFailure("acquire_sync_lock", lockDir, "0");
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses and reproduces the exact TypeScript owner format", async () => {
    const lockDir = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(lockDir);
    const owner = "pid=42\nstart_ticks=1234\ntoken=0123456789abcdef0123456789abcdef\n";
    await writeFile(join(lockDir, "owner"), owner, { encoding: "ascii", mode: 0o600 });

    await expectShellOutput(owner, "read_lock_owner", lockDir);
  });

  it("fails closed for malformed owners and owner symlinks", async () => {
    const malformedLock = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(malformedLock);
    await writeFile(join(malformedLock, "owner"), "pid=42\nstart_ticks=nope\ntoken=x\n");
    await expectShellFailure("read_lock_owner", malformedLock);

    const symlinkLock = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(symlinkLock);
    const externalOwner = join(symlinkLock, "..", "external-owner");
    await writeFile(
      externalOwner,
      "pid=42\nstart_ticks=1234\ntoken=0123456789abcdef0123456789abcdef\n",
    );
    await symlink(externalOwner, join(symlinkLock, "owner"));
    await expectShellFailure("read_lock_owner", symlinkLock);
  });

  it("rejects oversized PIDs and preserves malformed locks during reclaim", async () => {
    for (const pid of ["9007199254740992", "9".repeat(128)]) {
      const lockDir = await createTemporaryPath("carplate-shell-lock-");
      const owner = `pid=${pid}\nstart_ticks=1234\ntoken=0123456789abcdef0123456789abcdef\n`;
      await mkdir(lockDir);
      await writeFile(join(lockDir, "owner"), owner);

      await expectShellFailure("read_lock_owner", lockDir);
      await expectShellFailure("acquire_sync_lock", lockDir, "0");
      await expect(readFile(join(lockDir, "owner"), "ascii")).resolves.toBe(owner);
    }
  });

  it("waits for a live owner to release before acquiring", async () => {
    const lockDir = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "owner"),
      `pid=${String(process.pid)}\nstart_ticks=unknown\ntoken=0123456789abcdef0123456789abcdef\n`,
    );

    const acquisition = runShellBody(
      'token=$(acquire_sync_lock "$2" 2); printf "%s\\n" "$token"; release_sync_lock "$2" "$token"',
      [lockDir],
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    await unlink(join(lockDir, "owner"));
    await rm(lockDir, { recursive: true });

    const result = await acquisition;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{32}\n$/u);
  });

  it("reclaims a dead owner but preserves unexpected lock entries", async () => {
    const reclaimableLock = await createTemporaryPath("carplate-shell-lock-");
    await writeOwner(reclaimableLock, 999_999_999);
    const acquired = await runShellBody(
      'token=$(acquire_sync_lock "$2" 0); cat "$2/owner"; release_sync_lock "$2" "$token"',
      [reclaimableLock],
    );
    expect(acquired.code).toBe(0);
    expect(acquired.stdout).toMatch(
      /^pid=[1-9][0-9]*\nstart_ticks=([1-9][0-9]*|unknown)\ntoken=[0-9a-f]{32}\n$/u,
    );

    const guardedLock = await createTemporaryPath("carplate-shell-lock-");
    await writeOwner(guardedLock, 999_999_999);
    await writeFile(join(guardedLock, "unexpected"), "keep");
    await expectShellFailure("acquire_sync_lock", guardedLock, "0");
    await expect(readFile(join(guardedLock, "unexpected"), "utf8")).resolves.toBe("keep");
  });

  it("reclaims only empty orphan lock directories older than the publication grace period", async () => {
    const oldEmptyLock = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(oldEmptyLock);
    await agePath(oldEmptyLock);

    const acquired = await runShellBody(
      'token=$(acquire_sync_lock "$2" 0); cat "$2/owner"; release_sync_lock "$2" "$token"',
      [oldEmptyLock],
    );
    expect(acquired.code, acquired.stderr).toBe(0);
    expect(acquired.stdout).toMatch(
      /^pid=[1-9][0-9]*\nstart_ticks=([1-9][0-9]*|unknown)\ntoken=[0-9a-f]{32}\n$/u,
    );

    const freshEmptyLock = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(freshEmptyLock);
    await expectShellFailure("acquire_sync_lock", freshEmptyLock, "0");
    await expect(stat(freshEmptyLock)).resolves.toBeDefined();

    const oldGuardedLock = await createTemporaryPath("carplate-shell-lock-");
    await mkdir(oldGuardedLock);
    await writeFile(join(oldGuardedLock, ".owner.partial.tmp"), "keep");
    await agePath(oldGuardedLock);
    await expectShellFailure("acquire_sync_lock", oldGuardedLock, "0");
    await expect(readFile(join(oldGuardedLock, ".owner.partial.tmp"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});

describe("safe_result", () => {
  it("emits one JSON line with only the public allowlisted keys", async () => {
    const result = await runShellFunction(
      "safe_result",
      "deployed",
      firstSha,
      emptySha,
      firstSha,
      "diag_123",
      "ignored-secret",
    );
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);

    const parsedJson: unknown = JSON.parse(result.stdout);
    const parsed = z.record(z.string(), z.string()).parse(parsedJson);
    expect(parsed).toEqual({
      activatedSha: firstSha,
      diagnosticId: "diag_123",
      outcome: "deployed",
      previousSha: emptySha,
      requestedSha: firstSha,
    });
    expect(result.stdout).not.toContain("ignored-secret");
  });
});

describe("validate_candidate_tree", () => {
  it("allows ordinary files and internal relative symlinks", async () => {
    const candidate = await createTemporaryDirectory("carplate-candidate-");
    await mkdir(join(candidate, "dist"));
    await writeFile(join(candidate, "dist", "main.js"), "console.log('ok');\n", { mode: 0o644 });
    await symlink("dist/main.js", join(candidate, "main.js"));

    await expectShellSuccess("validate_candidate_tree", candidate);
  });

  it("rejects escaping symlinks and writable candidate content", async () => {
    const escaping = await createTemporaryDirectory("carplate-candidate-");
    await symlink("../../outside", join(escaping, "outside"));
    await expectShellFailure("validate_candidate_tree", escaping);

    const writable = await createTemporaryDirectory("carplate-candidate-");
    await writeFile(join(writable, "unsafe"), "unsafe");
    await chmod(join(writable, "unsafe"), 0o666);
    await expectShellFailure("validate_candidate_tree", writable);
  });

  it("rejects a FIFO without opening the special file", async () => {
    const candidate = await createTemporaryDirectory("carplate-candidate-");
    await expectProcessSuccess("mkfifo", [join(candidate, "unsafe-fifo")]);

    await expectShellFailure("validate_candidate_tree", candidate);
  });

  it.runIf(process.platform === "darwin")(
    "rejects candidate content with extended attributes",
    async () => {
      const candidate = await createTemporaryDirectory("carplate-candidate-");
      const file = join(candidate, "metadata");
      await writeFile(file, "unsafe metadata\n");
      await expectProcessSuccess("/usr/bin/xattr", [
        "-w",
        "com.example.carplate-task3",
        "present",
        file,
      ]);

      await expectShellFailure("validate_candidate_tree", candidate);
    },
  );

  it.runIf(process.platform === "darwin")(
    "inspects extended attributes on the candidate root",
    async () => {
      const candidate = await createTemporaryDirectory("carplate-candidate-");
      await expectProcessSuccess("/usr/bin/xattr", [
        "-w",
        "com.example.carplate-root",
        "present",
        candidate,
      ]);

      await expectShellFailure("validate_candidate_tree", candidate);
    },
  );

  it.runIf(process.platform === "darwin")("rejects real Darwin ACL entries", async () => {
    const candidate = await createTemporaryDirectory("carplate-candidate-");
    const file = join(candidate, "metadata");
    await writeFile(file, "acl metadata\n");
    const currentUser = await runProcess("/usr/bin/id", ["-un"]);
    expect(currentUser.code, currentUser.stderr).toBe(0);
    await expectProcessSuccess("/bin/chmod", [
      "+a",
      `user:${currentUser.stdout.trim()} allow read`,
      file,
    ]);

    await expectShellFailure("validate_candidate_tree", candidate);
  });

  it("rejects Linux extended attributes through os.setxattr when supported", async () => {
    const candidate = await createTemporaryDirectory("carplate-candidate-");
    const file = join(candidate, "metadata");
    await writeFile(file, "unsafe metadata\n");
    const setter = await runProcess("python3", [
      "-c",
      [
        "import errno, os, sys",
        "if not hasattr(os, 'setxattr'): raise SystemExit(77)",
        "try:",
        "    os.setxattr(sys.argv[1], 'user.carplate-task3', b'present', follow_symlinks=False)",
        "except OSError as error:",
        "    if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.EPERM): raise SystemExit(77)",
        "    raise",
      ].join("\n"),
      file,
    ]);
    if (setter.code === 77) {
      return;
    }
    expect(setter.code, setter.stderr).toBe(0);

    await expectShellFailure("validate_candidate_tree", candidate);
  });
});

describe("verify_invocation", () => {
  const previousInvocation = "a".repeat(32);
  const currentInvocation = "b".repeat(32);

  it("accepts a fresh stable invocation with the expected startup record", async () => {
    const journal = await writeJournal(
      `${JSON.stringify({
        appRevision: firstSha,
        cron: "0 * * * *",
        mode: "live",
        msg: "scheduler started",
      })}\n`,
    );

    await expectShellSuccess(
      "verify_invocation",
      previousInvocation,
      currentInvocation,
      "2",
      "2",
      "0 * * * *",
      firstSha,
      journal,
    );
  });

  it("rejects an old invocation, restart changes, and malformed journal JSON", async () => {
    const validJournal = await writeJournal(
      `${JSON.stringify({
        appRevision: firstSha,
        cron: "0 * * * *",
        mode: "live",
        msg: "scheduler started",
      })}\n`,
    );
    await expectShellFailure(
      "verify_invocation",
      previousInvocation,
      previousInvocation,
      "2",
      "2",
      "0 * * * *",
      firstSha,
      validJournal,
    );
    await expectShellFailure(
      "verify_invocation",
      previousInvocation,
      currentInvocation,
      "2",
      "3",
      "0 * * * *",
      firstSha,
      validJournal,
    );

    const malformedJournal = await writeJournal("not-json\n");
    await expectShellFailure(
      "verify_invocation",
      previousInvocation,
      currentInvocation,
      "2",
      "2",
      "0 * * * *",
      firstSha,
      malformedJournal,
    );
  });

  it("rejects duplicate keys and non-finite constants in valid-looking startup records", async () => {
    const ambiguousRecords = [
      `{"msg":"scheduler stopped","msg":"scheduler started","mode":"live","cron":"0 * * * *","appRevision":"${firstSha}"}\n`,
      `{"msg":"scheduler started","mode":"live","cron":"0 * * * *","appRevision":"${firstSha}","health":NaN}\n`,
      `{"msg":"scheduler started","mode":"live","cron":"0 * * * *","appRevision":"${firstSha}","health":Infinity}\n`,
      `{"msg":"scheduler started","mode":"live","cron":"0 * * * *","appRevision":"${firstSha}","health":-Infinity}\n`,
    ];

    for (const record of ambiguousRecords) {
      const journal = await writeJournal(record);
      await expectShellFailure(
        "verify_invocation",
        previousInvocation,
        currentInvocation,
        "2",
        "2",
        "0 * * * *",
        firstSha,
        journal,
      );
    }
  });
});

async function expectShellSuccess(functionName: string, ...arguments_: string[]): Promise<void> {
  const result = await runShellFunction(functionName, ...arguments_);
  expect(result.code, result.stderr).toBe(0);
}

async function expectShellFailure(functionName: string, ...arguments_: string[]): Promise<void> {
  const result = await runShellFunction(functionName, ...arguments_);
  expect(result.code).not.toBe(0);
}

async function expectShellOutput(
  output: string,
  functionName: string,
  ...arguments_: string[]
): Promise<void> {
  const result = await runShellFunction(functionName, ...arguments_);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(output);
}

async function runShellFunction(
  functionName: string,
  ...arguments_: string[]
): Promise<ProcessResult> {
  return await runProcess("bash", [
    "-c",
    'source "$1"; shift; function_name=$1; shift; "$function_name" "$@"',
    "bash",
    commonScript,
    functionName,
    ...arguments_,
  ]);
}

async function runShellBody(body: string, arguments_: string[]): Promise<ProcessResult> {
  return await runProcess("bash", [
    "-c",
    `source "$1"; ${body}`,
    "bash",
    commonScript,
    ...arguments_,
  ]);
}

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
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

interface GitHistory {
  readonly a: string;
  readonly b: string;
  readonly divergent: string;
  readonly gitDir: string;
}

async function createGitHistory(): Promise<GitHistory> {
  const repository = await createTemporaryDirectory("carplate-git-");
  await expectProcessSuccess("git", ["init", "-q", repository]);
  await expectProcessSuccess("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "tests@example.com",
  ]);
  await expectProcessSuccess("git", ["-C", repository, "config", "user.name", "Deployment Tests"]);
  await writeFile(join(repository, "state"), "a\n");
  await expectProcessSuccess("git", ["-C", repository, "add", "state"]);
  await expectProcessSuccess("git", ["-C", repository, "commit", "-q", "-m", "A"]);
  const a = await gitRevision(repository);
  await expectProcessSuccess("git", ["-C", repository, "branch", "divergent", a]);
  await writeFile(join(repository, "state"), "b\n");
  await expectProcessSuccess("git", ["-C", repository, "commit", "-q", "-am", "B"]);
  const b = await gitRevision(repository);
  await expectProcessSuccess("git", ["-C", repository, "switch", "-q", "divergent"]);
  await writeFile(join(repository, "other"), "divergent\n");
  await expectProcessSuccess("git", ["-C", repository, "add", "other"]);
  await expectProcessSuccess("git", ["-C", repository, "commit", "-q", "-m", "Divergent"]);
  const divergent = await gitRevision(repository);

  return { a, b, divergent, gitDir: join(repository, ".git") };
}

async function gitRevision(repository: string): Promise<string> {
  const result = await runProcess("git", ["-C", repository, "rev-parse", "HEAD"]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function expectProcessSuccess(command: string, arguments_: string[]): Promise<void> {
  const result = await runProcess(command, arguments_);
  expect(result.code, result.stderr).toBe(0);
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createTemporaryPath(prefix: string): Promise<string> {
  const parent = await createTemporaryDirectory(prefix);
  await chmod(parent, process.platform === "linux" ? 0o2770 : 0o770);
  return join(parent, "sync.lock");
}

async function writeOwner(lockDir: string, pid: number | string): Promise<void> {
  await mkdir(lockDir);
  await writeFile(
    join(lockDir, "owner"),
    `pid=${String(pid)}\nstart_ticks=1234\ntoken=0123456789abcdef0123456789abcdef\n`,
  );
}

async function agePath(path: string): Promise<void> {
  const oldTimestamp = new Date(Date.now() - 61_000);
  await utimes(path, oldTimestamp, oldTimestamp);
}

async function writeJournal(contents: string): Promise<string> {
  const directory = await createTemporaryDirectory("carplate-journal-");
  const journal = join(directory, "journal.jsonl");
  await writeFile(journal, contents, { encoding: "utf8", mode: 0o600 });
  return journal;
}

import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const atomicFsScript = join(repositoryRoot, "ops/deployment/atomic_fs.py");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("atomic_fs write-file", () => {
  it("atomically replaces content and enforces the requested mode", async () => {
    const root = await createRoot();
    const destination = join(root, "deployment", "deployed-sha");
    await writeFile(destination, "old\n", { mode: 0o644 });

    const result = await runAtomicFs(root, ["write-file", destination, "0600"], "new\n");

    expect(result.code, result.stderr).toBe(0);
    await expect(readFile(destination, "utf8")).resolves.toBe("new\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "deployment"))).toEqual(["deployed-sha"]);
  });

  it("rejects missing parents, path escape, and symlink destinations", async () => {
    const root = await createRoot();
    const missing = await runAtomicFs(
      root,
      ["write-file", join(root, "missing", "state"), "0600"],
      "x",
    );
    expect(missing.code).not.toBe(0);

    const outside = join(root, "..", "outside-state");
    const escaped = await runAtomicFs(root, ["write-file", outside, "0600"], "x");
    expect(escaped.code).not.toBe(0);

    const realFile = join(root, "deployment", "real-state");
    const linkedFile = join(root, "deployment", "linked-state");
    await writeFile(realFile, "keep\n");
    await symlink("real-state", linkedFile);
    const linked = await runAtomicFs(root, ["write-file", linkedFile, "0600"], "replace\n");
    expect(linked.code).not.toBe(0);
    await expect(readFile(realFile, "utf8")).resolves.toBe("keep\n");
  });
});

describe("atomic_fs replace-symlink", () => {
  it("atomically installs and replaces a relative symlink in the same parent", async () => {
    const root = await createRoot();
    const releases = join(root, "releases");
    await mkdir(join(releases, "a"));
    await mkdir(join(releases, "b"));
    const current = join(root, "current");

    const first = await runAtomicFs(root, ["replace-symlink", current, "releases/a"]);
    expect(first.code, first.stderr).toBe(0);
    await expect(readlink(current)).resolves.toBe("releases/a");

    const second = await runAtomicFs(root, ["replace-symlink", current, "releases/b"]);
    expect(second.code, second.stderr).toBe(0);
    await expect(readlink(current)).resolves.toBe("releases/b");
    expect((await lstat(current)).isSymbolicLink()).toBe(true);
  });

  it("rejects absolute, escaping, and symlink-mediated targets", async () => {
    const root = await createRoot();
    const current = join(root, "current");
    const absolute = await runAtomicFs(root, ["replace-symlink", current, "/tmp/outside"]);
    expect(absolute.code).not.toBe(0);
    const escaped = await runAtomicFs(root, ["replace-symlink", current, "../outside"]);
    expect(escaped.code).not.toBe(0);

    await symlink("/tmp", join(root, "escape"));
    const mediated = await runAtomicFs(root, ["replace-symlink", current, "escape/outside"]);
    expect(mediated.code).not.toBe(0);
  });

  it("does not replace a regular file with a symlink", async () => {
    const root = await createRoot();
    const current = join(root, "current");
    await writeFile(current, "keep\n");

    const result = await runAtomicFs(root, ["replace-symlink", current, "releases/a"]);

    expect(result.code).not.toBe(0);
    await expect(readFile(current, "utf8")).resolves.toBe("keep\n");
  });
});

describe("atomic_fs clear-file", () => {
  it("removes pending state and is idempotent when it is already absent", async () => {
    const root = await createRoot();
    const pending = join(root, "deployment", "activation-state");
    await writeFile(pending, '{"state":"pending"}\n', { mode: 0o600 });
    await chmod(pending, 0o600);

    const cleared = await runAtomicFs(root, ["clear-file", pending]);
    expect(cleared.code, cleared.stderr).toBe(0);
    await expect(stat(pending)).rejects.toMatchObject({ code: "ENOENT" });

    const repeated = await runAtomicFs(root, ["clear-file", pending]);
    expect(repeated.code, repeated.stderr).toBe(0);
  });
});

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function runAtomicFs(root: string, arguments_: string[], input = ""): Promise<ProcessResult> {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("python3", [atomicFsScript, "--allowed-root", root, ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(input);
  });
}

async function createRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "carplate-atomic-fs-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, "deployment"));
  await mkdir(join(root, "releases"));
  return root;
}

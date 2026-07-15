import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceEntrypoint = join(repositoryRoot, "ops/deployment/deploy-entrypoint.sh");
const sha = "abcdef0123456789abcdef0123456789abcdef01";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("forced deployment SSH entrypoint", () => {
  it("accepts only the exact deploy command and invokes the fixed deployer with a clean environment", async () => {
    const fixture = await createFixture();

    const result = await fixture.run(`deploy ${sha}`);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `{"outcome":"deployed","requestedSha":"${sha}","previousSha":"","activatedSha":"${sha}","diagnosticId":"diag_123"}\n`,
    );
    await expect(readFile(fixture.invocationFile, "utf8")).resolves.toBe(
      `-n\n--\n${fixture.deployer}\n${sha}\n`,
    );
    await expect(readFile(fixture.environmentFile, "utf8")).resolves.toBe(
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n" +
        "LC_ALL=C\n" +
        "LANG=C\n" +
        "HOME=/nonexistent\n",
    );
  });

  it("rejects missing, malformed, expanded, and injected SSH commands before invoking sudo", async () => {
    const fixture = await createFixture();

    for (const originalCommand of [
      undefined,
      `deploy ${sha.toUpperCase()}`,
      `deploy ${sha.slice(1)}`,
      `deploy ${sha} extra`,
      `DEPLOY_MODE=unsafe deploy ${sha}`,
      `deploy ${sha}; /bin/sh`,
      `deploy ${sha}$(/bin/sh)`,
    ]) {
      const result = await fixture.run(originalCommand);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }

    await expect(readFile(fixture.invocationFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a process that is not the dedicated deployment account", async () => {
    const fixture = await createFixture({ currentUid: "4243", deployUid: "4242" });

    const result = await fixture.run(`deploy ${sha}`);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readFile(fixture.invocationFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("forwards only the public deployment-result allowlist", async () => {
    const fixture = await createFixture({
      deployerOutput: `{"outcome":"deployed","requestedSha":"${sha}","previousSha":"","activatedSha":"${sha}","diagnosticId":"diag_123","secret":"do-not-leak"}`,
    });

    const result = await fixture.run(`deploy ${sha}`);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("forwards a valid allowlisted result before returning the deployer failure status", async () => {
    const fixture = await createFixture({ deployerExitCode: 1 });

    const result = await fixture.run(`deploy ${sha}`);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `{"outcome":"deployed","requestedSha":"${sha}","previousSha":"","activatedSha":"${sha}","diagnosticId":"diag_123"}\n`,
    );
  });

  it("emits nothing when a failed deployer returns invalid JSON", async () => {
    const fixture = await createFixture({
      deployerExitCode: 1,
      deployerOutput: "not-json",
    });

    const result = await fixture.run(`deploy ${sha}`);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("keeps the production executable chain fixed and avoids shell evaluation", async () => {
    const source = await readFile(sourceEntrypoint, "utf8");

    expect(source).toContain("/usr/bin/id");
    expect(source).toContain("/usr/bin/env");
    expect(source).toContain("/usr/bin/sudo");
    expect(source).toContain("/usr/local/sbin/deploy-car-plate-tracker");
    expect(source).toContain(
      "readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(source).toContain('"$ENV" -i');
    expect(source).not.toMatch(/\beval\b/u);
  });
});

interface EntrypointFixture {
  readonly deployer: string;
  readonly environmentFile: string;
  readonly invocationFile: string;
  run(originalCommand: string | undefined): Promise<ProcessResult>;
}

interface FixtureOptions {
  readonly currentUid?: string;
  readonly deployUid?: string;
  readonly deployerExitCode?: number;
  readonly deployerOutput?: string;
}

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<EntrypointFixture> {
  const root = await mkdtemp(join(tmpdir(), "carplate-entrypoint-"));
  temporaryDirectories.push(root);

  const id = join(root, "id");
  const environment = join(root, "env");
  const sudo = join(root, "sudo");
  const deployer = join(root, "deployer");
  const entrypoint = join(root, "deploy-entrypoint.sh");
  const invocationFile = join(root, "sudo-invocation");
  const environmentFile = join(root, "deployer-environment");
  const currentUid = options.currentUid ?? "4242";
  const deployUid = options.deployUid ?? "4242";
  const deployerExitCode = options.deployerExitCode ?? 0;
  const deployerOutput =
    options.deployerOutput ??
    `{"outcome":"deployed","requestedSha":"${sha}","previousSha":"","activatedSha":"${sha}","diagnosticId":"diag_123"}`;
  const source = await readFile(sourceEntrypoint, "utf8");
  const testEntrypoint = source
    .replaceAll("/usr/bin/id", id)
    .replaceAll("/usr/bin/env", environment)
    .replaceAll("/usr/bin/sudo", sudo)
    .replaceAll("/usr/local/sbin/deploy-car-plate-tracker", deployer);

  await Promise.all([
    writeExecutable(
      id,
      `#!/bin/sh\nif [ "$1" = "-u" ] && [ "$#" = 1 ]; then\n  printf '%s\\n' '${currentUid}'\n  exit 0\nfi\nif [ "$1" = "-u" ] && [ "$2" = "carplate-deploy" ] && [ "$#" = 2 ]; then\n  printf '%s\\n' '${deployUid}'\n  exit 0\nfi\nexit 1\n`,
    ),
    writeExecutable(
      environment,
      `#!/bin/sh\n[ "$1" = "-i" ] || exit 1\nshift\n: > '${environmentFile}'\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    *=*) printf '%s\\n' "$1" >> '${environmentFile}'; shift ;;\n    *) break ;;
  esac\ndone\nexec /usr/bin/env -i "$@"\n`,
    ),
    writeExecutable(
      sudo,
      `#!/bin/sh\n: > '${invocationFile}'\nfor argument in "$@"; do\n  printf '%s\\n' "$argument" >> '${invocationFile}'\ndone\n[ "$1" = "-n" ] && [ "$2" = "--" ] || exit 1\nshift 2\nexec "$@"\n`,
    ),
    writeExecutable(
      deployer,
      `#!/bin/sh\nprintf 'PATH=%s\\nLC_ALL=%s\\nLANG=%s\\nHOME=%s\\n' "$PATH" "$LC_ALL" "$LANG" "$HOME" > '${environmentFile}'\nprintf '%s\\n' '${deployerOutput}'\nprintf '%s\\n' 'sensitive deployer stderr' >&2\nexit ${String(deployerExitCode)}\n`,
    ),
    writeExecutable(entrypoint, testEntrypoint),
  ]);

  return {
    deployer,
    environmentFile,
    invocationFile,
    run: (originalCommand) =>
      runProcess(
        entrypoint,
        [],
        originalCommand === undefined ? {} : { SSH_ORIGINAL_COMMAND: originalCommand },
      ),
  };
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function runProcess(
  command: string,
  arguments_: readonly string[],
  environment: Record<string, string>,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, arguments_, {
      env: { ...process.env, ...environment, BASH_ENV: "/not-used", NODE_OPTIONS: "--not-used" },
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
    child.on("error", rejectResult);
    child.on("close", (code) => {
      resolveResult({ code, stderr, stdout });
    });
  });
}

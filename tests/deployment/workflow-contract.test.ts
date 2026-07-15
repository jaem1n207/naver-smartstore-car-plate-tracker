import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repositoryRoot, ".github/workflows/deploy-production.yml");
const dependabotPath = join(repositoryRoot, ".github/dependabot.yml");
const codeownersPath = join(repositoryRoot, ".github/CODEOWNERS");
const nodeVersionPath = join(repositoryRoot, ".node-version");
const packageJsonPath = join(repositoryRoot, "package.json");

const expectedActionPins = new Set([
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
]);

const expectedSecrets = new Set([
  "OCI_DEPLOY_HOST",
  "OCI_DEPLOY_KNOWN_HOSTS",
  "OCI_DEPLOY_SSH_PRIVATE_KEY",
  "OCI_DEPLOY_USER",
]);

const stepSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  id: z.string().optional(),
  if: z.string().optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const jobSchema = z.object({
  concurrency: z
    .object({
      "cancel-in-progress": z.boolean(),
      group: z.string(),
    })
    .optional(),
  environment: z.union([z.string(), z.object({ name: z.string() })]).optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  "runs-on": z.string(),
  steps: z.array(stepSchema),
  "timeout-minutes": z.number().optional(),
});

const workflowSchema = z.object({
  jobs: z.record(z.string(), jobSchema),
  name: z.string(),
  on: z.object({
    pull_request: z.object({ branches: z.array(z.string()) }),
    push: z.object({ branches: z.array(z.string()) }),
    workflow_dispatch: z.null(),
  }),
  permissions: z.record(z.string(), z.string()),
});

const dependabotSchema = z.object({
  updates: z.array(
    z.object({
      directory: z.string(),
      "package-ecosystem": z.string(),
      schedule: z.object({ interval: z.string() }),
    }),
  ),
  version: z.literal(2),
});

async function readWorkflow() {
  const source = await readFile(workflowPath, "utf8");
  const parsed: unknown = parse(source);
  return { source, workflow: workflowSchema.parse(parsed) };
}

function getJob(workflow: z.infer<typeof workflowSchema>, name: string) {
  const job = workflow.jobs[name];
  if (job === undefined) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

function getStep(job: z.infer<typeof jobSchema>, name: string) {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

function compactExpression(expression: string | undefined) {
  return expression?.replace(/\s+/gu, " ").trim();
}

async function checkShellSyntax(script: string) {
  return await new Promise<{ code: number | null; stderr: string }>((resolveCheck, rejectCheck) => {
    const child = spawn("bash", ["-n"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectCheck);
    child.on("close", (code) => {
      resolveCheck({ code, stderr });
    });
    child.stdin.end(script);
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string },
) {
  return await new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";

      child.stderr.setEncoding("utf8");
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", rejectRun);
      child.on("close", (code) => {
        resolveRun({ code, stderr, stdout });
      });
      child.stdin.end(options.stdin);
    },
  );
}

async function runGit(cwd: string, args: string[]) {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

describe("production deployment workflow", () => {
  it("verifies pull requests and deploys only verified main revisions", async () => {
    const { workflow } = await readWorkflow();
    const verify = getJob(workflow, "verify");
    const deploy = getJob(workflow, "deploy");

    expect(workflow.on.pull_request.branches).toEqual(["main"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow).not.toHaveProperty("on.pull_request_target");
    expect(deploy.needs).toBe("verify");
    expect(compactExpression(deploy.if)).toBe(
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
    );

    const dispatchGuard = getStep(verify, "Reject non-main manual ref");
    expect(compactExpression(dispatchGuard.if)).toBe(
      "github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'",
    );
    expect(dispatchGuard.run).toMatch(/(?:^|\n)\s*exit 1\s*(?:\n|$)/u);
  });

  it("fails closed before SSH when a main push changes privileged deployment assets", async () => {
    const { workflow } = await readWorkflow();
    const verify = getJob(workflow, "verify");
    const deploy = getJob(workflow, "deploy");
    const checkout = verify.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    const classifier = getStep(verify, "Classify privileged deployment changes");
    const maintenanceGate = getStep(deploy, "Require reviewed privileged maintenance");
    const request = getStep(deploy, "Request production deployment");

    expect(checkout?.with).toMatchObject({ "fetch-depth": 2 });
    expect(verify.outputs).toEqual({
      privileged_maintenance_required:
        "${{ steps.deployment_scope.outputs.privileged_maintenance_required }}",
    });
    expect(classifier.id).toBe("deployment_scope");
    expect(classifier.env).toEqual({
      CURRENT_SHA: "${{ github.sha }}",
      EVENT_NAME: "${{ github.event_name }}",
      GH_REPOSITORY: "${{ github.repository }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(classifier.run).toContain('[[ "${EVENT_NAME}" == push ]]');
    expect(classifier.run).toContain("actions/workflows/deploy-production.yml/runs");
    expect(classifier.run).toContain("trusted_production_sha");
    expect(classifier.run).toContain(
      'git diff --quiet "${trusted_production_sha}" "${CURRENT_SHA}" -- ops/deployment',
    );
    expect(classifier.run).toContain("privileged_maintenance_required=true");
    expect(classifier.run).toContain('>>"${GITHUB_OUTPUT}"');

    expect(compactExpression(maintenanceGate.if)).toBe(
      "github.event_name == 'push' && needs.verify.outputs.privileged_maintenance_required == 'true'",
    );
    expect(maintenanceGate.run).toContain("Privileged maintenance required");
    expect(maintenanceGate.run).toContain("workflow_dispatch");
    expect(maintenanceGate.run).toMatch(/(?:^|\n)\s*exit 1\s*(?:\n|$)/u);
    expect(deploy.steps.indexOf(maintenanceGate)).toBeLessThan(deploy.steps.indexOf(request));

    const classifierSyntax = await checkShellSyntax(classifier.run ?? "");
    expect(classifierSyntax.code, classifierSyntax.stderr).toBe(0);
    const gateSyntax = await checkShellSyntax(maintenanceGate.run ?? "");
    expect(gateSyntax.code, gateSyntax.stderr).toBe(0);
  });

  it("classifies application changes separately from privileged deployment changes", async () => {
    const { workflow } = await readWorkflow();
    const classifier = getStep(
      getJob(workflow, "verify"),
      "Classify privileged deployment changes",
    );
    const fixture = await mkdtemp(join(tmpdir(), "carplate-deployment-scope-"));

    try {
      await runGit(fixture, ["init", "--quiet"]);
      await runGit(fixture, ["config", "user.name", "Deployment Scope Test"]);
      await runGit(fixture, ["config", "user.email", "deployment-scope@example.invalid"]);
      await mkdir(join(fixture, "src"));
      await writeFile(join(fixture, "src/application.ts"), "export const version = 1;\n", "utf8");
      await runGit(fixture, ["add", "."]);
      await runGit(fixture, ["commit", "--quiet", "-m", "initial"]);
      const initialSha = await runGit(fixture, ["rev-parse", "HEAD"]);
      const shimDirectory = join(fixture, "bin");
      const ghShim = join(shimDirectory, "gh");
      await mkdir(shimDirectory);
      await writeFile(
        ghShim,
        '#!/bin/sh\nprintf \'{"workflow_runs":[{"event":"push","head_sha":"%s"}]}\\n\' "${TRUSTED_PRODUCTION_SHA}"\n',
      );
      await chmod(ghShim, 0o700);
      const classifierEnvironment = {
        ...process.env,
        EVENT_NAME: "push",
        GH_REPOSITORY: "example/repository",
        GH_TOKEN: "test-token",
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        TRUSTED_PRODUCTION_SHA: initialSha,
      };

      await writeFile(join(fixture, "src/application.ts"), "export const version = 2;\n", "utf8");
      await runGit(fixture, ["add", "."]);
      await runGit(fixture, ["commit", "--quiet", "-m", "application"]);
      const applicationSha = await runGit(fixture, ["rev-parse", "HEAD"]);
      const applicationOutput = join(fixture, "application-output");
      const applicationResult = await runCommand("bash", ["-c", classifier.run ?? ""], {
        cwd: fixture,
        env: {
          ...classifierEnvironment,
          CURRENT_SHA: applicationSha,
          GITHUB_OUTPUT: applicationOutput,
        },
      });

      expect(applicationResult.code, applicationResult.stderr).toBe(0);
      await expect(readFile(applicationOutput, "utf8")).resolves.toBe(
        "privileged_maintenance_required=false\n",
      );

      await mkdir(join(fixture, "ops/deployment"), { recursive: true });
      await writeFile(join(fixture, "ops/deployment/deploy.sh"), "#!/usr/bin/env bash\n", "utf8");
      await runGit(fixture, ["add", "."]);
      await runGit(fixture, ["commit", "--quiet", "-m", "privileged"]);
      const privilegedSha = await runGit(fixture, ["rev-parse", "HEAD"]);
      const privilegedOutput = join(fixture, "privileged-output");
      const privilegedResult = await runCommand("bash", ["-c", classifier.run ?? ""], {
        cwd: fixture,
        env: {
          ...classifierEnvironment,
          CURRENT_SHA: privilegedSha,
          GITHUB_OUTPUT: privilegedOutput,
        },
      });

      expect(privilegedResult.code, privilegedResult.stderr).toBe(0);
      await expect(readFile(privilegedOutput, "utf8")).resolves.toBe(
        "privileged_maintenance_required=true\n",
      );

      await writeFile(join(fixture, "src/application.ts"), "export const version = 3;\n", "utf8");
      await runGit(fixture, ["add", "."]);
      await runGit(fixture, ["commit", "--quiet", "-m", "application follow-up"]);
      const followUpSha = await runGit(fixture, ["rev-parse", "HEAD"]);
      const followUpOutput = join(fixture, "follow-up-output");
      const followUpResult = await runCommand("bash", ["-c", classifier.run ?? ""], {
        cwd: fixture,
        env: {
          ...classifierEnvironment,
          CURRENT_SHA: followUpSha,
          GITHUB_OUTPUT: followUpOutput,
        },
      });

      expect(followUpResult.code, followUpResult.stderr).toBe(0);
      await expect(readFile(followUpOutput, "utf8")).resolves.toBe(
        "privileged_maintenance_required=true\n",
      );
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("keeps repository access read-only and serializes only production deployment", async () => {
    const { workflow } = await readWorkflow();
    const verify = getJob(workflow, "verify");
    const deploy = getJob(workflow, "deploy");

    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(verify.permissions).toBeUndefined();
    expect(deploy.permissions).toBeUndefined();
    expect(verify.environment).toBeUndefined();
    expect(verify.concurrency).toBeUndefined();
    expect(deploy.environment).toBe("production");
    expect(deploy.concurrency).toEqual({
      "cancel-in-progress": false,
      group: "production-deploy",
    });
    expect(deploy["timeout-minutes"]).toBeGreaterThan(90);
  });

  it("pins every reusable action and runs the complete verification contract", async () => {
    const { workflow } = await readWorkflow();
    const verify = getJob(workflow, "verify");
    const deploy = getJob(workflow, "deploy");
    const uses = [...verify.steps, ...deploy.steps].flatMap((step) =>
      step.uses === undefined ? [] : [step.uses],
    );

    expect(uses).toHaveLength(expectedActionPins.size);
    expect(new Set(uses)).toEqual(expectedActionPins);
    expect(uses.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);

    const commands = verify.steps
      .flatMap((step) => (step.run === undefined ? [] : [step.run]))
      .join("\n");
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm exec playwright install --with-deps chromium");
    expect(commands).toContain("pnpm test:all");
    expect(commands).toContain("pnpm build");
    expect(commands).toContain("bash -n ops/deployment/*.sh ops/deployment/lib/*.sh");
    expect(commands).toContain("git diff --exit-code -- tests/visual/fixtures/sheets-view.css");
    expect(commands).toContain("actionlint_1.7.7_linux_amd64.tar.gz");
    expect(commands).toContain("023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757");
    expect(commands).toContain("shellcheck-v0.10.0.linux.x86_64.tar.xz");
    expect(commands).toContain("6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87");
    expect(commands.match(/sha256sum --check/gu)).toHaveLength(2);
    expect(commands).not.toContain("reviewdog");

    expect(verify["runs-on"]).toBe("ubuntu-24.04");
    expect(deploy["runs-on"]).toBe("ubuntu-24.04");

    const checkout = verify.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });

    const setupNode = verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setupNode?.with).toMatchObject({
      cache: "pnpm",
      "node-version-file": ".node-version",
    });

    const setupPnpm = verify.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"));
    expect(setupPnpm?.with).toMatchObject({ version: "11.10.0" });

    const diagnostics = verify.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(diagnostics?.if).toBe("failure()");
    expect(diagnostics?.with).toMatchObject({
      "retention-days": 7,
    });
    expect(String(diagnostics?.with?.path)).toContain("playwright-report");
    expect(String(diagnostics?.with?.path)).toContain("test-results");

    expect(getStep(verify, "Run actionlint").run).toContain(
      '"${RUNNER_TEMP}/static-tools/actionlint"',
    );
    expect(getStep(verify, "Run shellcheck").run).toContain(
      '"${RUNNER_TEMP}/static-tools/shellcheck"',
    );
  });

  it("pins the runner, Node.js, and pnpm production toolchain", async () => {
    const nodeVersion = (await readFile(nodeVersionPath, "utf8")).trim();
    const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const packageContract = z
      .object({
        engines: z.object({ node: z.string() }),
        packageManager: z.string(),
      })
      .parse(packageJson);

    expect(nodeVersion).toBe("22.23.1");
    expect(packageContract.packageManager).toBe("pnpm@11.10.0");
    expect(packageContract.engines.node).toBe(">=22.13");
    const [major, minor] = nodeVersion.split(".").map(Number);
    expect(major).toBe(22);
    expect(minor).toBeGreaterThanOrEqual(13);
  });

  it("uses only deploy credentials and sends one strict bounded forced command", async () => {
    const { source, workflow } = await readWorkflow();
    const deploy = getJob(workflow, "deploy");
    const secretNames = [...source.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/gu)].map(
      (match) => match[1],
    );

    expect(new Set(secretNames)).toEqual(expectedSecrets);

    const request = getStep(deploy, "Request production deployment");
    expect(request.run).toContain("timeout 110m ssh");
    expect(request.run).toContain("-o BatchMode=yes");
    expect(request.run).toContain("-o IdentitiesOnly=yes");
    expect(request.run).toContain("-o StrictHostKeyChecking=yes");
    expect(request.run).toContain("-o UserKnownHostsFile=");
    expect(request.run).toContain("-o ConnectTimeout=15");
    expect(request.run).toContain('[[ "${DEPLOY_USER}" != carplate-deploy');
    expect(request.run).toContain('"${GITHUB_SHA}" =~ ^[0-9a-f]{40}$');
    expect(request.run).toContain('"deploy ${GITHUB_SHA}"');
    expect(request.run?.match(/"deploy \$\{GITHUB_SHA\}"/gu)).toHaveLength(1);
    expect(request.run).toContain(
      'keys == ["activatedSha", "diagnosticId", "outcome", "previousSha", "requestedSha"]',
    );
    expect(request.run).toContain(
      "{outcome, requestedSha, previousSha, activatedSha, diagnosticId}",
    );
    expect(request.run).toContain(
      'deployment_outcome="$(jq -r .outcome <<<"${sanitized_result}")"',
    );
    expect(request.run).toContain(
      '[[ "${deployment_outcome}" == privileged_maintenance_required ]]',
    );
    expect(request.run).toContain("Privileged maintenance required");
    expect(request.run).toContain('>>"${GITHUB_STEP_SUMMARY}"');
    expect(request.run).not.toContain("`");
    expect(request.run).toContain(`printf '%s\\n' "\${sanitized_result}"`);
    expect(request.run).not.toMatch(/StrictHostKeyChecking=(?:no|accept-new)/u);
    expect(request.run).not.toMatch(/(?:journalctl|printenv|set -x|ssh -v)/u);

    const syntax = await checkShellSyntax(request.run ?? "");
    expect(syntax.code, syntax.stderr).toBe(0);
  });
});

describe("deployment governance", () => {
  it("pins the repository Node runtime", async () => {
    await expect(readFile(nodeVersionPath, "utf8")).resolves.toBe("22.23.1\n");
  });

  it("checks GitHub Actions updates weekly", async () => {
    const source = await readFile(dependabotPath, "utf8");
    const parsed: unknown = parse(source);
    const dependabot = dependabotSchema.parse(parsed);

    expect(dependabot.updates).toContainEqual({
      directory: "/",
      "package-ecosystem": "github-actions",
      schedule: { interval: "weekly" },
    });
  });

  it("requires review for workflows, deployment sources, and package manifests", async () => {
    const codeowners = await readFile(codeownersPath, "utf8");
    const rules = codeowners
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(rules).toEqual(
      expect.arrayContaining([
        "/.github/workflows/ @jaem1n207",
        "/ops/deployment/ @jaem1n207",
        "/package.json @jaem1n207",
        "/pnpm-lock.yaml @jaem1n207",
      ]),
    );
  });
});

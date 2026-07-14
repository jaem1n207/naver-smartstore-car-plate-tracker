import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repositoryRoot, ".github/workflows/deploy-production.yml");
const dependabotPath = join(repositoryRoot, ".github/dependabot.yml");
const codeownersPath = join(repositoryRoot, ".github/CODEOWNERS");
const nodeVersionPath = join(repositoryRoot, ".node-version");

const expectedActionPins = new Set([
  "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  "pnpm/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "reviewdog/action-actionlint@6fb7acc99f4a1008869fa8a0f09cfca740837d9d",
  "reviewdog/action-shellcheck@4c07458293ac342d477251099501a718ae5ef86e",
]);

const expectedSecrets = new Set([
  "OCI_DEPLOY_HOST",
  "OCI_DEPLOY_KNOWN_HOSTS",
  "OCI_DEPLOY_SSH_PRIVATE_KEY",
  "OCI_DEPLOY_USER",
]);

const stepSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
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

  it("keeps repository access read-only and serializes only production deployment", async () => {
    const { workflow } = await readWorkflow();
    const verify = getJob(workflow, "verify");
    const deploy = getJob(workflow, "deploy");

    expect(workflow.permissions).toEqual({ contents: "read" });
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

    for (const staticAnalysisStep of verify.steps.filter(
      (step) =>
        step.uses?.startsWith("reviewdog/action-actionlint@") === true ||
        step.uses?.startsWith("reviewdog/action-shellcheck@") === true,
    )) {
      expect(staticAnalysisStep.with).toMatchObject({
        fail_level: "error",
        filter_mode: "nofilter",
        reporter: "local",
      });
    }
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

# Car Plate Tracker Implementation Plan

> Historical implementation plan. The completed worker now creates Korean-named Google Sheets tabs automatically; current behavior is documented in `README.md` and `docs/architecture/system-overview.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js and TypeScript worker that syncs non-deleted Naver Smartstore products from two stores, extracts Korean vehicle plate numbers from product detail content, detects duplicates, and writes operator-friendly Google Sheets views.

**Architecture:** Implement a small worker with explicit boundaries: config validation, Naver API adapters, plate extraction, duplicate analysis, sheet repositories, sync orchestration, and scheduler entrypoints. Local development uses mock Naver data and in-memory Sheets tests; live Naver API calls are guarded by environment flags and intended only for a fixed-IP server.

**Tech Stack:** Node.js 22.13+, TypeScript, pnpm, Vitest, Playwright, ESLint, Prettier, Tailwind CSS, shadcn/ui conventions, Zod, Cheerio, he, bcryptjs, googleapis, pino, p-limit, node-cron, dotenv.

---

## Scope Check

The approved design covers one coherent MVP. It has multiple components, but each component contributes to one testable sync path. Keep this as one implementation plan and commit after each task.

## Dependency Policy

Use `pnpm` for every install and script command. Dependency versions in `package.json` must use caret ranges and should be refreshed to the npm registry latest version at implementation time. The versions in this plan were checked against npm registry on 2026-07-09.

Exception: TypeScript should use the latest stable version that satisfies `typescript-eslint`'s peer range. On 2026-07-09, that is `typescript@^6.0.3`; `typescript@7.0.2` is newer but outside `typescript-eslint@8.63.0`'s supported peer range.

## Styling Policy

Use Tailwind CSS for any HTML or React styling surface. If a React operator UI is introduced, initialize and manage UI components with `pnpm dlx shadcn@latest`, then use shadcn components such as `Card`, `Table`, `Badge`, `Button`, `Tabs`, and `Alert` instead of custom styled markup. Google Sheets tabs are the MVP operator UI and cannot use Tailwind or shadcn directly; for those, keep formatting deterministic through Sheets writes and document the exception.

## File Structure

Create these files:

- `package.json`: pnpm scripts and dependencies.
- `tsconfig.json`: strict TypeScript configuration.
- `eslint.config.js`: static lint configuration.
- `.prettierrc.json`: formatting configuration.
- `.prettierignore`: generated output formatting exclusions.
- `playwright.config.ts`: e2e and visual test configuration.
- `tests/visual/fixtures/sheets-view.input.css`: Tailwind CSS input for visual fixture styling.
- `.env.example`: names of required runtime variables only.
- `README.md`: local, test, and server operation commands.
- `src/config/env.ts`: environment parsing and live-mode guard.
- `src/config/stores.ts`: store config construction from environment.
- `src/logging/redact.ts`: secret redaction helper.
- `src/domain/plate/types.ts`: extraction status and result types.
- `src/domain/plate/normalize.ts`: unicode and plate canonicalization.
- `src/domain/plate/extract.ts`: HTML-to-text and plate candidate extraction.
- `src/domain/duplicates/types.ts`: product row and duplicate status types.
- `src/domain/duplicates/analyze.ts`: duplicate classification.
- `src/naver/types.ts`: Naver client interfaces and DTOs used by the app.
- `src/naver/auth.ts`: Naver signature and token cache.
- `src/naver/client.ts`: live Naver Commerce API client.
- `src/naver/mock-client.ts`: fixture-backed client for local dev and tests.
- `src/sheets/types.ts`: sheet row, run log, and repository interfaces.
- `src/sheets/columns.ts`: canonical sheet columns and row conversion helpers.
- `src/sheets/in-memory-repository.ts`: test repository.
- `src/sheets/google-repository.ts`: Google Sheets API repository.
- `src/sync/sync-job.ts`: orchestration for one full sync.
- `src/cli/sync-once.ts`: one-shot CLI entrypoint.
- `src/scheduler/main.ts`: cron scheduler entrypoint.
- `tests/fixtures/naver/store-a-products.json`: mock Store A product search result.
- `tests/fixtures/naver/store-b-products.json`: mock Store B product search result.
- `tests/fixtures/naver/details.json`: mock detail content by channel product number.
- `tests/unit/plate.test.ts`: extraction tests.
- `tests/unit/duplicates.test.ts`: duplicate tests.
- `tests/unit/redact.test.ts`: secret redaction tests.
- `tests/unit/config.test.ts`: config guard tests.
- `tests/integration/sync-job.test.ts`: mock end-to-end sync test.
- `tests/unit/naver-auth.test.ts`: signature/token behavior tests.
- `tests/e2e/mock-sync.cli.spec.ts`: CLI-level mock sync verification.
- `tests/visual/sheets-view.spec.ts`: visual snapshot of generated sheet-style HTML report.
- `tests/visual/fixtures/sheets-view.html`: deterministic visual fixture.
- `docs/conventions/ui-styling.md`: Tailwind and shadcn usage convention.
- `docs/architecture/system-overview.md`: architecture and data-flow reference.
- `docs/decisions/0001-sheets-first-worker.md`: decision record for the Sheets-first architecture.
- `docs/conventions/testing.md`: static/unit/integration/e2e/visual testing convention.
- `docs/troubleshooting/naver-commerce-api.md`: common Naver Commerce API errors and operator actions.

Modify these files:

- `.gitignore`: keep generated build output and local credentials excluded if missing.

---

### Task 1: Scaffold TypeScript Project

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `playwright.config.ts`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Write package and TypeScript configuration**

Create `package.json` with:

```json
{
  "name": "naver-smartstore-car-plate-tracker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.10.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint .",
    "format:check": "prettier . --check",
    "build:visual-css": "tailwindcss -i tests/visual/fixtures/sheets-view.input.css -o tests/visual/fixtures/sheets-view.css --minify",
    "test": "pnpm test:all",
    "test:all": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm test:visual",
    "test:unit": "vitest run tests/unit --passWithNoTests",
    "test:integration": "vitest run tests/integration --passWithNoTests",
    "test:e2e": "playwright test tests/e2e",
    "test:visual": "pnpm build:visual-css && playwright test tests/visual",
    "test:watch": "vitest",
    "sync:once": "tsx src/cli/sync-once.ts",
    "scheduler": "tsx src/scheduler/main.ts"
  },
  "engines": {
    "node": ">=22.13"
  },
  "dependencies": {
    "bcryptjs": "^3.0.3",
    "cheerio": "^1.2.0",
    "dotenv": "^17.4.2",
    "googleapis": "^173.0.0",
    "he": "^1.2.0",
    "node-cron": "^4.6.0",
    "p-limit": "^7.3.0",
    "pino": "^10.3.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@playwright/test": "^1.61.1",
    "@types/he": "^1.2.3",
    "@types/node": "^26.1.1",
    "@typescript-eslint/eslint-plugin": "^8.63.0",
    "@typescript-eslint/parser": "^8.63.0",
    "@tailwindcss/cli": "^4.3.2",
    "@vitest/coverage-v8": "^4.1.10",
    "eslint": "^10.6.0",
    "eslint-config-prettier": "^10.1.8",
    "globals": "^17.7.0",
    "prettier": "^3.9.4",
    "tailwindcss": "^4.3.2",
    "tsx": "^4.23.0",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.63.0",
    "vitest": "^4.1.10"
  }
}
```

Create `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "playwright.config.ts"]
}
```

Create `eslint.config.js` with:

```js
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "never",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
    },
  },
];
```

Create `.prettierrc.json` with:

```json
{
  "printWidth": 100,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
```

Create `.prettierignore` with:

```gitignore
dist/
node_modules/
coverage/
playwright-report/
test-results/
```

Create `playwright.config.ts` with:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/e2e/**/*.spec.ts", "tests/visual/**/*.spec.ts"],
  fullyParallel: false,
  retries: 0,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
```

- [ ] **Step 2: Create runtime variable template**

Create `.env.example` with variable names only:

```dotenv
NODE_ENV=
TZ=
LOG_LEVEL=
NAVER_API_MODE=
ALLOW_LIVE_NAVER_API=
NAVER_API_BASE_URL=
SYNC_CRON=
STORE_A_NAME=
STORE_A_BASE_URL=
STORE_A_CLIENT_ID=
STORE_A_CLIENT_SECRET=
STORE_A_ACCOUNT_ID=
STORE_B_NAME=
STORE_B_BASE_URL=
STORE_B_CLIENT_ID=
STORE_B_CLIENT_SECRET=
STORE_B_ACCOUNT_ID=
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_APPLICATION_CREDENTIALS=
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
```

- [ ] **Step 3: Check `.gitignore` protections**

Confirm `.gitignore` contains these entries:

```gitignore
dist/
.env
.env.*
!.env.example
node_modules/
coverage
playwright-report/
test-results/
*.log
```

If any entry is missing, add it once.

- [ ] **Step 4: Create README usage skeleton**

Create `README.md` with:

````markdown
# Naver Smartstore Car Plate Tracker

Node.js and TypeScript worker for syncing registered Naver Smartstore products, extracting vehicle plate numbers from product detail content, detecting duplicates, and writing Google Sheets views.

## Local Development

Local development uses mock Naver data by default.

```bash
corepack enable
pnpm install
pnpm test
pnpm sync:once
```

## Live API Guard

Live Naver Commerce API calls require both:

- `NAVER_API_MODE=live`
- `ALLOW_LIVE_NAVER_API=true`

Live mode is intended for a staging or production server with a fixed public IP registered in Naver Commerce API settings.

## Runtime Secrets

Copy `.env.example` to `.env` locally for mock development. Do not commit `.env`, Google service account JSON, Naver client secrets, browser cookies, or product data exports.
````

- [ ] **Step 5: Install dependencies with pnpm**

Run:

```bash
corepack enable
pnpm install
```

Expected: `pnpm-lock.yaml` is created and pnpm exits with status 0.

- [ ] **Step 6: Confirm direct dependencies are current**

Run:

```bash
pnpm outdated
```

Expected: no direct dependency has a newer `latest` version. If a direct dependency is outdated, update that `package.json` entry to the current latest version with a caret range, run `pnpm install`, and rerun `pnpm outdated`.

- [ ] **Step 7: Verify empty project build/test scripts**

Run:

```bash
pnpm build
pnpm test:unit
```

Expected: build succeeds if no source exists; Vitest reports no tests or exits cleanly after test files are added in later tasks. If Vitest exits with no-test failure, proceed after Task 2 adds tests.

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json eslint.config.js .prettierrc.json .prettierignore playwright.config.ts .env.example .gitignore README.md
git commit -m "Add TypeScript project scaffold"
```

---

### Task 2: Environment Validation And Redaction

**Files:**

- Create: `src/config/env.ts`
- Create: `src/config/stores.ts`
- Create: `src/logging/redact.ts`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/redact.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Create `tests/unit/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/logging/redact.js";

describe("redactSecrets", () => {
  it("masks configured secret values", () => {
    const result = redactSecrets("client secret is abc123 and token is live-token", [
      "abc123",
      "live-token",
    ]);

    expect(result).toBe("client secret is [REDACTED] and token is [REDACTED]");
  });

  it("ignores empty secret values", () => {
    const result = redactSecrets("safe message", ["", "   "]);

    expect(result).toBe("safe message");
  });
});
```

- [ ] **Step 2: Write failing config tests**

Create `tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";

const baseEnv = {
  NODE_ENV: "test",
  TZ: "Asia/Seoul",
  LOG_LEVEL: "silent",
  NAVER_API_MODE: "mock",
  ALLOW_LIVE_NAVER_API: "false",
  NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
  SYNC_CRON: "*/5 * * * *",
  STORE_A_NAME: "Store A",
  STORE_A_BASE_URL: "https://example.com/store-a",
  STORE_A_CLIENT_ID: "store-a-client",
  STORE_A_CLIENT_SECRET: "store-a-secret",
  STORE_A_ACCOUNT_ID: "store-a-account",
  STORE_B_NAME: "Store B",
  STORE_B_BASE_URL: "https://example.com/store-b",
  STORE_B_CLIENT_ID: "store-b-client",
  STORE_B_CLIENT_SECRET: "store-b-secret",
  STORE_B_ACCOUNT_ID: "store-b-account",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
};

describe("loadEnv", () => {
  it("loads mock mode without live permission", () => {
    const env = loadEnv(baseEnv);

    expect(env.naverApiMode).toBe("mock");
    expect(env.allowLiveNaverApi).toBe(false);
  });

  it("rejects live mode unless explicitly allowed", () => {
    expect(() =>
      loadEnv({ ...baseEnv, NAVER_API_MODE: "live", ALLOW_LIVE_NAVER_API: "false" }),
    ).toThrow("Live Naver API mode requires ALLOW_LIVE_NAVER_API=true");
  });
});

describe("loadStores", () => {
  it("builds two store configs", () => {
    const stores = loadStores(loadEnv(baseEnv));

    expect(stores).toHaveLength(2);
    expect(stores.map((store) => store.storeKey)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/redact.test.ts tests/unit/config.test.ts
```

Expected: FAIL because `src/logging/redact.ts`, `src/config/env.ts`, and `src/config/stores.ts` do not exist.

- [ ] **Step 4: Implement redaction helper**

Create `src/logging/redact.ts`:

```ts
export function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("[REDACTED]"), message);
}
```

- [ ] **Step 5: Implement environment loader**

Create `src/config/env.ts`:

```ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  TZ: z.string().default("Asia/Seoul"),
  LOG_LEVEL: z.string().default("info"),
  NAVER_API_MODE: z.enum(["mock", "live"]).default("mock"),
  ALLOW_LIVE_NAVER_API: z.enum(["true", "false"]).default("false"),
  NAVER_API_BASE_URL: z.string().url().default("https://api.commerce.naver.com/external"),
  SYNC_CRON: z.string().default("*/5 * * * *"),
  STORE_A_NAME: z.string().min(1),
  STORE_A_BASE_URL: z.string().url(),
  STORE_A_CLIENT_ID: z.string().min(1),
  STORE_A_CLIENT_SECRET: z.string().min(1),
  STORE_A_ACCOUNT_ID: z.string().min(1),
  STORE_B_NAME: z.string().min(1),
  STORE_B_BASE_URL: z.string().url(),
  STORE_B_CLIENT_ID: z.string().min(1),
  STORE_B_CLIENT_SECRET: z.string().min(1),
  STORE_B_ACCOUNT_ID: z.string().min(1),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
});

export type AppEnv = {
  nodeEnv: string;
  timezone: string;
  logLevel: string;
  naverApiMode: "mock" | "live";
  allowLiveNaverApi: boolean;
  naverApiBaseUrl: string;
  syncCron: string;
  googleSheetsSpreadsheetId: string;
  googleApplicationCredentials: string | undefined;
  googleServiceAccountJsonBase64: string | undefined;
  raw: z.infer<typeof EnvSchema>;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.parse(source);
  const allowLiveNaverApi = parsed.ALLOW_LIVE_NAVER_API === "true";

  if (parsed.NAVER_API_MODE === "live" && !allowLiveNaverApi) {
    throw new Error("Live Naver API mode requires ALLOW_LIVE_NAVER_API=true");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    timezone: parsed.TZ,
    logLevel: parsed.LOG_LEVEL,
    naverApiMode: parsed.NAVER_API_MODE,
    allowLiveNaverApi,
    naverApiBaseUrl: parsed.NAVER_API_BASE_URL,
    syncCron: parsed.SYNC_CRON,
    googleSheetsSpreadsheetId: parsed.GOOGLE_SHEETS_SPREADSHEET_ID,
    googleApplicationCredentials: parsed.GOOGLE_APPLICATION_CREDENTIALS,
    googleServiceAccountJsonBase64: parsed.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,
    raw: parsed,
  };
}
```

- [ ] **Step 6: Implement store loader**

Create `src/config/stores.ts`:

```ts
import type { AppEnv } from "./env.js";

export type StoreKey = "A" | "B";

export type StoreConfig = {
  storeKey: StoreKey;
  storeName: string;
  storeBaseUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
};

export function loadStores(env: AppEnv): StoreConfig[] {
  return [
    {
      storeKey: "A",
      storeName: env.raw.STORE_A_NAME,
      storeBaseUrl: env.raw.STORE_A_BASE_URL,
      clientId: env.raw.STORE_A_CLIENT_ID,
      clientSecret: env.raw.STORE_A_CLIENT_SECRET,
      accountId: env.raw.STORE_A_ACCOUNT_ID,
    },
    {
      storeKey: "B",
      storeName: env.raw.STORE_B_NAME,
      storeBaseUrl: env.raw.STORE_B_BASE_URL,
      clientId: env.raw.STORE_B_CLIENT_ID,
      clientSecret: env.raw.STORE_B_CLIENT_SECRET,
      accountId: env.raw.STORE_B_ACCOUNT_ID,
    },
  ];
}
```

- [ ] **Step 7: Verify tests pass**

Run:

```bash
pnpm vitest run tests/unit/redact.test.ts tests/unit/config.test.ts
```

Expected: PASS for all redaction and config tests.

- [ ] **Step 8: Commit config layer**

```bash
git add src/config/env.ts src/config/stores.ts src/logging/redact.ts tests/unit/config.test.ts tests/unit/redact.test.ts
git commit -m "Add runtime config validation"
```

---

### Task 3: Plate Normalization And Extraction

**Files:**

- Create: `src/domain/plate/types.ts`
- Create: `src/domain/plate/normalize.ts`
- Create: `src/domain/plate/extract.ts`
- Test: `tests/unit/plate.test.ts`

- [ ] **Step 1: Write failing plate tests**

Create `tests/unit/plate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractPlateFromHtml } from "../../src/domain/plate/extract.js";
import { normalizePlateCandidate } from "../../src/domain/plate/normalize.js";

describe("normalizePlateCandidate", () => {
  it("removes spaces and separators", () => {
    expect(normalizePlateCandidate("123 가 4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123-가-4567")).toBe("123가4567");
    expect(normalizePlateCandidate("123 | 가 | 4567")).toBe("123가4567");
  });
});

describe("extractPlateFromHtml", () => {
  it("extracts a label-near plate", () => {
    const result = extractPlateFromHtml("<p>차량번호 123 가 4567</p>");

    expect(result).toEqual({
      status: "success",
      rawPlate: "123 가 4567",
      normalizedPlate: "123가4567",
      candidates: ["123가4567"],
    });
  });

  it("extracts a table-form plate", () => {
    const result = extractPlateFromHtml(
      "<table><tr><th>차량번호</th><td>123-가-4567</td></tr></table>",
    );

    expect(result.status).toBe("success");
    expect(result.normalizedPlate).toBe("123가4567");
  });

  it("returns not_found when only image content exists", () => {
    const result = extractPlateFromHtml(
      '<p>상세 이미지를 확인하세요.</p><img src="plate.jpg" alt="차량 사진">',
    );

    expect(result).toEqual({
      status: "not_found",
      candidates: [],
      message: "No text vehicle plate candidate found",
    });
  });

  it("returns ambiguous for multiple different valid plates", () => {
    const result = extractPlateFromHtml("<p>차량번호 123가4567</p><p>이전번호 234나5678</p>");

    expect(result).toEqual({
      status: "ambiguous",
      candidates: ["123가4567", "234나5678"],
      message: "Multiple different vehicle plate candidates found",
    });
  });

  it("returns invalid_format when a label-near value is malformed", () => {
    const result = extractPlateFromHtml("<p>차량번호 12가456</p>");

    expect(result).toEqual({
      status: "invalid_format",
      rawPlate: "12가456",
      candidates: [],
      message: "Label-near vehicle plate value did not match supported format",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/plate.test.ts
```

Expected: FAIL because plate modules do not exist.

- [ ] **Step 3: Define plate result types**

Create `src/domain/plate/types.ts`:

```ts
export type PlateExtractionStatus = "success" | "not_found" | "invalid_format" | "ambiguous";

export type PlateExtractionResult =
  | {
      status: "success";
      rawPlate: string;
      normalizedPlate: string;
      candidates: string[];
    }
  | {
      status: "not_found";
      candidates: string[];
      message: string;
    }
  | {
      status: "invalid_format";
      rawPlate: string;
      candidates: string[];
      message: string;
    }
  | {
      status: "ambiguous";
      candidates: string[];
      message: string;
    };
```

- [ ] **Step 4: Implement normalization**

Create `src/domain/plate/normalize.ts`:

```ts
const SUPPORTED_PLATE_PATTERN = /^[0-9]{2,3}[가-힣][0-9]{4}$/u;

export function normalizePlateCandidate(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\-_.:|/\\]+/gu, "")
    .trim();
}

export function isSupportedPlate(value: string): boolean {
  return SUPPORTED_PLATE_PATTERN.test(normalizePlateCandidate(value));
}
```

- [ ] **Step 5: Implement extractor**

Create `src/domain/plate/extract.ts`:

```ts
import * as cheerio from "cheerio";
import he from "he";
import type { PlateExtractionResult } from "./types.js";
import { isSupportedPlate, normalizePlateCandidate } from "./normalize.js";

const LABELS = ["차량번호", "차번", "등록번호", "자동차번호"];
const PLATE_PATTERN = /[0-9]{2,3}[\s\-_.:|/\\]*[가-힣][\s\-_.:|/\\]*[0-9]{4}/gu;
const LABEL_NEAR_PATTERN = new RegExp(
  `(?:${LABELS.join("|")})\\s*[:：|\\-]?\\s*([0-9]{1,4}[\\s\\-_.:|/\\\\]*[가-힣]?[\\s\\-_.:|/\\\\]*[0-9]{1,5})`,
  "u",
);

export function extractPlateFromHtml(html: string): PlateExtractionResult {
  const text = htmlToText(html);
  const labelNear = LABEL_NEAR_PATTERN.exec(text);

  if (labelNear?.[1]) {
    const rawPlate = labelNear[1].trim();
    const normalizedPlate = normalizePlateCandidate(rawPlate);

    if (!isSupportedPlate(normalizedPlate)) {
      return {
        status: "invalid_format",
        rawPlate,
        candidates: [],
        message: "Label-near vehicle plate value did not match supported format",
      };
    }
  }

  const matches = Array.from(text.matchAll(PLATE_PATTERN), (match) => match[0].trim());
  const normalizedCandidates = unique(
    matches.map(normalizePlateCandidate).filter(isSupportedPlate),
  );

  if (normalizedCandidates.length === 0) {
    return {
      status: "not_found",
      candidates: [],
      message: "No text vehicle plate candidate found",
    };
  }

  if (normalizedCandidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: normalizedCandidates,
      message: "Multiple different vehicle plate candidates found",
    };
  }

  const normalizedPlate = normalizedCandidates[0];
  const rawPlate = matches.find(
    (candidate) => normalizePlateCandidate(candidate) === normalizedPlate,
  );

  if (!normalizedPlate || !rawPlate) {
    return {
      status: "not_found",
      candidates: [],
      message: "No text vehicle plate candidate found",
    };
  }

  return {
    status: "success",
    rawPlate,
    normalizedPlate,
    candidates: normalizedCandidates,
  };
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return he.decode($.root().text()).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
```

- [ ] **Step 6: Verify plate tests pass**

Run:

```bash
pnpm vitest run tests/unit/plate.test.ts
```

Expected: PASS for all plate tests.

- [ ] **Step 7: Commit plate extraction**

```bash
git add src/domain/plate tests/unit/plate.test.ts
git commit -m "Add vehicle plate extraction"
```

---

### Task 4: Duplicate Analyzer

**Files:**

- Create: `src/domain/duplicates/types.ts`
- Create: `src/domain/duplicates/analyze.ts`
- Test: `tests/unit/duplicates.test.ts`

- [ ] **Step 1: Write failing duplicate tests**

Create `tests/unit/duplicates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzeDuplicates } from "../../src/domain/duplicates/analyze.js";
import type { ProductRecord } from "../../src/domain/duplicates/types.js";

const base: Pick<ProductRecord, "productName" | "extractionStatus"> = {
  productName: "product",
  extractionStatus: "success",
};

describe("analyzeDuplicates", () => {
  it("marks unique rows", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "2", normalizedPlate: "234나5678" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual(["unique", "unique"]);
  });

  it("marks same-store duplicates", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "A", channelProductNo: "2", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_in_same_store",
      "duplicated_in_same_store",
    ]);
  });

  it("marks cross-store duplicates", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "2", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_across_stores",
      "duplicated_across_stores",
    ]);
  });

  it("marks rows that are duplicated both ways", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      { ...base, storeKey: "A", channelProductNo: "2", normalizedPlate: "123가4567" },
      { ...base, storeKey: "B", channelProductNo: "3", normalizedPlate: "123가4567" },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual([
      "duplicated_both",
      "duplicated_both",
      "duplicated_across_stores",
    ]);
  });

  it("ignores extraction failures", () => {
    const rows: ProductRecord[] = [
      { ...base, storeKey: "A", channelProductNo: "1", normalizedPlate: "123가4567" },
      {
        productName: "failure",
        storeKey: "B",
        channelProductNo: "2",
        extractionStatus: "not_found",
      },
    ];

    expect(analyzeDuplicates(rows).map((row) => row.duplicateStatus)).toEqual(["unique", "unique"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/duplicates.test.ts
```

Expected: FAIL because duplicate modules do not exist.

- [ ] **Step 3: Define duplicate types**

Create `src/domain/duplicates/types.ts`:

```ts
import type { PlateExtractionStatus } from "../plate/types.js";

export type DuplicateStatus =
  "unique" | "duplicated_in_same_store" | "duplicated_across_stores" | "duplicated_both";

export type ProductRecord = {
  storeKey: "A" | "B";
  channelProductNo: string;
  productName: string;
  extractionStatus: PlateExtractionStatus;
  normalizedPlate?: string | undefined;
};

export type ProductRecordWithDuplicateStatus = ProductRecord & {
  duplicateStatus: DuplicateStatus;
};
```

- [ ] **Step 4: Implement duplicate analyzer**

Create `src/domain/duplicates/analyze.ts`:

```ts
import type { ProductRecord, ProductRecordWithDuplicateStatus } from "./types.js";

export function analyzeDuplicates(
  rows: readonly ProductRecord[],
): ProductRecordWithDuplicateStatus[] {
  const plateGroups = groupSuccessfulRowsByPlate(rows);

  return rows.map((row) => {
    const plate = row.normalizedPlate;

    if (row.extractionStatus !== "success" || !plate) {
      return { ...row, duplicateStatus: "unique" };
    }

    const samePlateRows = plateGroups.get(plate) ?? [];
    const sameStoreCount = samePlateRows.filter(
      (candidate) => candidate.storeKey === row.storeKey,
    ).length;
    const storeCount = new Set(samePlateRows.map((candidate) => candidate.storeKey)).size;

    const duplicatedInSameStore = sameStoreCount > 1;
    const duplicatedAcrossStores = storeCount > 1;

    if (duplicatedInSameStore && duplicatedAcrossStores) {
      return { ...row, duplicateStatus: "duplicated_both" };
    }

    if (duplicatedInSameStore) {
      return { ...row, duplicateStatus: "duplicated_in_same_store" };
    }

    if (duplicatedAcrossStores) {
      return { ...row, duplicateStatus: "duplicated_across_stores" };
    }

    return { ...row, duplicateStatus: "unique" };
  });
}

function groupSuccessfulRowsByPlate(rows: readonly ProductRecord[]): Map<string, ProductRecord[]> {
  const groups = new Map<string, ProductRecord[]>();

  for (const row of rows) {
    if (row.extractionStatus !== "success" || !row.normalizedPlate) {
      continue;
    }

    const existing = groups.get(row.normalizedPlate) ?? [];
    existing.push(row);
    groups.set(row.normalizedPlate, existing);
  }

  return groups;
}
```

- [ ] **Step 5: Verify duplicate tests pass**

Run:

```bash
pnpm vitest run tests/unit/duplicates.test.ts
```

Expected: PASS for all duplicate tests.

- [ ] **Step 6: Commit duplicate analyzer**

```bash
git add src/domain/duplicates tests/unit/duplicates.test.ts
git commit -m "Add duplicate analysis"
```

---

### Task 5: Mock Naver Client And Fixtures

**Files:**

- Create: `src/naver/types.ts`
- Create: `src/naver/mock-client.ts`
- Create: `tests/fixtures/naver/store-a-products.json`
- Create: `tests/fixtures/naver/store-b-products.json`
- Create: `tests/fixtures/naver/details.json`

- [ ] **Step 1: Create Naver DTO and client interface**

Create `src/naver/types.ts`:

```ts
import { z } from "zod";
import type { StoreConfig } from "../config/stores.js";

export const NaverProductSummarySchema = z.object({
  originProductNo: z.string(),
  channelProductNo: z.string(),
  productName: z.string(),
  productStatus: z.string(),
  displayStatus: z.string().optional(),
});

export const NaverProductDetailSchema = NaverProductSummarySchema.extend({
  detailContent: z.string(),
});

export const DetailFixtureSchema = z.record(z.string());

export type NaverProductSummary = z.infer<typeof NaverProductSummarySchema>;
export type NaverProductDetail = z.infer<typeof NaverProductDetailSchema>;

export type NaverCommerceClient = {
  searchProducts(store: StoreConfig): Promise<NaverProductSummary[]>;
  getProductDetail(store: StoreConfig, channelProductNo: string): Promise<NaverProductDetail>;
};
```

- [ ] **Step 2: Create Store A fixture**

Create `tests/fixtures/naver/store-a-products.json`:

```json
[
  {
    "originProductNo": "1001",
    "channelProductNo": "2001",
    "productName": "Store A bucket truck",
    "productStatus": "SALE",
    "displayStatus": "ON"
  },
  {
    "originProductNo": "1002",
    "channelProductNo": "2002",
    "productName": "Store A duplicate truck",
    "productStatus": "SUSPENSION",
    "displayStatus": "SUSPENSION"
  },
  {
    "originProductNo": "1003",
    "channelProductNo": "2003",
    "productName": "Store A image only truck",
    "productStatus": "OUTOFSTOCK",
    "displayStatus": "ON"
  }
]
```

- [ ] **Step 3: Create Store B fixture**

Create `tests/fixtures/naver/store-b-products.json`:

```json
[
  {
    "originProductNo": "3001",
    "channelProductNo": "4001",
    "productName": "Store B same truck",
    "productStatus": "CLOSE",
    "displayStatus": "SUSPENSION"
  },
  {
    "originProductNo": "3002",
    "channelProductNo": "4002",
    "productName": "Store B unique truck",
    "productStatus": "WAIT",
    "displayStatus": "WAIT"
  }
]
```

- [ ] **Step 4: Create detail fixture**

Create `tests/fixtures/naver/details.json`:

```json
{
  "2001": "<table><tr><th>차량번호</th><td>123 가 4567</td></tr></table>",
  "2002": "<p>차량번호 123-가-4567</p>",
  "2003": "<p>상세 이미지를 확인하세요.</p><img src=\"vehicle.jpg\" alt=\"차량 사진\">",
  "4001": "<p>차량번호 123가4567</p>",
  "4002": "<p>차량번호 234나5678</p>"
}
```

- [ ] **Step 5: Implement mock client**

Create `src/naver/mock-client.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreConfig } from "../config/stores.js";
import {
  DetailFixtureSchema,
  NaverProductSummarySchema,
  type NaverCommerceClient,
  type NaverProductDetail,
  type NaverProductSummary,
} from "./types.js";

export class MockNaverCommerceClient implements NaverCommerceClient {
  constructor(private readonly fixtureRoot = "tests/fixtures/naver") {}

  async searchProducts(store: StoreConfig): Promise<NaverProductSummary[]> {
    const filename = store.storeKey === "A" ? "store-a-products.json" : "store-b-products.json";
    const content = await this.readJson(filename);
    return NaverProductSummarySchema.array().parse(content);
  }

  async getProductDetail(
    store: StoreConfig,
    channelProductNo: string,
  ): Promise<NaverProductDetail> {
    const summaries = await this.searchProducts(store);
    const summary = summaries.find((product) => product.channelProductNo === channelProductNo);

    if (!summary) {
      throw new Error(`Mock product not found: ${store.storeKey}/${channelProductNo}`);
    }

    const details = DetailFixtureSchema.parse(await this.readJson("details.json"));
    const detailContent = details[channelProductNo];

    if (!detailContent) {
      throw new Error(`Mock detail not found: ${channelProductNo}`);
    }

    return {
      ...summary,
      detailContent,
    };
  }

  private async readJson(filename: string): Promise<unknown> {
    const path = join(this.fixtureRoot, filename);
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  }
}
```

- [ ] **Step 6: Verify TypeScript build**

Run:

```bash
pnpm build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit mock Naver client**

```bash
git add src/naver tests/fixtures/naver
git commit -m "Add mock Naver client fixtures"
```

---

### Task 6: Sheet Repository Interfaces And In-Memory Adapter

**Files:**

- Create: `src/sheets/types.ts`
- Create: `src/sheets/columns.ts`
- Create: `src/sheets/in-memory-repository.ts`

- [ ] **Step 1: Define sheet interfaces**

Create `src/sheets/types.ts`:

```ts
import type { DuplicateStatus } from "../domain/duplicates/types.js";
import type { PlateExtractionStatus } from "../domain/plate/types.js";

export type SheetProductRow = {
  storeKey: "A" | "B";
  storeName: string;
  storeBaseUrl: string;
  channelProductNo: string;
  originProductNo: string;
  productUrl: string;
  productName: string;
  productStatus: string;
  displayStatus: string;
  rawPlate: string;
  normalizedPlate: string;
  extractionStatus: PlateExtractionStatus;
  duplicateStatus: DuplicateStatus;
  firstSeenAt: string;
  lastSyncedAt: string;
  lastErrorAt: string;
  errorMessage: string;
  detailContentHash: string;
  detailTextSnippet: string;
  apiTraceId: string;
  manualNote: string;
};

export type RunLogRow = {
  runStartedAt: string;
  runFinishedAt: string;
  mode: "mock" | "live";
  totalProducts: number;
  successCount: number;
  failureCount: number;
  duplicateCount: number;
  message: string;
};

export type SheetRepository = {
  readRawData(): Promise<SheetProductRow[]>;
  writeRawData(rows: SheetProductRow[]): Promise<void>;
  writeViews(rows: SheetProductRow[]): Promise<void>;
  appendRunLog(row: RunLogRow): Promise<void>;
};
```

- [ ] **Step 2: Define columns and row conversion**

Create `src/sheets/columns.ts`:

```ts
import type { SheetProductRow } from "./types.js";

export type RawDataColumn = keyof SheetProductRow;

export const RAW_DATA_COLUMNS: RawDataColumn[] = [
  "storeKey",
  "storeName",
  "storeBaseUrl",
  "channelProductNo",
  "originProductNo",
  "productUrl",
  "productName",
  "productStatus",
  "displayStatus",
  "rawPlate",
  "normalizedPlate",
  "extractionStatus",
  "duplicateStatus",
  "firstSeenAt",
  "lastSyncedAt",
  "lastErrorAt",
  "errorMessage",
  "detailContentHash",
  "detailTextSnippet",
  "apiTraceId",
  "manualNote",
];

export function sheetProductRowToValues(row: SheetProductRow): string[] {
  return RAW_DATA_COLUMNS.map((column) => String(row[column] ?? ""));
}

export function valuesToSheetProductRow(values: readonly string[]): SheetProductRow {
  const value = (column: RawDataColumn): string => {
    const index = RAW_DATA_COLUMNS.indexOf(column);
    return values[index] ?? "";
  };

  return {
    storeKey: value("storeKey") === "B" ? "B" : "A",
    storeName: value("storeName"),
    storeBaseUrl: value("storeBaseUrl"),
    channelProductNo: value("channelProductNo"),
    originProductNo: value("originProductNo"),
    productUrl: value("productUrl"),
    productName: value("productName"),
    productStatus: value("productStatus"),
    displayStatus: value("displayStatus"),
    rawPlate: value("rawPlate"),
    normalizedPlate: value("normalizedPlate"),
    extractionStatus: parseExtractionStatus(value("extractionStatus")),
    duplicateStatus: parseDuplicateStatus(value("duplicateStatus")),
    firstSeenAt: value("firstSeenAt"),
    lastSyncedAt: value("lastSyncedAt"),
    lastErrorAt: value("lastErrorAt"),
    errorMessage: value("errorMessage"),
    detailContentHash: value("detailContentHash"),
    detailTextSnippet: value("detailTextSnippet"),
    apiTraceId: value("apiTraceId"),
    manualNote: value("manualNote"),
  };
}

function parseExtractionStatus(value: string): SheetProductRow["extractionStatus"] {
  if (
    value === "success" ||
    value === "not_found" ||
    value === "invalid_format" ||
    value === "ambiguous"
  ) {
    return value;
  }

  return "not_found";
}

function parseDuplicateStatus(value: string): SheetProductRow["duplicateStatus"] {
  if (
    value === "unique" ||
    value === "duplicated_in_same_store" ||
    value === "duplicated_across_stores" ||
    value === "duplicated_both"
  ) {
    return value;
  }

  return "unique";
}
```

- [ ] **Step 3: Implement in-memory repository**

Create `src/sheets/in-memory-repository.ts`:

```ts
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

export class InMemorySheetRepository implements SheetRepository {
  rawRows: SheetProductRow[] = [];
  viewRows: Record<string, SheetProductRow[]> = {};
  runLogs: RunLogRow[] = [];

  async readRawData(): Promise<SheetProductRow[]> {
    return structuredClone(this.rawRows);
  }

  async writeRawData(rows: SheetProductRow[]): Promise<void> {
    this.rawRows = structuredClone(rows);
  }

  async writeViews(rows: SheetProductRow[]): Promise<void> {
    this.viewRows = {
      A_Store_View: rows.filter((row) => row.storeKey === "A" && row.productStatus !== "DELETE"),
      B_Store_View: rows.filter((row) => row.storeKey === "B" && row.productStatus !== "DELETE"),
      Across_Stores_Duplicates: rows.filter(
        (row) =>
          row.duplicateStatus === "duplicated_across_stores" ||
          row.duplicateStatus === "duplicated_both",
      ),
      Same_Store_Duplicates: rows.filter(
        (row) =>
          row.duplicateStatus === "duplicated_in_same_store" ||
          row.duplicateStatus === "duplicated_both",
      ),
      Extraction_Failures: rows.filter((row) => row.extractionStatus !== "success"),
    };
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    this.runLogs.push(structuredClone(row));
  }
}
```

- [ ] **Step 4: Verify TypeScript build**

Run:

```bash
pnpm build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit sheet interfaces**

```bash
git add src/sheets
git commit -m "Add sheet repository interfaces"
```

---

### Task 7: Sync Job With Mock End-To-End Test

**Files:**

- Create: `src/sync/sync-job.ts`
- Test: `tests/integration/sync-job.test.ts`

- [ ] **Step 1: Write failing sync integration test**

Create `tests/integration/sync-job.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { loadStores } from "../../src/config/stores.js";
import { MockNaverCommerceClient } from "../../src/naver/mock-client.js";
import { InMemorySheetRepository } from "../../src/sheets/in-memory-repository.js";
import { runSyncJob } from "../../src/sync/sync-job.js";

const env = loadEnv({
  NODE_ENV: "test",
  TZ: "Asia/Seoul",
  LOG_LEVEL: "silent",
  NAVER_API_MODE: "mock",
  ALLOW_LIVE_NAVER_API: "false",
  NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
  SYNC_CRON: "*/5 * * * *",
  STORE_A_NAME: "Store A",
  STORE_A_BASE_URL: "https://example.com/store-a",
  STORE_A_CLIENT_ID: "store-a-client",
  STORE_A_CLIENT_SECRET: "store-a-secret",
  STORE_A_ACCOUNT_ID: "store-a-account",
  STORE_B_NAME: "Store B",
  STORE_B_BASE_URL: "https://example.com/store-b",
  STORE_B_CLIENT_ID: "store-b-client",
  STORE_B_CLIENT_SECRET: "store-b-secret",
  STORE_B_ACCOUNT_ID: "store-b-account",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
});

describe("runSyncJob", () => {
  it("syncs mock products into raw and view rows", async () => {
    const sheets = new InMemorySheetRepository();
    const result = await runSyncJob({
      env,
      stores: loadStores(env),
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(result.totalProducts).toBe(5);
    expect(result.successCount).toBe(4);
    expect(result.failureCount).toBe(1);
    expect(sheets.rawRows).toHaveLength(5);
    expect(sheets.viewRows.Extraction_Failures).toHaveLength(1);
    expect(sheets.viewRows.Across_Stores_Duplicates).toHaveLength(3);
    expect(sheets.runLogs).toHaveLength(1);
  });

  it("preserves firstSeenAt and manualNote during upsert", async () => {
    const sheets = new InMemorySheetRepository();
    sheets.rawRows = [
      {
        storeKey: "A",
        storeName: "Store A",
        storeBaseUrl: "https://example.com/store-a",
        channelProductNo: "2001",
        originProductNo: "1001",
        productUrl: "https://example.com/store-a/products/2001",
        productName: "old",
        productStatus: "SALE",
        displayStatus: "ON",
        rawPlate: "",
        normalizedPlate: "",
        extractionStatus: "not_found",
        duplicateStatus: "unique",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        lastErrorAt: "",
        errorMessage: "",
        detailContentHash: "",
        detailTextSnippet: "",
        apiTraceId: "",
        manualNote: "operator note",
      },
    ];

    await runSyncJob({
      env,
      stores: loadStores(env),
      naverClient: new MockNaverCommerceClient(),
      sheetRepository: sheets,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const row = sheets.rawRows.find((candidate) => candidate.channelProductNo === "2001");

    expect(row?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.manualNote).toBe("operator note");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run tests/integration/sync-job.test.ts
```

Expected: FAIL because `src/sync/sync-job.ts` does not exist.

- [ ] **Step 3: Implement sync job**

Create `src/sync/sync-job.ts`:

```ts
import { createHash } from "node:crypto";
import type { AppEnv } from "../config/env.js";
import type { StoreConfig } from "../config/stores.js";
import { analyzeDuplicates } from "../domain/duplicates/analyze.js";
import type { ProductRecord } from "../domain/duplicates/types.js";
import { extractPlateFromHtml } from "../domain/plate/extract.js";
import type { PlateExtractionResult } from "../domain/plate/types.js";
import type { NaverCommerceClient, NaverProductDetail } from "../naver/types.js";
import type { SheetProductRow, SheetRepository } from "../sheets/types.js";

export type SyncJobDependencies = {
  env: AppEnv;
  stores: StoreConfig[];
  naverClient: NaverCommerceClient;
  sheetRepository: SheetRepository;
  now: () => Date;
};

export type SyncJobResult = {
  totalProducts: number;
  successCount: number;
  failureCount: number;
  duplicateCount: number;
};

export async function runSyncJob(dependencies: SyncJobDependencies): Promise<SyncJobResult> {
  const runStartedAt = dependencies.now().toISOString();
  const existingRows = await dependencies.sheetRepository.readRawData();
  const existingByKey = new Map(
    existingRows.map((row) => [rowKey(row.storeKey, row.channelProductNo), row]),
  );
  const syncedRows: SheetProductRow[] = [];

  for (const store of dependencies.stores) {
    const summaries = await dependencies.naverClient.searchProducts(store);
    const nonDeletedSummaries = summaries.filter((summary) => summary.productStatus !== "DELETE");

    for (const summary of nonDeletedSummaries) {
      const existing = existingByKey.get(rowKey(store.storeKey, summary.channelProductNo));
      const detail = await dependencies.naverClient.getProductDetail(
        store,
        summary.channelProductNo,
      );
      const mergedDetail = {
        ...detail,
        originProductNo: detail.originProductNo || summary.originProductNo,
        productName: detail.productName || summary.productName,
        productStatus: detail.productStatus || summary.productStatus,
        displayStatus: detail.displayStatus || summary.displayStatus,
      };
      const extraction = extractPlateFromHtml(mergedDetail.detailContent);

      syncedRows.push(
        toSheetRow({
          store,
          detail: mergedDetail,
          extraction,
          existing,
          syncedAt: runStartedAt,
        }),
      );
    }
  }

  const rowsWithDuplicates = applyDuplicateStatus(syncedRows);
  const result = summarize(rowsWithDuplicates);
  const runFinishedAt = dependencies.now().toISOString();

  await dependencies.sheetRepository.writeRawData(rowsWithDuplicates);
  await dependencies.sheetRepository.writeViews(rowsWithDuplicates);
  await dependencies.sheetRepository.appendRunLog({
    runStartedAt,
    runFinishedAt,
    mode: dependencies.env.naverApiMode,
    totalProducts: result.totalProducts,
    successCount: result.successCount,
    failureCount: result.failureCount,
    duplicateCount: result.duplicateCount,
    message: "Sync completed",
  });

  return result;
}

function toSheetRow(input: {
  store: StoreConfig;
  detail: NaverProductDetail;
  extraction: PlateExtractionResult;
  existing: SheetProductRow | undefined;
  syncedAt: string;
}): SheetProductRow {
  const productUrl = `${input.store.storeBaseUrl.replace(/\/$/u, "")}/products/${input.detail.channelProductNo}`;
  const success = input.extraction.status === "success";

  return {
    storeKey: input.store.storeKey,
    storeName: input.store.storeName,
    storeBaseUrl: input.store.storeBaseUrl,
    channelProductNo: input.detail.channelProductNo,
    originProductNo: input.detail.originProductNo,
    productUrl,
    productName: input.detail.productName,
    productStatus: input.detail.productStatus,
    displayStatus: input.detail.displayStatus ?? "",
    rawPlate: success
      ? input.extraction.rawPlate
      : "rawPlate" in input.extraction
        ? input.extraction.rawPlate
        : "",
    normalizedPlate: success ? input.extraction.normalizedPlate : "",
    extractionStatus: input.extraction.status,
    duplicateStatus: "unique",
    firstSeenAt: input.existing?.firstSeenAt || input.syncedAt,
    lastSyncedAt: input.syncedAt,
    lastErrorAt: success ? "" : input.syncedAt,
    errorMessage: success ? "" : input.extraction.message,
    detailContentHash: sha256(input.detail.detailContent),
    detailTextSnippet: input.detail.detailContent
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120),
    apiTraceId: "",
    manualNote: input.existing?.manualNote ?? "",
  };
}

function applyDuplicateStatus(rows: SheetProductRow[]): SheetProductRow[] {
  const duplicateInput: ProductRecord[] = rows.map((row) => ({
    storeKey: row.storeKey,
    channelProductNo: row.channelProductNo,
    productName: row.productName,
    extractionStatus: row.extractionStatus,
    normalizedPlate: row.normalizedPlate || undefined,
  }));

  const analyzed = analyzeDuplicates(duplicateInput);
  const statusByKey = new Map(
    analyzed.map((row) => [rowKey(row.storeKey, row.channelProductNo), row.duplicateStatus]),
  );

  return rows.map((row) => ({
    ...row,
    duplicateStatus: statusByKey.get(rowKey(row.storeKey, row.channelProductNo)) ?? "unique",
  }));
}

function summarize(rows: readonly SheetProductRow[]): SyncJobResult {
  return {
    totalProducts: rows.length,
    successCount: rows.filter((row) => row.extractionStatus === "success").length,
    failureCount: rows.filter((row) => row.extractionStatus !== "success").length,
    duplicateCount: rows.filter((row) => row.duplicateStatus !== "unique").length,
  };
}

function rowKey(storeKey: string, channelProductNo: string): string {
  return `${storeKey}:${channelProductNo}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 4: Verify sync test passes**

Run:

```bash
pnpm vitest run tests/integration/sync-job.test.ts
```

Expected: PASS for both sync tests.

- [ ] **Step 5: Run all current tests**

Run:

```bash
pnpm test:unit
pnpm test:integration
pnpm build
```

Expected: all tests and TypeScript build pass.

- [ ] **Step 6: Commit sync job**

```bash
git add src/sync tests/integration/sync-job.test.ts
git commit -m "Add mock sync job"
```

---

### Task 8: Naver Authentication And Live Client

**Files:**

- Create: `src/naver/auth.ts`
- Create: `src/naver/client.ts`
- Test: `tests/unit/naver-auth.test.ts`

- [ ] **Step 1: Write failing auth tests**

Create `tests/unit/naver-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createClientSecretSign, TokenCache } from "../../src/naver/auth.js";

describe("createClientSecretSign", () => {
  it("returns base64 bcrypt text", () => {
    const signature = createClientSecretSign({
      clientId: "aaaabbbbcccc",
      clientSecret: "$2a$04$abcdefghijklmnopqrstuu",
      timestamp: 1643961623299,
    });

    const decoded = Buffer.from(signature, "base64").toString("utf8");

    expect(decoded).toContain("$2a$04$");
    expect(decoded.length).toBeGreaterThan(20);
  });
});

describe("TokenCache", () => {
  it("returns cached token before safety window", () => {
    const cache = new TokenCache(() => 1_000_000);
    cache.set("A", { accessToken: "token", expiresIn: 300 });

    expect(cache.get("A")).toBe("token");
  });

  it("returns undefined after expiry safety window", () => {
    const cache = new TokenCache(() => 1_000_000);
    cache.set("A", { accessToken: "token", expiresIn: 30 });

    expect(cache.get("A")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run auth tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/naver-auth.test.ts
```

Expected: FAIL because `src/naver/auth.ts` does not exist.

- [ ] **Step 3: Implement auth helpers**

Create `src/naver/auth.ts`:

```ts
import bcrypt from "bcryptjs";

export type SignatureInput = {
  clientId: string;
  clientSecret: string;
  timestamp: number;
};

export type TokenResponse = {
  accessToken: string;
  expiresIn: number;
};

export function createClientSecretSign(input: SignatureInput): string {
  const password = `${input.clientId}_${input.timestamp}`;
  const hashed = bcrypt.hashSync(password, input.clientSecret);
  return Buffer.from(hashed, "utf8").toString("base64");
}

export class TokenCache {
  private readonly tokens = new Map<string, { accessToken: string; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get(storeKey: string): string | undefined {
    const cached = this.tokens.get(storeKey);

    if (!cached || cached.expiresAtMs <= this.nowMs()) {
      return undefined;
    }

    return cached.accessToken;
  }

  set(storeKey: string, response: TokenResponse): void {
    const safetyWindowSeconds = 60;
    const usableSeconds = Math.max(0, response.expiresIn - safetyWindowSeconds);
    this.tokens.set(storeKey, {
      accessToken: response.accessToken,
      expiresAtMs: this.nowMs() + usableSeconds * 1000,
    });
  }

  clear(storeKey: string): void {
    this.tokens.delete(storeKey);
  }
}
```

- [ ] **Step 4: Implement live Naver client**

Create `src/naver/client.ts`:

```ts
import pLimit from "p-limit";
import { z } from "zod";
import type { StoreConfig } from "../config/stores.js";
import { createClientSecretSign, TokenCache } from "./auth.js";
import type { NaverCommerceClient, NaverProductDetail, NaverProductSummary } from "./types.js";

type NaverClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenCache?: TokenCache;
};

const ProductSearchResponseSchema = z.object({
  contents: z
    .array(
      z.object({
        originProductNo: z.number().optional(),
        channelProducts: z
          .array(
            z.object({
              channelProductNo: z.number().optional(),
              name: z.string().optional(),
              channelProductName: z.string().optional(),
              statusType: z.string().optional(),
              channelProductDisplayStatusType: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  last: z.boolean().optional(),
  page: z.number().optional(),
  totalPages: z.number().optional(),
});

const ProductDetailResponseSchema = z.object({
  originProduct: z
    .object({
      name: z.string().optional(),
      detailContent: z.string().optional(),
      statusType: z.string().optional(),
    })
    .optional(),
  smartstoreChannelProduct: z
    .object({
      channelProductName: z.string().optional(),
      channelProductDisplayStatusType: z.string().optional(),
    })
    .optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const GatewayErrorSchema = z.object({
  code: z.string().optional(),
});

export class LiveNaverCommerceClient implements NaverCommerceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenCache: TokenCache;
  private readonly detailLimit = pLimit(3);

  constructor(private readonly options: NaverClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenCache = options.tokenCache ?? new TokenCache();
  }

  async searchProducts(store: StoreConfig): Promise<NaverProductSummary[]> {
    const products: NaverProductSummary[] = [];
    let page = 1;
    let last = false;

    while (!last) {
      const response = ProductSearchResponseSchema.parse(
        await this.request(store, "/v1/products/search", {
          method: "POST",
          body: JSON.stringify({
            page,
            size: 100,
            orderType: "NO",
          }),
        }),
      );

      for (const content of response.contents ?? []) {
        for (const channelProduct of content.channelProducts ?? []) {
          if (!channelProduct.channelProductNo) {
            continue;
          }

          products.push({
            originProductNo: String(content.originProductNo ?? ""),
            channelProductNo: String(channelProduct.channelProductNo),
            productName: channelProduct.channelProductName ?? channelProduct.name ?? "",
            productStatus: channelProduct.statusType ?? "",
            displayStatus: channelProduct.channelProductDisplayStatusType ?? "",
          });
        }
      }

      last = response.last ?? page >= (response.totalPages ?? page);
      page += 1;
    }

    return products.filter((product) => product.productStatus !== "DELETE");
  }

  async getProductDetail(
    store: StoreConfig,
    channelProductNo: string,
  ): Promise<NaverProductDetail> {
    return this.detailLimit(async () => {
      const response = await this.request(
        store,
        `/v2/products/channel-products/${channelProductNo}`,
        { method: "GET" },
      );
      const parsed = ProductDetailResponseSchema.parse(response);

      return {
        originProductNo: "",
        channelProductNo,
        productName:
          parsed.smartstoreChannelProduct?.channelProductName ?? parsed.originProduct?.name ?? "",
        productStatus: parsed.originProduct?.statusType ?? "",
        displayStatus: parsed.smartstoreChannelProduct?.channelProductDisplayStatusType ?? "",
        detailContent: parsed.originProduct?.detailContent ?? "",
      };
    });
  }

  private async request(store: StoreConfig, path: string, init: RequestInit): Promise<unknown> {
    const firstToken = await this.getAccessToken(store);
    const firstResponse = await this.fetchJson(path, firstToken, init);

    if (firstResponse.authExpired) {
      this.tokenCache.clear(store.storeKey);
      const refreshedToken = await this.getAccessToken(store);
      const secondResponse = await this.fetchJson(path, refreshedToken, init);

      if (secondResponse.authExpired) {
        throw new Error(`Naver API authentication failed after refresh: ${path}`);
      }

      return secondResponse.body;
    }

    return firstResponse.body;
  }

  private async getAccessToken(store: StoreConfig): Promise<string> {
    const cached = this.tokenCache.get(store.storeKey);

    if (cached) {
      return cached;
    }

    const timestamp = Date.now();
    const response = await this.fetchImpl(`${this.options.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: store.clientId,
        timestamp,
        grant_type: "client_credentials",
        client_secret_sign: createClientSecretSign({
          clientId: store.clientId,
          clientSecret: store.clientSecret,
          timestamp,
        }),
        type: "SELLER",
        account_id: store.accountId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Naver token request failed with HTTP ${response.status}`);
    }

    const body = TokenResponseSchema.parse(await response.json());

    this.tokenCache.set(store.storeKey, {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
    });

    return body.access_token;
  }

  private async fetchJson(
    path: string,
    accessToken: string,
    init: RequestInit,
  ): Promise<{ body: unknown; authExpired: boolean }> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 401) {
      const body = GatewayErrorSchema.parse(await response.json().catch(() => ({})));
      return { body: {}, authExpired: body.code === "GW.AUTHN" };
    }

    if (response.status === 429) {
      throw new Error(`Naver API rate limit exceeded for ${path}`);
    }

    if (!response.ok) {
      throw new Error(`Naver API request failed for ${path} with HTTP ${response.status}`);
    }

    return { body: await response.json(), authExpired: false };
  }
}
```

- [ ] **Step 5: Verify auth tests and build pass**

Run:

```bash
pnpm vitest run tests/unit/naver-auth.test.ts
pnpm build
```

Expected: auth tests and TypeScript build pass.

- [ ] **Step 6: Commit live Naver client**

```bash
git add src/naver/auth.ts src/naver/client.ts tests/unit/naver-auth.test.ts
git commit -m "Add Naver Commerce API client"
```

---

### Task 9: Google Sheets Repository

**Files:**

- Create: `src/sheets/google-repository.ts`

- [ ] **Step 1: Implement Google repository**

Create `src/sheets/google-repository.ts`:

```ts
import { google, sheets_v4 } from "googleapis";
import { RAW_DATA_COLUMNS, sheetProductRowToValues, valuesToSheetProductRow } from "./columns.js";
import type { RunLogRow, SheetProductRow, SheetRepository } from "./types.js";

const TAB_NAMES = {
  raw: "RawData",
  storeA: "A_Store_View",
  storeB: "B_Store_View",
  acrossStores: "Across_Stores_Duplicates",
  sameStore: "Same_Store_Duplicates",
  failures: "Extraction_Failures",
  runLog: "RunLog",
};

export class GoogleSheetRepository implements SheetRepository {
  private readonly sheets: sheets_v4.Sheets;

  constructor(private readonly spreadsheetId: string) {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  async readRawData(): Promise<SheetProductRow[]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${TAB_NAMES.raw}!A2:U`,
    });

    return (response.data.values ?? []).map((row) => valuesToSheetProductRow(row.map(String)));
  }

  async writeRawData(rows: SheetProductRow[]): Promise<void> {
    await this.replaceSheet(TAB_NAMES.raw, [
      Array.from(RAW_DATA_COLUMNS),
      ...rows.map(sheetProductRowToValues),
    ]);
  }

  async writeViews(rows: SheetProductRow[]): Promise<void> {
    await this.replaceSheet(
      TAB_NAMES.storeA,
      viewValues(rows.filter((row) => row.storeKey === "A" && row.productStatus !== "DELETE")),
    );
    await this.replaceSheet(
      TAB_NAMES.storeB,
      viewValues(rows.filter((row) => row.storeKey === "B" && row.productStatus !== "DELETE")),
    );
    await this.replaceSheet(
      TAB_NAMES.acrossStores,
      viewValues(
        rows.filter(
          (row) =>
            row.duplicateStatus === "duplicated_across_stores" ||
            row.duplicateStatus === "duplicated_both",
        ),
      ),
    );
    await this.replaceSheet(
      TAB_NAMES.sameStore,
      viewValues(
        rows.filter(
          (row) =>
            row.duplicateStatus === "duplicated_in_same_store" ||
            row.duplicateStatus === "duplicated_both",
        ),
      ),
    );
    await this.replaceSheet(
      TAB_NAMES.failures,
      viewValues(rows.filter((row) => row.extractionStatus !== "success")),
    );
  }

  async appendRunLog(row: RunLogRow): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${TAB_NAMES.runLog}!A:H`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            row.runStartedAt,
            row.runFinishedAt,
            row.mode,
            row.totalProducts,
            row.successCount,
            row.failureCount,
            row.duplicateCount,
            row.message,
          ],
        ],
      },
    });
  }

  private async replaceSheet(tabName: string, values: string[][]): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:Z`,
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }
}

function viewValues(rows: SheetProductRow[]): string[][] {
  return [Array.from(RAW_DATA_COLUMNS), ...rows.map(sheetProductRowToValues)];
}
```

- [ ] **Step 2: Verify build**

Run:

```bash
pnpm build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Commit Google Sheets repository**

```bash
git add src/sheets/google-repository.ts
git commit -m "Add Google Sheets repository"
```

---

### Task 10: CLI And Scheduler Entrypoints

**Files:**

- Create: `src/cli/sync-once.ts`
- Create: `src/scheduler/main.ts`

- [ ] **Step 1: Implement one-shot CLI**

Create `src/cli/sync-once.ts`:

```ts
import "dotenv/config";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { MockNaverCommerceClient } from "../naver/mock-client.js";
import { LiveNaverCommerceClient } from "../naver/client.js";
import { GoogleSheetRepository } from "../sheets/google-repository.js";
import { InMemorySheetRepository } from "../sheets/in-memory-repository.js";
import { runSyncJob } from "../sync/sync-job.js";

const env = loadEnv();
const logger = pino({ level: env.logLevel === "silent" ? "silent" : env.logLevel });
const stores = loadStores(env);
const naverClient =
  env.naverApiMode === "live"
    ? new LiveNaverCommerceClient({ baseUrl: env.naverApiBaseUrl })
    : new MockNaverCommerceClient();
const sheetRepository =
  env.naverApiMode === "live"
    ? new GoogleSheetRepository(env.googleSheetsSpreadsheetId)
    : new InMemorySheetRepository();

const result = await runSyncJob({
  env,
  stores,
  naverClient,
  sheetRepository,
  now: () => new Date(),
});

logger.info(result, "sync completed");
```

- [ ] **Step 2: Implement scheduler**

Create `src/scheduler/main.ts`:

```ts
import "dotenv/config";
import cron from "node-cron";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { loadStores } from "../config/stores.js";
import { LiveNaverCommerceClient } from "../naver/client.js";
import { MockNaverCommerceClient } from "../naver/mock-client.js";
import { GoogleSheetRepository } from "../sheets/google-repository.js";
import { InMemorySheetRepository } from "../sheets/in-memory-repository.js";
import { runSyncJob } from "../sync/sync-job.js";

const env = loadEnv();
const logger = pino({ level: env.logLevel === "silent" ? "silent" : env.logLevel });
const stores = loadStores(env);
const naverClient =
  env.naverApiMode === "live"
    ? new LiveNaverCommerceClient({ baseUrl: env.naverApiBaseUrl })
    : new MockNaverCommerceClient();
const sheetRepository =
  env.naverApiMode === "live"
    ? new GoogleSheetRepository(env.googleSheetsSpreadsheetId)
    : new InMemorySheetRepository();

let running = false;

cron.schedule(env.syncCron, async () => {
  if (running) {
    logger.warn("previous sync is still running");
    return;
  }

  running = true;

  try {
    const result = await runSyncJob({
      env,
      stores,
      naverClient,
      sheetRepository,
      now: () => new Date(),
    });
    logger.info(result, "scheduled sync completed");
  } catch (error) {
    logger.error({ error }, "scheduled sync failed");
  } finally {
    running = false;
  }
});

logger.info({ cron: env.syncCron, mode: env.naverApiMode }, "scheduler started");
```

- [ ] **Step 3: Verify mock CLI**

Run with mock environment:

```bash
NODE_ENV=test TZ=Asia/Seoul LOG_LEVEL=silent NAVER_API_MODE=mock ALLOW_LIVE_NAVER_API=false NAVER_API_BASE_URL=https://api.commerce.naver.com/external SYNC_CRON="*/5 * * * *" STORE_A_NAME="Store A" STORE_A_BASE_URL=https://example.com/store-a STORE_A_CLIENT_ID=a STORE_A_CLIENT_SECRET='$2a$04$abcdefghijklmnopqrstuu' STORE_A_ACCOUNT_ID=a STORE_B_NAME="Store B" STORE_B_BASE_URL=https://example.com/store-b STORE_B_CLIENT_ID=b STORE_B_CLIENT_SECRET='$2a$04$abcdefghijklmnopqrstuu' STORE_B_ACCOUNT_ID=b GOOGLE_SHEETS_SPREADSHEET_ID=test pnpm sync:once
```

Expected: command exits with status 0.

- [ ] **Step 4: Verify build and tests**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm build
```

Expected: static checks, unit tests, integration tests, and TypeScript build pass. E2E and visual checks are added in Task 11.

- [ ] **Step 5: Commit entrypoints**

```bash
git add src/cli src/scheduler
git commit -m "Add sync entrypoints"
```

---

### Task 11: Static, E2E, And Visual Test Harness

**Files:**

- Create: `tests/e2e/mock-sync.cli.spec.ts`
- Create: `tests/visual/fixtures/sheets-view.input.css`
- Create: `tests/visual/fixtures/sheets-view.html`
- Generate: `tests/visual/fixtures/sheets-view.css`
- Create: `tests/visual/sheets-view.spec.ts`
- Commit generated: `tests/visual/sheets-view.spec.ts-snapshots/sheets-view-chromium-*.png`

- [ ] **Step 1: Create CLI e2e test**

Create `tests/e2e/mock-sync.cli.spec.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("mock sync CLI exits successfully", async () => {
  const { stdout, stderr } = await execFileAsync("pnpm", ["sync:once"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      TZ: "Asia/Seoul",
      LOG_LEVEL: "silent",
      NAVER_API_MODE: "mock",
      ALLOW_LIVE_NAVER_API: "false",
      NAVER_API_BASE_URL: "https://api.commerce.naver.com/external",
      SYNC_CRON: "*/5 * * * *",
      STORE_A_NAME: "Store A",
      STORE_A_BASE_URL: "https://example.com/store-a",
      STORE_A_CLIENT_ID: "store-a-client",
      STORE_A_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
      STORE_A_ACCOUNT_ID: "store-a-account",
      STORE_B_NAME: "Store B",
      STORE_B_BASE_URL: "https://example.com/store-b",
      STORE_B_CLIENT_ID: "store-b-client",
      STORE_B_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
      STORE_B_ACCOUNT_ID: "store-b-account",
      GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
    },
    timeout: 20_000,
  });

  expect(stderr).toBe("");
  expect(stdout).not.toContain("store-a-secret");
  expect(stdout).not.toContain("store-b-secret");
});
```

- [ ] **Step 2: Create deterministic Tailwind visual fixture**

Create `tests/visual/fixtures/sheets-view.input.css`:

```css
@import "tailwindcss";
@source "./sheets-view.html";

@theme {
  --font-sans:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Create `tests/visual/fixtures/sheets-view.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sheet View Fixture</title>
    <link rel="stylesheet" href="./sheets-view.css" />
  </head>
  <body class="bg-slate-50 p-6 font-sans text-slate-900">
    <main class="mx-auto w-[1120px]">
      <h1 class="mb-4 text-2xl font-bold">차량번호 동기화 결과</h1>
      <section class="mb-5 grid grid-cols-4 gap-3" aria-label="sync summary">
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <span class="block text-xs text-slate-500">전체 등록 매물</span>
          <strong class="mt-1.5 block text-2xl">5</strong>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <span class="block text-xs text-slate-500">추출 성공</span>
          <strong class="mt-1.5 block text-2xl">4</strong>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <span class="block text-xs text-slate-500">중복 확인</span>
          <strong class="mt-1.5 block text-2xl">3</strong>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <span class="block text-xs text-slate-500">추출 실패</span>
          <strong class="mt-1.5 block text-2xl">1</strong>
        </div>
      </section>
      <table
        class="w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-left text-sm"
      >
        <thead>
          <tr class="bg-slate-100 text-slate-700">
            <th class="border-b border-slate-200 px-3 py-2.5 font-semibold">스토어</th>
            <th class="border-b border-slate-200 px-3 py-2.5 font-semibold">상품번호</th>
            <th class="border-b border-slate-200 px-3 py-2.5 font-semibold">상품명</th>
            <th class="border-b border-slate-200 px-3 py-2.5 font-semibold">차량번호</th>
            <th class="border-b border-slate-200 px-3 py-2.5 font-semibold">상태</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border-b border-slate-100 px-3 py-2.5">A</td>
            <td class="border-b border-slate-100 px-3 py-2.5">2001</td>
            <td class="border-b border-slate-100 px-3 py-2.5">Store A bucket truck</td>
            <td class="border-b border-slate-100 px-3 py-2.5">123가4567</td>
            <td class="border-b border-slate-100 px-3 py-2.5">
              <span
                class="inline-block min-w-28 rounded-full bg-amber-100 px-2 py-1 text-center text-xs font-bold text-amber-800"
                >cross-store</span
              >
            </td>
          </tr>
          <tr>
            <td class="border-b border-slate-100 px-3 py-2.5">A</td>
            <td class="border-b border-slate-100 px-3 py-2.5">2003</td>
            <td class="border-b border-slate-100 px-3 py-2.5">Store A image only truck</td>
            <td class="border-b border-slate-100 px-3 py-2.5"></td>
            <td class="border-b border-slate-100 px-3 py-2.5">
              <span
                class="inline-block min-w-28 rounded-full bg-red-100 px-2 py-1 text-center text-xs font-bold text-red-800"
                >not found</span
              >
            </td>
          </tr>
          <tr>
            <td class="px-3 py-2.5">B</td>
            <td class="px-3 py-2.5">4002</td>
            <td class="px-3 py-2.5">Store B unique truck</td>
            <td class="px-3 py-2.5">234나5678</td>
            <td class="px-3 py-2.5">
              <span
                class="inline-block min-w-28 rounded-full bg-emerald-100 px-2 py-1 text-center text-xs font-bold text-emerald-800"
                >unique</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  </body>
</html>
```

- [ ] **Step 3: Create visual regression test**

Create `tests/visual/sheets-view.spec.ts`:

```ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

test("sheet operator view remains readable", async ({ page }) => {
  const fixtureUrl = pathToFileURL(resolve("tests/visual/fixtures/sheets-view.html")).toString();

  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto(fixtureUrl);

  await expect(page).toHaveScreenshot("sheets-view.png", {
    fullPage: true,
    animations: "disabled",
  });
});
```

- [ ] **Step 4: Generate visual baseline once**

Run:

```bash
pnpm test:visual -- --update-snapshots
```

Expected: Playwright creates a snapshot PNG under `tests/visual/sheets-view.spec.ts-snapshots/`.

- [ ] **Step 5: Run static, e2e, and visual checks**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:e2e
pnpm test:visual
```

Expected: all commands pass. If Playwright browsers are missing, run `pnpm exec playwright install chromium` and rerun.

- [ ] **Step 6: Commit test harness**

```bash
git add tests/e2e tests/visual
git commit -m "Add e2e and visual test harness"
```

---

### Task 12: Operational Documentation And Deployment Notes

**Files:**

- Modify: `README.md`
- Create: `docs/operations/oracle-cloud-systemd.md`
- Create: `docs/operations/live-smoke-test.md`
- Create: `docs/architecture/system-overview.md`
- Create: `docs/decisions/0001-sheets-first-worker.md`
- Create: `docs/conventions/testing.md`
- Create: `docs/conventions/ui-styling.md`
- Create: `docs/troubleshooting/naver-commerce-api.md`

- [ ] **Step 1: Expand README operations section**

Append to `README.md`:

```markdown
## Server Operation

Use a fixed public IP server for live Naver Commerce API calls.

Recommended first deployment:

- Oracle Cloud Free Tier VM
- Node.js LTS
- systemd service and timer
- Google service account shared with the target spreadsheet

## Product Status Policy

All registered non-deleted products are included regardless of sale or display status. Naver products with status `DELETE` are excluded from default views.

## Google Sheets Tabs

The worker writes:

- `RawData`
- `A_Store_View`
- `B_Store_View`
- `Across_Stores_Duplicates`
- `Same_Store_Duplicates`
- `Extraction_Failures`
- `RunLog`
```

- [ ] **Step 2: Add systemd guide**

Create `docs/operations/oracle-cloud-systemd.md`:

````markdown
# Oracle Cloud systemd Operation

Use this guide after the server has a fixed public IP and Naver Commerce API has allowed that IP.

## Install

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Environment

Create a server-only `.env` file outside git. Include the variables from `.env.example`.

## Service

Create `/etc/systemd/system/car-plate-tracker.service`:

```ini
[Unit]
Description=Naver Smartstore Car Plate Tracker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/naver-smartstore-car-plate-tracker
EnvironmentFile=/opt/naver-smartstore-car-plate-tracker/.env
ExecStart=/usr/bin/pnpm scheduler
Restart=always
RestartSec=10
User=carplate
Group=carplate

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable car-plate-tracker
sudo systemctl start car-plate-tracker
sudo journalctl -u car-plate-tracker -f
```
````

- [ ] **Step 3: Add live smoke test guide**

Create `docs/operations/live-smoke-test.md`:

```markdown
# Live Smoke Test

Run this only on a fixed-IP staging or production server.

## Preconditions

- Server public IP is registered in Naver Commerce API settings.
- Naver app has product read permissions enabled.
- Store account IDs are confirmed.
- Google service account can edit the target spreadsheet.
- Naver client secrets have been rotated after any exposure.

## Sequence

1. Set `NAVER_API_MODE=live`.
2. Set `ALLOW_LIVE_NAVER_API=true`.
3. Run `pnpm sync:once`.
4. Confirm `RawData` receives rows.
5. Confirm `Extraction_Failures` has image-only or no-text products.
6. Confirm duplicate views match known test cases.
7. Review logs for `GW.IP_NOT_ALLOWED`, `GW.AUTHN`, `GW.RATE_LIMIT`, and `GW.QUOTA_LIMIT`.
```

- [ ] **Step 4: Add architecture reference**

Create `docs/architecture/system-overview.md`:

```markdown
# System Overview

The worker runs one sync pipeline:

1. Load runtime config and two store configs.
2. Fetch non-deleted registered products from Naver Commerce API.
3. Fetch product detail content for each channel product.
4. Extract and normalize vehicle plate numbers from text content only.
5. Calculate same-store and cross-store duplicate status.
6. Upsert `RawData`, rewrite view tabs, and append `RunLog`.

Google Sheets is the operator UI and MVP state store. The worker does not mutate Smartstore products.
```

- [ ] **Step 5: Add architecture decision record**

Create `docs/decisions/0001-sheets-first-worker.md`:

```markdown
# ADR 0001: Use a Sheets-first worker for MVP

## Context

The operator needs a low-friction way to inspect registered products, extracted vehicle plate numbers, duplicates, and extraction failures.

## Decision

Use a single Node.js worker and Google Sheets as the MVP state and review surface.

## Alternatives Considered

- SQLite plus generated Sheets views: better local state, but adds backup and migration work.
- Postgres-backed service: more scalable, but unnecessary for two stores and a small sync workload.

## Consequences

The implementation must preserve manually editable columns during upsert and keep derived views deterministic.
```

- [ ] **Step 6: Add testing convention**

Create `docs/conventions/testing.md`:

```markdown
# Testing Convention

Every implementation task must leave the repo passing:

- Static: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- Unit: `pnpm test:unit`
- Integration: `pnpm test:integration`
- E2E: `pnpm test:e2e`
- Visual: `pnpm test:visual`

Use fixtures for local Naver data. Do not call live Naver Commerce API from local tests.
```

- [ ] **Step 7: Add UI styling convention**

Create `docs/conventions/ui-styling.md`:

```markdown
# UI Styling Convention

Use Tailwind CSS for any HTML or React styling surface.

## Tailwind

- Prefer Tailwind utility classes over handwritten CSS.
- Keep visual test fixtures deterministic by compiling local Tailwind CSS with `pnpm build:visual-css`.
- Avoid remote CSS/CDN dependencies in tests.

## shadcn/ui

If a React operator UI is introduced, use shadcn/ui components before custom markup.

Required workflow:

1. Run `pnpm dlx shadcn@latest info --json` to inspect project context.
2. Run `pnpm dlx shadcn@latest docs card table badge button alert tabs` before using those components.
3. Add components with `pnpm dlx shadcn@latest add card table badge button alert tabs`.
4. Review generated files before committing.

Use shadcn `Card`, `Table`, and `Badge` for dashboard-style status views. Use `Button` variants rather than custom button classes. Use semantic tokens and `gap-*`; avoid raw color overrides and `space-y-*`.

## Google Sheets Exception

Google Sheets is the MVP operator UI and cannot use Tailwind or shadcn directly. Keep Sheets formatting deterministic through repository writes and document any view formatting in operations docs.
```

- [ ] **Step 8: Add Naver troubleshooting guide**

Create `docs/troubleshooting/naver-commerce-api.md`:

```markdown
# Naver Commerce API Troubleshooting

## `GW.IP_NOT_ALLOWED`

The request came from an unregistered public IP. Run live sync only from the fixed-IP server registered in Naver Commerce API settings.

## `GW.AUTHN`

The access token is invalid or expired. The client refreshes once. Repeated failures mean the signature, timestamp, client ID, client secret, or account ID needs review.

## `GW.RATE_LIMIT` or `GW.QUOTA_LIMIT`

Reduce concurrency, increase sync interval, and retry with backoff.

## Missing `originProduct.detailContent`

Verify product detail read permissions and inspect the official channel product response shape before changing extractor code.
```

- [ ] **Step 9: Verify docs do not contain secrets**

Run:

```bash
rg -n "client_secret|NID_|Cookie|truck-|docs.google.com/spreadsheets|\\$2a\\$04\\$" README.md docs .env.example
```

Expected: the only matches are generic variable names, documentation warnings, or intentionally fake bcrypt strings in command examples. No real secret, real store URL, real spreadsheet URL, real cookie, or real plate appears.

- [ ] **Step 10: Commit operations docs**

```bash
git add README.md docs/operations docs/architecture docs/decisions docs/conventions docs/troubleshooting
git commit -m "Add operations documentation"
```

---

### Task 13: Final Verification

**Files:**

- Modify only if verification exposes a concrete defect.

- [ ] **Step 1: Run full test suite**

Run:

```bash
pnpm test:all
```

Expected: static, unit, integration, e2e, and visual checks pass.

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
pnpm build
```

Expected: build exits with status 0.

- [ ] **Step 3: Run mock sync once**

Run the mock command from Task 10 Step 3.

Expected: command exits with status 0.

- [ ] **Step 4: Scan for secrets and real data**

Run:

```bash
rg -n "docs.google.com/spreadsheets|NID_|NID_AUT|NID_SES|REAL_STORE_SLUG|\\$2a\\$04\\$|[0-9]{2,3}[가-힣][0-9]{4}" .
```

Expected: no real spreadsheet URL, browser cookie, real store path, exposed real bcrypt secret prefix, or real vehicle plate is present. Test fixtures may contain fake plate values such as `123가4567` and `234나5678`.

- [ ] **Step 5: Review commit history**

Run:

```bash
git log --oneline --decorate -12
git status
```

Expected: task commits are present and working tree is clean.

- [ ] **Step 6: Prepare handoff summary**

Write a final implementation summary with:

- Commits created.
- Test commands and results.
- Live API items still requiring operator setup.
- Exact next command for staging smoke test.

Do not push until the user asks.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/e2e/**/*.spec.ts", "tests/visual/**/*.spec.ts"],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    browserName: "chromium",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 2540, height: 720 },
    deviceScaleFactor: 1,
    contextOptions: {
      reducedMotion: "reduce",
    },
    launchOptions: {
      args: ["--force-color-profile=srgb"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

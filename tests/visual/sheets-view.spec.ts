import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const localChromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = existsSync(localChromeExecutable)
  ? { executablePath: localChromeExecutable }
  : {};

test.use({ launchOptions });

test("sheet operator view remains readable", async ({ page }) => {
  const fixtureUrl = pathToFileURL(resolve("tests/visual/fixtures/sheets-view.html")).toString();

  await page.setViewportSize({ width: 2440, height: 720 });
  await page.goto(fixtureUrl);

  await expect(page).toHaveScreenshot("sheets-view.png", {
    animations: "disabled",
    fullPage: true,
  });
});

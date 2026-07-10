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

  await page.setViewportSize({ width: 2490, height: 720 });
  await page.goto(fixtureUrl);

  await expect(page).toHaveScreenshot("sheets-view.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("sheet operator colors remain readable against dark chrome", async ({ page }) => {
  const fixtureUrl = pathToFileURL(resolve("tests/visual/fixtures/sheets-view.html")).toString();

  await page.setViewportSize({ width: 2490, height: 720 });
  await page.goto(fixtureUrl);
  await page.evaluate("document.documentElement.classList.add('dark')");

  await expect(page).toHaveScreenshot("sheets-view-dark.png", {
    animations: "disabled",
    fullPage: true,
  });
});

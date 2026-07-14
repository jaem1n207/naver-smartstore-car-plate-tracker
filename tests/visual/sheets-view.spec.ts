import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const localChromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = existsSync(localChromeExecutable)
  ? { executablePath: localChromeExecutable }
  : {};

test.use({ launchOptions });

test("sheet operator view remains readable", async ({ page }) => {
  const fixtureUrl = pathToFileURL(resolve("tests/visual/fixtures/sheets-view.html")).toString();

  await page.setViewportSize({ width: 2540, height: 720 });
  await page.goto(fixtureUrl);

  expect(await documentFitsViewport(page)).toBe(true);

  await expect(page).toHaveScreenshot("sheets-view.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("sheet operator colors remain readable against dark chrome", async ({ page }) => {
  const fixtureUrl = pathToFileURL(resolve("tests/visual/fixtures/sheets-view.html")).toString();

  await page.setViewportSize({ width: 2540, height: 720 });
  await page.goto(fixtureUrl);
  await page.evaluate("document.documentElement.classList.add('dark')");

  expect(await documentFitsViewport(page)).toBe(true);
  await expectComputedColors(page, "thead tr", "rgb(23, 76, 60)", "rgb(255, 255, 255)");
  await expectComputedColors(
    page,
    "tbody tr:last-child td:nth-child(3)",
    "rgb(248, 250, 252)",
    "rgb(15, 23, 42)",
  );
  await expectComputedColors(
    page,
    "tbody tr:first-child td:first-child",
    "rgb(252, 232, 230)",
    "rgb(138, 28, 28)",
  );
  await expectComputedColors(
    page,
    "tbody tr:nth-child(2) td:nth-child(5)",
    "rgb(252, 232, 213)",
    "rgb(138, 59, 18)",
  );

  await expect(page).toHaveScreenshot("sheets-view-dark.png", {
    animations: "disabled",
    fullPage: true,
  });
});

async function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
}

async function expectComputedColors(
  page: Page,
  selector: string,
  backgroundColor: string,
  color: string,
): Promise<void> {
  await expect(page.locator(selector)).toHaveCSS("background-color", backgroundColor);
  await expect(page.locator(selector)).toHaveCSS("color", color);
}

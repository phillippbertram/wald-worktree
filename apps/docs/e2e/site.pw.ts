import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("serves docs and search results under the GitHub Pages prefix", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Git worktrees/);
  await expect(page.getByRole("link", { name: "Configure lifecycle hooks" })).toHaveAttribute(
    "href",
    /\/docs\/project-setup/,
  );
  await page.getByRole("link", { name: "Get started", exact: true }).first().click();
  await expect(page).toHaveURL(/\/wald-worktree\/docs\/getting-started\/$/);
  await expect(page.getByRole("heading", { level: 2, name: /^Install wald\b/ })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: /search/i });
  await input.fill("Parallel coding agents");
  await page
    .getByRole("option", { name: /Parallel coding agents/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/wald-worktree\/docs\/agent-workflows\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Parallel coding agents");

  const theme = page.getByRole("button", { name: "Toggle Theme" });
  await theme.click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await theme.click();
  await expect(page.locator("html")).toHaveClass(/light/);

  const missing = await page.goto("./missing/");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("plays real terminal output and synchronizes chapter navigation", async ({ page }) => {
  const recordings: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".cast")) recordings.push(request.url());
  });
  await page.goto("./");
  const demo = page.getByRole("region", { name: "Create a worktree" });
  const terminal = demo.getByRole("region", { name: "Terminal recording" });
  await expect(terminal.getByText("What would you like to do?")).toBeVisible();
  expect(recordings).toEqual([]);

  await demo.getByRole("button", { name: "Play demo" }).click();
  await expect(demo.getByRole("button", { name: "Pause" })).toBeVisible();
  await demo.getByRole("button", { name: "Pause" }).click();
  await demo.getByRole("button", { name: "Inspect the result" }).click();
  await expect(demo.getByRole("button", { name: "Inspect the result" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(terminal).toContainText("feature/search");
  expect(recordings).toHaveLength(1);

  const cleanup = page.getByRole("region", { name: "Remove a worktree safely" });
  await cleanup.getByRole("button", { name: "Check what remains" }).click();
  await expect(cleanup.getByText("Git repository · review/ui branch kept")).toBeVisible();
  await cleanup.getByRole("button", { name: "Review the removal" }).click();
  await expect(cleanup.getByText("review-ui/", { exact: true })).toBeVisible();
});

test("keeps the comparison usable at mobile widths and with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("./");
  await page.getByRole("button", { name: "One checkout" }).click();
  await expect(page.getByText("One branch at a time")).toBeVisible();
  await page.getByRole("button", { name: "Two worktrees" }).click();
  await expect(page.getByText("hotfix-login/", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
  ).toEqual([]);
});

test("serves the quickstart and demo transcript without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(new URL("docs/", baseURL).href);
    await expect(page.getByRole("heading", { name: "Why wald?" })).toBeVisible();
    await expect(page.getByText(/pronounced \/valt\//)).toBeVisible();
    await page.goto(new URL("docs/getting-started/", baseURL).href);
    await expect(page.getByRole("heading", { level: 2, name: /^Install wald\b/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: /^Uninstall wald\b/ })).toBeVisible();
    await page.getByText("Read transcript", { exact: true }).click();
    await expect(page.getByText(/Created feature-search at/)).toBeVisible();
  } finally {
    await context.close();
  }
});

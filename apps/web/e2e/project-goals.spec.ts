import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const width of [1440, 390]) {
  test(`Projects Goal/KR management at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signup(page, `goals-${width}-${Date.now()}@example.com`, "password123", "Goal tester");
    await completeOnboarding(page);
    const project = await rpc<{ id: string }>(page, "projects/create", {
      name: "Goal acceptance project",
    });
    await page.goto(`/app/projects/${project.id}`);
    await expect(
      page.getByRole("heading", { name: "Goal acceptance project", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Goal name", { exact: true }).fill("Ship measurable results");
    await page.getByRole("button", { name: "Add goal", exact: true }).click();
    const goal = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "Ship measurable results", exact: true }) });
    await expect(goal).toBeVisible();
    const creator = goal
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: /^Add key result$/ }) });
    await creator.locator("summary").click();
    await creator.getByLabel("Name", { exact: true }).fill("Verified journeys");
    await creator.getByLabel("Measure", { exact: true }).fill("journeys");
    await creator.getByLabel("Current value", { exact: true }).fill("2");
    await creator.getByLabel("Target value", { exact: true }).fill("10");
    await creator
      .getByLabel("Calculation rule", { exact: true })
      .fill("Count verified user journeys");
    await creator.getByRole("button", { name: "Save", exact: true }).click();
    await expect(goal.getByText("2 / 10 journeys", { exact: true })).toBeVisible();
    const editor = goal
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: /^Edit key result$/ }) });
    await editor.locator("summary").click();
    await editor.getByLabel("Current value", { exact: true }).fill("4");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(goal.getByText("4 / 10 journeys", { exact: true })).toBeVisible();
    await page.reload();
    await expect(goal.getByText("Verified journeys", { exact: true })).toBeVisible();
    await expect(goal.getByText("4 / 10 journeys", { exact: true })).toBeVisible();
    await expect(
      goal.getByRole("progressbar", { name: "Key result progress", exact: true }),
    ).toHaveAttribute("value", "40");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width === 390) {
      await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
    }
    await captureScreenshot(page, testInfo, `rak15-project-goals-${width}`);
    await goal.getByRole("button", { name: "Archive key result", exact: true }).click();
    await expect(goal.getByText("Verified journeys", { exact: true })).toHaveCount(0);
    await page.getByLabel("Archived key results", { exact: true }).check();
    await expect(goal.getByText("Verified journeys", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `rak15-archived-kr-${width}`);
    const resultPath = testInfo.outputPath("result.json");
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          test: testInfo.title,
          width,
          route: new URL(page.url()).pathname,
          currentValue: 4,
          targetValue: 10,
          progress: 40,
          archivedVisible: true,
          status: "passed",
        },
        null,
        2,
      ),
    );
    await testInfo.attach("result.json", { path: resultPath, contentType: "application/json" });
  });
}

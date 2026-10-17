import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

test("board creates a ticket and opens it", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  const title = "Ship the board";
  const description = "Track the kanban launch.";
  await signup(page, `board-${stamp}@rakazo.test`, "password12", "Board QA");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/board$/);
  await expect(page.getByTestId("board-columns")).toBeVisible();
  await expect(page.getByText("No tickets yet", { exact: true })).toBeVisible();
  const board = page.getByTestId("board-columns");
  expect(await board.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByRole("heading", { name: "Won't do", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await board.evaluate(
      (node) => node.parentElement!.scrollWidth > node.parentElement!.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureScreenshot(page, testInfo, "board-kanban");

  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Description").fill(description);
  const owner = dialog.getByLabel("Owner");
  await expect(owner.locator("option", { hasText: "Planner" })).toHaveCount(1);
  await owner.selectOption({ label: "Planner" });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(dialog).toBeHidden();
  const card = page.locator("[data-testid^='board-card-']").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Planner");
  await captureScreenshot(page, testInfo, "board-ticket-created");

  await card.click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Title")).toHaveValue(title);
  await expect(detail.getByTestId("ticket-description")).toHaveValue(description);
  await expect(detail.getByTestId("ticket-comments")).toBeVisible();
  await captureScreenshot(page, testInfo, "board-ticket-detail");
});

for (const width of [360, 390]) {
  test(`responsive projects and tickets at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await signup(page, `projects-${width}-${Date.now()}@rakazo.test`, "password12", "Projects QA");
    await completeOnboarding(page);
    await createNamedBot(page, "Planner");
    const project = await rpc<{ id: string }>(page, "projects/create", {
      name: "Responsive project",
    });
    const archived = await rpc<{ id: string }>(page, "projects/create", {
      name: "Archived project",
    });
    await rpc(page, "projects/archive", { id: archived.id });
    const milestone = await rpc<{ id: string }>(page, "milestones/create", {
      projectId: project.id,
      name: "First milestone",
    });
    const archivedMilestone = await rpc<{ id: string }>(page, "milestones/create", {
      projectId: project.id,
      name: "Archived milestone",
    });
    await rpc(page, "milestones/archive", { id: archivedMilestone.id });
    await page.goto(`/app/projects/${project.id}`);
    await expect(
      page.getByRole("heading", { name: "Responsive project", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("0/0 · No tickets yet", { exact: true }).first()).toBeVisible();
    await expect(page.locator("progress")).toHaveCount(0);
    await page.getByRole("link", { name: "First milestone", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/milestones/${milestone.id}$`));
    await captureScreenshot(page, testInfo, `milestone-${width}`);
    await page.goto("/app/board");
    await expect(page.getByTestId("ticket-list")).toBeAttached();
    await expect(page.getByText("No tickets yet", { exact: true })).toBeVisible();
    await expect(page.getByTestId("board-columns")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Project", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Milestone", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Status", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureScreenshot(page, testInfo, `tickets-${width}`);
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New ticket" });
    await expect(
      dialog
        .getByLabel("Project", { exact: true })
        .locator("option", { hasText: "Archived project" }),
    ).toHaveCount(0);
    await dialog.getByLabel("Project", { exact: true }).selectOption(project.id);
    const milestoneSelect = dialog.getByLabel("Milestone", { exact: true });
    await expect(milestoneSelect.locator("option", { hasText: "First milestone" })).toHaveCount(1);
    await expect(milestoneSelect.locator("option", { hasText: "Archived milestone" })).toHaveCount(
      0,
    );
  });
}

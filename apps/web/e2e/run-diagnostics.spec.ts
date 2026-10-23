import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("opens read-only run diagnostics and switches evidence categories", async ({
  page,
}, testInfo) => {
  await signup(page, `diagnostics-${Date.now()}@rakazo.test`, "password12", "Diagnostics");
  await completeOnboarding(page);
  const at = "2026-10-22T05:00:00.000Z";
  await page.route("**/rpc/runs/list", async (route) => {
    const body = route.request().postDataJSON() as { json?: { filter?: string } } | null;
    const runs =
      body?.json?.filter === "active"
        ? [
            {
              runId: "run-diagnostics",
              botId: "bot-diagnostics",
              botName: "Diagnostics fixture",
              groupId: null,
              groupName: null,
              threadId: "thread-diagnostics",
              status: "running",
              trigger: "user",
              notificationsEnabled: false,
              promptSnippet: "Read-only evidence fixture",
              updatedAt: at,
            },
          ]
        : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { runs } }),
    });
  });
  await page.route("**/rpc/runs/diagnostics", async (route) => {
    const body = route.request().postDataJSON() as { json: { section: string } };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          runId: "run-diagnostics",
          status: "uncertain",
          section: body.json.section,
          entries: [],
          nextCursor: null,
          windowStartedAt: at,
          historyMayBeIncomplete: true,
        },
      }),
    });
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByText("Run diagnostics", { exact: true }).click();
  const diagnostics = page.getByRole("region", { name: "Run diagnostics" });
  await expect(diagnostics.getByText("Run status: uncertain", { exact: true })).toBeVisible();
  await expect(
    diagnostics.getByText("No recorded evidence in this window.", { exact: true }),
  ).toBeVisible();
  await diagnostics.getByLabel("Evidence category").selectOption("usage");
  await expect(diagnostics.getByRole("combobox")).toHaveValue("usage");
  await expect(diagnostics.getByText("Run status: uncertain", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "run-diagnostics-uncertain-usage");
});

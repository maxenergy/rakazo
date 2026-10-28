import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("shows proposal revisions and invalidates an older approval", async ({ page }, testInfo) => {
  const now = new Date().toISOString();
  await page.route("**/rpc/proposals/list", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "proposal-changed",
            botId: "bot-test",
            botName: "Chief",
            version: 2,
            contentHash: "b".repeat(64),
            approvedVersion: 1,
            approvedContentHash: "a".repeat(64),
            kind: "plan",
            title: "Launch plan",
            summary: "Prepare the launch.",
            options: [],
            recommendation: "",
            status: "approved",
            chosenOption: null,
            comment: null,
            decidedAt: now,
            decidedBy: "user",
            createdAt: now,
          },
          {
            id: "proposal-pending",
            botId: "bot-test",
            botName: "Chief",
            version: 3,
            contentHash: "c".repeat(64),
            approvedVersion: null,
            approvedContentHash: null,
            kind: "decision",
            title: "Launch timing",
            summary: "Choose the launch date.",
            options: ["Today", "Tomorrow"],
            recommendation: "",
            status: "pending",
            chosenOption: null,
            comment: null,
            decidedAt: null,
            decidedBy: "user",
            createdAt: now,
          },
        ],
      }),
    }),
  );

  await signup(
    page,
    `proposal-versions-${Date.now()}@rakazo.test`,
    "password12",
    "Proposal versions",
  );
  await completeOnboarding(page);
  await page.goto("/app/approvals");

  await expect(page.getByText("Version 3", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Previous approval is no longer valid because this proposal has changed."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "approval-proposal-versions");
});

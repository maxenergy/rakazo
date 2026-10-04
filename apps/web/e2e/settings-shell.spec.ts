import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("settings keep the same bounds across sections at each viewport size", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await signup(page, `settings-size-${stamp}@rakazo.test`, "password12", "Settings size");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 700 },
    { width: 600, height: 720 },
  ]) {
    await test.step(`${viewport.width} × ${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      await settings.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const bounds = await settings.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error("Settings dialog has no bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(16);
      expect(bounds.y).toBeGreaterThanOrEqual(16);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 16);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 16);

      const buttons = await settings.getByTestId("settings-nav").getByRole("button").all();
      for (const button of buttons) {
        await button.click();
        await expect(button).toHaveAttribute("aria-current", "page");
        await expect.poll(() => settings.boundingBox()).toEqual(bounds);
        const section = await settings.getAttribute("data-settings-section");
        if (section === "models") {
          await expect(settings.getByRole("button", { name: /OpenAI-compatible/ })).toBeVisible();
          await expect.poll(() => settings.boundingBox()).toEqual(bounds);
        }
        if (section === "general" || section === "models") {
          await captureScreenshot(
            page,
            testInfo,
            `settings-stable-size-${viewport.width}-${section}`,
          );
        }
      }
    });
  }
});

test("settings shell is two-pane and deep-links Models Memory Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Replies", exact: true })).toHaveCount(0);
  await settings.getByTestId("advanced-settings").locator("summary").click();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await expect(settings.getByText("Stream replies", { exact: true })).toBeVisible();
  await streamReplies.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-shell-general");
  await streamReplies.click();
  await expect(streamReplies).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo.responseStreaming")))
    .toBe("on");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Provider")).toBeVisible();
  await memory.getByLabel("Provider").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

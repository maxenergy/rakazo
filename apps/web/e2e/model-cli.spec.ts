import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("subscription CLI providers use official sign-in without API-key controls", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cli-model-${stamp}@rakazo.test`, "password12", `CLI ${stamp}`);
  await completeOnboarding(page);
  await openUserSettings(page, "models");

  const search = page.getByPlaceholder("Search providers");
  for (const [provider, name] of [
    ["codex-cli", "Codex CLI"],
    ["claude-code", "Claude Code"],
    ["gemini-cli", "Gemini CLI"],
    ["grok-cli", "Grok CLI"],
  ]) {
    await search.fill(provider!);
    await page.getByRole("button", { name: new RegExp(name!) }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toBeHidden();
    await expect(page.getByLabel("Maximum output tokens")).toBeHidden();
    await expect(page.getByText("Advanced", { exact: true })).toBeHidden();
  }
  await captureScreenshot(page, testInfo, "grok-cli-subscription");

  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-cli-login",
          provider: "claude-code",
          mode: "browser",
          verificationUri: "https://claude.ai/oauth/authorize?fake=1",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  await page.route("**/rpc/models/cancelOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: null }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  await search.fill("claude-code");
  await page.getByRole("button", { name: /Claude Code/ }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue sign-in" })).toBeVisible();
  await expect(page.getByLabel("Authorization code")).toBeHidden();
  await captureScreenshot(page, testInfo, "claude-cli-browser-signin");
  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelled;
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

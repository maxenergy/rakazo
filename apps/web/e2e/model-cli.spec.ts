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
    ["antigravity-cli", "Antigravity CLI"],
    ["grok-cli", "Grok CLI"],
  ]) {
    await search.fill(provider!);
    await page.getByRole("button", { name: new RegExp(name!) }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toBeHidden();
    await expect(page.getByLabel("Maximum output tokens")).toBeHidden();
    await expect(page.getByText("Advanced", { exact: true })).toBeHidden();
    if (provider === "antigravity-cli") {
      await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
        "Gemini 3.8 Flash (High)",
      );
      await captureScreenshot(page, testInfo, "antigravity-cli-subscription");
    }
  }
  await captureScreenshot(page, testInfo, "grok-cli-subscription");

  let manualCode = false;
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    const provider = route.request().postDataJSON().json.provider;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-cli-login",
          provider,
          mode: manualCode ? "auth-url" : "browser",
          ...(manualCode ? { callbackOwner: "provider" } : {}),
          verificationUri:
            provider === "antigravity-cli"
              ? "https://accounts.google.com/o/oauth2/auth?state=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"
              : manualCode
                ? "https://claude.com/cai/oauth/authorize?state=fake&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
                : "https://claude.ai/oauth/authorize?fake=1",
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

  // Hosted CLI callbacks must open in the browser without a desktop loopback
  // listener, and their code must use the shared submit/cancel lifecycle.
  manualCode = true;
  await page.evaluate(() => {
    Reflect.set(window, "rakazoDesktop", {
      oauth: {
        open: async (_url: string, options: { callbackOwner: string }) => {
          Reflect.set(window, "oauthCallbackOwner", options.callbackOwner);
        },
        cancel: async () => undefined,
        onCallback: () => () => undefined,
      },
    });
  });
  await page.route("**/rpc/models/submitOAuthCode", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Authorization code or callback URL")).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "oauthCallbackOwner"))).toBe("provider");
  await captureScreenshot(page, testInfo, "claude-cli-code-signin");
  await page.getByLabel("Authorization code or callback URL").fill("fake-code#fake-state");
  const submitted = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/submitOAuthCode"),
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    json: { loginId: "fake-cli-login", code: "fake-code#fake-state" },
  });
  const codeCancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await codeCancelled;
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  await search.fill("antigravity-cli");
  await page.getByRole("button", { name: /Antigravity CLI/ }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Authorization code or callback URL")).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "oauthCallbackOwner"))).toBe("provider");
  await captureScreenshot(page, testInfo, "antigravity-cli-code-signin");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "Could not connect this provider",
        },
      }),
    });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Could not connect this provider", { exact: true })).toBeVisible();
  await expect(page.getByText("Internal server error", { exact: true })).toBeHidden();
});

test("subscription sign-in failures are localized in Chinese", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cli-errors-${stamp}@rakazo.test`, "password12", `CLI ${stamp}`);
  await completeOnboarding(page);
  await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "zh-CN"));
  await page.reload();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByTestId("settings-nav-models").click();
  await page.getByPlaceholder("搜索提供方").fill("antigravity");
  await page.getByRole("button", { name: /Antigravity CLI/ }).click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-cli-login",
          provider: "antigravity-cli",
          mode: "auth-url",
          callbackOwner: "provider",
          expiresInSeconds: 900,
          verificationUri: "https://accounts.google.com/o/oauth2/auth?state=fake",
        },
      }),
    });
  });
  await page.route("**/rpc/models/submitOAuthCode", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });
  await page.route("**/rpc/models/cancelOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });
  let error = "";
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "error", error } }),
    });
  });
  for (const [diagnostic, translated] of [
    ["CLI sign-in failed. Start sign-in again.", "无法连接此提供方"],
    ["CLI request timed out. Try again.", "授权超时，请重试。"],
    ["Authorization code is invalid. Start sign-in again.", "授权码无效，请重新登录。"],
  ]) {
    error = diagnostic!;
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByLabel("授权码或回调 URL").fill("4/fake-code");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.getByText(translated!, { exact: true })).toBeVisible();
    await expect(page.getByText(diagnostic!, { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "antigravity-cli-chinese-signin-error");
});

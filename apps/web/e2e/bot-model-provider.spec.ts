import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("bot model choices keep provider identity in default, selected and unavailable models", async ({
  page,
}, testInfo) => {
  await signup(page, `bot-provider-${Date.now()}@rakazo.test`, "password12", "Provider picker");
  await completeOnboarding(page);
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  let bot = bots[0]!;
  const catalog = [
    {
      provider: "claude-code",
      providerName: "Claude Code",
      id: "shared-model",
      label: "Shared model",
      billing: "",
    },
    {
      provider: "codex-cli",
      providerName: "Codex CLI",
      id: "shared-model",
      label: "Shared model",
      billing: "",
    },
    {
      provider: "deepseek",
      providerName: "DeepSeek",
      id: "flash-model",
      label: "Flash model",
      billing: "",
    },
  ];
  let credentials = catalog.map((entry) => ({
    id: `fixture-${entry.provider}`,
    provider: entry.provider,
    label: entry.providerName,
    modelId: entry.id,
    hasKey: true,
    isDefault: entry.provider === "codex-cli",
  }));
  await page.route("**/rpc/models/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: catalog }),
    });
  });
  await page.route("**/rpc/models/credentials", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: credentials }),
    });
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, defaultProvider: "codex-cli", defaultModel: "shared-model" } },
    });
  });
  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          current: {
            ...body.json.current,
            bots: body.json.current.bots.map((entry: Bot) => (entry.id === bot.id ? bot : entry)),
          },
        },
      },
    });
  });
  await page.route("**/rpc/bots/update", async (route) => {
    const { json: patch } = route.request().postDataJSON();
    bot = { ...bot, ...patch };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: bot }) });
  });
  await page.locator("main").getByRole("button", { name: bot.name, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByText("Advanced", { exact: true }).click();
  const select = settings.getByLabel("Model", { exact: true });
  await expect(select.locator('option[value=""]')).toHaveText(
    "Space default (Codex CLI · Shared model)",
  );
  await expect(select.locator('option[value="claude-code::shared-model"]')).toHaveText(
    "Claude Code · Shared model",
  );
  await expect(select.locator('option[value="codex-cli::shared-model"]')).toHaveText(
    "Codex CLI · Shared model",
  );
  await captureScreenshot(page, testInfo, "bot-model-provider-default");

  for (const provider of ["claude-code", "codex-cli"]) {
    await select.selectOption(`${provider}::shared-model`);
    const saved = page.waitForRequest((request) => request.url().includes("/rpc/bots/update"));
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).postDataJSON()).toMatchObject({
      json: { modelProvider: provider, modelId: "shared-model" },
    });
    await expect(select).toHaveValue(`${provider}::shared-model`);
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  }

  // A disconnected connection still needs a clear label for the stored override.
  credentials = credentials.filter((entry) => entry.provider !== "codex-cli");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.locator("main").getByRole("button", { name: bot.name, exact: true }).click();
  await settings.getByText("Advanced", { exact: true }).click();
  await expect(select).toHaveValue("codex-cli::shared-model");
  await expect(select.locator('option[value="codex-cli::shared-model"]')).toHaveText(
    "Codex CLI · Shared model",
  );
  await captureScreenshot(page, testInfo, "bot-model-provider-saved");
});

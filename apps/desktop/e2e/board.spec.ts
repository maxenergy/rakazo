import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { completeOnboarding } from "../../web/e2e/helpers";

let app: ElectronApplication | undefined;
let page: Page | undefined;
let profile: string | undefined;
let logs: string[] = [];
let tracing = false;

test.beforeEach(() => {
  app = undefined;
  page = undefined;
  profile = undefined;
  logs = [];
  tracing = false;
});

test("Electron displays a persisted ticket in its real board column", async ({
  baseURL,
  request,
}, testInfo) => {
  if (!baseURL || !process.env.API_URL) throw new Error("baseURL and API_URL are required");
  testInfo.setTimeout(150_000);
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${process.env.API_URL}/health`, { timeout: 2_000 })).ok();
        } catch {
          return false;
        }
      },
      { timeout: 15_000, intervals: [200, 500, 1_000] },
    )
    .toBe(true);
  profile = await mkdtemp(path.join(tmpdir(), "rakazo-board-"));
  app = await electron.launch({
    args: [".", `--user-data-dir=${profile}`],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, RAKAZO_WEB_URL: baseURL!, RAKAZO_DISABLE_AUTO_UPDATE: "1" },
  });
  app.process().stdout?.on("data", (chunk) => logs.push(`[stdout] ${chunk}`));
  app.process().stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk}`));
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  const runningApp = app;
  await expect
    .poll(
      async () => {
        for (const candidate of runningApp.windows()) {
          if (candidate.isClosed()) continue;
          const hasBridge = await candidate
            .evaluate(() =>
              Boolean((window as unknown as { rakazoDesktop?: unknown }).rakazoDesktop),
            )
            .catch(() => false);
          if (hasBridge) {
            page = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (!page) throw new Error("Electron application window was not found");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/`));
  await page.goto(new URL("/sign-up", baseURL!).href);
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await page.getByPlaceholder("Your name").fill("Electron QA");
  await page
    .getByPlaceholder("Your email address")
    .fill(`electron-board-${Date.now()}@rakazo.test`);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
  const rpc = async <T>(procedure: string, body: unknown): Promise<T> => {
    const response = await page!.evaluate(
      async ({ procedure, body }) => {
        const result = await fetch(`/rpc/${procedure}`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
          signal: AbortSignal.timeout(15_000),
        });
        return { ok: result.ok, status: result.status, body: await result.json() };
      },
      { procedure, body },
    );
    const parsed = response.body as { json?: T; error?: { message?: string } };
    if (!response.ok || parsed.error) {
      throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? "failed"}`);
    }
    return parsed.json as T;
  };
  await completeOnboarding(page);
  const [bot] = await rpc<Array<{ id: string }>>("bots/list", {});
  expect(bot).toBeDefined();
  const ticket = await rpc<{ id: string; ref: string }>("tickets/create", {
    title: "Electron persisted board ticket",
    description: "Seeded through the real disposable API.",
    assigneeBotId: bot!.id,
  });
  await rpc("tickets/update", { id: ticket.id, status: "doing" });
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/board$/);
  const column = page
    .getByTestId("board-columns")
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "In progress", exact: true }),
    });
  const card = column.getByTestId(`board-card-${ticket.id}`);
  await expect(card).toContainText("Electron persisted board ticket");
  await expect(card).toContainText(ticket.ref);
  await page.reload();
  await expect(card).toContainText(ticket.ref);
  await expect(card).toContainText("Electron persisted board ticket");
  await card.click();
  await expect(page.getByRole("dialog")).toContainText("Seeded through the real disposable API.");
  await page.screenshot({
    path: testInfo.outputPath("board-success.png"),
    fullPage: true,
    timeout: 5_000,
  });
});

async function bounded<T>(operation: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.afterEach(async ({ baseURL }, testInfo) => {
  void baseURL;
  testInfo.setTimeout(45_000);
  try {
    await writeFile(
      testInfo.outputPath("main-process.log"),
      logs.join("") || "No main-process output captured.\n",
    );
    if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
      await page
        .screenshot({
          path: testInfo.outputPath("board-failure.png"),
          fullPage: true,
          timeout: 5_000,
        })
        .catch((error) =>
          logs.push(`[screenshot] ${String(error)}
`),
        );
    }
    if (tracing && app) {
      const options =
        testInfo.status !== testInfo.expectedStatus
          ? { path: testInfo.outputPath("trace.zip") }
          : undefined;
      await bounded(app.context().tracing.stop(options), "Trace capture").catch((error) =>
        logs.push(`[trace] ${String(error)}
`),
      );
      tracing = false;
    }
  } catch (error) {
    logs.push(`[diagnostics] ${String(error)}
`);
  } finally {
    try {
      if (app) {
        const runningApp = app;
        const child = runningApp.process();
        try {
          await bounded(runningApp.close(), "Electron close");
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }
    } catch (error) {
      logs.push(`[cleanup] ${String(error)}
`);
    } finally {
      try {
        await writeFile(
          testInfo.outputPath("main-process.log"),
          logs.join("") || "No main-process stdout or stderr captured.\n",
        );
      } finally {
        if (profile)
          await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
});

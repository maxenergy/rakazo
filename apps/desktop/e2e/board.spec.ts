import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { completeOnboarding, rpc, signup } from "../../web/e2e/helpers";

test("Electron displays a persisted ticket in its real board column", async ({
  baseURL,
  request,
}, testInfo) => {
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
  const profile = await mkdtemp(path.join(tmpdir(), "rakazo-board-"));
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  const logs: string[] = [];
  let tracing = false;
  try {
    app = await electron.launch({
      args: [".", `--user-data-dir=${profile}`],
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, RAKAZO_WEB_URL: baseURL!, RAKAZO_DISABLE_AUTO_UPDATE: "1" },
    });
    app.process().stdout?.on("data", (chunk) => logs.push(`[stdout] ${chunk}`));
    app.process().stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk}`));
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page).toHaveURL(new RegExp(`^${baseURL}/`));
    await signup(page, `electron-board-${Date.now()}@rakazo.test`, "password12", "Electron QA");
    await completeOnboarding(page);
    const [bot] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
    expect(bot).toBeDefined();
    const ticket = await rpc<{ id: string; ref: string }>(page, "tickets/create", {
      title: "Electron persisted board ticket",
      description: "Seeded through the real disposable API.",
      assigneeBotId: bot!.id,
    });
    await rpc(page, "tickets/update", { id: ticket.id, status: "doing" });
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/board$/);
    const column = page.getByTestId("board-column-doing");
    const card = column.getByTestId(`board-card-${ticket.id}`);
    await expect(card).toContainText("Electron persisted board ticket");
    await expect(card).toContainText(ticket.ref);
    await card.click();
    await expect(page.getByRole("dialog")).toContainText("Seeded through the real disposable API.");
    await page.screenshot({ path: testInfo.outputPath("board-success.png"), fullPage: true });
    throw new Error("RAK-31 deliberate failure: verify screenshot, trace and main-process artifact upload");
  } catch (error) {
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: testInfo.outputPath("board-failure.png"), fullPage: true })
        .catch(() => {});
    }
    if (tracing && app) {
      await app
        .context()
        .tracing.stop({ path: testInfo.outputPath("trace.zip") })
        .catch(() => {});
      tracing = false;
    }
    throw error;
  } finally {
    if (tracing && app)
      await app
        .context()
        .tracing.stop()
        .catch(() => {});
    try {
      await app?.close();
    } catch (error) {
      logs.push(`[cleanup] ${String(error)}\n`);
    } finally {
      try {
        await writeFile(
          testInfo.outputPath("main-process.log"),
          logs.join("") || "No main-process stdout or stderr captured.\n",
        );
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
});

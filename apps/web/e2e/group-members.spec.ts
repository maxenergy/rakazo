import { expect, test } from "@playwright/test";

for (const variant of ["robot", "organic"]) {
  for (const view of ["settings", "create"]) {
    test(`${view} member picker stays still across ${variant} avatar motion and status refresh`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`/e2e/fixtures/group-members.html?variant=${variant}&view=${view}`);
      const panel = page.getByTestId("group-panel");
      const researcher = panel.getByRole("button", { name: "Researcher", exact: true });
      const writer = panel.getByRole("button", { name: "Writer", exact: true });
      await expect(researcher).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (view === "create") {
        await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Draft team");
        await researcher.click();
        await writer.click();
      }
      const name = panel.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Unsaved team");
      await panel.getByRole("button", { name: "Reviewer", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Archived", exact: true })).toHaveCount(0);
      await expect(researcher).toHaveAttribute("aria-pressed", "true");
      const members = researcher.locator("..");
      await expect(members.locator("animate")).toHaveCount(0);
      expect(await members.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
      const nodes = await members.locator("button").elementHandles();
      const bounds = await members.boundingBox();
      await page.mouse.move(700, 500);
      const first = await members.screenshot({ animations: "allow" });
      // Include the running frame, idle frame and a return to running at the polling cadence.
      for (const refresh of [1, 2]) {
        await expect(page.getByTestId("refresh-count")).toHaveText(String(refresh));
        expect((await members.screenshot({ animations: "allow" })).equals(first)).toBe(true);
        expect(await members.boundingBox()).toEqual(bounds);
        for (const node of nodes) {
          expect(await node.evaluate((el) => el.isConnected)).toBe(true);
        }
        await expect(name).toHaveValue("Unsaved team");
        await expect(panel.locator('button[aria-pressed="true"]')).toHaveCount(3);
      }
      await testInfo.attach(`group-members-${view}-${variant}`, {
        body: await panel.screenshot({ animations: "allow" }),
        contentType: "image/png",
      });
      await panel
        .getByRole("button", {
          name: view === "create" ? "Create group" : "Save",
          exact: true,
        })
        .click();
      await expect(page.getByTestId("saved-input")).toHaveText(
        JSON.stringify({
          name: "Unsaved team",
          botIds: ["fixture-bot-0", "fixture-bot-1", "fixture-bot-2"],
        }),
      );
    });
  }
}

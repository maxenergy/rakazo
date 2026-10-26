import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
describe("host work location RPC boundary", () => {
  it("rejects bot callers inheriting owner identity before reading or writing host settings", async () => {
    const updateMany = vi.fn();
    const findMany = vi.fn();
    const deps = {
      prisma: { bot: { updateMany }, hostAuditLog: { findMany } },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    await expect(
      client.bots.setWorkLocation({ botId: "employee", workLocation: "host", hostRoots: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.bots.hostAuditLogs({ botId: "employee", limit: 50 })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

describe("employee continuation preview", () => {
  it("includes former ticket/routine projects and paused current memberships with no writes", async () => {
    const actor = {
      userId: "user-1",
      spaceId: "space-1",
      email: "fake@rakazo.test",
      isDeploymentOwner: true,
    };
    const ticket = { id: "ticket-1", projectId: "former", title: "Unfinished", status: "doing" };
    const routine = {
      id: "routine-1",
      projectId: "former",
      botId: "bot-1",
      name: "Disabled",
      prompt: "Work",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: false,
      notify: false,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-01-01"),
    };
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1", archivedAt: new Date() })) },
      projectMember: { findMany: vi.fn(async () => [{ projectId: "current" }]) },
      ticket: { findMany: vi.fn(async () => [ticket]) },
      routine: { findMany: vi.fn(async () => [routine]) },
      project: {
        findMany: vi.fn(async () => [
          { id: "current", name: "Current", status: "paused", archivedAt: null },
          { id: "former", name: "Former", status: "active", archivedAt: null },
        ]),
      },
    };
    const client = createRouterClient(createRouter({ prisma, env: {} } as unknown as RouterDeps), {
      context: { actor },
    });
    const preview = await client.bots.continuationPreview({ botId: "bot-1" });
    expect(preview).toMatchObject({
      botId: "bot-1",
      tickets: [ticket],
      routines: [{ id: "routine-1", active: false, projectId: "former" }],
      projects: [
        { id: "current", status: "paused", member: true },
        { id: "former", member: false },
      ],
    });
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: actor.spaceId,
          assigneeBotId: "bot-1",
          status: { notIn: ["done", "closed"] },
        },
      }),
    );
    expect(prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: actor.spaceId, userId: actor.userId, botId: "bot-1", active: false },
      }),
    );
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: actor.spaceId, id: { in: ["current", "former"] } },
      }),
    );
  });
});

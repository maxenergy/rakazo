import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("disabled ticket board", () => {
  it.each([undefined, false])(
    "refuses every route and stream before accessing the database (%s)",
    async (enabled) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const follow = vi.fn();
      const prisma = new Proxy({}, { get: () => query });
      const client = createRouterClient(
        createRouter({
          prisma,
          env: { ticketBoardEnabled: enabled },
          boardEvents: { follow },
        } as unknown as RouterDeps),
        { context: { actor } },
      );
      const calls = [
        () => client.boards.list(),
        () => client.boards.get(),
        () => client.boards.rename({ name: "Launch" }),
        () => client.boards.subscribe(),
        () => client.projects.list({}),
        () => client.projects.get({ id: "project-1" }),
        () => client.projects.create({ name: "Launch" }),
        () => client.projects.update({ id: "project-1", name: "Changed" }),
        () => client.projects.archive({ id: "project-1" }),
        () => client.projects.delete({ id: "project-1" }),
        () => client.milestones.list({ projectId: "project-1" }),
        () => client.milestones.get({ id: "milestone-1" }),
        () => client.milestones.create({ projectId: "project-1", name: "Launch" }),
        () => client.milestones.update({ id: "milestone-1", name: "Changed" }),
        () => client.milestones.archive({ id: "milestone-1" }),
        () => client.milestones.delete({ id: "milestone-1" }),
        () => client.tickets.list({}),
        () => client.tickets.get({ id: "ticket-1" }),
        () => client.tickets.create({ title: "Launch", assigneeBotId: "bot-1" }),
        () => client.tickets.update({ id: "ticket-1", assigneeBotId: "bot-1" }),
        () => client.tickets.move({ id: "ticket-1", status: "doing" }),
        () => client.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
        () => client.tickets.comments({ ticketId: "ticket-1" }),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(query).not.toHaveBeenCalled();
      expect(follow).not.toHaveBeenCalled();
    },
  );
});

it.each([false, true])("includes the board capability in me (%s)", async (ticketBoardEnabled) => {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "user@rakazo.test",
        name: "Test",
        avatarStyle: "robot",
      })),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
  };
  const deps = {
    prisma,
    env: {
      ticketBoardEnabled,
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  await expect(client.me()).resolves.toHaveProperty("ticketBoardEnabled", ticketBoardEnabled);
});

it("requires an authenticated actor for project and milestone routes", async () => {
  const query = vi.fn(() => {
    throw new Error("Unexpected database access");
  });
  const client = createRouterClient(
    createRouter({
      prisma: new Proxy({}, { get: () => query }),
      env: { ticketBoardEnabled: true },
    } as unknown as RouterDeps),
    { context: { actor: undefined } },
  );
  const calls = [
    () => client.projects.list({}),
    () => client.projects.get({ id: "project-1" }),
    () => client.projects.create({ name: "Launch" }),
    () => client.projects.update({ id: "project-1", name: "Changed" }),
    () => client.projects.archive({ id: "project-1" }),
    () => client.projects.delete({ id: "project-1" }),
    () => client.milestones.list({ projectId: "project-1" }),
    () => client.milestones.get({ id: "milestone-1" }),
    () => client.milestones.create({ projectId: "project-1", name: "Launch" }),
    () => client.milestones.update({ id: "milestone-1", name: "Changed" }),
    () => client.milestones.archive({ id: "milestone-1" }),
    () => client.milestones.delete({ id: "milestone-1" }),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(query).not.toHaveBeenCalled();
});

import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("ticket association API isolation", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `api-links-org-${suffix}`;
  const userId = `api-links-user-${suffix}`;
  const spaceId = `api-links-local-${suffix}`;
  const foreignSpaceId = `api-links-foreign-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let projectId: string;
  let milestoneId: string;
  let foreignProjectId: string;
  let foreignMilestoneId: string;
  const changes = vi.fn(async () => {});
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        env: { ticketBoardEnabled: true },
        ticketChanges: changes,
      } as unknown as RouterDeps),
      { context: { actor } },
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id: userId, name: "API tester", email: actor.email } });
    await prisma.organization.create({
      data: { id: organizationId, name: "API links", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.createMany({
      data: [
        { id: spaceId, organizationId, name: "Local" },
        { id: foreignSpaceId, organizationId, name: "Foreign" },
      ],
    });
    botId = (
      await prisma.bot.create({ data: { spaceId, userId, name: "Assignee", color: "blue" } })
    ).id;
    projectId = (await prisma.project.create({ data: { spaceId, name: "Local project" } })).id;
    milestoneId = (
      await prisma.milestone.create({ data: { spaceId, projectId, name: "Local milestone" } })
    ).id;
    foreignProjectId = (
      await prisma.project.create({ data: { spaceId: foreignSpaceId, name: "Foreign project" } })
    ).id;
    foreignMilestoneId = (
      await prisma.milestone.create({
        data: { spaceId: foreignSpaceId, projectId: foreignProjectId, name: "Foreign milestone" },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });

  it("returns indistinguishable NOT_FOUND errors for foreign and missing associations without writing or notifying", async () => {
    const api = client();
    const before = await prisma.ticket.count({ where: { spaceId } });
    changes.mockClear();
    for (const patch of [
      { projectId: foreignProjectId },
      { projectId: `missing-${suffix}` },
      { milestoneId: foreignMilestoneId },
      { milestoneId: `missing-${suffix}` },
    ]) {
      await expect(
        api.tickets.create({ title: "Rejected", assigneeBotId: botId, ...patch }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found." });
    }
    expect(await prisma.ticket.count({ where: { spaceId } })).toBe(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it("rejects a same-space project mismatch and preserves existing links on rejected updates", async () => {
    const api = client();
    const other = await prisma.project.create({ data: { spaceId, name: "Other project" } });
    const ticket = await api.tickets.create({ title: "Linked", assigneeBotId: botId, milestoneId });
    changes.mockClear();
    await expect(
      api.tickets.update({ id: ticket.id, projectId: other.id, milestoneId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.tickets.update({ id: ticket.id, projectId: foreignProjectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      spaceId,
      projectId,
      milestoneId,
    });
    expect(changes).not.toHaveBeenCalled();
  });

  it("ignores caller-supplied spaceId and resolves associations in the authenticated space", async () => {
    const input = { title: "Scoped", assigneeBotId: botId, milestoneId, spaceId: foreignSpaceId };
    const ticket = await client().tickets.create(input);
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      spaceId,
      projectId,
      milestoneId,
    });
    const foreignInput = {
      title: "Rejected override",
      assigneeBotId: botId,
      projectId: foreignProjectId,
      spaceId: foreignSpaceId,
    };
    await expect(client().tickets.create(foreignInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

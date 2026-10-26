import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeGoalTool, isGoalToolName } from "./goal-tools.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
(enabled ? describe.sequential : describe.skip)("Goal tools PostgreSQL acceptance", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const prisma = db.prisma;
  const id = `goal-tools-${process.pid}-${Date.now()}`;
  const foreign = `${id}-foreign`;
  let projectId: string;
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id, name: "Tool fixtures", slug: id, createdAt: new Date() },
    });
    await prisma.space.createMany({
      data: [
        { id, organizationId: id, name: "Local" },
        { id: foreign, organizationId: id, name: "Foreign" },
      ],
    });
    projectId = (await prisma.project.create({ data: { spaceId: id, name: "Tool project" } })).id;
  });
  afterAll(async () => {
    try {
      await prisma.organization.deleteMany({ where: { id } });
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });
  it("gates disabled tools before accessing persistence", async () => {
    expect(await executeGoalTool({ prisma }, id, "goal_list", {})).toEqual({
      error: "Ticket board is disabled.",
    });
    expect(isGoalToolName("goal_archive")).toBe(false);
    expect(isGoalToolName("toString")).toBe(false);
  });
  it("isolates records and preserves values when archived-project writes fail", async () => {
    const deps = { prisma, ticketBoardEnabled: true };
    const goal = (await executeGoalTool(deps, id, "goal_create", {
      projectId,
      name: "Revenue",
    })) as { id: string };
    expect(goal.id).toBeTruthy();
    expect(await executeGoalTool(deps, foreign, "goal_get", { id: goal.id })).toEqual({
      error: "Resource not found.",
    });
    const kr = (await executeGoalTool(deps, id, "key_result_create", {
      goalId: goal.id,
      name: "Verified revenue",
      measure: "USD",
      targetValue: 100,
      currentValue: 0,
      calculationRule: "Verified receipts",
    })) as { id: string };
    expect(kr.id).toBeTruthy();
    expect(
      await executeGoalTool(deps, foreign, "key_result_update", { id: kr.id, currentValue: 99 }),
    ).toEqual({ error: "Resource not found." });
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    for (const [name, args] of [
      ["goal_delete", { id: goal.id }],
      ["key_result_archive", { id: kr.id }],
      ["key_result_delete", { id: kr.id }],
      ["key_result_update", { id: kr.id, currentValue: 50 }],
    ] as const) {
      expect(await executeGoalTool(deps, id, name, args)).toEqual({
        error: "Project is archived.",
      });
    }
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      currentValue: 0,
      archivedAt: null,
    });
    expect(await executeGoalTool(deps, id, "goal_get", { id: goal.id })).toMatchObject({
      archived: true,
    });
  });
  it("manages project members using the same scoped persistence rules", async () => {
    const userId = id + "-member-user";
    await prisma.user.create({
      data: { id: userId, email: userId + "@example.test", name: "Fixture" },
    });
    try {
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId, name: "Member", color: "blue" },
      });
      const deps = { prisma, ticketBoardEnabled: true };
      expect(
        await executeGoalTool(deps, id, "project_set_owner", { projectId, botId: bot.id }),
      ).toMatchObject([{ botId: bot.id, role: "owner" }]);
      expect(
        await executeGoalTool(deps, id, "project_add_member", { projectId, botId: bot.id }),
      ).toMatchObject([{ role: "owner" }]);
      expect(await executeGoalTool(deps, foreign, "project_members", { projectId })).toEqual({
        error: "Resource not found.",
      });
      expect(
        await executeGoalTool(deps, id, "project_set_owner", { projectId, botId: null }),
      ).toMatchObject([{ role: "member" }]);
      expect(
        await executeGoalTool(deps, id, "project_remove_member", { projectId, botId: bot.id }),
      ).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});

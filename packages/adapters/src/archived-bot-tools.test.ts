import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { executeArchivedBotTool } from "./archived-bot-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";

const scope = { spaceId: "space", botId: "cto" };
function fixture(role = "cto") {
  const employee = {
    id: "employee",
    userId: "owner",
    archivedAt: new Date("2026-01-01"),
    computer: null,
    memory: "retained",
    name: "Employee",
  };
  const routine = {
    id: "routine",
    name: "Disabled",
    projectId: "old",
    active: false,
    crons: ["0 9 * * *"],
    timezone: "UTC",
    webhookSecret: "private-placeholder",
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "cto"
          ? { orgRole: role }
          : where.id === "employee" && where.spaceId === "space"
            ? employee
            : null,
      ),
      findMany: vi.fn(async () => [
        {
          id: employee.id,
          name: employee.name,
          title: "Engineer",
          modelProvider: "provider",
          modelId: "model",
          archivedAt: employee.archivedAt,
        },
      ]),
      update: vi.fn(async ({ data }) => Object.assign(employee, data)),
    },
    project: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "new"
          ? {
              id: "new",
              name: "New",
              status: "paused",
            }
          : null,
      ),
      findMany: vi.fn(async () => [
        { id: "old", name: "Old", status: "active", archivedAt: null },
        { id: "new", name: "New", status: "paused", archivedAt: null },
      ]),
    },
    projectMember: {
      findMany: vi.fn(async () => [
        {
          projectId: "old",
          createdAt: new Date("2026-01-01"),
          role: "member",
          project: { name: "Old", status: "active" },
        },
      ]),
      upsert: vi.fn(async () => ({})),
    },
    ticket: {
      findMany: vi.fn(async ({ take }) =>
        take
          ? [
              {
                number: 7,
                title: "Recent",
                status: "doing",
                board: { ticketPrefix: "RAK" },
              },
            ]
          : [{ id: "ticket", title: "Unfinished", status: "doing", projectId: "old" }],
      ),
    },
    routine: {
      findMany: vi.fn(async () => [routine]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const call = (name: Parameters<typeof executeArchivedBotTool>[2], args = {}) =>
    executeArchivedBotTool({ prisma: prisma as unknown as PrismaClient }, scope, name, args);
  return { prisma, employee, call };
}

describe("archived employee tools", () => {
  it("lists only this space's archived employees with project membership and five recent tickets", async () => {
    const { call, prisma } = fixture("ceo");
    expect(await call("list_archived_bots")).toEqual({
      bots: [
        {
          id: "employee",
          name: "Employee",
          title: "Engineer",
          modelProvider: "provider",
          modelId: "model",
          archivedAt: "2026-01-01T00:00:00.000Z",
          projects: [{ projectId: "old", role: "member", name: "Old", status: "active" }],
          tickets: [{ ref: "RAK-7", title: "Recent", status: "doing" }],
        },
      ],
    });
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", archivedAt: { not: null } },
      }),
    );
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", assigneeBotId: "employee" },
        take: 5,
      }),
    );
  });

  it("previews original work and paused target without writes or exposing routine credentials", async () => {
    const { call, prisma } = fixture();
    const result = await call("preview_restore_bot", { botId: "employee", projectId: "new" });
    expect(result).toMatchObject({
      botId: "employee",
      targetProjectPaused: true,
      projects: [
        { id: "old", member: true },
        { id: "new", status: "paused" },
      ],
      tickets: [{ id: "ticket", projectId: "old" }],
      routines: [{ id: "routine", active: false }],
    });
    expect(JSON.stringify(result)).not.toContain("private-placeholder");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
    expect(prisma.routine.updateMany).not.toHaveBeenCalled();
    expect(prisma.projectMember.upsert).not.toHaveBeenCalled();
  });

  it("restores the same identity into a paused project, leaves routines disabled and returns continuation", async () => {
    const { call, prisma, employee } = fixture();
    const result = await call("restore_bot", { botId: "employee", projectId: "new" });
    expect(result).toMatchObject({ ok: true, botId: "employee", targetProjectPaused: true });
    expect(employee).toMatchObject({
      id: "employee",
      name: "Employee",
      memory: "retained",
      archivedAt: null,
    });
    expect(prisma.bot.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "employee" },
      data: { archivedAt: null },
    });
    expect(prisma.routine.updateMany).toHaveBeenCalledWith({
      where: { spaceId: "space", botId: "employee" },
      data: { active: false, nextRunAt: null },
    });
    expect(prisma.projectMember.upsert).toHaveBeenCalledWith({
      where: { projectId_botId: { projectId: "new", botId: "employee" } },
      create: { projectId: "new", botId: "employee", role: "member" },
      update: {},
    });
  });

  it("rejects non-executive callers for every tool before reading targets or writing", async () => {
    const { call, prisma } = fixture("member");
    for (const name of ["list_archived_bots", "preview_restore_bot", "restore_bot"] as const) {
      expect(await call(name, { botId: "employee" })).toHaveProperty("error");
    }
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bot.findFirst).toHaveBeenCalledTimes(3);
  });

  it("rejects a foreign caller, employee or target project before mutation", async () => {
    const { call, prisma } = fixture();
    for (const name of ["preview_restore_bot", "restore_bot"] as const) {
      expect(await call(name, { botId: "foreign" })).toHaveProperty("error");
      expect(await call(name, { botId: "employee", projectId: "foreign-project" })).toHaveProperty(
        "error",
      );
    }
    prisma.bot.findFirst.mockResolvedValueOnce(null);
    expect(await call("list_archived_bots")).toHaveProperty("error");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign-project", spaceId: "space" },
      }),
    );
  });

  it("exposes the tools only to CEO/CTO runs", () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      orgMessaging: true,
    };
    for (const role of ["member", "lead", "ceo", "cto"]) {
      const names = selectBuiltinToolsForRun({ ...options, orgRole: role }).map(
        (tool) => tool.name,
      );
      expect(names.includes("restore_bot")).toBe(["ceo", "cto"].includes(role));
    }
  });
});

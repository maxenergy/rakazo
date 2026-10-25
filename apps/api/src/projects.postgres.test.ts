import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
describePostgres("project and milestone API isolation", () => {
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
  const notify = vi.fn(async (_spaceId: string) => {});
  const changes = vi.fn(async () => {});
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        env: { ticketBoardEnabled: true },
        ticketChanges: changes,
        boardEvents: { notify },
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

  afterEach(async () => {
    const violations = await prisma.$queryRaw<
      { projects: bigint; milestones: bigint; mismatches: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM tickets t JOIN projects p ON p.id = t."projectId" WHERE t."spaceId" <> p."spaceId") AS projects,
        (SELECT count(*) FROM tickets t JOIN milestones m ON m.id = t."milestoneId" WHERE t."spaceId" <> m."spaceId") AS milestones,
        (SELECT count(*) FROM tickets t JOIN milestones m ON m.id = t."milestoneId" WHERE t."projectId" IS DISTINCT FROM m."projectId") AS mismatches
    `;
    expect(violations).toEqual([{ projects: 0n, milestones: 0n, mismatches: 0n }]);
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

  it("hides foreign and missing resources consistently without notifying", async () => {
    const api = client();
    notify.mockClear();
    const foreignSnapshot = async () => ({
      projects: await prisma.project.findMany({
        where: { spaceId: foreignSpaceId },
        orderBy: { id: "asc" },
      }),
      milestones: await prisma.milestone.findMany({
        where: { spaceId: foreignSpaceId },
        orderBy: { id: "asc" },
      }),
      tickets: await prisma.ticket.findMany({
        where: { spaceId: foreignSpaceId },
        orderBy: { id: "asc" },
      }),
    });
    const before = await foreignSnapshot();
    for (const id of [foreignProjectId, `missing-${suffix}`]) {
      for (const action of [
        () => api.projects.get({ id }),
        () => api.projects.budget({ projectId: id }),
        () => api.projects.setBudget({ projectId: id, limitMicroUsd: "1000000" }),
        () => api.projects.update({ id, name: "Rejected" }),
        () => api.projects.archive({ id }),
        () => api.projects.delete({ id }),
        () => api.milestones.list({ projectId: id }),
        () => api.milestones.create({ projectId: id, name: "Rejected" }),
      ]) {
        await expect(action()).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found.",
        });
        expect(await foreignSnapshot()).toEqual(before);
      }
    }
    for (const id of [foreignMilestoneId, `missing-${suffix}`]) {
      for (const action of [
        () => api.milestones.get({ id }),
        () => api.milestones.update({ id, name: "Rejected" }),
        () => api.milestones.archive({ id }),
        () => api.milestones.delete({ id }),
      ]) {
        await expect(action()).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found.",
        });
        expect(await foreignSnapshot()).toEqual(before);
      }
    }
    expect(notify).not.toHaveBeenCalled();
    expect((await api.projects.list({})).map((row) => row.id)).not.toContain(foreignProjectId);
    expect((await api.milestones.list({ projectId })).map((row) => row.id)).toEqual([milestoneId]);
  });

  it("preserves exact budget amounts and versions through the API", async () => {
    const api = client();
    const project = await api.projects.create({ name: "Exact budget" });
    expect(await api.projects.budget({ projectId: project.id })).toBeNull();
    const first = await api.projects.setBudget({
      projectId: project.id,
      limitMicroUsd: "9007199254740993",
    });
    expect(first).toMatchObject({
      projectId: project.id,
      version: 1,
      limitMicroUsd: "9007199254740993",
      reservedMicroUsd: "0",
      settledMicroUsd: "0",
    });
    expect(await api.projects.budget({ projectId: project.id })).toEqual(first);
    const second = await api.projects.setBudget({ projectId: project.id, limitMicroUsd: "0" });
    expect(second).toMatchObject({ version: 2, limitMicroUsd: "0" });
    const versions = await prisma.projectBudgetVersion.findMany({
      where: { budget: { projectId: project.id } },
      orderBy: { version: "asc" },
    });
    expect(versions.map((row) => row.limitMicroUsd)).toEqual([9007199254740993n, 0n]);
  });

  it("retains associations and progress when the parent is archived", async () => {
    const api = client();
    const project = await api.projects.create({ name: "Archive progress" });
    const milestone = await api.milestones.create({ projectId: project.id, name: "Child" });
    expect(project.progress).toEqual({ total: 0, completed: 0, ratio: null });
    const ticket = await api.tickets.create({
      title: "Completed",
      assigneeBotId: botId,
      milestoneId: milestone.id,
    });
    await api.tickets.update({ id: ticket.id, status: "done" });
    notify.mockClear();
    notify.mockImplementationOnce(async (scope) => {
      expect(scope).toBe(spaceId);
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).archivedAt,
      ).not.toBeNull();
    });
    expect((await api.projects.archive({ id: project.id })).progress).toEqual({
      total: 1,
      completed: 1,
      ratio: 1,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await api.milestones.get({ id: milestone.id })).toMatchObject({
      archived: true,
      archivedAt: null,
      progress: { total: 1, completed: 1, ratio: 1 },
    });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: milestone.id,
    });
    expect(await api.milestones.list({ projectId: project.id })).toEqual([]);
    expect(
      (await api.milestones.list({ projectId: project.id, archived: true })).map((row) => row.id),
    ).toEqual([milestone.id]);
    await api.tickets.update({ id: ticket.id, status: "doing" });
    expect((await api.projects.get({ id: project.id })).progress).toEqual({
      total: 1,
      completed: 0,
      ratio: 0,
    });
  });

  it("filters null, omitted and switched project associations with AND-scoped search", async () => {
    const api = client();
    const a = await api.projects.create({ name: "Filter A" });
    const b = await api.projects.create({ name: "Filter B" });
    const m = await api.milestones.create({ projectId: a.id, name: "Filter milestone" });
    const linked = await api.tickets.create({
      title: "Needle linked",
      assigneeBotId: botId,
      milestoneId: m.id,
    });
    const plain = await api.tickets.create({ title: "Needle plain", assigneeBotId: botId });
    const ids = async (filter: Parameters<typeof api.tickets.list>[0]) =>
      (await api.tickets.list(filter)).tickets.map((row) => row.id);
    expect(await ids({ q: "Needle" })).toEqual(expect.arrayContaining([linked.id, plain.id]));
    expect(await ids({ q: "Needle", projectId: a.id })).toEqual([linked.id]);
    expect(await ids({ q: "Needle", projectId: null })).toEqual([plain.id]);
    expect(await ids({ q: "Needle", milestoneId: null })).toEqual([plain.id]);
    expect(await ids({ projectId: a.id, milestoneId: m.id, status: "done" })).toEqual([]);
    await expect(ids({ projectId: b.id, milestoneId: m.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    for (const filter of [
      { projectId: foreignProjectId },
      { projectId: `missing-${suffix}` },
      { milestoneId: foreignMilestoneId },
      { milestoneId: `missing-${suffix}` },
    ]) {
      await expect(ids(filter)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found.",
      });
    }
    await api.tickets.update({ id: linked.id, projectId: b.id });
    expect(await ids({ projectId: a.id })).toEqual([]);
    expect(await ids({ projectId: b.id })).toEqual([linked.id]);
    expect(await ids({ q: "Needle", milestoneId: null })).toEqual(
      expect.arrayContaining([linked.id, plain.id]),
    );
  });

  it("counts direct tickets once across milestones, closed, unknown and reopened states", async () => {
    const api = client();
    const project = await api.projects.create({ name: "Aggregate" });
    const first = await api.milestones.create({ projectId: project.id, name: "First" });
    const second = await api.milestones.create({ projectId: project.id, name: "Second" });
    const tickets = [];
    for (const milestoneId of [first.id, second.id, undefined]) {
      tickets.push(
        await api.tickets.create({
          title: "Counted",
          assigneeBotId: botId,
          projectId: project.id,
          milestoneId,
        }),
      );
    }
    expect((await api.projects.get({ id: project.id })).progress).toEqual({
      total: 3,
      completed: 0,
      ratio: 0,
    });
    await api.tickets.update({ id: tickets[0]!.id, status: "done" });
    await api.tickets.update({ id: tickets[1]!.id, status: "closed" });
    await prisma.ticket.update({
      where: { id: tickets[2]!.id },
      data: { status: "legacy-unknown" },
    });
    expect((await api.projects.get({ id: project.id })).progress).toEqual({
      total: 3,
      completed: 2,
      ratio: 2 / 3,
    });
    expect((await api.milestones.get({ id: first.id })).progress).toEqual({
      total: 1,
      completed: 1,
      ratio: 1,
    });
    await api.tickets.update({ id: tickets[0]!.id, status: "todo" });
    expect((await api.projects.get({ id: project.id })).progress).toEqual({
      total: 3,
      completed: 1,
      ratio: 1 / 3,
    });
    expect((await api.milestones.get({ id: first.id })).progress).toEqual({
      total: 1,
      completed: 0,
      ratio: 0,
    });
  });

  it("updates, searches, archives and deletes local resources with committed notifications", async () => {
    const api = client();
    const project = await api.projects.create({ name: "CRUD project" });
    const milestone = await api.milestones.create({
      projectId: project.id,
      name: "CRUD milestone",
    });
    notify.mockClear();
    notify.mockImplementationOnce(async (scope) => {
      expect(scope).toBe(spaceId);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe(
        "Searchable project",
      );
    });
    await api.projects.update({
      id: project.id,
      name: "Searchable project",
      description: "Unique project description",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      (await api.projects.list({ q: "Unique project description" })).map((row) => row.id),
    ).toEqual([project.id]);
    const dueAt = "2026-12-01T00:00:00.000Z";
    expect(
      await api.milestones.update({
        id: milestone.id,
        name: "Searchable milestone",
        description: "Unique milestone description",
        dueAt,
      }),
    ).toMatchObject({ name: "Searchable milestone", dueAt });
    expect(
      (await api.milestones.list({ projectId: project.id, q: "Unique milestone description" })).map(
        (row) => row.id,
      ),
    ).toEqual([milestone.id]);
    expect(
      await api.milestones.update({ id: milestone.id, description: null, dueAt: null }),
    ).toMatchObject({ description: null, dueAt: null });
    const ticket = await api.tickets.create({
      title: "Retained ticket",
      assigneeBotId: botId,
      milestoneId: milestone.id,
    });
    await api.milestones.archive({ id: milestone.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: milestone.id,
    });
    expect(
      (await api.milestones.list({ projectId: project.id, archived: true })).map((row) => row.id),
    ).toEqual([milestone.id]);
    notify.mockClear();
    notify.mockImplementationOnce(async () => {
      expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).toBeNull();
      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
        projectId: project.id,
        milestoneId: null,
      });
    });
    await expect(api.milestones.delete({ id: milestone.id })).resolves.toEqual({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
    const child = await api.milestones.create({ projectId: project.id, name: "Deleted child" });
    await api.tickets.update({ id: ticket.id, milestoneId: child.id });
    notify.mockClear();
    notify.mockImplementationOnce(async () => {
      expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
      expect(await prisma.milestone.findUnique({ where: { id: child.id } })).toBeNull();
      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
        projectId: null,
        milestoneId: null,
      });
    });
    await expect(api.projects.delete({ id: project.id })).resolves.toEqual({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("rolls back writes and sends no event when the transaction fails", async () => {
    const api = client();
    const before = await prisma.project.count({ where: { spaceId } });
    const original = prisma.$transaction.bind(prisma);
    const failure = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
      operation: (tx: unknown) => Promise<unknown>,
      options: unknown,
    ) =>
      original(async (tx) => {
        await operation(tx);
        throw new Error("Synthetic rollback");
      }, options as never)) as never);
    notify.mockClear();
    try {
      await expect(api.projects.create({ name: "Rolled back" })).rejects.toThrow(
        "Synthetic rollback",
      );
    } finally {
      failure.mockRestore();
    }
    expect(await prisma.project.count({ where: { spaceId } })).toBe(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it("isolates Goal/KR API resources and preserves archived project history", async () => {
    const api = client();
    const project = await api.projects.create({ name: "Goal API project" });
    const goal = await api.goals.create({ projectId: project.id, name: "Revenue" });
    const kr = await api.keyResults.create({
      goalId: goal.id,
      name: "Sales",
      measure: "USD",
      targetValue: 100,
      currentValue: 0,
      calculationRule: "Verified sales",
    });
    expect(await api.goals.get({ id: goal.id })).toMatchObject({
      id: goal.id,
      projectId: project.id,
    });
    expect(await api.keyResults.update({ id: kr.id, currentValue: 25 })).toMatchObject({
      currentValue: 25,
    });
    notify.mockClear();
    await expect(
      api.goals.create({ projectId: foreignProjectId, name: "Forbidden" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(notify).not.toHaveBeenCalled();
    await api.projects.archive({ id: project.id });
    expect(await api.goals.get({ id: goal.id })).toMatchObject({
      archived: true,
      archivedAt: null,
    });
    expect(await api.keyResults.get({ id: kr.id })).toMatchObject({
      archived: true,
      currentValue: 25,
      archivedAt: null,
    });
    notify.mockClear();
    await expect(api.goals.update({ id: goal.id, state: "achieved" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(api.keyResults.update({ id: kr.id, currentValue: 100 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      api.keyResults.create({
        goalId: goal.id,
        name: "Blocked",
        measure: "USD",
        targetValue: 1,
        currentValue: 0,
        calculationRule: "Verified",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.goals.delete({ id: goal.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.keyResults.archive({ id: kr.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(api.keyResults.delete({ id: kr.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(notify).not.toHaveBeenCalled();
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      currentValue: 25,
      archivedAt: null,
    });
  });
  it("validates dependency edits and isolates prerequisite rows", async () => {
    const api = client();
    const a = await api.tickets.create({ title: "Dependency downstream", assigneeBotId: botId });
    const b = await api.tickets.create({ title: "Dependency prerequisite", assigneeBotId: botId });
    const foreignBoard = await prisma.board.upsert({
      where: { spaceId: foreignSpaceId },
      update: {},
      create: { spaceId: foreignSpaceId, name: "Foreign dependencies" },
    });
    const foreign = await prisma.ticket.create({
      data: {
        spaceId: foreignSpaceId,
        boardId: foreignBoard.id,
        number: 900001,
        title: "Foreign prerequisite",
      },
    });
    await expect(
      api.tickets.addDependency({ ticketId: a.id, prerequisiteId: a.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.tickets.addDependency({ ticketId: a.id, prerequisiteId: "" }),
    ).rejects.toThrow();
    await expect(
      api.tickets.addDependency({ ticketId: a.id, prerequisiteId: foreign.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const added = await api.tickets.addDependency({ ticketId: a.id, prerequisiteId: b.id });
    expect(added).toMatchObject({ blockedByDependency: true, prerequisites: [{ id: b.id }] });
    expect(await api.tickets.dependencies({ ticketId: b.id })).toMatchObject({
      dependents: [{ id: a.id }],
    });
    expect(
      await api.tickets.removeDependency({ ticketId: a.id, prerequisiteId: b.id }),
    ).toMatchObject({ prerequisites: [], blockedByDependency: false });
  });
  it("exposes membership and owner through the API and rejects foreign projects", async () => {
    const api = client();
    const project = await api.projects.create({ name: "Members" });
    expect(project).toMatchObject({ status: "active", pausedAt: null, owner: null });
    await api.projects.setOwner({ projectId: project.id, botId });
    expect(await api.projects.get({ id: project.id })).toMatchObject({
      owner: { botId, role: "owner" },
    });
    expect((await api.bots.get({ botId })).projects).toContainEqual({
      projectId: project.id,
      name: "Members",
      role: "owner",
      status: "active",
    });
    expect(await api.projects.addMember({ projectId: project.id, botId })).toHaveLength(1);
    expect(await api.projects.members({ projectId: project.id })).toMatchObject([
      { botId, role: "owner" },
    ]);
    await expect(api.projects.members({ projectId: foreignProjectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      api.projects.setOwner({ projectId: foreignProjectId, botId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await api.projects.removeMember({ projectId: project.id, botId })).toEqual([]);
    expect((await api.projects.get({ id: project.id })).owner).toBeNull();
  });
});

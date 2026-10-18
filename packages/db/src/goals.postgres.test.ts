import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, Prisma } from "./client.js";
import {
  archiveKeyResult,
  createGoal,
  createKeyResult,
  deleteGoal,
  deleteKeyResult,
  updateGoal,
  updateKeyResult,
} from "./goal-writes.js";
import { readGoals, readKeyResults } from "./goals.js";
import {
  archiveMilestone,
  archiveProject,
  deleteMilestone,
  deleteProject,
} from "./project-links.js";
import { withTransactionRetry } from "./transaction-retry.js";

const enabled = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;
(enabled ? describe.sequential : describe.skip)("Goal/KR PostgreSQL acceptance", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const prisma = db.prisma;
  const organizationId = `goals-org-${process.pid}-${Date.now()}`;
  let spaceId: string;
  let foreignSpaceId: string;
  const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withTransactionRetry(() =>
      prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      }),
    );
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: organizationId, slug: organizationId, name: "Goal test", createdAt: new Date() },
    });
    spaceId = (
      await prisma.space.create({
        data: { id: organizationId + "-local", organizationId, name: "Local" },
      })
    ).id;
    foreignSpaceId = (
      await prisma.space.create({
        data: { id: organizationId + "-foreign", organizationId, name: "Foreign" },
      })
    ).id;
  });
  afterAll(async () => {
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function fixture() {
    const project = await prisma.project.create({ data: { spaceId, name: "Project" } });
    const milestone = await prisma.milestone.create({
      data: { spaceId, projectId: project.id, name: "Milestone" },
    });
    const goal = await transaction((tx) =>
      createGoal(tx, spaceId, { projectId: project.id, name: "Goal" }),
    );
    const kr = await transaction((tx) =>
      createKeyResult(tx, spaceId, {
        goalId: goal.id,
        milestoneId: milestone.id,
        name: "Revenue",
        measure: "USD",
        targetValue: 100,
        currentValue: 0,
        calculationRule: "Explicit verified revenue",
      }),
    );
    return { project, milestone, goal, kr };
  }
  it("installs the enabled milestone deletion trigger", async () => {
    const rows = await prisma.$queryRaw<{ definition: string; enabled: string }[]>`
      SELECT pg_get_triggerdef(oid) AS definition, tgenabled::text AS enabled
      FROM pg_trigger
      WHERE tgrelid = 'milestones'::regclass
        AND tgname = 'clear_key_result_milestone_link_before_delete'
        AND NOT tgisinternal
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe("O");
    expect(rows[0]?.definition).toContain("BEFORE DELETE");
    expect(rows[0]?.definition).toContain("FOR EACH ROW");
    expect(rows[0]?.definition).toContain("clear_key_result_milestone_link()");
  });
  it("clears only the deleted milestone link with baseline-style deletion", async () => {
    const first = await fixture();
    const second = await fixture();
    await prisma.milestone.delete({ where: { id: first.milestone.id } });
    expect(await prisma.keyResult.findUnique({ where: { id: first.kr.id } })).toMatchObject({
      milestoneId: null,
      projectId: first.project.id,
      goalId: first.goal.id,
      currentValue: 0,
    });
    expect(await prisma.keyResult.findUnique({ where: { id: second.kr.id } })).toMatchObject({
      milestoneId: second.milestone.id,
    });
  });
  it("rejects cross-project milestone links at the database boundary", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(
      prisma.keyResult.update({
        where: { id: first.kr.id },
        data: { milestoneId: second.milestone.id },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.keyResult.findUnique({ where: { id: first.kr.id } })).toMatchObject({
      milestoneId: first.milestone.id,
    });
  });
  it("allows baseline-style project deletion to cascade through linked records", async () => {
    const { project, milestone, goal, kr } = await fixture();
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).toBeNull();
    expect(await prisma.goal.findUnique({ where: { id: goal.id } })).toBeNull();
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toBeNull();
  });
  it("isolates reads and writes and rejects foreign milestone links", async () => {
    const { goal, kr, project } = await fixture();
    await expect(
      transaction((tx) => readGoals(tx, foreignSpaceId, { id: goal.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      transaction((tx) => updateKeyResult(tx, foreignSpaceId, { id: kr.id, currentValue: 10 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const foreignProject = await prisma.project.create({
      data: { spaceId: foreignSpaceId, name: "Other" },
    });
    const milestone = await prisma.milestone.create({
      data: { spaceId: foreignSpaceId, projectId: foreignProject.id, name: "Other" },
    });
    await expect(
      transaction((tx) => updateKeyResult(tx, spaceId, { id: kr.id, milestoneId: milestone.id })),
    ).rejects.toBeDefined();
    expect(
      (await transaction((tx) => readGoals(tx, spaceId, { projectId: project.id })))[0]?.id,
    ).toBe(goal.id);
  });
  it("keeps achievement explicit and returns the calculation rule", async () => {
    const { goal, kr } = await fixture();
    await transaction((tx) =>
      updateKeyResult(tx, spaceId, { id: kr.id, currentValue: 150, state: "active" }),
    );
    const rows = await transaction((tx) => readKeyResults(tx, spaceId, { goalId: goal.id }));
    expect(rows[0]).toMatchObject({
      currentValue: 150,
      targetValue: 100,
      state: "active",
      calculationRule: "Explicit verified revenue",
    });
  });
  it("preserves links and child timestamps on project archive", async () => {
    const { project, milestone, goal, kr } = await fixture();
    await transaction((tx) => archiveProject(tx, spaceId, project.id));
    expect(await transaction((tx) => readGoals(tx, spaceId, { projectId: project.id }))).toEqual(
      [],
    );
    expect((await transaction((tx) => readGoals(tx, spaceId, { id: goal.id })))[0]?.archived).toBe(
      true,
    );
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      milestoneId: milestone.id,
      archivedAt: null,
    });
    expect(
      (await prisma.milestone.findUnique({ where: { id: milestone.id } }))?.archivedAt,
    ).toBeNull();
    expect(
      (await transaction((tx) => readKeyResults(tx, spaceId, { id: kr.id })))[0]?.archived,
    ).toBe(true);
    await expect(
      transaction((tx) => updateGoal(tx, spaceId, { id: goal.id, state: "achieved" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      transaction((tx) => updateKeyResult(tx, spaceId, { id: kr.id, currentValue: 200 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      transaction((tx) =>
        createKeyResult(tx, spaceId, {
          goalId: goal.id,
          name: "Blocked",
          measure: "count",
          targetValue: 1,
          currentValue: 0,
          calculationRule: "Manual",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("preserves KR history on milestone archive", async () => {
    const { milestone, kr } = await fixture();
    await transaction((tx) => archiveMilestone(tx, spaceId, milestone.id));
    expect(
      (await transaction((tx) => readKeyResults(tx, spaceId, { id: kr.id })))[0]?.archived,
    ).toBe(true);
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      milestoneId: milestone.id,
      archivedAt: null,
    });
  });
  it("rejects KR updates and new links to archived milestones", async () => {
    const { milestone, kr, goal } = await fixture();
    await transaction((tx) => archiveMilestone(tx, spaceId, milestone.id));
    await expect(
      transaction((tx) => updateKeyResult(tx, spaceId, { id: kr.id, currentValue: 25 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      transaction((tx) =>
        createKeyResult(tx, spaceId, {
          goalId: goal.id,
          milestoneId: milestone.id,
          name: "Rejected archived link",
          measure: "count",
          targetValue: 10,
          currentValue: 0,
          calculationRule: "manual",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      milestoneId: milestone.id,
      archivedAt: null,
    });
  });
  it("rejects updates but permits archive and deletion after milestone archive", async () => {
    const first = await fixture();
    await transaction((tx) => archiveMilestone(tx, spaceId, first.milestone.id));
    await expect(
      transaction((tx) => updateKeyResult(tx, spaceId, { id: first.kr.id, currentValue: 10 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await transaction((tx) => archiveKeyResult(tx, spaceId, first.kr.id));
    expect(
      (await prisma.keyResult.findUnique({ where: { id: first.kr.id } }))?.archivedAt,
    ).toBeInstanceOf(Date);
    const second = await fixture();
    await transaction((tx) => archiveMilestone(tx, spaceId, second.milestone.id));
    await transaction((tx) => deleteKeyResult(tx, spaceId, second.kr.id));
    expect(await prisma.keyResult.findUnique({ where: { id: second.kr.id } })).toBeNull();
  });

  it("clears only the milestone link on milestone deletion", async () => {
    const { milestone, kr, goal } = await fixture();
    await transaction((tx) => deleteMilestone(tx, spaceId, milestone.id));
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      milestoneId: null,
      goalId: goal.id,
    });
  });
  it("cascades goal and project deletion without orphan KRs", async () => {
    const first = await fixture();
    await transaction((tx) => deleteGoal(tx, spaceId, first.goal.id));
    expect(await prisma.keyResult.findUnique({ where: { id: first.kr.id } })).toBeNull();
    const second = await fixture();
    await transaction((tx) => deleteProject(tx, spaceId, second.project.id));
    expect(await prisma.goal.findUnique({ where: { id: second.goal.id } })).toBeNull();
    expect(await prisma.keyResult.findUnique({ where: { id: second.kr.id } })).toBeNull();
  });
  it("serializes milestone deletion with KR updates", async () => {
    const { milestone, kr } = await fixture();
    await Promise.all([
      transaction((tx) => deleteMilestone(tx, spaceId, milestone.id)),
      transaction((tx) => updateKeyResult(tx, spaceId, { id: kr.id, currentValue: 20 })),
    ]);
    expect(await prisma.keyResult.findUnique({ where: { id: kr.id } })).toMatchObject({
      milestoneId: null,
      currentValue: 20,
    });
  });
});

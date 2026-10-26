import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideOverrunApproval,
  expireOverrunApprovals,
  requestOverrunApproval,
} from "./budget-overrun-approvals.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { reserveBudget, setProjectBudget, writeOffBudgetHolding } from "./project-budgets.js";
import { decideProposal } from "./proposals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("budget overrun approvals", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationId = `overrun-test-${crypto.randomUUID()}`;
  let spaceId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Overrun tests",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    spaceId = (
      await prisma.space.create({
        data: { id: `overrun-space-${crypto.randomUUID()}`, organizationId, name: "Overrun tests" },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      // Explicit cleanup of synthetic accounting fixtures in the disposable test database.
      const fixtureSpaces = await prisma.space.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const fixtureSpaceIds = fixtureSpaces.map((space) => space.id);
      await prisma.projectBudget.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.budgetSpendLedger.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function budgetFor(limitMicroUsd: bigint) {
    const project = await prisma.project.create({ data: { spaceId, name: "Overrun fixture" } });
    await setProjectBudget(prisma, { spaceId, projectId: project.id, limitMicroUsd });
    return project.id;
  }

  it("keeps an expired waiting_budget run and holding unchanged until explicit idempotent write-off", async () => {
    const projectId = await budgetFor(1_000_000n);
    const userId = `expiry-user-${crypto.randomUUID()}`;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Expiry fixture", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_budget",
        trigger: "user_message",
        projectId,
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_budget" },
    });
    const callId = `expiry-call-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const proposal = await prisma.proposal.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        kind: "decision",
        title: "Budget expiry",
        summary: "Synthetic expiry fixture",
        submitKey: crypto.randomUUID(),
      },
    });
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      proposalId: proposal.id,
      amountMicroUsd: 500_000n,
      requestKey: crypto.randomUUID(),
      scope: JSON.stringify({
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        attemptId: attempt.id,
        leaseFence: 1,
        callId,
      }),
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { spaceId, projectId, callId, amountMicroUsd: "500000" },
        }),
      },
    });
    // Model an unknown-cost provider call whose funds must remain held.
    await prisma.$executeRaw`UPDATE budget_reservations SET status = 'unreconciled' WHERE "spaceId" = ${spaceId} AND "callId" = ${callId}`;
    const holdingBefore = await prisma.budgetReservation.findUniqueOrThrow({
      where: { spaceId_callId: { spaceId, callId } },
    });
    const budgetBefore = await prisma.projectBudget.findUniqueOrThrow({
      where: { spaceId_projectId: { spaceId, projectId } },
    });
    const runBefore = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const attemptBefore = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const workBefore = await prisma.run.findMany({
      where: { threadId: thread.id },
      orderBy: { id: "asc" },
    });
    const tasksBefore = await prisma.task.findMany({
      where: { threadId: thread.id },
      orderBy: { id: "asc" },
    });
    const ledgerBefore = await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId } });
    expect(holdingBefore.status).toBe("unreconciled");
    expect(budgetBefore.reservedMicroUsd).toBe(100_000n);
    // Persist a deadline already elapsed according to PostgreSQL, without wall-clock sleeps.
    await prisma.$executeRaw`UPDATE budget_overrun_approvals SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${approval.id}`;
    const [deadline] = await prisma.$queryRaw<
      { elapsed: boolean }[]
    >`SELECT "expiresAt" <= clock_timestamp() AS elapsed FROM budget_overrun_approvals WHERE id = ${approval.id}`;
    expect(deadline?.elapsed).toBe(true);
    await expireOverrunApprovals(prisma);
    await expireOverrunApprovals(prisma);
    expect(
      await prisma.budgetOverrunApproval.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: "expired", appliedVersion: null });
    expect(await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({
      status: "expired",
      chosenOption: null,
    });
    await expect(
      decideProposal(prisma, { spaceId, userId }, { proposalId: proposal.id, decision: "approve" }),
    ).rejects.toThrow("already decided");
    expect(
      await decideOverrunApproval(prisma, {
        spaceId,
        approvalId: approval.id,
        decision: "approved",
      }),
    ).toMatchObject({ status: "expired", resume: false, appliedVersion: null });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toEqual(runBefore);
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(
      attemptBefore,
    );
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toEqual(holdingBefore);
    expect(
      await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId, projectId } },
      }),
    ).toEqual(budgetBefore);
    expect(
      await prisma.run.findMany({ where: { threadId: thread.id }, orderBy: { id: "asc" } }),
    ).toEqual(workBefore);
    expect(
      await prisma.task.findMany({ where: { threadId: thread.id }, orderBy: { id: "asc" } }),
    ).toEqual(tasksBefore);
    expect(await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId } })).toEqual(
      ledgerBefore,
    );
    expect(await prisma.budgetReservation.count({ where: { spaceId, projectId } })).toBe(1);
    const input = {
      spaceId,
      callId,
      actorUserId: userId,
      reason: "Synthetic unknown-cost holding reviewed",
    };
    expect(await writeOffBudgetHolding(prisma, input)).toMatchObject({ replayed: false });
    const writtenOff = await prisma.budgetReservation.findUniqueOrThrow({
      where: { spaceId_callId: { spaceId, callId } },
    });
    expect(writtenOff).toMatchObject({
      status: "written_off",
      writtenOffBy: userId,
      writeOffReason: input.reason,
    });
    expect(writtenOff.writtenOffAt).toBeInstanceOf(Date);
    expect(
      await prisma.run.findMany({ where: { threadId: thread.id }, orderBy: { id: "asc" } }),
    ).toEqual(workBefore);
    expect(
      await prisma.task.findMany({ where: { threadId: thread.id }, orderBy: { id: "asc" } }),
    ).toEqual(tasksBefore);
    expect(await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId } })).toEqual(
      ledgerBefore,
    );
    const budgetAfter = await prisma.projectBudget.findUniqueOrThrow({
      where: { spaceId_projectId: { spaceId, projectId } },
    });
    expect(budgetAfter).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: budgetBefore.settledMicroUsd,
      limitMicroUsd: budgetBefore.limitMicroUsd,
      version: budgetBefore.version,
    });
    const ledgerAfter = await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId } });
    expect(await writeOffBudgetHolding(prisma, input)).toMatchObject({ replayed: true });
    expect(await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId } })).toEqual(
      ledgerAfter,
    );
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toEqual(writtenOff);
    expect(
      await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId, projectId } },
      }),
    ).toEqual(budgetAfter);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toEqual(runBefore);
  });
});

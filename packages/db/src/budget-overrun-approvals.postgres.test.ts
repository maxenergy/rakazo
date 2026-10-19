import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideOverrunApproval,
  OverrunRequestConflictError,
  requestOverrunApproval,
} from "./budget-overrun-approvals.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { setProjectBudget } from "./project-budgets.js";

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

  const limitOf = async (projectId: string) =>
    (
      await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId, projectId } },
      })
    ).limitMicroUsd;

  it("approval raises the limit by exactly the bound amount and resumes once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const req = {
      spaceId,
      projectId,
      amountMicroUsd: 500_000n,
      scope: "run:a",
      requestKey: crypto.randomUUID(),
    };
    const approval = await requestOverrunApproval(prisma, req);
    expect(approval.budgetVersion).toBe(1);
    const first = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(first).toMatchObject({
      status: "approved",
      resume: true,
      replayed: false,
      appliedVersion: 2,
    });
    const replay = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(replay).toMatchObject({ status: "approved", resume: false, replayed: true });
    expect(await limitOf(projectId)).toBe(1_500_000n);
  });

  it("rejection applies nothing, never resumes, and cannot be flipped by a later approve", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 200_000n,
      scope: "run:b",
      requestKey: crypto.randomUUID(),
    });
    const rejected = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "rejected",
    });
    expect(rejected).toMatchObject({ status: "rejected", resume: false });
    const late = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(late).toMatchObject({ status: "rejected", resume: false, replayed: true });
    expect(await limitOf(projectId)).toBe(1_000_000n);
  });

  it("goes stale when the budget version changed after the request", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 300_000n,
      scope: "run:c",
      requestKey: crypto.randomUUID(),
    });
    await setProjectBudget(prisma, { spaceId, projectId, limitMicroUsd: 2_000_000n });
    const result = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(result).toMatchObject({ status: "stale", resume: false });
    expect(await limitOf(projectId)).toBe(2_000_000n);
  });

  it("concurrent approvals apply the amount once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 100_000n,
      scope: "run:d",
      requestKey: crypto.randomUUID(),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        decideOverrunApproval(prisma, { spaceId, approvalId: approval.id, decision: "approved" }),
      ),
    );
    expect(results.filter((r) => r.resume)).toHaveLength(1);
    expect(await limitOf(projectId)).toBe(1_100_000n);
  });

  it("requestKey replay is idempotent and conflicting parameters are rejected", async () => {
    const projectId = await budgetFor(1_000_000n);
    const req = {
      spaceId,
      projectId,
      amountMicroUsd: 100_000n,
      scope: "run:e",
      requestKey: crypto.randomUUID(),
    };
    const a = await requestOverrunApproval(prisma, req);
    const b = await requestOverrunApproval(prisma, req);
    expect(b.id).toBe(a.id);
    await expect(
      requestOverrunApproval(prisma, { ...req, amountMicroUsd: 200_000n }),
    ).rejects.toBeInstanceOf(OverrunRequestConflictError);
    await expect(
      requestOverrunApproval(prisma, { ...req, scope: "run:other" }),
    ).rejects.toBeInstanceOf(OverrunRequestConflictError);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { claimEmptySpaceDeletionForMember, deleteEmptySpaceForMember } from "./spaces.js";
import { deleteProject } from "./project-links.js";
import { reserveBudget, setProjectBudget, settleBudgetInTransaction, settleBudget, writeOffBudgetHolding, releaseBudgetReservation } from "./project-budgets.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("Space budget evidence cleanup", () => {
  let db: ReturnType<typeof createDb>;
  let p: PrismaClient;
  beforeAll(() => { db = createDb(process.env.DATABASE_URL!); p = db.prisma; });
  afterAll(async () => { await p?.$disconnect(); await db?.pool.end(); });
  async function fixture() {
    const id = `cleanup-${crypto.randomUUID()}`;
    const userId = `${id}-owner`;
    await p.organization.create({ data: { id, name: "Synthetic cleanup", slug: id, createdAt: new Date() } });
    await p.user.create({ data: { id: userId, name: "Synthetic owner", email: `${userId}@example.invalid` } });
    await p.member.create({ data: { id: `${id}-member`, organizationId: id, userId, role: "owner", createdAt: new Date() } });
    const fallback = `${id}-fallback`;
    for (const spaceId of [id, fallback]) {
      await p.space.create({ data: { id: spaceId, organizationId: id, name: "Synthetic Space", isDefault: spaceId === fallback } });
      await p.spaceMember.create({ data: { id: `${spaceId}-membership`, organizationId: id, spaceId, userId, role: "owner", createdAt: new Date() } });
    }
    const project = await p.project.create({ data: { spaceId: id, name: "Synthetic project" } });
    const budget = await setProjectBudget(p, { spaceId: id, projectId: project.id, limitMicroUsd: 1000000n });
    const callId = `${id}-call`;
    await reserveBudget(p, { spaceId: id, projectId: project.id, callId, amountMicroUsd: 100n });
    await p.budgetOverrunApproval.create({ data: { spaceId: id, projectId: project.id, budgetId: budget.id, budgetVersion: budget.version, amountMicroUsd: 1n, scope: "project", requestKey: `${id}-approval` } });
    await p.$transaction(tx => deleteProject(tx, id, project.id));
    const input = { currentSpaceId: fallback, userId, spaceId: id };
    const claim = await claimEmptySpaceDeletionForMember(p, input);
    return { id, callId, input: { ...input, claimId: claim.claimId } };
  }
  async function counts(id: string) {
    return Promise.all([p.budgetSpendLedger.count({ where: { spaceId: id } }), p.budgetApprovalDeletionAudit.count({ where: { spaceId: id } })]);
  }
  it("retains project deletion evidence, then atomically removes it with the Space", async () => {
    const f = await fixture();
    expect(await counts(f.id)).toEqual([1, 1]);
    await deleteEmptySpaceForMember(p, f.input);
    expect(await counts(f.id)).toEqual([0, 0]);
    expect(await p.space.findUnique({ where: { id: f.id } })).toBeNull();
  });
  it("rolls back both cleanups when the final Space delete fails", async () => {
    const f = await fixture();
    await p.$executeRawUnsafe(`CREATE FUNCTION rak35_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic delete rejection'; END $$`);
    await p.$executeRawUnsafe(`CREATE TRIGGER rak35_reject_delete BEFORE DELETE ON spaces FOR EACH ROW EXECUTE FUNCTION rak35_reject_delete()`);
    try {
      await expect(deleteEmptySpaceForMember(p, f.input)).rejects.toThrow();
      expect(await counts(f.id)).toEqual([1, 1]);
      expect(await p.space.findUnique({ where: { id: f.id } })).not.toBeNull();
    } finally {
      await p.$executeRawUnsafe(`DROP TRIGGER rak35_reject_delete ON spaces`);
      await p.$executeRawUnsafe(`DROP FUNCTION rak35_reject_delete()`);
    }
    await deleteEmptySpaceForMember(p, f.input);
  });
  it("cleans evidence committed by an in-flight settlement before deletion", async () => {
    const f = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const writer = p.$transaction(async tx => {
      await settleBudgetInTransaction(tx, { spaceId: f.id, callId: f.callId, actualMicroUsd: 25n });
      locked();
      await gate;
    }, { timeout: 10000 });
    // Surface writer failures without leaving the readiness barrier hanging.
    await Promise.race([ready, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
    const deletion = deleteEmptySpaceForMember(p, f.input);
    release();
    await Promise.all([writer, deletion]);
    expect(await counts(f.id)).toEqual([0, 0]);
    expect(await p.space.findUnique({ where: { id: f.id } })).toBeNull();
  });
  it("serializes concurrent settlement/write-off and rejects late writers", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      deleteEmptySpaceForMember(p, f.input),
      settleBudget(p, { spaceId: f.id, callId: f.callId, actualMicroUsd: 25n }),
      writeOffBudgetHolding(p, { spaceId: f.id, callId: f.callId, actorUserId: f.input.userId, reason: "Synthetic write-off" }),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(await counts(f.id)).toEqual([0, 0]);
    await expect(settleBudget(p, { spaceId: f.id, callId: f.callId, actualMicroUsd: 25n })).rejects.toThrow();
    await expect(writeOffBudgetHolding(p, { spaceId: f.id, callId: f.callId, actorUserId: f.input.userId, reason: "Late synthetic write-off" })).rejects.toThrow();
    await expect(releaseBudgetReservation(p, { spaceId: f.id, callId: f.callId })).rejects.toThrow();
    await expect(p.$transaction(tx => lockTicketSpace(tx, f.id))).rejects.toThrow();
    expect(await counts(f.id)).toEqual([0, 0]);
  });
});

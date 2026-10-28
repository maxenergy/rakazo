import type { Actor } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDisposableCluster } from "../../../packages/testkit/src/acceptance/disposable-postgres.js";
import { getRunDiagnostics } from "./run-diagnostics.js";

const actor: Actor = {
  userId: "diagnostics-user",
  spaceId: "diagnostics-space",
  email: "diagnostics@rakazo.test",
  isDeploymentOwner: false,
};
const now = new Date("2026-10-22T03:00:00Z");
describe("run diagnostics disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof startDisposableCluster>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
    expect(cluster.port).not.toBe(5432);
    const name = await cluster.createDatabase("diagnostics");
    await cluster.migrate(name);
    db = createDb(cluster.url(name));
    const p = db.prisma;
    await p.user.create({
      data: { id: actor.userId, name: "Fixture", email: actor.email, emailVerified: false },
    });
    await p.organization.create({
      data: { id: "diagnostics-org", name: "Fixture", slug: "diagnostics-fixture", createdAt: now },
    });
    await p.space.create({
      data: { id: actor.spaceId, organizationId: "diagnostics-org", name: "Fixture" },
    });
    await p.bot.create({
      data: {
        id: "diagnostics-bot",
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Fixture",
        color: "blue",
      },
    });
    await p.thread.create({
      data: {
        id: "diagnostics-thread",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "diagnostics-bot",
      },
    });
    await p.task.create({
      data: {
        id: "diagnostics-task",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "diagnostics-bot",
        threadId: "diagnostics-thread",
        prompt: "PRIVATE_SENTINEL",
        status: "running",
      },
    });
    await p.run.create({
      data: {
        id: "diagnostics-run",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "diagnostics-bot",
        threadId: "diagnostics-thread",
        taskId: "diagnostics-task",
        status: "leased",
        trigger: "manual",
      },
    });
    await p.attempt.createMany({
      data: [
        { id: "attempt-b", runId: "diagnostics-run", fence: 2, status: "running", startedAt: now },
        { id: "attempt-a", runId: "diagnostics-run", fence: 1, status: "failed", startedAt: now },
        {
          id: "attempt-old",
          runId: "diagnostics-run",
          fence: 0,
          status: "failed",
          startedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
  }, 120000);
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (cluster) await cluster.stop();
  });
  it("reconstructs completion, approval and interruption recovery with a fresh client", async () => {
    const p = db.prisma;
    await p.run.update({ where: { id: "diagnostics-run" }, data: { status: "completed" } });
    const read = () =>
      getRunDiagnostics(
        p,
        actor,
        { runId: "diagnostics-run", section: "attempts", limit: 25 },
        now,
      );
    expect((await read()).status).toBe("completed");
    await p.proposal.create({
      data: {
        id: "diagnostics-approval",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "diagnostics-bot",
        kind: "plan",
        title: "Fixture",
        summary: "Fixture",
        submitKey: "diagnostics-run:submit_proposal:fixture",
        status: "pending",
      },
    });
    // Reconnect rather than relying on any in-memory run/approval state.
    await p.$disconnect();
    expect(await read()).toMatchObject({
      status: "waiting_approval",
      persistedStatus: "completed",
      pendingApprovalIds: ["diagnostics-approval"],
    });
    await p.proposal.update({
      where: { id: "diagnostics-approval" },
      data: { status: "approved" },
    });
    expect((await read()).status).toBe("completed");
    for (const status of ["failed", "queued", "running", "completed"]) {
      await p.run.update({ where: { id: "diagnostics-run" }, data: { status } });
      await p.$disconnect();
      expect((await read()).status).toBe(status);
    }
    await p.run.update({ where: { id: "diagnostics-run" }, data: { status: "leased" } });
  });
  it("paginates equal timestamps, preserves retention and performs no writes", async () => {
    const before = await db.prisma.run.findUniqueOrThrow({ where: { id: "diagnostics-run" } });
    const attempts = await db.prisma.attempt.findMany({ orderBy: { id: "asc" } });
    const first = await getRunDiagnostics(
      db.prisma,
      actor,
      { runId: before.id, section: "attempts", limit: 1 },
      now,
    );
    expect(first.status).toBe("leased");
    expect(first.entries.map((row) => row.id)).toEqual(["attempt-b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await getRunDiagnostics(
      db.prisma,
      actor,
      { runId: before.id, section: "attempts", limit: 1, before: first.nextCursor! },
      now,
    );
    expect(second.entries.map((row) => row.id)).toEqual(["attempt-a"]);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SENTINEL");
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db.prisma.attempt.findMany({ orderBy: { id: "asc" } })).toEqual(attempts);
  });
  it("denies another space and another user", async () => {
    for (const foreign of [
      { ...actor, spaceId: "foreign-space" },
      { ...actor, userId: "foreign-user" },
    ]) {
      await expect(
        getRunDiagnostics(
          db.prisma,
          foreign,
          { runId: "diagnostics-run", section: "attempts", limit: 25 },
          now,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

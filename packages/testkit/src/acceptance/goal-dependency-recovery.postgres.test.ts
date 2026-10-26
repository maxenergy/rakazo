import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { archiveMilestone, archiveProject, createDb } from "@rakazo/db";
import { expect, it } from "vitest";
import { postgresAvailable, startDisposableCluster } from "./disposable-postgres.js";
import {
  assertGoalDependencyExpectation,
  captureGoalDependencyState,
  saveGoalDependencyExpectation,
  seedGoalDependencyFixture,
} from "./goal-dependency-fixture.js";

const execFileAsync = promisify(execFile);

const oldDbDir = process.env.RAK_OLD_DB_DIR;
const databaseAvailable = postgresAvailable();

if (process.env.RAK_REQUIRE_OLD_DB === "1" && !oldDbDir) {
  throw new Error("RAK_REQUIRE_OLD_DB=1 but RAK_OLD_DB_DIR is not set");
}
if (oldDbDir && !path.isAbsolute(oldDbDir)) {
  throw new Error("RAK_OLD_DB_DIR must be an absolute path to the disposable old-schema worktree");
}
if (process.env.RAK_REQUIRE_PG === "1" && !databaseAvailable) {
  throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
}

it.skipIf(!oldDbDir || !databaseAvailable)(
  "preserves exact dependency edges and Goal/KR fields across deploy, dump restore and server restart",
  async () => {
    if (!oldDbDir) throw new Error("RAK_OLD_DB_DIR is required");
    const { stdout: oldHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: oldDbDir,
    });
    expect(oldHead.trim()).toBe("e402c0652185878e99e9a0364d057f7e385aa1f0");
    console.log("RAK_OLD_DB_DIR=", oldDbDir);
    console.log("RAK_OLD_DB_HEAD=", oldHead.trim());
    console.log("RAK_PG_CLIENT_BIN_DIR=", process.env.RAK_PG_CLIENT_BIN_DIR);
    const cluster = await startDisposableCluster();
    const directory = await mkdtemp(path.join(tmpdir(), "rak19-exact-"));
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await cluster.createDatabase("goal_exact");
      await execFileAsync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
        cwd: oldDbDir,
        env: { ...process.env, DATABASE_URL: cluster.url("rak_t_goal_exact") },
      });
      db = createDb(cluster.url("rak_t_goal_exact"));
      const fixture = await seedGoalDependencyFixture(db.prisma);
      const userId = `${fixture.spaceId}-user`;
      await db.prisma.user.create({
        data: { id: userId, name: "Synthetic legacy", email: `${userId}@example.invalid` },
      });
      const bot = await db.prisma.bot.create({
        data: { spaceId: fixture.spaceId, userId, name: "Synthetic legacy bot", color: "#123456" },
      });
      const thread = await db.prisma.thread.create({
        data: { spaceId: fixture.spaceId, userId, botId: bot.id },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: fixture.spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Synthetic migration fixture",
          status: "completed",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: fixture.spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "manual",
        },
        select: { id: true },
      });
      const usage = { id: `${fixture.spaceId}-usage` };
      await db.prisma
        .$executeRaw`INSERT INTO usage_records (id, "spaceId", "userId", "botId", "runId", provider, model, "costUsd", "inputTokens", "outputTokens") VALUES (${usage.id}, ${fixture.spaceId}, ${userId}, ${bot.id}, ${run.id}, 'synthetic', 'legacy', 0.125, 123, 45)`;
      const budget = await db.prisma.projectBudget.create({
        data: { spaceId: fixture.spaceId, projectId: fixture.projectId, limitMicroUsd: 1000000n },
        select: { id: true },
      });
      const reservation = { id: `${fixture.spaceId}-reservation` };
      await db.prisma
        .$executeRaw`INSERT INTO budget_reservations (id, "budgetId", "spaceId", "projectId", "budgetVersion", "callId", "amountMicroUsd", "expiresAt") VALUES (${reservation.id}, ${budget.id}, ${fixture.spaceId}, ${fixture.projectId}, 1, ${`${fixture.spaceId}-call`}, ${125000n}, ${new Date("2030-01-01T00:00:00Z")})`;
      const assertCompatibility = async () => {
        const r = await db!.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
        expect([r.projectId, r.parentRunId, r.rootRunId]).toEqual([null, null, null]);
        const u = await db!.prisma.usageRecord.findUniqueOrThrow({ where: { id: usage.id } });
        expect([u.costUsd, u.inputTokens, u.outputTokens, u.runId]).toEqual([
          0.125,
          123,
          45,
          run.id,
        ]);
        expect([
          u.costMicroUsd,
          u.billingKind,
          u.projectId,
          u.attributedRunId,
          u.rootRunId,
          u.parentRunId,
        ]).toEqual([null, "unknown", null, null, null, null]);
        const b = await db!.prisma.budgetReservation.findUniqueOrThrow({
          where: { id: reservation.id },
        });
        expect([b.amountMicroUsd, b.projectId, b.budgetVersion]).toEqual([
          125000n,
          fixture.projectId,
          1,
        ]);
        expect([
          b.recoveredAt,
          b.unreconciledAt,
          b.chargedAfterRelease,
          b.chargedAfterWriteOff,
          b.executionState,
          b.providerStartedAt,
          b.writtenOffAt,
          b.writtenOffBy,
          b.writeOffReason,
        ]).toEqual([null, null, false, false, "unknown", null, null, null, null]);
        console.log(
          "Legacy Run/UsageRecord/BudgetReservation values and new-column defaults verified",
        );
      };
      const before = await captureGoalDependencyState(db.prisma, fixture.spaceId);
      expect(before.dependencies).toHaveLength(3);
      expect(before.keyResults).toHaveLength(2);
      const exceeded = before.keyResults.find((kr) => kr.currentValue > kr.targetValue);
      expect(exceeded).toBeDefined();
      expect(exceeded!.state).toBe("active");
      const upgradeExpected = path.join(directory, "before-upgrade.json");
      await saveGoalDependencyExpectation(db.prisma, fixture.spaceId, upgradeExpected);
      await cluster.migrate("rak_t_goal_exact");
      await assertGoalDependencyExpectation(db.prisma, upgradeExpected);
      await assertCompatibility();
      await db.prisma.$transaction((tx) =>
        archiveMilestone(tx, fixture.spaceId, fixture.milestoneId),
      );
      await db.prisma.$transaction((tx) => archiveProject(tx, fixture.spaceId, fixture.projectId));
      const archived = await captureGoalDependencyState(db.prisma, fixture.spaceId);
      expect(archived.dependencies).toEqual(before.dependencies);
      expect(archived.tickets).toEqual(before.tickets);
      expect(archived.goals).toEqual(before.goals);
      expect(archived.keyResults).toEqual(before.keyResults);
      const expected = path.join(directory, "expected.json");
      await saveGoalDependencyExpectation(db.prisma, fixture.spaceId, expected);
      const kr = archived.keyResults[0]!;
      await db.prisma.keyResult.update({
        where: { id: kr.id },
        data: { currentValue: kr.currentValue + 1 },
      });
      await expect(assertGoalDependencyExpectation(db.prisma, expected)).rejects.toThrow(
        "Exact recovery mismatch: keyResults",
      );
      await db.prisma.keyResult.update({
        where: { id: kr.id },
        data: { currentValue: kr.currentValue, updatedAt: kr.updatedAt },
      });
      await assertGoalDependencyExpectation(db.prisma, expected);
      await assertCompatibility();
      await cluster.migrate("rak_t_goal_exact");
      await assertGoalDependencyExpectation(db.prisma, expected);
      await assertCompatibility();
      const bin = process.env.RAK_PG_CLIENT_BIN_DIR ?? process.env.RAK_PG_BIN_DIR!;
      const env = {
        ...process.env,
        LD_LIBRARY_PATH: [process.env.RAK_PG_LIB_DIR, process.env.LD_LIBRARY_PATH]
          .filter(Boolean)
          .join(":"),
      };
      const dump = path.join(directory, "fixture.dump");
      await execFileAsync(
        path.join(bin, "pg_dump"),
        ["--format=custom", "--file", dump, cluster.url("rak_t_goal_exact")],
        { env },
      );
      await cluster.createDatabase("goal_restored");
      await execFileAsync(
        path.join(bin, "pg_restore"),
        ["--exit-on-error", "--no-owner", "--dbname", cluster.url("rak_t_goal_restored"), dump],
        { env },
      );
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(cluster.url("rak_t_goal_restored"));
      await assertGoalDependencyExpectation(db.prisma, expected);
      await assertCompatibility();
      await db.prisma.$disconnect();
      await db.pool.end();
      db = undefined;
      await cluster.restartServer();
      db = createDb(cluster.url("rak_t_goal_restored"));
      await assertGoalDependencyExpectation(db.prisma, expected);
      await assertCompatibility();
      console.log(
        "Exact dependency/Goal/KR equality after repeated deploy and PostgreSQL restart verified",
      );
    } finally {
      if (db) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
      await cluster.stop();
      if (process.env.RAK19_EVIDENCE_DIR) {
        await mkdir(process.env.RAK19_EVIDENCE_DIR, { recursive: true });
        await cp(directory, process.env.RAK19_EVIDENCE_DIR, { recursive: true });
        console.log("Synthetic fixture evidence retained");
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  180000,
);

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { archiveMilestone, archiveProject, createDb } from "@rakazo/db";
import { expect, it } from "vitest";
import { startDisposableCluster } from "./disposable-postgres.js";
import {
  assertGoalDependencyExpectation,
  captureGoalDependencyState,
  saveGoalDependencyExpectation,
  seedGoalDependencyFixture,
} from "./goal-dependency-fixture.js";

const execFileAsync = promisify(execFile);

it("preserves exact dependency edges and Goal/KR fields across deploy, dump restore and server restart", async () => {
  const cluster = await startDisposableCluster();
  const directory = await mkdtemp(path.join(tmpdir(), "rak19-exact-"));
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await cluster.createDatabase("goal_exact");
    await cluster.migrate("rak_t_goal_exact");
    db = createDb(cluster.url("rak_t_goal_exact"));
    const fixture = await seedGoalDependencyFixture(db.prisma);
    const before = await captureGoalDependencyState(db.prisma, fixture.spaceId);
    expect(before.dependencies).toHaveLength(3);
    expect(before.keyResults).toHaveLength(2);
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
    await cluster.migrate("rak_t_goal_exact");
    await assertGoalDependencyExpectation(db.prisma, expected);
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
    await db.prisma.$disconnect();
    await db.pool.end();
    db = undefined;
    await cluster.restartServer();
    db = createDb(cluster.url("rak_t_goal_restored"));
    await assertGoalDependencyExpectation(db.prisma, expected);
    console.log(
      "Exact dependency/Goal/KR equality after repeated deploy and PostgreSQL restart verified",
    );
  } finally {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    await cluster.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);

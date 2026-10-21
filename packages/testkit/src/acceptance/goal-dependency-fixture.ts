import { deepStrictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { createDb } from "@rakazo/db";

type FixtureDb = ReturnType<typeof createDb>["prisma"];

/** Synthetic input only. The caller must supply a disposable database. */
export async function seedGoalDependencyFixture(db: FixtureDb) {
  const id = `rak19-exact-${randomUUID()}`;
  return db.$transaction(async (tx) => {
    await tx.organization.create({
      data: { id, slug: id, name: "Synthetic recovery fixture", createdAt: new Date() },
    });
    const space = await tx.space.create({
      data: { id: `${id}-space`, organizationId: id, name: "Synthetic acceptance" },
    });
    const project = await tx.project.create({
      data: { spaceId: space.id, name: "Exact recovery project", description: "Synthetic fixture" },
    });
    const milestone = await tx.milestone.create({
      data: { spaceId: space.id, projectId: project.id, name: "Exact recovery milestone" },
    });
    const board = await tx.board.create({ data: { spaceId: space.id, name: "Synthetic board" } });
    const tickets = [];
    for (let number = 1; number <= 3; number++) {
      tickets.push(
        await tx.ticket.create({
          data: {
            spaceId: space.id,
            boardId: board.id,
            number,
            title: `Synthetic dependency ${number}`,
            projectId: project.id,
            milestoneId: number === 3 ? null : milestone.id,
          },
        }),
      );
    }
    await tx.ticketDependency.createMany({
      data: [
        { spaceId: space.id, ticketId: tickets[1]!.id, prerequisiteId: tickets[0]!.id },
        { spaceId: space.id, ticketId: tickets[2]!.id, prerequisiteId: tickets[0]!.id },
        { spaceId: space.id, ticketId: tickets[2]!.id, prerequisiteId: tickets[1]!.id },
      ],
    });
    const goal = await tx.goal.create({
      data: {
        spaceId: space.id,
        projectId: project.id,
        name: "Explicit recovery goal",
        description: "Preserve exact values and links",
        state: "active",
        dueAt: new Date("2030-06-01T12:34:56.000Z"),
      },
    });
    for (const [index, milestoneId] of [milestone.id, null].entries()) {
      await tx.keyResult.create({
        data: {
          spaceId: space.id,
          projectId: project.id,
          goalId: goal.id,
          milestoneId,
          name: `Exact KR ${index}`,
          description: index === 0 ? "Linked synthetic KR" : null,
          state: "active",
          measure: "synthetic units",
          targetValue: 123.5 + index,
          currentValue: index === 0 ? 150.25 : 18.25,
          calculationRule: "Explicit synthetic measurement; never inferred from progress",
          dueAt: new Date("2030-05-01T01:02:03.000Z"),
        },
      });
    }
    return {
      organizationId: id,
      spaceId: space.id,
      projectId: project.id,
      milestoneId: milestone.id,
    };
  });
}

/** Full rows retain timestamps, nullable fields, direction of edges and all links. */
export async function captureGoalDependencyState(db: FixtureDb, spaceId: string) {
  return db.$transaction(
    async (tx) => ({
      projects: await tx.project.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      milestones: await tx.milestone.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      tickets: await tx.ticket.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      dependencies: await tx.ticketDependency.findMany({
        where: { spaceId },
        orderBy: [{ ticketId: "asc" }, { prerequisiteId: "asc" }],
      }),
      goals: await tx.goal.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      keyResults: await tx.keyResult.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
    }),
    { isolationLevel: "RepeatableRead" },
  );
}

export async function saveGoalDependencyExpectation(db: FixtureDb, spaceId: string, file: string) {
  const state = await captureGoalDependencyState(db, spaceId);
  await writeFile(file, `${JSON.stringify({ version: 1, spaceId, state }, null, 2)}\n`, {
    flag: "wx",
  });
}

export async function assertGoalDependencyExpectation(db: FixtureDb, file: string) {
  const expected = JSON.parse(await readFile(file, "utf8"));
  deepStrictEqual(expected.version, 1, "Unsupported expectation version");
  const actual = JSON.parse(JSON.stringify(await captureGoalDependencyState(db, expected.spaceId)));
  for (const table of [
    "projects",
    "milestones",
    "tickets",
    "dependencies",
    "goals",
    "keyResults",
  ]) {
    deepStrictEqual(actual[table], expected.state[table], `Exact recovery mismatch: ${table}`);
  }
}

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  archiveMilestone,
  archiveProject,
  isProjectItemArchived,
  resolveTicketLinks,
} from "./project-links.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("project archive (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `archive-org-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let spaceId: string;
  let foreignSpaceId: string;
  let boardId: string;
  let number = 0;

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
        name: "Archive tests",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    spaceId = (await prisma.space.create({ data: { id: "archive-local-" + suffix, organizationId, name: "Local" } })).id;
    foreignSpaceId = (await prisma.space.create({ data: { id: "archive-foreign-" + suffix, organizationId, name: "Foreign" } })).id;
    boardId = (await ensureBoard(prisma, spaceId)).id;
  });

  afterEach(async () => {
    const rows = await prisma.$queryRaw<
      { projects: bigint; milestones: bigint; mismatches: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM tickets t JOIN projects p ON p.id = t."projectId" WHERE t."spaceId" <> p."spaceId") AS projects,
        (SELECT count(*) FROM tickets t JOIN milestones m ON m.id = t."milestoneId" WHERE t."spaceId" <> m."spaceId") AS milestones,
        (SELECT count(*) FROM tickets t JOIN milestones m ON m.id = t."milestoneId" WHERE t."projectId" IS DISTINCT FROM m."projectId") AS mismatches
    `;
    expect(rows).toEqual([{ projects: 0n, milestones: 0n, mismatches: 0n }]);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function fixture() {
    const project = await prisma.project.create({ data: { spaceId, name: "Project" } });
    const milestone = await prisma.milestone.create({
      data: { spaceId, projectId: project.id, name: "Milestone" },
    });
    const ticket = await prisma.ticket.create({
      data: {
        spaceId,
        boardId,
        number: ++number,
        title: "Retained",
        status: "done",
        projectId: project.id,
        milestoneId: milestone.id,
      },
    });
    return { project, milestone, ticket };
  }

  it.each(["project", "milestone"])(
    "archives %s atomically while retaining links and comments",
    async (kind) => {
      const { project, milestone, ticket } = await fixture();
      const comment = await prisma.ticketComment.create({
        data: { spaceId, ticketId: ticket.id, body: "Retained comment" },
      });
      const archive = () =>
        prisma.$transaction((tx) =>
          kind === "project"
            ? archiveProject(tx, spaceId, project.id)
            : archiveMilestone(tx, spaceId, milestone.id),
        );
      const rollback = new Error("Intentional rollback");
      await expect(
        prisma.$transaction(async (tx) => {
          if (kind === "project") await archiveProject(tx, spaceId, project.id);
          else await archiveMilestone(tx, spaceId, milestone.id);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).archivedAt,
      ).toBeNull();
      expect(
        (await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).archivedAt,
      ).toBeNull();
      await archive();
      const savedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      const savedMilestone = await prisma.milestone.findUniqueOrThrow({
        where: { id: milestone.id },
      });
      expect(isProjectItemArchived(savedMilestone, savedProject)).toBe(true);
      if (kind === "project") expect(savedMilestone.archivedAt).toBeNull();
      else expect(savedProject.archivedAt).toBeNull();
      expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
        projectId: project.id,
        milestoneId: milestone.id,
        status: "done",
      });
      expect(await prisma.ticketComment.findUnique({ where: { id: comment.id } })).not.toBeNull();
      expect(
        await prisma.ticket.count({
          where: { spaceId, projectId: project.id, milestoneId: milestone.id, status: "done" },
        }),
      ).toBe(1);
      await expect(
        prisma.$transaction((tx) =>
          resolveTicketLinks(
            tx,
            spaceId,
            { projectId: null, milestoneId: null },
            { milestoneId: milestone.id },
          ),
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await archive();
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).archivedAt,
      ).toEqual(savedProject.archivedAt);
      expect(
        (await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).archivedAt,
      ).toEqual(savedMilestone.archivedAt);
    },
  );

  it("preserves child timestamps when the parent is archived", async () => {
    const { project, milestone } = await fixture();
    await prisma.$transaction((tx) => archiveMilestone(tx, spaceId, milestone.id));
    const before = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    await prisma.$transaction((tx) => archiveProject(tx, spaceId, project.id));
    await prisma.$transaction((tx) => archiveMilestone(tx, spaceId, milestone.id));
    expect(
      (await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } })).archivedAt,
    ).toEqual(before.archivedAt);
  });

  it.each(["project", "milestone"])(
    "hides foreign and missing %s archive targets",
    async (kind) => {
      const { project, milestone } = await fixture();
      for (const [targetSpace, id] of [
        [foreignSpaceId, kind === "project" ? project.id : milestone.id],
        [spaceId, `missing-${suffix}`],
      ]) {
        await expect(
          prisma.$transaction((tx) =>
            kind === "project"
              ? archiveProject(tx, targetSpace!, id!)
              : archiveMilestone(tx, targetSpace!, id!),
          ),
        ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found." });
      }
    },
  );

  it.each(["project", "milestone"])(
    "serializes %s archive after an association writer",
    async (kind) => {
      const { project, milestone } = await fixture();
      let release = () => {};
      let signal = () => {};
      const held = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = prisma.$transaction(
        async (tx) => {
          const links = await resolveTicketLinks(
            tx,
            spaceId,
            { projectId: null, milestoneId: null },
            { milestoneId: milestone.id },
          );
          signal();
          await gate;
          return tx.ticket.create({
            data: { spaceId, boardId, number: ++number, title: "Concurrent", ...links },
          });
        },
        { timeout: 10000 },
      );
      try {
        await Promise.race([
          held,
          writer.then(() => {
            throw new Error("Writer completed before gate");
          }),
        ]);
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
            if (kind === "project") await archiveProject(tx, spaceId, project.id);
            else await archiveMilestone(tx, spaceId, milestone.id);
          }),
        ).rejects.toThrow(/lock timeout/i);
      } finally {
        release();
        await writer;
      }
      const ticket = await writer;
      await prisma.$transaction((tx) =>
        kind === "project"
          ? archiveProject(tx, spaceId, project.id)
          : archiveMilestone(tx, spaceId, milestone.id),
      );
      expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
        projectId: project.id,
        milestoneId: milestone.id,
      });
    },
  );

  it.each(["project", "milestone"])(
    "rejects associations after a concurrent %s archive commits",
    async (kind) => {
      const { project, milestone } = await fixture();
      let release = () => {};
      let signal = () => {};
      const held = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const archiver = prisma.$transaction(
        async (tx) => {
          if (kind === "project") await archiveProject(tx, spaceId, project.id);
          else await archiveMilestone(tx, spaceId, milestone.id);
          signal();
          await gate;
        },
        { timeout: 10000 },
      );
      const associate = () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
          return resolveTicketLinks(
            tx,
            spaceId,
            { projectId: null, milestoneId: null },
            { milestoneId: milestone.id },
          );
        });
      try {
        await Promise.race([
          held,
          archiver.then(() => {
            throw new Error("Archiver completed before gate");
          }),
        ]);
        await expect(associate()).rejects.toThrow(/lock timeout/i);
      } finally {
        release();
        await archiver;
      }
      await expect(associate()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );
});

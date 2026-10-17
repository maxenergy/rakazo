import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureBoard } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  deleteMilestone,
  deleteProject,
  lockTicketForLinkUpdate,
  resolveTicketLinks,
} from "./project-links.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("project links (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `links-org-${suffix}`;
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
      data: { id: organizationId, name: "Link tests", slug: organizationId, createdAt: new Date() },
    });
    const local = await prisma.space.create({
      data: { id: "links-local-" + suffix, organizationId, name: "Local" },
    });
    const foreign = await prisma.space.create({
      data: { id: "links-foreign-" + suffix, organizationId, name: "Foreign" },
    });
    spaceId = local.id;
    foreignSpaceId = foreign.id;
    boardId = (await ensureBoard(prisma, spaceId)).id;
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
    } finally {
      await close();
    }
  });

  async function fixture(targetSpaceId = spaceId) {
    const project = await prisma.project.create({
      data: { spaceId: targetSpaceId, name: "Project" },
    });
    const milestone = await prisma.milestone.create({
      data: { spaceId: targetSpaceId, projectId: project.id, name: "Milestone" },
    });
    return { project, milestone };
  }

  async function linkedTicket(projectId: string, milestoneId: string) {
    return prisma.ticket.create({
      data: { spaceId, boardId, number: ++number, title: "Keep ticket", projectId, milestoneId },
    });
  }

  it.each(["project", "milestone"])(
    "blocks %s deletion while an association transaction holds parent locks",
    async (kind) => {
      const { project, milestone } = await fixture();
      let release = () => {};
      let signalLocked = () => {};
      const held = new Promise<void>((resolve) => {
        signalLocked = resolve;
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
          signalLocked();
          await gate;
          return tx.ticket.create({
            data: { spaceId, boardId, number: ++number, title: "Concurrent link", ...links },
          });
        },
        { timeout: 10000 },
      );
      try {
        await Promise.race([
          held,
          writer.then(() => {
            throw new Error("Writer completed before the gate");
          }),
        ]);
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
            if (kind === "project") await deleteProject(tx, spaceId, project.id);
            else await deleteMilestone(tx, spaceId, milestone.id);
          }),
        ).rejects.toThrow(/lock timeout/i);
      } finally {
        release();
        await writer;
      }
      const ticket = await writer;
      await prisma.$transaction((tx) =>
        kind === "project"
          ? deleteProject(tx, spaceId, project.id)
          : deleteMilestone(tx, spaceId, milestone.id),
      );
      expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
        projectId: kind === "project" ? null : project.id,
        milestoneId: null,
      });
    },
  );

  it("detects association changes between the initial read and ticket lock", async () => {
    const first = await fixture();
    const second = await fixture();
    const ticket = await linkedTicket(first.project.id, first.milestone.id);
    await expect(
      prisma.$transaction(async (tx) => {
        const original = tx.ticket.findFirst.bind(tx.ticket);
        const spy = vi.spyOn(tx.ticket, "findFirst").mockImplementationOnce((async (
          args: Parameters<typeof tx.ticket.findFirst>[0],
        ) => {
          const candidate = await original(args);
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { projectId: second.project.id, milestoneId: second.milestone.id },
          });
          return candidate;
        }) as typeof tx.ticket.findFirst);
        try {
          return await lockTicketForLinkUpdate(tx, spaceId, boardId, ticket.id, {
            milestoneId: null,
          });
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toMatchObject({ code: "P2034" });
    await prisma.$transaction(async (tx) => {
      const locked = await lockTicketForLinkUpdate(tx, spaceId, boardId, ticket.id, {
        milestoneId: null,
      });
      expect(locked?.links).toEqual({ projectId: second.project.id, milestoneId: null });
      if (!locked?.links) throw new Error("Expected resolved ticket links");
      await tx.ticket.update({ where: { id: ticket.id }, data: locked.links });
    });
  });

  it("updates status without waiting for a parent lock", async () => {
    const { project, milestone } = await fixture();
    const ticket = await linkedTicket(project.id, milestone.id);
    await prisma.$transaction(async (parentTx) => {
      await parentTx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
        const locked = await lockTicketForLinkUpdate(tx, spaceId, boardId, ticket.id, {});
        expect(locked?.links).toBeUndefined();
        await tx.ticket.update({ where: { id: ticket.id }, data: { status: "doing" } });
      });
    });
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      status: "doing",
      projectId: project.id,
      milestoneId: milestone.id,
    });
  });

  it("infers the project from a milestone and clears stale milestones on project changes", async () => {
    const first = await fixture();
    const second = await fixture();
    const empty = { projectId: null, milestoneId: null };
    await expect(
      prisma.$transaction((tx) =>
        resolveTicketLinks(tx, spaceId, empty, { milestoneId: first.milestone.id }),
      ),
    ).resolves.toEqual({ projectId: first.project.id, milestoneId: first.milestone.id });
    const current = { projectId: first.project.id, milestoneId: first.milestone.id };
    await expect(
      prisma.$transaction((tx) =>
        resolveTicketLinks(tx, spaceId, current, { projectId: second.project.id }),
      ),
    ).resolves.toEqual({ projectId: second.project.id, milestoneId: null });
    await expect(
      prisma.$transaction((tx) => resolveTicketLinks(tx, spaceId, current, { projectId: null })),
    ).resolves.toEqual(empty);
    await expect(
      prisma.$transaction((tx) =>
        resolveTicketLinks(tx, spaceId, empty, {
          projectId: second.project.id,
          milestoneId: first.milestone.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns NOT_FOUND for foreign and missing resources before reporting mismatches", async () => {
    const local = await fixture();
    const foreign = await fixture(foreignSpaceId);
    const empty = { projectId: null, milestoneId: null };
    for (const patch of [
      { projectId: foreign.project.id, milestoneId: local.milestone.id },
      { projectId: `missing-${suffix}`, milestoneId: local.milestone.id },
      { projectId: local.project.id, milestoneId: foreign.milestone.id },
      { milestoneId: `missing-${suffix}` },
    ]) {
      await expect(
        prisma.$transaction((tx) => resolveTicketLinks(tx, spaceId, empty, patch)),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found." });
    }
    await expect(
      prisma.$transaction((tx) => deleteProject(tx, spaceId, foreign.project.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      prisma.$transaction((tx) => deleteMilestone(tx, spaceId, foreign.milestone.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.project.findUnique({ where: { id: foreign.project.id } })).not.toBeNull();
  });

  it("rolls back project deletion and link clearing together, then preserves tickets and comments on commit", async () => {
    const { project, milestone } = await fixture();
    const ticket = await linkedTicket(project.id, milestone.id);
    const comment = await prisma.ticketComment.create({
      data: { spaceId, ticketId: ticket.id, body: "Keep comment" },
    });
    const rollback = new Error("Intentional rollback");
    await expect(
      prisma.$transaction(async (tx) => {
        await deleteProject(tx, spaceId, project.id);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: milestone.id,
    });
    expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
    expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).not.toBeNull();
    await prisma.$transaction((tx) => deleteProject(tx, spaceId, project.id));
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      projectId: null,
      milestoneId: null,
      title: "Keep ticket",
    });
    expect(await prisma.ticketComment.findUnique({ where: { id: comment.id } })).not.toBeNull();
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).toBeNull();
  });

  it("deletes a single milestone atomically while retaining the project and sibling links", async () => {
    const { project, milestone } = await fixture();
    const sibling = await prisma.milestone.create({
      data: { spaceId, projectId: project.id, name: "Sibling" },
    });
    const ticket = await linkedTicket(project.id, milestone.id);
    const other = await linkedTicket(project.id, sibling.id);
    const rollback = new Error("Intentional rollback");
    await expect(
      prisma.$transaction(async (tx) => {
        await deleteMilestone(tx, spaceId, milestone.id);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: milestone.id,
    });
    await prisma.$transaction((tx) => deleteMilestone(tx, spaceId, milestone.id));
    expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: null,
    });
    expect(await prisma.ticket.findUnique({ where: { id: other.id } })).toMatchObject({
      projectId: project.id,
      milestoneId: sibling.id,
    });
    expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
    expect(await prisma.milestone.findUnique({ where: { id: milestone.id } })).toBeNull();
  });
});

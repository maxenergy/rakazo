import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard } from "./board.js";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { archiveProject, deleteProject, lockTicketForLinkUpdate } from "./project-links.js";
import { addTicketDependency, removeTicketDependency } from "./ticket-dependencies.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
describePostgres("ticket dependency transactions", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationId = `dependency-test-${crypto.randomUUID()}`;
  let spaceId: string;
  let boardId: string;
  let number = 0;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => { await prisma.$disconnect(); await db.pool.end(); };
    await prisma.organization.create({ data: { id: organizationId, name: "Dependency tests", slug: organizationId, createdAt: new Date() } });
    const space = await prisma.space.create({ data: { id: `dependency-space-${crypto.randomUUID()}`, organizationId, name: "Dependency tests" } });
    spaceId = space.id;
    boardId = (await ensureBoard(prisma, spaceId)).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function ticket() {
    return prisma.ticket.create({ data: { spaceId, boardId, number: ++number, title: "Dependency fixture" } });
  }

  async function contend(
    holder: (tx: Prisma.TransactionClient) => Promise<unknown>,
    contender: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let release!: () => void;
    let held!: () => void;
    let identify!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { held = resolve; });
    const backend = new Promise<number>((resolve) => { identify = resolve; });
    const first = prisma.$transaction(async (tx) => {
      await holder(tx);
      held();
      await gate;
    }, { timeout: 10000 });
    const firstResult = first.then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let secondResult: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await Promise.race([ready, first.then(() => { throw new Error("Holder ended before barrier"); })]);
      const second = prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        identify(row!.pid);
        return contender(tx);
      }, { timeout: 10000 });
      secondResult = second.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const pid = await Promise.race([backend, second.then(() => { throw new Error("Contender ended before PID"); })]);
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS waiting`;
        if (row!.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting, "Contender must wait for the holder's advisory lock").toBe(true);
      release();
      return await Promise.all([firstResult, secondResult]);
    } finally {
      release();
      await firstResult;
      if (secondResult) await secondResult;
    }
  }

  it("serializes opposing concurrent edges and rejects the resulting cycle", async () => {
    const a = await ticket();
    const b = await ticket();
    const results = await contend(
      (tx) => addTicketDependency(tx, spaceId, a.id, b.id),
      (tx) => addTicketDependency(tx, spaceId, b.id, a.id),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: { in: [a.id, b.id] } } })).toBe(1);
  });

  it.each(["archive", "delete"])("serializes dependency creation after project %s", async (action) => {
    const project = await prisma.project.create({ data: { spaceId, name: "Race project" } });
    const upstream = await ticket();
    const downstream = await ticket();
    await prisma.ticket.update({ where: { id: upstream.id }, data: { projectId: project.id } });
    const results = await contend(
      (tx) => action === "archive"
        ? archiveProject(tx, spaceId, project.id)
        : deleteProject(tx, spaceId, project.id),
      (tx) => addTicketDependency(tx, spaceId, downstream.id, upstream.id),
    );
    expect(results[0].status).toBe("fulfilled");
    if (action === "archive") {
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "BAD_REQUEST" } });
      expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: downstream.id } })).toBe(0);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: upstream.id } })).projectId).toBe(project.id);
    } else {
      expect(results[1].status).toBe("fulfilled");
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: upstream.id } })).projectId).toBeNull();
      expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: downstream.id, prerequisiteId: upstream.id } })).toBe(1);
    }
  });

  it("rejects cross-space references through both service and database", async () => {
    const a = await ticket();
    const foreignSpaceId = `dependency-foreign-${crypto.randomUUID()}`;
    await prisma.space.create({ data: { id: foreignSpaceId, organizationId, name: "Foreign" } });
    const foreignBoard = await ensureBoard(prisma, foreignSpaceId);
    const b = await prisma.ticket.create({ data: { spaceId: foreignSpaceId, boardId: foreignBoard.id, number: 1, title: "Foreign ticket" } });
    await expect(prisma.$transaction((tx) => addTicketDependency(tx, spaceId, a.id, b.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prisma.ticketDependency.create({ data: { spaceId, ticketId: a.id, prerequisiteId: b.id } })).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: a.id } })).toBe(0);
  });

  it("enforces self-edge and duplicate constraints for direct writes", async () => {
    const a = await ticket();
    const b = await ticket();
    await expect(prisma.$transaction((tx) => addTicketDependency(tx, spaceId, a.id, a.id))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(prisma.ticketDependency.create({ data: { spaceId, ticketId: a.id, prerequisiteId: a.id } })).rejects.toThrow();
    const data = { spaceId, ticketId: a.id, prerequisiteId: b.id };
    await prisma.ticketDependency.create({ data });
    await expect(prisma.ticketDependency.create({ data })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.ticketDependency.count({ where: data })).toBe(1);
  });

  it.each(["done", "closed", "todo"])("serializes dependency removal with transition to %s", async (status) => {
    const downstream = await ticket();
    const upstream = await ticket();
    await prisma.ticket.update({ where: { id: upstream.id }, data: { status: status === "todo" ? "done" : "todo" } });
    await prisma.$transaction((tx) => addTicketDependency(tx, spaceId, downstream.id, upstream.id));
    const results = await contend(
      async (tx) => {
        const current = await lockTicketForLinkUpdate(tx, spaceId, boardId, upstream.id, {});
        expect(current).not.toBeNull();
        await tx.ticket.update({ where: { id: upstream.id }, data: { status } });
      },
      (tx) => removeTicketDependency(tx, spaceId, downstream.id, upstream.id),
    );
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: upstream.id } })).status).toBe(status);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: downstream.id } })).status).toBe(downstream.status);
    expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: downstream.id } })).toBe(0);
  });

  it("keeps repeated additions and removals idempotent", async () => {
    const a = await ticket();
    const b = await ticket();
    for (let i = 0; i < 2; i++)
      await prisma.$transaction((tx) => addTicketDependency(tx, spaceId, a.id, b.id));
    expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: a.id } })).toBe(1);
    for (let i = 0; i < 2; i++)
      await prisma.$transaction((tx) => removeTicketDependency(tx, spaceId, a.id, b.id));
    expect(await prisma.ticketDependency.count({ where: { spaceId, ticketId: a.id } })).toBe(0);
  });
});

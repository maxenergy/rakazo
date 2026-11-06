import { describe, expect, it, vi } from "vitest";
import type { ContextMessage } from "./context-selection.js";
import { selectContext } from "./context-selection.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "./ticket-tools.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: "board-1",
    spaceId: "ws",
    name: "Personal",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function boardSpace() {
  const row = board();
  return {
    board: {
      findUnique: vi.fn(async () => row),
      createMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    space: { findUnique: vi.fn(async () => ({ name: "Personal" })) },
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    boardId: "board-1",
    spaceId: "ws",
    number: 1,
    title: "Ticket",
    description: null,
    status: "todo",
    priority: null,
    assigneeBotId: "bot-1",
    createdByBotId: null,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe("ticket tools", () => {
  it("lists tickets strictly within the space and board", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 1, status: "doing" })]);
    const prisma = {
      ...boardSpace(),
      ticket: { findMany },
    };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      status: "doing",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", boardId: "board-1", status: "doing" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    expect(result).toEqual({ tickets: [expect.objectContaining({ ref: "RAK-1" })] });
  });

  it("leaves closed tickets out of an unfiltered list and shortens descriptions", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 2, description: "x".repeat(500) })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws", boardId: "board-1", status: { not: "closed" } },
        take: 51,
      }),
    );
    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toHaveLength(200);
    expect(listed.description.endsWith("…")).toBe(true);
  });

  it("pages older tickets with a cursor and rejects a bad one", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      ticket({
        id: `t${String(index).padStart(2, "0")}`,
        number: index + 1,
        createdAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const findMany = vi.fn(async (_query: unknown) => rows);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const first = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });
    expect(first).toEqual({
      tickets: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const page = first as { tickets: { id: string }[]; nextCursor: string };
    expect(page.tickets).toHaveLength(50);
    expect(page.tickets[49]?.id).toBe("t49");

    await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      cursor: page.nextCursor,
    });
    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: {
        spaceId: "ws",
        boardId: "board-1",
        status: { not: "closed" },
        OR: [
          { createdAt: { lt: rows[49]!.createdAt } },
          { createdAt: rows[49]!.createdAt, id: { lt: "t49" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });

    const invalid = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      cursor: "not-a-cursor",
    });
    expect(invalid).toEqual({ error: "cursor is invalid." });
  });
});

function mutationDeps(ticketBoardEnabled = true) {
  let current = ticket();
  const changes = vi.fn(async (_change: { wakeAssignee: boolean }) => {});
  const tx = {
    board: { update: vi.fn(async () => ({ nextNumber: 2 })) },
    ticket: {
      findFirst: vi.fn(async () => current),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = ticket(data);
        return current;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
        return current;
      }),
    },
    ticketComment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "comment-1",
        createdAt: NOW,
        updatedAt: NOW,
        authorBot: { name: "Planner" },
        authorUser: null,
        ...data,
      })),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    ...boardSpace(),
    bot: { findFirst: vi.fn(async () => ({ id: "bot-2" })) },
    ticket: tx.ticket,
    ticketComment: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    deps: { prisma, onTicketChange: changes, ticketBoardEnabled } as never,
    prisma,
    tx,
    changes,
  };
}

describe("ticket mutations", () => {
  it.each(["bot-2", "bot-3"])("uses the owner reread under the lock: %s", async (owner) => {
    const s = mutationDeps();
    s.tx.ticket.findFirst
      .mockResolvedValueOnce(ticket({ assigneeBotId: "bot-1" }))
      .mockResolvedValueOnce(ticket({ assigneeBotId: owner }));
    await commentTicket(s.deps, { spaceId: "ws", botId: "bot-2", id: "t1", body: "Review" });
    expect(s.tx.ticket.findFirst).toHaveBeenCalledTimes(2);
    expect(s.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      s.tx.ticket.findFirst.mock.invocationCallOrder[1]!,
    );
    expect(s.changes).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeBotId: owner,
        wakeAssignee: owner !== "bot-2",
      }),
    );
  });

  it("disables every tool without database access or wake-ups", async () => {
    const s = mutationDeps(false);
    await createTicket(s.deps, { spaceId: "ws", botId: "bot-1", title: "Ship" });
    await updateTicket(s.deps, { spaceId: "ws", botId: "bot-1", id: "t1", ownerBotId: "bot-2" });
    await commentTicket(s.deps, { spaceId: "ws", botId: "bot-1", id: "t1", body: "Ready" });
    await listBoardTickets(s.deps, { spaceId: "ws" });
    await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1" });
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });
  it("allocates a number and wakes the assigned bot once", async () => {
    const s = mutationDeps();
    const result = await createTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      title: "  Ship  ",
      ownerBotId: "bot-2",
    });
    expect(result).toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1", title: "Ship", assigneeBotId: "bot-2" }),
    });
    expect(s.tx.board.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextNumber: { increment: 1 } } }),
    );
    expect(s.changes).toHaveBeenCalledOnce();
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: true }));
  });
  it("wakes on an actual reassignment once, and never on status edits or repeated assignment", async () => {
    const s = mutationDeps();
    await updateTicket(s.deps, { spaceId: "ws", id: "t1", ownerBotId: "bot-2", status: "doing" });
    expect(s.changes).toHaveBeenCalledWith(
      expect.objectContaining({ wakeAssignee: true, assigneeBotId: "bot-2" }),
    );
    await updateTicket(s.deps, { spaceId: "ws", id: "t1", ownerBotId: "bot-2", status: "done" });
    expect(
      s.changes.mock.calls.map(([value]) => (value as { wakeAssignee: boolean }).wakeAssignee),
    ).toEqual([true, false]);
    expect(s.tx.ticket.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "done", completedAt: expect.any(Date) }),
      }),
    );
  });
  it("asks the bot that finishes a ticket for a proven lesson", async () => {
    const s = mutationDeps();
    const done = await updateTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t1",
      status: "done",
    });
    expect(done).toHaveProperty("note", expect.stringContaining("team-lessons"));
    const doing = await updateTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t1",
      status: "doing",
    });
    expect(doing).not.toHaveProperty("note");
  });
  it("does not wake a bot creating or assigning a ticket to itself", async () => {
    const s = mutationDeps();
    await createTicket(s.deps, { spaceId: "ws", botId: "bot-1", title: "Ship" });
    await updateTicket(s.deps, { spaceId: "ws", id: "t1", ownerBotId: "bot-2", botId: "bot-2" });
    expect(s.changes.mock.calls.map(([value]) => value.wakeAssignee)).toEqual([false, false]);
  });
  it("wakes the owner when someone else comments", async () => {
    const s = mutationDeps();
    await commentTicket(s.deps, { spaceId: "ws", botId: "bot-2", id: "t1", body: "Fix the test" });
    await commentTicket(s.deps, { spaceId: "ws", userId: "user-1", id: "t1", body: "Go ahead" });
    expect(s.changes.mock.calls.map(([value]) => value.wakeAssignee)).toEqual([true, true]);
  });
  it("comments on its own ticket without waking itself", async () => {
    const s = mutationDeps();
    const result = await commentTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t1",
      body: " Ready ",
    });
    expect(result).toHaveProperty("comment.authorName", "Planner");
    expect(s.tx.ticketComment.create).toHaveBeenCalledWith({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: expect.objectContaining({ body: "Ready", ticketId: "t1" }),
    });
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });
  it("reads tickets with their comments", async () => {
    const s = mutationDeps();
    await expect(getTicket(s.deps, { spaceId: "ws", ref: "RAK-1" })).resolves.toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1" }),
      comments: [],
      commentsTotal: 0,
      commentsOmitted: 0,
    });
    expect(s.prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { number: 1, spaceId: "ws", boardId: "board-1" },
    });
  });
  it("rejects invalid input and foreign owners before a write", async () => {
    const s = mutationDeps();
    await expect(
      createTicket(s.deps, { spaceId: "ws", botId: "bot-1", title: " " }),
    ).resolves.toHaveProperty("error");
    s.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      updateTicket(s.deps, { spaceId: "ws", id: "t1", ownerBotId: "foreign" }),
    ).resolves.toHaveProperty("error");
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("ticket comment paging", () => {
  function fixture() {
    const s = mutationDeps();
    const rows = Array.from({ length: 105 }, (_, index) => ({
      id: String(index).padStart(3, "0"),
      ticketId: "t1",
      spaceId: "ws",
      body: index === 104 ? "运营取证😀".repeat(901) : "comment",
      createdAt: NOW,
      updatedAt: NOW,
      authorBotId: "bot-1",
      authorUserId: null,
      authorBot: { name: "Planner" },
      authorUser: null,
    }));
    s.prisma.ticketComment.count.mockResolvedValue(rows.length);
    (
      s.prisma.ticketComment.findMany as unknown as {
        mockImplementation: (
          fn: (args: {
            where: {
              spaceId: string;
              ticketId: string;
              id?: string;
              OR?: [unknown, { id: { lt: string } }];
            };
            take: number;
          }) => Promise<never>,
        ) => void;
      }
    ).mockImplementation(
      async (args: {
        where: {
          spaceId: string;
          ticketId: string;
          id?: string;
          OR?: [unknown, { id: { lt: string } }];
        };
        take: number;
      }) =>
        rows
          .filter(
            (row) =>
              row.spaceId === args.where.spaceId &&
              row.ticketId === args.where.ticketId &&
              (!args.where.id || row.id === args.where.id) &&
              (!args.where.OR || row.id < args.where.OR[1].id.lt),
          )
          .reverse()
          .slice(0, args.take) as never,
    );
    return { ...s, rows };
  }
  it("pages 105 tied timestamps without omissions and returns the latest evidence first", async () => {
    const s = fixture();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1", cursor });
      if (!("comments" in result)) throw new Error("unexpected error");
      expect(result.comments.map((c) => c.id)).toEqual(result.comments.map((c) => c.id).sort());
      if (!cursor) {
        expect(result.commentsTotal).toBe(105);
        expect(result.commentsOmitted).toBe(85);
        expect(result.comments.at(-1)?.id).toBe("104");
      }
      seen.push(...result.comments.map((c) => c.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(105);
    expect(seen).toHaveLength(105);
  });
  it("reads every code unit of the final long comment using returned offsets", async () => {
    const s = fixture();
    let bodyOffset = 0;
    let body = "";
    for (;;) {
      const result = await getTicket(s.deps, {
        spaceId: "ws",
        ref: "t1",
        commentId: "104",
        bodyOffset,
      });
      if (!("comments" in result)) throw new Error("unexpected error");
      const comment = result.comments[0]!;
      expect(comment.body.length).toBeLessThanOrEqual(1000);
      body += comment.body;
      if (comment.nextBodyOffset === undefined) break;
      expect(comment.bodyTruncated).toBe(true);
      bodyOffset = comment.nextBodyOffset;
    }
    expect(body).toBe(s.rows[104]!.body);
    expect(s.prisma.ticketComment.count).toHaveBeenCalledWith({
      where: { ticketId: "t1", spaceId: "ws" },
    });
  });
  it.each([5000, 548])(
    "reads and pages all evidence through selectContext at budget %i",
    async (contextWindow) => {
      const s = fixture();
      type Input = Parameters<typeof getTicket>[1];
      async function read(input: Input) {
        async function select(request: Input, window: number) {
          const result = await getTicket(s.deps, request);
          if (!("comments" in result)) throw new Error("unexpected ticket error");
          const selected = selectContext<ContextMessage>(
            [
              {
                role: "assistant",
                content: [{ type: "toolCall", id: "call", name: "ticket_get", arguments: request }],
              },
              {
                role: "toolResult",
                toolCallId: "call",
                toolName: "ticket_get",
                content: JSON.stringify(result),
              },
            ],
            {
              strategy: "retrieval",
              budget: { contextWindow: window, outputReserve: 0, systemPrompt: "", tools: [] },
            },
          );
          const last = selected.messages.at(-1)!;
          const text =
            typeof last.content === "string"
              ? last.content
              : (last.content as Array<{ text: string }>)[0]!.text;
          return JSON.parse(text) as typeof result & {
            needsRetry?: boolean;
            retry?: Input;
            contextTruncated?: boolean;
          };
        }
        let result = await select(input, contextWindow);
        if (result.needsRetry) {
          expect(result.contextTruncated).toBe(true);
          expect(result).not.toHaveProperty("nextCursor");
          expect(result.retry).toEqual({ limit: 1 });
          // The minimum target cannot hold ticket metadata. Retry the exact
          // unconsumed position with limit=1 once sufficient context is available.
          result = await select({ ...input, ...result.retry! }, 5000);
        }
        expect(result.needsRetry).not.toBe(true);
        return result;
      }
      let cursor: string | undefined;
      const seen: string[] = [];
      let newest: Awaited<ReturnType<typeof read>>["comments"][number] | undefined;
      do {
        const page = await read({ spaceId: "ws", ref: "RAK-1", cursor });
        if (!cursor) {
          newest = page.comments.at(-1)!;
          expect(newest.id).toBe("104");
        }
        seen.push(...page.comments.map((c) => c.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(105);
      expect(new Set(seen).size).toBe(105);
      let body = newest!.body;
      let offset = newest!.nextBodyOffset;
      expect(offset).toBe(newest!.bodyOffset + newest!.body.length);
      while (offset !== undefined) {
        const result = await read({
          spaceId: "ws",
          ref: "RAK-1",
          commentId: "104",
          bodyOffset: offset,
        });
        const comment = result.comments[0]!;
        expect(comment.body.length).toBeGreaterThan(0);
        expect(comment.bodyOffset).toBe(offset);
        body += comment.body;
        expect(comment.bodyTruncated).toBe(true);
        if (comment.nextBodyOffset !== undefined) {
          expect(comment.nextBodyOffset).toBe(offset + comment.body.length);
        }
        offset = comment.nextBodyOffset;
      }
      expect(body).toBe(s.rows[104]!.body);
    },
  );
  it("validates cursors, bounds and comment ownership", async () => {
    const s = fixture();
    for (const args of [
      { limit: 0 },
      { limit: 21 },
      { bodyOffset: -1 },
      { bodyOffset: 1 },
      { cursor: "invalid" },
      { commentId: "104", cursor: "invalid" },
    ]) {
      expect(await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1", ...args })).toHaveProperty(
        "error",
      );
    }
    expect(
      await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1", commentId: "foreign" }),
    ).toHaveProperty("error", "Comment not found in this ticket.");
    const one = await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1", limit: 1 });
    expect(one).toHaveProperty("comments", [expect.objectContaining({ id: "104" })]);
  });
});

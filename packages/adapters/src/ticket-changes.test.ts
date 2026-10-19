import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { TicketChange } from "./ticket-changes.js";
import { createTicketChangeNotifier } from "./ticket-changes.js";
import { reconcileTicketWakes } from "./ticket-wake.js";

const change: TicketChange = {
  spaceId: "space-1",
  boardId: "board-1",
  ticketId: "ticket-1",
  assigneeBotId: "bot-1",
  wakeAssignee: true,
};
function setup(ticketBoardEnabled: boolean, status = "todo") {
  const notify = vi.fn(async () => {});
  const enqueue = vi.fn(async () => {});
  const createRun = vi.fn(async () => ({ id: "run-1" }));
  const createTask = vi.fn(async () => ({ id: "task-1" }));
  const tx = {
    ticket: {
      findFirst: vi.fn(async () => ({
        id: "ticket-1",
        status,
        number: 1,
        board: { ticketPrefix: "RAK" },
      })),
    },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", userId: "user-1", thread: { id: "thread-1" } })),
    },
    task: { create: createTask },
    run: { create: createRun, findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  const changes = createTicketChangeNotifier({
    ticketBoardEnabled,
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    jobs: { enqueue } as never,
    boardEvents: { notify } as never,
  });
  return { changes, notify, enqueue, createRun, createTask, transaction, tx };
}

describe("ticket changes", () => {
  it("does nothing when disabled, including creation and assignment", async () => {
    const s = setup(false);
    await s.changes(change);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it.each(["todo", "doing", "review", "blocked"])(
    "wakes an assigned %s ticket once using a hidden run",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.createRun).toHaveBeenCalledTimes(1);
      expect(s.createRun).toHaveBeenCalledWith({
        data: expect.objectContaining({ trigger: "tickets", status: "queued" }),
      });
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
      );
      expect(s.notify).toHaveBeenCalledWith("space-1", {
        boardId: "board-1",
        ticketId: "ticket-1",
      });
    },
  );
  it("skips an already queued wake without creating a task or run", async () => {
    const s = setup(true);
    s.tx.run.findFirst.mockResolvedValue({ id: "run-x" });
    await s.changes(change);
    const updateWake = vi.fn(async () => ({}));
    const tx = {
      ...s.tx,
      ticket: {
        findFirst: vi.fn(async () => ({
          id: "ticket-1",
          status: "todo",
          number: 1,
          board: { ticketPrefix: "RAK" },
          assigneeBotId: "bot-1",
        })),
      },
      $executeRaw: vi.fn(async () => 1),
      ticketWake: { update: updateWake },
    };
    const delivered = await reconcileTicketWakes(
      {
        ticketBoardEnabled: true,
        jobs: { enqueue: s.enqueue } as never,
        prisma: {
          $executeRaw: vi.fn(async () => 0),
          $queryRaw: vi.fn(async () => [
            { id: "wake-1", spaceId: "space-1", ticketId: "ticket-1" },
          ]),
          $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        } as unknown as PrismaClient,
      },
      { claimer: "test-worker" },
    );
    expect(delivered).toBe(0);
    expect(s.createTask).not.toHaveBeenCalled();
    expect(s.createRun).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(updateWake).toHaveBeenCalledWith({
      where: { id: "wake-1" },
      data: { status: "skipped", wokenAt: null, outcomeReason: "already_queued" },
    });
  });
  it.each(["done", "closed", "cancelled"])(
    "does not wake a reassigned %s ticket",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.notify).toHaveBeenCalledTimes(1);
      expect(s.createTask).not.toHaveBeenCalled();
      expect(s.createRun).not.toHaveBeenCalled();
      expect(s.enqueue).not.toHaveBeenCalled();
    },
  );
  it("only publishes changes for comments or status edits", async () => {
    const s = setup(true);
    await s.changes({ ...change, wakeAssignee: false });
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("does not wake an unassigned ticket", async () => {
    const s = setup(true);
    await s.changes({ ...change, assigneeBotId: null });
    expect(s.transaction).not.toHaveBeenCalled();
  });
});

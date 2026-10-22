import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import {
  releaseBudgetReservation,
  reserveBudget,
  settleBudget,
  startBudgetReservation,
} from "./project-budgets.js";

describe("execution fence history boundaries", () => {
  for (const boundary of ["message", "event"] as const) {
    it("rejects stale " + boundary + " writes before creating history rows", async () => {
      const tx = {
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 2 }) },
        message: { create: vi.fn() },
        event: { create: vi.fn() },
      };
      const executionFence = { runId: "run-1", leaseOwner: "old-worker", leaseFence: 1 };
      const client = tx as unknown as Prisma.TransactionClient;
      const write =
        boundary === "message"
          ? createThreadMessageInTransaction(client, {
              threadId: "thread-1",
              role: "bot",
              blocks: [],
              runId: "run-1",
              executionFence,
            })
          : appendEventInTransaction(client, {
              spaceId: "space-1",
              threadId: "thread-1",
              botId: "bot-1",
              type: "run.started",
              payload: {},
              runId: "run-1",
              executionFence,
            });
      await expect(write).rejects.toThrow("Run execution fence is no longer current");
      expect(tx.thread.update).toHaveBeenCalledTimes(1);
      expect(tx.thread.update.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.run.updateMany.mock.invocationCallOrder[0]!,
      );
      expect(tx.message.create).not.toHaveBeenCalled();
      expect(tx.event.create).not.toHaveBeenCalled();
    });
  }
});

describe("execution fence budget boundaries", () => {
  for (const boundary of ["reserve", "start", "release", "settle"] as const) {
    it("rejects stale " + boundary + " before touching budget rows", async () => {
      const tx = {
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        budgetReservation: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
      };
      const db = {
        $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
      } as unknown as PrismaClient;
      const executionFence = { runId: "run-1", leaseOwner: "old-worker", leaseFence: 1 };
      const input = { spaceId: "space-1", callId: "call-1", executionFence };
      const write =
        boundary === "reserve"
          ? reserveBudget(db, { ...input, projectId: "project-1", amountMicroUsd: 1n })
          : boundary === "start"
            ? startBudgetReservation(db, input)
            : boundary === "settle"
              ? settleBudget(db, { ...input, actualMicroUsd: 1n })
              : releaseBudgetReservation(db, input);
      await expect(write).rejects.toThrow("Run execution fence is no longer current");
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.run.updateMany.mock.invocationCallOrder[0]!,
      );
      expect(tx.budgetReservation.findUnique).not.toHaveBeenCalled();
      expect(tx.budgetReservation.create).not.toHaveBeenCalled();
      expect(tx.budgetReservation.updateMany).not.toHaveBeenCalled();
    });
  }
});

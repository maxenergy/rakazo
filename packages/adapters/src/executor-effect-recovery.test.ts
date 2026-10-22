import { describe, expect, it, vi } from "vitest";
import { recordEffect, recoverUnfinishedEffects } from "./executor.js";

const run = { id: "run-a", spaceId: "space-a", threadId: "thread-a", botId: "bot-a" };
const fence = { runId: run.id, leaseOwner: "worker-new", leaseFence: 2 };
function fixture(current = true) {
  const effect = { id: "effect-a", kind: "shell", status: "executing" };
  const events: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      updateMany: vi.fn(async () => ({ count: current ? 1 : 0 })),
      findUnique: vi.fn(async () => ({ status: "running", startedAt: new Date() })),
    },
    externalEffect: {
      findMany: vi.fn(async () => (effect.status === "executing" ? [effect] : [])),
      updateMany: vi.fn(async () => {
        effect.status = "uncertain";
        return { count: 1 };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
    event: {
      create: vi.fn(async (input: unknown) => {
        events.push(input);
        return input;
      }),
    },
  };
  const deps = {
    prisma: { $transaction: async (write: (value: unknown) => Promise<unknown>) => write(tx) },
  } as unknown as Parameters<typeof recoverUnfinishedEffects>[0];
  return { deps, tx, effect, events };
}

describe("unfinished effects after execution takeover", () => {
  it("marks an unfinished effect uncertain once and records review metadata", async () => {
    const f = fixture();
    await recoverUnfinishedEffects(f.deps, run, fence);
    await recoverUnfinishedEffects(f.deps, run, fence);
    expect(f.effect.status).toBe("uncertain");
    expect(f.tx.externalEffect.updateMany).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveLength(1);
    expect(f.tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "effect.reconciled",
          payload: expect.objectContaining({ status: "uncertain", requiresReview: true }),
        }),
      }),
    );
  });
  it("rejects a stale writer before reading or changing effects", async () => {
    const f = fixture(false);
    await expect(recoverUnfinishedEffects(f.deps, run, fence)).rejects.toThrow(
      "Run execution fence is no longer current",
    );
    expect(f.tx.externalEffect.findMany).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(0);
  });
});

describe("effect creation execution fence", () => {
  it("rejects a stale writer before creating an intended effect", async () => {
    const create = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: { updateMany: vi.fn(async () => ({ count: 0 })) },
      externalEffect: { create },
    };
    const deps = {
      prisma: {
        externalEffect: {
          findUnique: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
        },
        $transaction: async (write: (value: unknown) => Promise<unknown>) => write(tx),
      },
    } as unknown as Parameters<typeof recordEffect>[0];
    await expect(
      recordEffect(deps, { ...run, executionFence: fence }, "synthetic_write", "synthetic-key", {}),
    ).rejects.toThrow("Run execution fence is no longer current");
    expect(create).not.toHaveBeenCalled();
  });
});

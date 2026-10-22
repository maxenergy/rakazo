import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createStuckWorkerDetector, STUCK_WORKER_AFTER_MS } from "./stuck-worker.js";

const now = new Date("2026-10-22T13:00:00Z");
const old = new Date(now.getTime() - STUCK_WORKER_AFTER_MS);
function run(overrides = {}) {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    progressAt: old,
    startedAt: old,
    leaseFence: 2,
    ...overrides,
  };
}
function setup(rows = [run()]) {
  const findMany = vi.fn(async () => rows);
  const detect = createStuckWorkerDetector({ run: { findMany } } as unknown as PrismaClient);
  return { findMany, detect, rows };
}

describe("stuck worker detection", () => {
  it("alerts on stale persisted progress even while lease heartbeats continue", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const { detect, findMany } = setup();
      await detect(now);
      await detect(now);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "worker progress stalled",
        expect.objectContaining({
          alert: "stuck_worker",
          runId: "run-1",
          leaseFence: 2,
          progressAt: old.toISOString(),
          stalledForMs: STUCK_WORKER_AFTER_MS,
        }),
      );
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "running" },
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores recent progress and rearms after progress resumes", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const { detect, rows } = setup();
      await detect(now);
      rows[0] = run({ progressAt: now });
      await detect(now);
      expect(warn).toHaveBeenCalledTimes(1);
      await detect(new Date(now.getTime() + STUCK_WORKER_AFTER_MS));
      expect(warn).toHaveBeenCalledTimes(2);
      rows.length = 0;
      await detect(now);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("detects a stall before the first checkpoint from startedAt", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const { detect } = setup([run({ progressAt: null })]);
      await detect(now);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

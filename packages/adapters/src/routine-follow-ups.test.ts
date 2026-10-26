import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { onceFollowUpSuperseded } from "./routine-follow-ups.js";

const run = {
  id: "run-1",
  botId: "bot-1",
  routineId: "routine-1",
  createdAt: new Date("2026-10-26T07:23:00.000Z"),
};

function prisma(crons: string[], newer: Array<{ routine: { crons: string[] } | null }>) {
  return {
    routine: { findUnique: vi.fn(async () => ({ crons })) },
    run: { findMany: vi.fn(async () => newer) },
  } as never;
}

describe("onceFollowUpSuperseded", () => {
  it("skips a one-time follow-up when the bot queued a newer one", async () => {
    const db = prisma([ONCE_ROUTINE_CRON], [{ routine: { crons: [ONCE_ROUTINE_CRON] } }]);
    await expect(onceFollowUpSuperseded(db, run)).resolves.toBe(true);
    expect(
      (db as { run: { findMany: ReturnType<typeof vi.fn> } }).run.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          trigger: "routine",
          status: "queued",
          createdAt: { gt: run.createdAt },
        }),
      }),
    );
  });

  it("keeps the latest follow-up, recurring routines, and follow-ups behind recurring runs", async () => {
    await expect(onceFollowUpSuperseded(prisma([ONCE_ROUTINE_CRON], []), run)).resolves.toBe(false);
    await expect(
      onceFollowUpSuperseded(
        prisma(["0 9 * * *"], [{ routine: { crons: [ONCE_ROUTINE_CRON] } }]),
        run,
      ),
    ).resolves.toBe(false);
    await expect(
      onceFollowUpSuperseded(
        prisma([ONCE_ROUTINE_CRON], [{ routine: { crons: ["0 9 * * *"] } }]),
        run,
      ),
    ).resolves.toBe(false);
    await expect(
      onceFollowUpSuperseded(prisma([ONCE_ROUTINE_CRON], []), { ...run, routineId: null }),
    ).resolves.toBe(false);
  });
});

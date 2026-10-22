import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

// Longer than ordinary tool calls; independent of lease heartbeats.
export const STUCK_WORKER_AFTER_MS = 10 * 60_000;

/** Alert once per stalled progress episode, without reclaiming or cancelling work. */
export function createStuckWorkerDetector(prisma: PrismaClient) {
  let alerted = new Map<string, string>();
  return async (now: Date) => {
    const current = new Map<string, string>();
    let cursor: string | undefined;
    for (;;) {
      const runs = await prisma.run.findMany({
        where: { status: "running", ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: 100,
        select: {
          id: true,
          spaceId: true,
          botId: true,
          threadId: true,
          progressAt: true,
          startedAt: true,
          leaseFence: true,
        },
      });
      for (const run of runs) {
        const progressAt = run.progressAt ?? run.startedAt;
        if (!progressAt || now.getTime() - progressAt.getTime() < STUCK_WORKER_AFTER_MS) continue;
        const episode = `${String(run.leaseFence)}:${progressAt.toISOString()}`;
        current.set(run.id, episode);
        if (alerted.get(run.id) === episode) continue;
        getLogger().warn("worker progress stalled", {
          alert: "stuck_worker",
          runId: run.id,
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          leaseFence: run.leaseFence,
          progressAt: progressAt.toISOString(),
          stalledForMs: now.getTime() - progressAt.getTime(),
        });
        alerted.set(run.id, episode);
      }
      if (runs.length < 100) break;
      cursor = runs[runs.length - 1]?.id;
    }
    alerted = current;
  };
}

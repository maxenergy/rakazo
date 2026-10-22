import type { PrismaClient } from "./client.js";
import type { ExecutionFence } from "./execution-fence.js";
import { assertExecutionFence } from "./execution-fence.js";

export const DEFAULT_RUN_DEADLINE_MS = 2 * 60 * 60_000;
export const MAX_RUN_DEADLINE_MS = 24 * 60 * 60_000;

export function runDeadline(now: Date, durationMs = DEFAULT_RUN_DEADLINE_MS): Date {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Run deadline duration must be positive and finite");
  }
  return new Date(now.getTime() + Math.min(durationMs, MAX_RUN_DEADLINE_MS));
}

/** Checkpoints and progress commit together while holding the existing run fence. */
export async function saveRunSegment(
  prisma: PrismaClient,
  fence: ExecutionFence,
  segmentCheckpoint: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertExecutionFence(tx, fence);
    await tx.run.update({
      where: { id: fence.runId },
      data: { segmentCheckpoint, progressAt: new Date() },
    });
  });
}

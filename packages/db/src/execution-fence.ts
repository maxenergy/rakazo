import type { Prisma } from "./client.js";

export interface ExecutionFence {
  runId: string;
  leaseOwner: string;
  leaseFence: number;
}

export class StaleExecutionFenceError extends Error {
  constructor() {
    super("Run execution fence is no longer current");
    this.name = "StaleExecutionFenceError";
  }
}

/** Hold the run row lock until the caller's durable write commits. */
export async function assertExecutionFence(
  tx: Prisma.TransactionClient,
  fence: ExecutionFence,
): Promise<void> {
  const matched = await tx.run.updateMany({
    where: {
      id: fence.runId,
      status: "running",
      leaseOwner: fence.leaseOwner,
      leaseFence: fence.leaseFence,
      leaseExpiresAt: { gt: new Date() },
    },
    data: { leaseFence: fence.leaseFence },
  });
  if (matched.count !== 1) throw new StaleExecutionFenceError();
}

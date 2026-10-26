import type { PrismaClient } from "./client.js";
import type { ExecutionFence } from "./execution-fence.js";
import {
  releaseBudgetReservation,
  reserveBudget,
  startBudgetReservation,
} from "./project-budgets.js";

/**
 * Prisma-backed implementation of the runtime's BudgetPort (see adapters/budget-observer).
 * Structural typing keeps adapters free of a dependency on this package.
 */
export function createDbBudgetPort(db: PrismaClient) {
  return {
    reserve: (input: {
      spaceId: string;
      projectId: string;
      callId: string;
      amountMicroUsd: bigint;
      executionFence?: ExecutionFence;
    }) => reserveBudget(db, input),
    start: (input: { spaceId: string; callId: string; executionFence?: ExecutionFence }) =>
      startBudgetReservation(db, input),
    release: (input: { spaceId: string; callId: string; executionFence?: ExecutionFence }) =>
      releaseBudgetReservation(db, input),
  };
}

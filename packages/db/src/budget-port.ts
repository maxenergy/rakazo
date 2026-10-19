import type { PrismaClient } from "./client.js";
import { releaseBudgetReservation, reserveBudget } from "./project-budgets.js";

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
    }) => reserveBudget(db, input),
    release: (input: { spaceId: string; callId: string }) => releaseBudgetReservation(db, input),
  };
}

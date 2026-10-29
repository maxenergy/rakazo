import { setTimeout } from "node:timers/promises";
import { getLogger } from "@rakazo/logging";

const MAX_TRANSACTION_ATTEMPTS = 5;
const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const prismaError = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (prismaError.code === "P2034") return true;
  const databaseCode = prismaError.meta?.driverAdapterError?.cause?.originalCode;
  return typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode);
}

export async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error;
      if (attempt >= MAX_TRANSACTION_ATTEMPTS) {
        const conflict = error as {
          code: string;
          meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
        };
        getLogger().warn("Transaction conflict retries exhausted", {
          attempts: attempt,
          code: conflict.code,
          databaseCode: conflict.meta?.driverAdapterError?.cause?.originalCode,
        });
        throw error;
      }
      // Four waits of at most 50 * attempt ms total at most 500 ms.
      await sleep((10 + Math.floor(Math.random() * 41)) * attempt);
    }
  }
}

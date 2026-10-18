import { randomUUID } from "node:crypto";
import type { AgentUsage, ModelCallObserver } from "@rakazo/adapter-kit";

/** Subset of the D2a project-budgets service that the runtime needs. Amounts are micro-USD bigint. */
export interface BudgetPort {
  reserve(input: {
    spaceId: string;
    projectId: string;
    callId: string;
    amountMicroUsd: bigint;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: "no_budget" | "insufficient" | "reservation_closed"; availableMicroUsd: bigint }
  >;
  settle(input: { spaceId: string; callId: string; actualMicroUsd: bigint }): Promise<unknown>;
  release(input: { spaceId: string; callId: string }): Promise<unknown>;
}

export interface BudgetCallScope {
  spaceId: string;
  projectId: string;
}

export interface BudgetObserverOptions {
  port: BudgetPort;
  /** Resolves the project for this run; null means the run has no budgeted project. */
  scope: () => BudgetCallScope | null;
  /** Controllable upper bound for one call. Must never underestimate. */
  upperBoundMicroUsd: (call: Parameters<ModelCallObserver["beforeCall"]>[0]) => bigint;
  /** Wrapped observer, for example the existing usage accounting. */
  inner?: ModelCallObserver;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly reason: "no_budget" | "insufficient" | "reservation_closed",
    readonly availableMicroUsd: bigint,
  ) {
    super(`Project budget does not allow this model call (${reason})`);
    this.name = "BudgetExceededError";
  }
}

export function usdToMicroUsd(costUsd: number): bigint {
  return BigInt(Math.ceil(costUsd * 1_000_000));
}

/**
 * Reserves an upper bound before every model call and settles or releases afterwards. Because
 * observedPiStream wraps the primary, backup-model and nested-agent streams, one observer covers
 * all of them. A missing price settles at the reserved bound, never at zero.
 */
export function createBudgetObserver(options: BudgetObserverOptions): ModelCallObserver {
  const open = new Map<string, { spaceId: string; amountMicroUsd: bigint; inner?: string }>();
  return {
    async beforeCall(call) {
      const scope = options.scope();
      if (!scope) {
        return options.inner ? await options.inner.beforeCall(call) : randomUUID();
      }
      const callId = randomUUID();
      const amountMicroUsd = options.upperBoundMicroUsd(call);
      const result = await options.port.reserve({ ...scope, callId, amountMicroUsd });
      if (!result.ok) throw new BudgetExceededError(result.reason, result.availableMicroUsd);
      let inner: string | undefined;
      try {
        inner = options.inner ? await options.inner.beforeCall(call) : undefined;
      } catch (error) {
        await options.port.release({ spaceId: scope.spaceId, callId });
        throw error;
      }
      open.set(callId, { spaceId: scope.spaceId, amountMicroUsd, inner });
      return inner === undefined ? callId : `${callId}:${inner}`;
    },
    async afterCall(reservationId: string, usage: AgentUsage | null) {
      const callId = reservationId.split(":", 1)[0]!;
      const entry = open.get(callId);
      if (!entry) {
        if (options.inner) await options.inner.afterCall(reservationId, usage);
        return;
      }
      open.delete(callId);
      const innerId = reservationId.slice(callId.length + 1);
      try {
        if (usage === null) {
          await options.port.release({ spaceId: entry.spaceId, callId });
        } else {
          const actual =
            typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)
              ? usdToMicroUsd(usage.costUsd)
              : entry.amountMicroUsd;
          await options.port.settle({ spaceId: entry.spaceId, callId, actualMicroUsd: actual });
        }
      } finally {
        if (options.inner && entry.inner !== undefined) {
          await options.inner.afterCall(innerId, usage);
        }
      }
    },
  };
}

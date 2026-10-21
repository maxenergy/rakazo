import type { AgentUsage, ModelCallObserver } from "@rakazo/adapter-kit";

/** Subset of the D2a project-budgets service that the runtime needs. Amounts are micro-USD bigint. */
type ExecutionFence = { runId: string; leaseOwner: string; leaseFence: number };

export interface BudgetPort {
  reserve(input: {
    spaceId: string;
    projectId: string;
    callId: string;
    amountMicroUsd: bigint;
    executionFence?: ExecutionFence;
  }): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: "no_budget" | "insufficient" | "reservation_closed";
        availableMicroUsd: bigint;
      }
  >;
  start(input: { spaceId: string; callId: string; executionFence?: ExecutionFence }): Promise<boolean>;
  release(input: { spaceId: string; callId: string; executionFence?: ExecutionFence }): Promise<unknown>;
}

export interface BudgetCallScope {
  spaceId: string;
  projectId: string;
  executionFence?: ExecutionFence;
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
    readonly call?: BudgetCallScope & { callId: string; amountMicroUsd: bigint },
  ) {
    super(`Project budget does not allow this model call (${reason})`);
    this.name = "BudgetExceededError";
  }
}

/** Reserve per physical call; D1 accounting exclusively owns settlement. */
export function createBudgetObserver(options: BudgetObserverOptions): ModelCallObserver {
  const open = new Map<string, { spaceId: string; callId: string; inner?: string; executionFence?: ExecutionFence }>();
  return {
    async beforeCall(call) {
      const scope = options.scope();
      if (!scope) {
        return options.inner ? await options.inner.beforeCall(call) : call.callId;
      }
      const callId = call.callId;
      const amountMicroUsd = options.upperBoundMicroUsd(call);
      const result = await options.port.reserve({ ...scope, callId, amountMicroUsd });
      if (!result.ok) {
        throw new BudgetExceededError(result.reason, result.availableMicroUsd, {
          ...scope,
          callId,
          amountMicroUsd,
        });
      }
      let inner: string | undefined;
      try {
        inner = options.inner ? await options.inner.beforeCall(call) : undefined;
      } catch (error) {
        await options.port.release({ spaceId: scope.spaceId, callId, executionFence: scope.executionFence });
        throw error;
      }
      open.set(callId, { spaceId: scope.spaceId, callId, inner, executionFence: scope.executionFence });
      return callId;
    },
    async startCall(reservationId) {
      const entry = open.get(reservationId);
      if (!entry) {
        await options.inner?.startCall?.(reservationId);
        return;
      }
      await options.inner?.startCall?.(entry.inner ?? reservationId);
      const started = await options.port.start({ spaceId: entry.spaceId, callId: entry.callId, executionFence: entry.executionFence });
      if (!started) throw new BudgetExceededError("reservation_closed", 0n);
    },
    async afterCall(
      reservationId: string,
      usage: AgentUsage | null,
      lifecycle?: { started: boolean },
    ) {
      const callId = reservationId;
      const entry = open.get(callId);
      if (!entry) {
        if (options.inner) await options.inner.afterCall(reservationId, usage, lifecycle);
        return;
      }
      open.delete(callId);
      try {
        if (usage === null) {
          // Missing accounting is not evidence that no provider call started.
          if (lifecycle?.started === false) {
            await options.port.release({ spaceId: entry.spaceId, callId, executionFence: entry.executionFence });
          }
        }
      } finally {
        if (options.inner && entry.inner !== undefined) {
          await options.inner.afterCall(entry.inner, usage, lifecycle);
        }
      }
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  createBudgetObserver,
  type BudgetPort,
} from "./budget-observer.js";

const call = { provider: "p", modelId: "m", inputTokensEstimate: 10, maxOutputTokens: 10 };

function port(ok = true): BudgetPort {
  return {
    reserve: vi.fn(async () =>
      ok ? { ok: true as const } : { ok: false as const, reason: "insufficient" as const, availableMicroUsd: 0n },
    ),
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

const scope = () => ({ spaceId: "s", projectId: "p" });

describe("createBudgetObserver", () => {
  it("rejects the call when the reservation is refused", async () => {
    const p = port(false);
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    await expect(o.beforeCall(call)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.settle).not.toHaveBeenCalled();
  });

  it("settles actual cost in micro-USD after a call", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5_000_000n });
    const id = await o.beforeCall(call);
    await o.afterCall(id, { costUsd: 0.0123 } as never);
    expect(p.settle).toHaveBeenCalledWith(expect.objectContaining({ actualMicroUsd: 12_300n }));
  });

  it("settles at the reserved bound when the price is unknown, never zero", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 777n });
    const id = await o.beforeCall(call);
    await o.afterCall(id, { costUsd: null } as never);
    expect(p.settle).toHaveBeenCalledWith(expect.objectContaining({ actualMicroUsd: 777n }));
  });

  it("releases when the call never started", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    const id = await o.beforeCall(call);
    await o.afterCall(id, null);
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(p.settle).not.toHaveBeenCalled();
  });

  it("uses a fresh callId for each call, so backup-model calls reserve separately", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    await o.beforeCall(call);
    await o.beforeCall(call);
    const ids = (p.reserve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].callId);
    expect(new Set(ids).size).toBe(2);
  });
});

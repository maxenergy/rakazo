import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, type BudgetPort, createBudgetObserver } from "./budget-observer.js";

const call = {
  callId: "physical-call",
  provider: "p",
  modelId: "m",
  inputTokensEstimate: 10,
  maxOutputTokens: 10,
};

function port(ok = true): BudgetPort {
  return {
    reserve: vi.fn(async () =>
      ok
        ? { ok: true as const }
        : { ok: false as const, reason: "insufficient" as const, availableMicroUsd: 0n },
    ),
    release: vi.fn(async () => undefined),
  };
}

const scope = () => ({ spaceId: "s", projectId: "p" });

describe("createBudgetObserver", () => {
  it("rejects the call when the reservation is refused", async () => {
    const p = port(false);
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    await expect(o.beforeCall(call)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it.each([0.0123, null])("leaves accounting to D1 for cost %s", async (costUsd) => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 777n });
    const id = await o.beforeCall(call);
    expect(id).toBe(call.callId);
    expect(p.reserve).toHaveBeenCalledWith({
      ...scope(),
      callId: call.callId,
      amountMicroUsd: 777n,
    });
    await o.afterCall(id, { costUsd } as never, { started: true });
    expect(p.release).not.toHaveBeenCalled();
  });

  it("releases when the call never started", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    const id = await o.beforeCall(call);
    await o.afterCall(id, null, { started: false });
    expect(p.release).toHaveBeenCalledTimes(1);
  });

  it.each([true, undefined])(
    "retains holding when started is %s and accounting is missing",
    async (started) => {
      const p = port();
      const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
      const id = await o.beforeCall(call);
      await o.afterCall(id, null, started === undefined ? undefined : { started });
      expect(p.release).not.toHaveBeenCalled();
    },
  );

  it("preserves distinct producer callIds for primary and backup calls", async () => {
    const p = port();
    const o = createBudgetObserver({ port: p, scope, upperBoundMicroUsd: () => 5n });
    await o.beforeCall(call);
    await o.beforeCall({ ...call, callId: "backup-call" });
    const ids = (p.reserve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].callId);
    expect(ids).toEqual([call.callId, "backup-call"]);
  });
});

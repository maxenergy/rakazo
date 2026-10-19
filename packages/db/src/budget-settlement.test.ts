import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { settleBudget, writeOffBudgetHolding } from "./project-budgets.js";

describe("write-off and late settlement", () => {
  it("closes the holding once and preserves its audit through a duplicate late charge", async () => {
    const reservation = {
      id: "reservation",
      budgetId: "budget",
      amountMicroUsd: 100n,
      status: "unreconciled",
      settledMicroUsd: null as bigint | null,
      overrunMicroUsd: 0n,
      settledLate: false,
      writtenOffBy: null as string | null,
      writeOffReason: null as string | null,
      chargedAfterWriteOff: false,
    };
    let reserved = 100n;
    let settled = 0n;
    const updateBudget = vi.fn(async ({ data }) => {
      reserved -= data.reservedMicroUsd?.decrement ?? 0n;
      settled += data.settledMicroUsd?.increment ?? 0n;
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").includes("budget_reservations") ? [reservation] : [],
      ),
      projectBudget: { update: updateBudget },
      budgetSpendLedger: { create: vi.fn(async () => ({})) },
      budgetReservation: {
        update: vi.fn(async ({ data }) => {
          for (const [key, value] of Object.entries(data))
            if (value !== undefined) Object.assign(reservation, { [key]: value });
          return reservation;
        }),
      },
    };
    const db = {
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const identity = { spaceId: "space", callId: "call" };
    await writeOffBudgetHolding(db, {
      ...identity,
      actorUserId: "auditor",
      reason: " unresolved provider charge ",
    });
    expect(
      await writeOffBudgetHolding(db, { ...identity, actorUserId: "auditor", reason: "repeat" }),
    ).toMatchObject({ replayed: true });
    expect(reserved).toBe(0n);
    expect(settled).toBe(0n);
    expect(await settleBudget(db, { ...identity, actualMicroUsd: 125n })).toMatchObject({
      replayed: false,
      settledMicroUsd: 125n,
      overrunMicroUsd: 25n,
      settledLate: true,
    });
    expect(await settleBudget(db, { ...identity, actualMicroUsd: 125n })).toMatchObject({
      replayed: true,
    });
    expect(reserved).toBe(0n);
    expect(settled).toBe(125n);
    expect(updateBudget).toHaveBeenCalledTimes(2);
    expect(tx.budgetSpendLedger.create).toHaveBeenCalledTimes(1);
    expect(reservation).toMatchObject({
      writtenOffBy: "auditor",
      writeOffReason: "unresolved provider charge",
      chargedAfterWriteOff: true,
      status: "settled",
    });
  });
});

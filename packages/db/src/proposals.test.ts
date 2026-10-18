import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createProposal, decideProposal, ProposalDecisionError } from "./proposals.js";

const scope = { userId: "user-1", spaceId: "space-1" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    botId: "ceo-1",
    kind: "plan",
    title: "Plan",
    summary: "Summary",
    options: ["A", "B"],
    recommendation: "",
    status: "pending",
    chosenOption: null,
    comment: null,
    decidedAt: null,
    createdAt: new Date(0),
    bot: { name: "CEO" },
    ...overrides,
  };
}

describe("proposals", () => {
  it("returns the existing proposal for a replayed submit key", async () => {
    const create = vi.fn();
    const prisma = {
      $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma),
      proposal: { findUnique: vi.fn().mockResolvedValue(row()), create },
    } as unknown as PrismaClient;
    const result = await createProposal(prisma, scope, {
      botId: "ceo-1",
      submitKey: "call-1",
      kind: "plan",
      title: "Plan",
      summary: "Summary",
      options: [],
      recommendation: "",
    });
    expect(result).toMatchObject({ replayed: true, proposal: { id: "p-1", botName: "CEO" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("records only the first decision", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma),
      budgetOverrunApproval: { findFirst: vi.fn().mockResolvedValue(null) },
      proposal: {
        findFirst: vi.fn().mockResolvedValue({ options: ["A", "B"] }),
        updateMany,
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue(
            row({ status: "approved", chosenOption: "B", decidedAt: new Date(0) }),
          ),
      },
    } as unknown as PrismaClient;

    await expect(
      decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve", option: "B" }),
    ).resolves.toMatchObject({ status: "approved", chosenOption: "B" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "pending", spaceId: "space-1", userId: "user-1" }),
        data: expect.objectContaining({ status: "approved", chosenOption: "B" }),
      }),
    );
    await expect(
      decideProposal(prisma, scope, { proposalId: "p-1", decision: "reject" }),
    ).rejects.toThrow("This proposal was already decided");
  });

  it("rejects an option the proposal did not offer and a proposal from another space", async () => {
    const prisma = {
      $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma),
      proposal: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ options: ["A"] })
          .mockResolvedValueOnce(null),
      },
    } as unknown as PrismaClient;
    await expect(
      decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve", option: "Z" }),
    ).rejects.toBeInstanceOf(ProposalDecisionError);
    await expect(
      decideProposal(prisma, scope, { proposalId: "p-9", decision: "approve" }),
    ).rejects.toThrow("Proposal not found");
  });

  it("records a launch team decision as already decided by the team", async () => {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) =>
      row({ ...args.data, id: "p-2" }),
    );
    const prisma = {
      $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(prisma),
      proposal: { findUnique: vi.fn().mockResolvedValue(null), create },
    } as unknown as PrismaClient;
    const { proposal } = await createProposal(prisma, scope, {
      botId: "ceo-1",
      submitKey: "call-2",
      kind: "decision",
      title: "Use one engineer",
      summary: "Staff one engineer on gpt-6.1-sol",
      options: [],
      recommendation: "Cheapest model that fits",
      teamDecision: { chosenOption: "One engineer" },
    });
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      status: "approved",
      decidedBy: "team",
      chosenOption: "One engineer",
    });
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("teamDecision");
    expect(proposal).toMatchObject({ status: "approved", decidedBy: "team" });
  });
});


describe("budget approval recovery", () => {
  function fixture(status = "waiting_budget", checkpointChanges: Record<string, unknown> = {}, budgetVersion = 1) {
    const binding = { threadId: "thread-1", runId: "run-1", botId: "bot-1", attemptId: "attempt-1", leaseFence: 3, callId: "call-1" };
    const approval = { id: "approval-1", spaceId: scope.spaceId, projectId: "project-1", budgetId: "budget-1", budgetVersion: 1, amountMicroUsd: 10n, scope: JSON.stringify(binding), status: "pending", appliedVersion: null };
    const checkpoint = { kind: "budget_pause_v1", approvalId: approval.id, proposalId: "p-1", call: { callId: binding.callId, projectId: approval.projectId, spaceId: scope.spaceId, amountMicroUsd: "10" }, ...checkpointChanges };
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("project_budgets") ? [{ id: "budget-1", version: budgetVersion, limitMicroUsd: 100n }] : [{ id: "locked" }]),
      proposal: { findFirst: vi.fn().mockResolvedValue({ options: [] }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findFirstOrThrow: vi.fn().mockResolvedValue(row({ status: "approved" })) },
      budgetOverrunApproval: { findFirst: vi.fn().mockResolvedValue(approval), findUniqueOrThrow: vi.fn().mockResolvedValue(approval), update: vi.fn().mockResolvedValue({}) },
      attempt: { findFirst: vi.fn().mockResolvedValue({ id: "attempt-1" }) },
      projectBudget: { update: vi.fn().mockResolvedValue({}) },
      projectBudgetVersion: { create: vi.fn().mockResolvedValue({}) },
      run: { findFirst: vi.fn().mockResolvedValue({ status, leaseFence: 3, checkpoint: JSON.stringify(checkpoint) }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
    return { tx, prisma };
  }

  it("raises the bound budget and queues its paused run", async () => {
    const { tx, prisma } = fixture();
    await decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve" });
    expect(tx.projectBudget.update).toHaveBeenCalledWith({ where: { id: "budget-1" }, data: { version: 2, limitMicroUsd: 110n } });
    expect(tx.run.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "queued", checkpoint: null } }));
  });

  it.each(["cancelled", "running", "queued"])("does not approve or resume a %s run", async (status) => {
    const { tx, prisma } = fixture(status);
    await expect(decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve" })).rejects.toThrow("no longer matches");
    expect(tx.projectBudget.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a missing or mismatched paused attempt", async () => {
    const { tx, prisma } = fixture();
    tx.attempt.findFirst.mockResolvedValueOnce(null as never);
    await expect(decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve" })).rejects.toThrow("no longer matches");
    expect(tx.attempt.findFirst).toHaveBeenCalledWith({
      where: { id: "attempt-1", runId: "run-1", fence: 3, status: "waiting_budget" },
      select: { id: true },
    });
    expect(tx.projectBudget.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint bound to another approval", async () => {
    const { tx, prisma } = fixture("waiting_budget", { approvalId: "another-approval" });
    await expect(decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve" })).rejects.toThrow("no longer matches");
    expect(tx.projectBudget.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does not raise the budget or resume after rejection", async () => {
    const { tx, prisma } = fixture();
    await decideProposal(prisma, scope, { proposalId: "p-1", decision: "reject" });
    expect(tx.budgetOverrunApproval.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }));
    expect(tx.projectBudget.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("marks an approval stale without resuming when the budget version changed", async () => {
    const { tx, prisma } = fixture("waiting_budget", {}, 2);
    await decideProposal(prisma, scope, { proposalId: "p-1", decision: "approve" });
    expect(tx.budgetOverrunApproval.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "stale" }) }));
    expect(tx.projectBudget.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

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

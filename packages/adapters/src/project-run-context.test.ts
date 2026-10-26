import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { projectRunMessages } from "./project-run-context.js";
import { loadAgentTicketContext } from "./ticket-context.js";

describe("project run context", () => {
  it("keeps only current-project run history and source turns", () => {
    const messages = [
      { id: "old-user", runId: null },
      { id: "old-answer", runId: "old-run" },
      { id: "same-user", runId: null },
      { id: "same-answer", runId: "same-run" },
      { id: "current-user", runId: null },
      { id: "unscoped", runId: null },
    ];
    expect(
      projectRunMessages(
        messages,
        [{ id: "same-run", sourceMessageId: "same-user" }],
        "current-user",
      ),
    ).toEqual(messages.slice(2, 5));
  });

  it("filters referenced tickets by the run's project even when the prompt names another project", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      board: { findUnique: vi.fn(async () => ({ id: "board", ticketPrefix: "RAK" })) },
      ticket: { findMany },
    } as unknown as PrismaClient;
    await loadAgentTicketContext(
      { prisma, ticketBoardEnabled: true },
      { spaceId: "space", text: "RAK-1 RAK-2", projectId: "current" },
    );
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        boardId: "board",
        projectId: "current",
        number: { in: [1, 2] },
      },
    });
  });
});

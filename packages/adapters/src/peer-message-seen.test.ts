import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { peerMessageAlreadySeen } from "./bot-messages.js";

const run = { id: "run-2", threadId: "thread-1", botId: "bot-1", sourceMessageId: "message-1" };

function prisma(orgRole: string | null, covering: { id: string } | null) {
  const findFirst = vi.fn().mockResolvedValue(covering);
  return {
    client: {
      bot: { findUnique: vi.fn().mockResolvedValue({ orgRole }) },
      message: {
        findUnique: vi.fn().mockResolvedValue({ createdAt: new Date("2026-10-16T10:00:00Z") }),
      },
      run: { findFirst },
    } as unknown as PrismaClient,
    findFirst,
  };
}

describe("peerMessageAlreadySeen", () => {
  it("skips a peer message a later completed turn already had in its history", async () => {
    const { client, findFirst } = prisma("member", { id: "run-3" });
    await expect(peerMessageAlreadySeen(client, run)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-1",
          botId: "bot-1",
          id: { not: "run-2" },
          status: "completed",
          startedAt: { gt: new Date("2026-10-16T10:00:00Z") },
        }),
      }),
    );
  });

  it("runs the turn when no later turn has seen the message", async () => {
    await expect(peerMessageAlreadySeen(prisma("member", null).client, run)).resolves.toBe(false);
  });

  it("leaves bots outside an org on one turn per message", async () => {
    const { client, findFirst } = prisma(null, { id: "run-3" });
    await expect(peerMessageAlreadySeen(client, run)).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

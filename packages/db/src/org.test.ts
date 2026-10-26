import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { reportsToError } from "./org.js";

const actor = { userId: "user-1", spaceId: "space-1" };

function prismaWith(
  bots: Record<string, { archivedAt?: Date | null; reportsToBotId: string | null }>,
) {
  const findFirst = vi.fn(async (args: { where: { id: string; spaceId: string } }) => {
    const bot = args.where.spaceId === actor.spaceId ? bots[args.where.id] : undefined;
    return bot ? { id: args.where.id, archivedAt: bot.archivedAt ?? null, ...bot } : null;
  });
  return { bot: { findFirst } } as unknown as PrismaClient;
}

describe("reportsToError", () => {
  it("accepts an active manager in the same space", async () => {
    const prisma = prismaWith({ ceo: { reportsToBotId: null } });
    await expect(reportsToError(prisma, actor, "lead", "ceo")).resolves.toBeUndefined();
  });

  it("rejects self, missing, and archived managers", async () => {
    const prisma = prismaWith({ old: { archivedAt: new Date(0), reportsToBotId: null } });
    await expect(reportsToError(prisma, actor, "lead", "lead")).resolves.toBe(
      "A bot cannot report to itself",
    );
    await expect(reportsToError(prisma, actor, "lead", "ghost")).resolves.toBe(
      "Manager bot not found",
    );
    await expect(reportsToError(prisma, actor, "lead", "old")).resolves.toBe(
      "Manager bot is archived",
    );
  });

  it("rejects a manager whose chain leads back to the bot", async () => {
    const prisma = prismaWith({
      member: { reportsToBotId: "lead" },
      lead: { reportsToBotId: "ceo" },
      ceo: { reportsToBotId: null },
    });
    await expect(reportsToError(prisma, actor, "ceo", "member")).resolves.toBe(
      "That would create a reporting loop",
    );
  });
});

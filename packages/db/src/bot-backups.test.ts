import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { listEffectiveBotBackupModels, replaceBotBackupModels } from "./model-backups.js";

const scope = { userId: "owner", spaceId: "space", botId: "bot" };
const choice = { provider: "provider", modelId: "model" };

describe("bot backup isolation and inheritance", () => {
  function fixture(models = [choice], owned = true) {
    return {
      bot: { findFirst: vi.fn().mockResolvedValue(owned ? { id: scope.botId } : null) },
      botBackupModel: { findMany: vi.fn().mockResolvedValue(models) },
      spaceBackupModel: { findMany: vi.fn().mockResolvedValue([{ provider: "owner-provider", modelId: "owner-model" }]) },
    };
  }

  it("uses the complete bot list without consulting owner backups", async () => {
    const db = fixture();
    await expect(listEffectiveBotBackupModels(db as unknown as PrismaClient, scope)).resolves.toEqual([choice]);
    expect(db.spaceBackupModel.findMany).not.toHaveBeenCalled();
    expect(db.bot.findFirst).toHaveBeenCalledWith({ where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId }, select: { id: true } });
  });

  it("inherits owner backups when the bot list is empty", async () => {
    const db = fixture([]);
    await expect(listEffectiveBotBackupModels(db as unknown as PrismaClient, scope)).resolves.toEqual([{ provider: "owner-provider", modelId: "owner-model" }]);
    expect(db.spaceBackupModel.findMany).toHaveBeenCalledWith({ where: { userId: scope.userId, spaceId: scope.spaceId }, orderBy: { position: "asc" }, select: { provider: true, modelId: true } });
  });

  it("rejects foreign bots before reading either backup list", async () => {
    const db = fixture([], false);
    await expect(listEffectiveBotBackupModels(db as unknown as PrismaClient, scope)).rejects.toThrow();
    expect(db.botBackupModel.findMany).not.toHaveBeenCalled();
    expect(db.spaceBackupModel.findMany).not.toHaveBeenCalled();
  });

  it("does not clear backups when the scoped bot lock finds no bot", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), botBackupModel: { deleteMany: vi.fn(), createMany: vi.fn() } };
    const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) };
    await expect(replaceBotBackupModels(db as unknown as PrismaClient, scope, [])).rejects.toThrow();
    expect(tx.botBackupModel.deleteMany).not.toHaveBeenCalled();
  });
});

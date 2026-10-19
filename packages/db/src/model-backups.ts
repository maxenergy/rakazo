import type { ModelBackupChoice } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type BackupModelScope = { userId: string; spaceId: string };

export async function listSpaceBackupModels(
  prisma: Pick<PrismaClient, "spaceBackupModel">,
  scope: BackupModelScope,
): Promise<ModelBackupChoice[]> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  return prisma.spaceBackupModel.findMany({
    where: scoped,
    orderBy: { position: "asc" },
    select: { provider: true, modelId: true },
  });
}

export async function replaceSpaceBackupModels(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: BackupModelScope,
  models: ModelBackupChoice[],
): Promise<void> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Lock a row that exists even when the backup list is empty. At ReadCommitted,
        // the delete after this lock observes the previous writer's committed list.
        const membership = await tx.$queryRaw<Array<{ locked: number }>>`
          SELECT 1 AS locked FROM "space_members"
          WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}
          FOR UPDATE
        `;
        if (membership.length !== 1) throw new Error("Space membership not found");
        await tx.spaceBackupModel.deleteMany({ where: scoped });
        if (models.length === 0) return;
        await tx.spaceBackupModel.createMany({
          data: models.map((model, position) => ({ ...scoped, ...model, position })),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}


type BotBackupModelScope = BackupModelScope & { botId: string };

export async function listBotBackupModels(
  prisma: Pick<PrismaClient, "bot" | "botBackupModel">,
  scope: BotBackupModelScope,
): Promise<ModelBackupChoice[]> {
  const bot = await prisma.bot.findFirst({
    where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId },
    select: { id: true },
  });
  if (!bot) throw new Error("Bot not found");
  return prisma.botBackupModel.findMany({
    where: { botId: bot.id },
    orderBy: { position: "asc" },
    select: { provider: true, modelId: true },
  });
}

export async function replaceBotBackupModels(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: BotBackupModelScope,
  models: ModelBackupChoice[],
): Promise<void> {
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const bots = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "bots"
        WHERE "id" = ${scope.botId}
          AND "userId" = ${scope.userId} AND "spaceId" = ${scope.spaceId}
        FOR UPDATE
      `;
      if (bots.length !== 1) throw new Error("Bot not found");
      await tx.botBackupModel.deleteMany({ where: { botId: scope.botId } });
      if (!models.length) return;
      await tx.botBackupModel.createMany({
        data: models.map((model, position) => ({ ...model, botId: scope.botId, position })),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
  );
}

/** A nonempty bot list replaces the entire owner list; empty means inherit. */
export async function listEffectiveBotBackupModels(
  prisma: Pick<PrismaClient, "bot" | "botBackupModel" | "spaceBackupModel">,
  scope: BotBackupModelScope,
): Promise<ModelBackupChoice[]> {
  const models = await listBotBackupModels(prisma, scope);
  return models.length ? models : listSpaceBackupModels(prisma, scope);
}

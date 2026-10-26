import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export async function requireHostOwnerSession(
  prisma: PrismaClient,
  actor: Actor,
  sessionId: string | undefined,
): Promise<void> {
  if (!actor.isDeploymentOwner || !sessionId) throw new ORPCError("FORBIDDEN");
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId: actor.userId, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!session || settings?.ownerUserId !== actor.userId) throw new ORPCError("FORBIDDEN");
}

import {
  assertExecutionFence,
  type ExecutionFence,
  editProjectMember,
  lockTicketSpace,
  type PrismaClient,
  readBotContinuation,
  restoreBotUnderComputerQuota,
  withTransactionRetry,
} from "@rakazo/db";
import { z } from "zod";

const targetInput = z.object({ botId: z.string().min(1), projectId: z.string().min(1).optional() });
export const archivedBotToolInputs = {
  list_archived_bots: z.object({ recentTickets: z.number().int().min(1).max(20).default(5) }),
  preview_restore_bot: targetInput,
  restore_bot: targetInput,
};
export type ArchivedBotToolName = keyof typeof archivedBotToolInputs;
export function isArchivedBotToolName(name: string): name is ArchivedBotToolName {
  return Object.hasOwn(archivedBotToolInputs, name);
}

export async function executeArchivedBotTool(
  deps: { prisma: PrismaClient; executionFence?: ExecutionFence },
  scope: { spaceId: string; botId: string },
  name: ArchivedBotToolName,
  args: unknown,
) {
  // Re-read authority from storage; model arguments cannot grant an org role.
  const caller = await deps.prisma.bot.findFirst({
    where: { id: scope.botId, spaceId: scope.spaceId, archivedAt: null },
    select: { orgRole: true },
  });
  if (!caller || !["ceo", "cto"].includes(caller.orgRole ?? "")) {
    return { error: "仅本空间 CEO/CTO 可以列出、预览或恢复归档员工。" };
  }
  const parsed = archivedBotToolInputs[name].safeParse(args);
  if (!parsed.success) return { error: parsed.error.message };
  if (name === "list_archived_bots") {
    const { recentTickets } = archivedBotToolInputs.list_archived_bots.parse(args);
    const bots = await deps.prisma.bot.findMany({
      where: { spaceId: scope.spaceId, archivedAt: { not: null } },
      select: {
        id: true,
        name: true,
        title: true,
        modelProvider: true,
        modelId: true,
        archivedAt: true,
      },
      orderBy: [{ archivedAt: "desc" }, { id: "asc" }],
    });
    return {
      bots: await Promise.all(
        bots.map(async (bot) => {
          const [memberships, tickets] = await Promise.all([
            deps.prisma.projectMember.findMany({
              where: { botId: bot.id, project: { spaceId: scope.spaceId } },
              select: {
                projectId: true,
                role: true,
                project: { select: { name: true, status: true } },
              },
              orderBy: { projectId: "asc" },
            }),
            deps.prisma.ticket.findMany({
              where: { spaceId: scope.spaceId, assigneeBotId: bot.id },
              select: {
                number: true,
                title: true,
                status: true,
                board: { select: { ticketPrefix: true } },
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: recentTickets,
            }),
          ]);
          return {
            ...bot,
            archivedAt: bot.archivedAt?.toISOString() ?? null,
            projects: memberships.map(({ projectId, role, project }) => ({
              projectId,
              role,
              ...project,
            })),
            tickets: tickets.map(({ number, title, status, board }) => ({
              ref: `${board.ticketPrefix}-${number}`,
              title,
              status,
            })),
          };
        }),
      ),
    };
  }
  const input = targetInput.parse(args);
  const target = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: scope.spaceId },
    select: { id: true, userId: true, archivedAt: true, computer: { select: { id: true } } },
  });
  if (!target) return { error: "本空间内找不到该员工。" };
  const targetProject = input.projectId
    ? await deps.prisma.project.findFirst({
        where: { id: input.projectId, spaceId: scope.spaceId },
        select: { id: true, name: true, status: true },
      })
    : null;
  if (input.projectId && !targetProject) return { error: "本空间内找不到该项目。" };
  if (name === "restore_bot") {
    await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        await lockTicketSpace(tx, scope.spaceId);
        if (deps.executionFence) await assertExecutionFence(tx, deps.executionFence);
        // Only the archive flag changes. Identity, memory, files and historical runs stay in place.
        if (target.archivedAt) {
          if (target.computer) {
            await restoreBotUnderComputerQuota(tx, {
              userId: target.userId,
              botId: target.id,
              computerId: target.computer.id,
            });
          } else {
            await tx.bot.update({ where: { id: target.id }, data: { archivedAt: null } });
          }
          await tx.routine.updateMany({
            where: { spaceId: scope.spaceId, botId: target.id },
            data: { active: false, nextRunAt: null },
          });
        }
        if (input.projectId) {
          await editProjectMember(tx, scope.spaceId, "add", {
            projectId: input.projectId,
            botId: target.id,
          });
        }
      }),
    );
  }
  const preview = await readBotContinuation(deps.prisma, {
    spaceId: scope.spaceId,
    userId: target.userId,
    botId: target.id,
  });
  return {
    ...(name === "restore_bot" ? { ok: true } : {}),
    ...preview,
    // Do not expose routine webhook credentials or other private transport fields.
    routines: preview.routines.map(({ id, name, projectId, active, crons, timezone }) => ({
      id,
      name,
      projectId,
      active,
      crons,
      timezone,
    })),
    targetProject,
    targetProjectPaused: targetProject?.status === "paused",
  };
}

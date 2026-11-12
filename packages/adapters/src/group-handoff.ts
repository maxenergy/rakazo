import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import { botMessageHopExhausted, nextBotMessageHop, renderGroupMembersContext } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

type HandoffRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
};

async function createHandoffRun(
  tx: Prisma.TransactionClient,
  run: HandoffRun,
  input: { deliveryKey: string; targetId: string; text: string; hop: number },
) {
  const handoffBlock: MessageBlock = {
    kind: "handoff",
    fromBotId: run.botId,
    toBotId: input.targetId,
    text: input.text,
    hop: input.hop,
  };
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role: "bot",
    blocks: [handoffBlock],
    botId: run.botId,
    runId: run.id,
    clientNonce: input.deliveryKey,
  });
  const task = await tx.task.create({
    data: {
      spaceId: run.spaceId,
      botId: input.targetId,
      threadId: run.threadId,
      userId: run.userId,
      prompt: input.text,
      status: "queued",
    },
  });
  const attributionParent = await tx.run.findFirst({
    where: { id: run.id, spaceId: run.spaceId },
    select: { projectId: true, ticketId: true, rootRunId: true },
  });
  if (!attributionParent) throw new Error("Handoff parent run is unavailable");
  const nextRun = await tx.run.create({
    data: {
      spaceId: run.spaceId,
      botId: input.targetId,
      threadId: run.threadId,
      taskId: task.id,
      userId: run.userId,
      status: "queued",
      trigger: "follow_up",
      sourceMessageId: message.id,
      projectId: attributionParent.projectId,
      ticketId: attributionParent.ticketId,
      parentRunId: run.id,
      rootRunId: attributionParent.rootRunId ?? run.id,
    },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "group.handoff",
    runId: run.id,
    payload: {
      messageId: message.id,
      fromBotId: run.botId,
      toBotId: input.targetId,
      text: input.text,
    },
  });
  return { runId: nextRun.id, eventSeq: event.seq };
}

async function announceHandoff(
  deps: Pick<ExecutorDeps, "events" | "jobs">,
  threadId: string,
  handoff: { runId: string; eventSeq: number },
) {
  await deps.events.notify(threadId, handoff.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(handoff.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
}

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: HandoffRun,
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const deliveryKey = `group-handoff:${run.id}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: "running",
        },
        select: { id: true, sourceMessage: { select: { blocks: true } } },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
      select: {
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
      return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    let sourceBlocks: MessageBlock[] = [];
    if (activeSource.sourceMessage) {
      const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    if (sourceHandoff?.fromBotId === targetId) {
      return {
        error:
          "do not hand this stage back to its sender; post the result in the shared thread instead",
      } as const;
    }
    const hop = nextBotMessageHop(sourceHandoff?.hop);
    if (botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    const handoff = await createHandoffRun(tx, run, {
      deliveryKey,
      targetId,
      text: input.message,
      hop,
    });
    await touchGroupUpdatedAt(tx, groupId);
    return { ok: true, botId: targetId, ...handoff } as const;
  });
  if ("error" in committed) return committed;
  await announceHandoff(deps, run.threadId, committed);
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
  );
}

/**
 * Tell the bot that handed off a stage that the run it started failed for good. It travels as
 * a handoff so the chain's hop limit bounds it and the sender cannot pass the stage straight
 * back unchanged.
 */
export async function returnHandoffFailure(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: HandoffRun & { sourceMessageId?: string | null; parentRunId?: string | null },
  error: string,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // A timeout's recovery run has no source of its own; the run it continues does.
    const sourceMessageId =
      run.sourceMessageId ??
      (run.parentRunId
        ? (
            await tx.run.findUnique({
              where: { id: run.parentRunId },
              select: { sourceMessageId: true },
            })
          )?.sourceMessageId
        : null);
    if (!sourceMessageId) return null;
    const source = await tx.message.findUnique({
      where: { id: sourceMessageId },
      select: { blocks: true },
    });
    const blocks = MessageBlock.array().safeParse(source?.blocks);
    const sourceHandoff = blocks.data?.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    if (!sourceHandoff) return null;
    const hop = nextBotMessageHop(sourceHandoff.hop);
    if (botMessageHopExhausted(hop)) return null;
    const thread = await tx.thread.findUnique({
      where: { id: run.threadId },
      select: { groupId: true },
    });
    if (!thread?.groupId) return null;
    // Group changes hold this lock while they cancel runs, so check under it.
    await lockOwnedGroup(tx, run, thread.groupId);
    const group = await tx.chatGroup.findFirst({
      where: {
        id: thread.groupId,
        archivedAt: null,
        members: { some: { botId: sourceHandoff.fromBotId, bot: { archivedAt: null } } },
      },
      select: { id: true },
    });
    if (!group) return null;
    const deliveryKey = `group-handoff-failure:${run.id}`;
    const delivered = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
      select: { id: true },
    });
    if (delivered) return null;
    const handoff = await createHandoffRun(tx, run, {
      deliveryKey,
      targetId: sourceHandoff.fromBotId,
      text: `Automatic report: I could not finish the stage you handed off. ${error} Check this thread for what was done before deciding the next step.`,
      hop,
    });
    await touchGroupUpdatedAt(tx, group.id);
    return handoff;
  });
  if (committed) await announceHandoff(deps, run.threadId, committed);
}

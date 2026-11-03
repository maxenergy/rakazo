import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { DEFAULT_RUN_DEADLINE_MS } from "./run-segments.js";

export const RUN_DEADLINE_ERROR = "deadline_exceeded";

/**
 * Work that nothing else picks up after a timeout. A bot_message run already tells its
 * sender it failed, and routines and check-ins run again on their own.
 */
const RECOVERABLE_TRIGGERS = new Set(["user", "follow_up", "tickets"]);
const RECOVERY_NOTE_COUNT = 20;
const RECOVERY_NOTE_CHARS = 600;
const RECOVERY_TASK_CHARS = 8_000;

function earlierWork(task: string, notes: readonly string[]) {
  return [
    `Its task:\n${task.slice(0, RECOVERY_TASK_CHARS)}`,
    notes.length
      ? `Your last notes from that run:\n${notes.map((note) => `- ${note}`).join("\n")}`
      : undefined,
    "Continue from where the work stands. Before repeating anything with an outside effect, such as a push, a pull request, a message or a deployment, check the work directory, git history and pull requests for what already happened.",
  ];
}

export function deadlineRecoveryPrompt(task: string, notes: readonly string[]) {
  return [
    "Recovery (automatic, not from the user): your previous run reached its time limit before it finished.",
    ...earlierWork(task, notes),
    "This run has a shorter limit and will not be recovered again, so commit finished steps as you go. If you cannot finish, say what remains and what you need.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resumePrompt(task: string, notes: readonly string[]) {
  return [
    "The user asked you to continue: your previous run failed before it finished.",
    ...earlierWork(task, notes),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function latestRunNotes(tx: Prisma.TransactionClient, runId: string) {
  const latest = await tx.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    take: RECOVERY_NOTE_COUNT,
    select: { blocks: true },
  });
  return runNotes(latest.toReversed());
}

function runNotes(messages: ReadonlyArray<{ blocks: unknown }>) {
  return messages.flatMap((message) =>
    (message.blocks as MessageBlock[]).flatMap((block) =>
      block.kind === "text" && block.text.trim()
        ? [block.text.trim().slice(0, RECOVERY_NOTE_CHARS)]
        : [],
    ),
  );
}

/**
 * Queue one shorter run to continue work that timed out, at most once per bot in a run
 * chain, so a run that cannot finish costs a bounded amount and then stops for a person.
 */
export async function createDeadlineRecoveryRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string },
): Promise<string | null> {
  const failed = await tx.run.findUnique({
    where: { id: input.runId },
    select: {
      trigger: true,
      userId: true,
      projectId: true,
      rootRunId: true,
      modelPinned: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      task: { select: { prompt: true } },
      bot: { select: { archivedAt: true } },
    },
  });
  if (!failed || !RECOVERABLE_TRIGGERS.has(failed.trigger) || failed.bot.archivedAt) return null;
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return null;
  const rootRunId = failed.rootRunId ?? input.runId;
  const earlierTimeouts = await tx.run.count({
    where: {
      id: { not: input.runId },
      botId: input.botId,
      status: "failed",
      error: RUN_DEADLINE_ERROR,
      OR: [{ id: rootRunId }, { rootRunId }],
    },
  });
  if (earlierTimeouts > 0) return null;
  const notes = await latestRunNotes(tx, input.runId);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: failed.userId,
      prompt: deadlineRecoveryPrompt(failed.task.prompt, notes),
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: failed.userId,
      status: "queued",
      trigger: failed.trigger,
      projectId: failed.projectId,
      parentRunId: input.runId,
      rootRunId,
      deadlineMs: DEFAULT_RUN_DEADLINE_MS,
      ...(failed.modelPinned
        ? {
            modelPinned: true,
            modelProvider: failed.modelProvider,
            modelId: failed.modelId,
            thinkingLevel: failed.thinkingLevel,
          }
        : {}),
    },
  });
  return run.id;
}

/**
 * Queue a run that picks up a person's failed run, on their request. Returns null once the
 * run is no longer the bot's latest in its thread or the bot is archived, so a stale or
 * repeated request starts nothing.
 */
export async function createResumeRun(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; runId: string },
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    // Concurrent requests for one run take turns, so the second sees the first one's run.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const failed = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        userId: input.userId,
        status: "failed",
        bot: { archivedAt: null },
      },
      select: {
        botId: true,
        threadId: true,
        createdAt: true,
        projectId: true,
        rootRunId: true,
        modelPinned: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
        task: { select: { prompt: true } },
      },
    });
    if (!failed) return null;
    const superseded = await tx.run.findFirst({
      where: {
        threadId: failed.threadId,
        botId: failed.botId,
        OR: [{ status: { in: [...ACTIVE_RUN_STATUSES] } }, { createdAt: { gt: failed.createdAt } }],
      },
      select: { id: true },
    });
    if (superseded) return null;
    const notes = await latestRunNotes(tx, input.runId);
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: failed.botId,
        threadId: failed.threadId,
        userId: input.userId,
        prompt: resumePrompt(failed.task.prompt, notes),
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: failed.botId,
        threadId: failed.threadId,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: "resume",
        projectId: failed.projectId,
        parentRunId: input.runId,
        rootRunId: failed.rootRunId ?? input.runId,
        ...(failed.modelPinned
          ? {
              modelPinned: true,
              modelProvider: failed.modelProvider,
              modelId: failed.modelId,
              thinkingLevel: failed.thinkingLevel,
            }
          : {}),
      },
      select: { id: true },
    });
    return run.id;
  });
}

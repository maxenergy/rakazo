import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "./client.js";
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

export function deadlineRecoveryPrompt(task: string, notes: readonly string[]) {
  return [
    "Recovery (automatic, not from the user): your previous run reached its time limit before it finished.",
    `Its task:\n${task.slice(0, RECOVERY_TASK_CHARS)}`,
    notes.length
      ? `Your last notes from that run:\n${notes.map((note) => `- ${note}`).join("\n")}`
      : undefined,
    "Continue from where the work stands. Before repeating anything with an outside effect, such as a push, a pull request, a message or a deployment, check the work directory, git history and pull requests for what already happened.",
    "This run has a shorter limit and will not be recovered again, so commit finished steps as you go. If you cannot finish, say what remains and what you need.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const latest = await tx.message.findMany({
    where: { runId: input.runId, role: "bot" },
    orderBy: { seq: "desc" },
    take: RECOVERY_NOTE_COUNT,
    select: { blocks: true },
  });
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: failed.userId,
      prompt: deadlineRecoveryPrompt(failed.task.prompt, runNotes(latest.toReversed())),
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

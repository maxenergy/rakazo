import type { TicketStatus } from "@rakazo/contracts";
import {
  CommentTicketInput,
  CreateTicketInput,
  isTicketCompletedStatus,
  TicketStatusSchema,
  UpdateTicketInput,
} from "@rakazo/contracts";
import type { ExecutionFence, PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  assertExecutionFence,
  enqueueDependentWakes,
  ensureBoard,
  findTicket,
  listTicketComments,
  lockTicketForLinkUpdate,
  lockTicketSpace,
  resolveTicketLinks,
  toTicketCommentDto,
  toTicketDto,
  withTransactionRetry,
} from "@rakazo/db";
import type { TicketChangeNotifier } from "./ticket-changes.js";

export type TicketToolDeps = {
  executionFence?: ExecutionFence;
  prisma: PrismaClient;
  ticketBoardEnabled?: boolean;
  onTicketChange?: TicketChangeNotifier;
};
const STATUS_ERROR = `status must be one of ${TicketStatusSchema.options.join(", ")}.`;
function coerceInputStatus(value: string) {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
async function botInSpace(deps: TicketToolDeps, spaceId: string, botId: string) {
  return Boolean(
    await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId, archivedAt: null },
      select: { id: true },
    }),
  );
}
const LIST_TICKETS_LIMIT = 50;
const LIST_DESCRIPTION_CHARS = 200;

/**
 * The page key is the ticket's `createdAt` with `id` as the tiebreaker, because
 * both never change. A key on `updatedAt` would move a ticket that is edited
 * while a bot pages the board: the ticket would end up above the saved cursor
 * and no later page could return it. A stable key keeps the scan complete.
 */
function encodeTicketListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeTicketListCursor(
  cursor: string,
): { createdAt: Date; id: string } | { error: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { error: "cursor is invalid." };
  }
  const split = raw.indexOf("|");
  if (split <= 0) return { error: "cursor is invalid." };
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return { error: "cursor is invalid." };
  return { createdAt, id };
}

function truncateDescription(value: string | null | undefined) {
  if (!value || value.length <= LIST_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, LIST_DESCRIPTION_CHARS - 1)}…`;
}

export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
    cursor?: string;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const cursor = input.cursor?.trim();
  let pageCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const decoded = decodeTicketListCursor(cursor);
    if ("error" in decoded) return decoded;
    pageCursor = decoded;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId, deps.executionFence);
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      // Closed tickets are history; they only show up when asked for by status.
      ...(status ? { status } : { status: { not: "closed" } }),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      ...(pageCursor
        ? {
            OR: [
              { createdAt: { lt: pageCursor.createdAt } },
              { createdAt: pageCursor.createdAt, id: { lt: pageCursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_TICKETS_LIMIT + 1,
  });
  const page = rows.slice(0, LIST_TICKETS_LIMIT);
  const next = rows.length > LIST_TICKETS_LIMIT ? page.at(-1) : undefined;
  // A list is for scanning; ticket_get returns the full description.
  return {
    tickets: page.map((row) => {
      const dto = toTicketDto(row, board.ticketPrefix);
      return { ...dto, description: truncateDescription(dto.description) };
    }),
    ...(next ? { nextCursor: encodeTicketListCursor(next) } : {}),
  };
}

export async function getTicket(deps: TicketToolDeps, input: { spaceId: string; ref: string }) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const ref = input.ref.trim();
  if (!ref) return { error: "ref is required." };
  const board = await ensureBoard(deps.prisma, input.spaceId, deps.executionFence);
  const row =
    (await findTicket(deps.prisma, input.spaceId, board, { ref })) ??
    (await findTicket(deps.prisma, input.spaceId, board, { id: ref }));
  if (!row) return { error: `Ticket ${ref} not found.` };
  const comments = await listTicketComments(deps.prisma, input.spaceId, row.id);
  return {
    ticket: toTicketDto(row, board.ticketPrefix),
    comments: comments.map(toTicketCommentDto),
  };
}

export async function createTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId?: string;
    title: string;
    description?: string;
    priority?: string;
    ownerBotId?: string;
    projectId?: string | null;
    milestoneId?: string | null;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = CreateTicketInput.safeParse({
    ...input,
    assigneeBotId: input.ownerBotId ?? input.botId,
  });
  if (!parsed.success) return { error: "Invalid ticket." };
  const data = parsed.data;
  if (!(await botInSpace(deps, input.spaceId, data.assigneeBotId)))
    return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId, deps.executionFence);
  const row = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      if (deps.executionFence) {
        await lockTicketSpace(tx, input.spaceId);
        await assertExecutionFence(tx, deps.executionFence);
      }
      const links = await resolveTicketLinks(
        tx,
        input.spaceId,
        { projectId: null, milestoneId: null },
        data,
      );
      const number = await allocateTicketNumber(tx, board.id);
      return tx.ticket.create({
        data: {
          ...links,
          boardId: board.id,
          spaceId: input.spaceId,
          number,
          title: data.title,
          description: data.description ?? null,
          priority: data.priority,
          assigneeBotId: data.assigneeBotId,
          createdByBotId: input.botId ?? null,
          createdByUserId: input.userId ?? null,
        },
      });
    }),
  );
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: row.assigneeBotId !== input.botId,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    id: string;
    title?: string;
    description?: string | null;
    priority?: string | null;
    status?: string;
    ownerBotId?: string;
    projectId?: string | null;
    milestoneId?: string | null;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = UpdateTicketInput.safeParse({ ...input, assigneeBotId: input.ownerBotId });
  if (!parsed.success) return { error: "Invalid ticket." };
  const data = parsed.data;
  if (data.assigneeBotId && !(await botInSpace(deps, input.spaceId, data.assigneeBotId)))
    return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId, deps.executionFence);
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      if (deps.executionFence) {
        await lockTicketSpace(tx, input.spaceId);
        await assertExecutionFence(tx, deps.executionFence);
      }
      const locked = await lockTicketForLinkUpdate(tx, input.spaceId, board.id, data.id, data);
      if (!locked) return null;
      const { current, links } = locked;
      const row = await tx.ticket.update({
        where: { id: current.id },
        data: {
          ...links,
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority ?? "normal" } : {}),
          ...(data.assigneeBotId !== undefined ? { assigneeBotId: data.assigneeBotId } : {}),
          ...(data.status !== undefined
            ? {
                status: data.status,
                completedAt: isTicketCompletedStatus(data.status)
                  ? (current.completedAt ?? new Date())
                  : null,
              }
            : {}),
        },
      });
      if (data.status !== undefined && row.completedAt && !current.completedAt) {
        await enqueueDependentWakes(tx, input.spaceId, row.id, row.completedAt);
      }
      return {
        row,
        reassigned:
          data.assigneeBotId !== undefined && data.assigneeBotId !== current.assigneeBotId,
      };
    }),
  );
  if (!result) return { error: "Ticket not found." };
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: result.row.id,
    assigneeBotId: result.row.assigneeBotId,
    wakeAssignee: result.reassigned && result.row.assigneeBotId !== input.botId,
  });
  const finishedNow =
    input.botId !== undefined &&
    data.status !== undefined &&
    isTicketCompletedStatus(data.status) &&
    result.row.completedAt !== null;
  return {
    ticket: toTicketDto(result.row, board.ticketPrefix),
    // The moment a lesson is proven: ask for it while the work is fresh.
    ...(finishedNow
      ? {
          note: "If this work proved something reusable (a workaround, a pitfall, a working command), add it in at most three lines to the team-lessons skill with skill_update.",
        }
      : {}),
  };
}

export async function commentTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId?: string;
    id: string;
    body: string;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = CommentTicketInput.safeParse({ ticketId: input.id, body: input.body });
  if (!parsed.success) return { error: "Invalid comment." };
  const board = await ensureBoard(deps.prisma, input.spaceId, deps.executionFence);
  const ticket = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!ticket) return { error: "Ticket not found." };
  const row = await deps.prisma.$transaction(async (tx) => {
    if (deps.executionFence) {
      await lockTicketSpace(tx, input.spaceId);
      await assertExecutionFence(tx, deps.executionFence);
    }
    const comment = await tx.ticketComment.create({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: {
        ticketId: ticket.id,
        spaceId: input.spaceId,
        authorBotId: input.botId ?? null,
        authorUserId: input.userId ?? null,
        body: parsed.data.body,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    return comment;
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    // A review or answer left on the ticket is work for its owner; without a wake
    // the owner never sees it and the ticket stalls.
    wakeAssignee: ticket.assigneeBotId !== null && ticket.assigneeBotId !== input.botId,
  });
  return { comment: toTicketCommentDto(row) };
}

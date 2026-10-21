import { EditTicketDependencyInput, TicketDependenciesInput } from "@rakazo/contracts";
import {
  assertExecutionFence,
  lockTicketSpace,
  addTicketDependency,
  Prisma,
  ProjectLinkError,
  readTicketDependencies,
  removeTicketDependency,
  withTransactionRetry,
} from "@rakazo/db";
import type { TicketToolDeps } from "./ticket-tools.js";

export const dependencyToolNames = [
  "ticket_dependency_list",
  "ticket_dependency_add",
  "ticket_dependency_remove",
] as const;
export type DependencyToolName = (typeof dependencyToolNames)[number];
export function isDependencyToolName(name: string): name is DependencyToolName {
  return dependencyToolNames.some((candidate) => candidate === name);
}

export async function executeDependencyTool(
  deps: TicketToolDeps,
  spaceId: string,
  name: DependencyToolName,
  args: unknown,
) {
  if (!deps.ticketBoardEnabled) return { error: "Ticket board is disabled." };
  const parsed = (
    name === "ticket_dependency_list" ? TicketDependenciesInput : EditTicketDependencyInput
  ).safeParse(args);
  if (!parsed.success) return { error: parsed.error.message };
  try {
    const result = await withTransactionRetry(() =>
      deps.prisma.$transaction(
        async (tx) => {
          if (deps.executionFence) {
            await lockTicketSpace(tx, spaceId);
            await assertExecutionFence(tx, deps.executionFence);
          }
          const { ticketId } = parsed.data;
          if (name !== "ticket_dependency_list") {
            const edge = EditTicketDependencyInput.parse(args);
            if (name === "ticket_dependency_add")
              await addTicketDependency(tx, spaceId, ticketId, edge.prerequisiteId);
            else await removeTicketDependency(tx, spaceId, ticketId, edge.prerequisiteId);
          }
          const dependencies = await readTicketDependencies(tx, spaceId, ticketId);
          const ticket = await tx.ticket.findFirstOrThrow({ where: { spaceId, id: ticketId } });
          return { dependencies, ticket };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
    if (name !== "ticket_dependency_list") {
      await deps.onTicketChange?.({
        spaceId,
        boardId: result.ticket.boardId,
        ticketId: result.ticket.id,
        assigneeBotId: result.ticket.assigneeBotId,
        wakeAssignee: false,
      });
    }
    return result.dependencies;
  } catch (error) {
    if (error instanceof ProjectLinkError) return { error: error.message };
    throw error;
  }
}
